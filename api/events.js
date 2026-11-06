// api/events.js
// Event broadcasting and attendee registration platform.
// Public listing & registration, admin-only broadcasting & management.

import crypto from 'crypto';
import {
  listEvents,
  getEvent,
  putEvent,
  deleteEvent,
  getEventAttendees,
  registerForEvent,
  confirmEventPayment,
  setAttendeeCheckIn,
  removeEventAttendee,
} from './_lib/records.js';
import {
  applyCors,
  handlePreflight,
  getAdminSession,
  requireAdmin,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  isEmail,
  cleanPhone,
  withErrorHandling,
} from './_lib/http.js';
import { sendEmailWithin } from './_lib/email.js';
import { deliverEmailIntent } from './_lib/email-outbox.js';

function newEventId() {
  return `EVT-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;
}

const TICKET_ID_PATTERN = /^TKT-[A-Z0-9-]{6,80}$/;

/** What the check-in desk needs to recognise the person in front of it. */
function attendeeDeskView(a) {
  return {
    ticketId: a.ticketId,
    name: a.name,
    company: a.company,
    status: a.status,
    paymentStatus: a.paymentStatus,
    checkedInAt: a.checkedInAt || null,
    checkInMethod: a.checkInMethod || null,
    // Who marked them present: the CSV export shows it on the scan log.
    checkedInBy: a.checkedInBy || null,
  };
}

function getPublicVenue(event, isAdmin = false) {
  if (!event) return '';
  if (isAdmin) return event.venue;
  const isPaid = event.pricingType === 'paid' && Number(event.fee) > 0;
  const isOnline = event.mode === 'online' || /^https?:\/\//i.test(String(event.venue || '').trim());
  if (isPaid || isOnline) {
    return 'Meeting details will be sent to registered attendees upon payment confirmation.';
  }
  return event.venue;
}

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── 1. GET — List events (public) or single event ────────────────
  if (req.method === 'GET') {
    const adminEmail = await getAdminSession(req);
    const isAdmin = !!adminEmail;

    const eventId = str(req.query?.id, 100);
    if (eventId) {
      const event = await getEvent(eventId);
      if (!event) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }
      const capacity = Number(event.capacity) || 0;
      const registered = Number(event.registeredCount) || 0;
      const enriched = {
        ...event,
        venue: getPublicVenue(event, isAdmin),
        seatsLeft: Math.max(0, capacity - registered),
        isFull: capacity > 0 && registered >= capacity,
      };

      if (req.query?.includeAttendees === 'true') {
        const isAdminSession = await requireAdmin(req, res);
        if (!isAdminSession) return;
        enriched.attendees = await getEventAttendees(eventId);
      }
      return res.status(200).json({ success: true, event: enriched });
    }

    const events = await listEvents();
    const enriched = events.map(e => {
      const cap = Number(e.capacity) || 0;
      const reg = Number(e.registeredCount) || 0;
      return {
        ...e,
        venue: getPublicVenue(e, isAdmin),
        seatsLeft: Math.max(0, cap - reg),
        isFull: cap > 0 && reg >= cap,
      };
    });
    return res.status(200).json({ success: true, events: enriched });
  }

  // ── 2. POST — Register for event (public) OR Broadcast event (admin)
  if (req.method === 'POST') {
    const action = str(req.query?.action || req.body?.action, 50).toLowerCase();

    // ── 2a. Public Attendee Registration ─────────────────────────────
    if (action === 'register') {
      const body = req.body || {};
      const eventId = str(body.eventId, 100);
      const name = str(body.name, 120);
      const email = str(body.email, 254).toLowerCase();
      const phone = cleanPhone(body.phone);
      const company = str(body.company, 200) || 'Delegate / Independent';
      const paymentRef = str(body.paymentRef, 100);

      if (!eventId) {
        return res.status(400).json({ success: false, error: 'Event ID is required.' });
      }
      if (name.length < 2) {
        return res.status(400).json({ success: false, error: 'Full name is required (min 2 characters).' });
      }
      if (!isEmail(email)) {
        return res.status(400).json({ success: false, error: 'Valid email address is required.' });
      }
      if (!/^[6-9]\d{9}$/.test(phone)) {
        return res.status(400).json({ success: false, error: 'Valid 10-digit Indian mobile number is required.' });
      }

      // Verify event exists and enforce payment reference for paid events
      const targetEvent = await getEvent(eventId);
      if (!targetEvent) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }
      if (targetEvent.pricingType === 'paid' && Number(targetEvent.fee) > 0) {
        if (!paymentRef || paymentRef.length < 4) {
          return res.status(400).json({
            success: false,
            error: 'Payment UTR / transaction reference is required for paid events.',
          });
        }
      }

      // Rate limit registrations by IP
      const ip = clientIp(req);
      const ipLimit = await rateLimit(`eventreg:ip:${ip}`, { max: 10, windowSec: 60 });
      if (!ipLimit.ok) {
        return tooManyRequests(res, ipLimit.retryAfter, 'Too many registration requests. Please wait a moment.');
      }
      // Each registration emails the address typed in and takes a seat, so cap
      // both: a script cannot fill one event from a single network, nor use
      // the form to send tickets to a stranger's inbox over and over. 20 an
      // hour still lets a company register its delegates from one office.
      const eventIpLimit = await rateLimit(`eventreg:ip:${ip}:event:${eventId}`, { max: 20, windowSec: 3600 });
      if (!eventIpLimit.ok) {
        return tooManyRequests(res, eventIpLimit.retryAfter, 'Too many registrations for this event from your network. Please try again later.');
      }
      const recipientLimit = await rateLimit(`eventreg:email:${email}`, { max: 5, windowSec: 86400 });
      if (!recipientLimit.ok) {
        return tooManyRequests(res, recipientLimit.retryAfter, 'This email address has reached today\'s registration limit. Please try again tomorrow.');
      }

      const result = await registerForEvent(eventId, { name, email, phone, company, paymentRef });
      if (!result.success) {
        const message = result.error || 'Registration could not be completed.';
        // The event was checked above, so a "not found" here means it was
        // deleted between the two reads: that is a 404, not a conflict.
        const status = /event not found/i.test(message) ? 404 : 409;
        return res.status(status).json({ success: false, error: message });
      }

      // Only a stored ticket ID is useful: confirmation looks it up by ID.
      const ticketId = result.ticketId;
      if (!ticketId) {
        throw new Error(`Registration for event ${eventId} was stored without a ticket ID.`);
      }

      // SEC-04: If event is paid, acknowledge registration pending Secretariat verification.
      // Do NOT send the confidential meeting link / access pass until payment is confirmed.
      const isPaid = targetEvent.pricingType === 'paid' && Number(targetEvent.fee) > 0;
      if (isPaid) {
        // Awaited: Vercel may freeze the function once the response is sent,
        // and sendEmail() reports SMTP failures in its result, not by throwing.
        const mail = await sendEmailWithin({
          type: 'event_registration_pending',
          to: email,
          data: {
            ticketId,
            eventTitle: result.event.title,
            date: result.event.date,
            time: result.event.time,
            pricingType: result.event.pricingType,
            fee: result.event.fee,
            paymentRef: result.attendee.paymentRef,
            attendeeName: result.attendee.name,
            company: result.attendee.company,
            phone: result.attendee.phone,
            email: result.attendee.email,
          },
        });
        if (!mail.success) {
          console.warn('[BCCI Event] Failed to dispatch registration pending email:', mail.error);
        }

        console.log(`[BCCI Event] Registered ${email} (pending verification) for event ${eventId}`);
        return res.status(200).json({
          success: true,
          emailSent: mail.success,
          message: mail.success
            ? 'Registration received! Your registration is pending payment verification. You will receive your official E-Ticket once payment is verified.'
            : 'Registration received and pending payment verification, but we could not confirm the acknowledgement email was sent. You will still receive your official E-Ticket once payment is verified.',
          event: {
            id: result.event.id,
            title: result.event.title,
            date: result.event.date,
            time: result.event.time,
            mode: result.event.mode,
            pricingType: result.event.pricingType,
            fee: result.event.fee,
            venue: getPublicVenue(result.event, false),
          },
          attendee: {
            name: result.attendee.name,
            email: result.attendee.email,
            phone: result.attendee.phone,
            company: result.attendee.company,
            paymentRef: result.attendee.paymentRef,
            status: result.attendee.status,
            paymentStatus: result.attendee.paymentStatus,
            registeredAt: result.attendee.registeredAt,
          },
          status: 'pending',
        });
      }

      // Free event: instant confirmation with full admission pass
      const mail = await sendEmailWithin({
        type: 'event_ticket',
        to: email,
        data: {
          ticketId,
          eventTitle: result.event.title,
          date: result.event.date,
          time: result.event.time,
          venue: result.event.venue,
          mode: result.event.mode,
          pricingType: result.event.pricingType,
          fee: result.event.fee,
          paymentRef: result.attendee.paymentRef,
          attendeeName: result.attendee.name,
          company: result.attendee.company,
          phone: result.attendee.phone,
          email: result.attendee.email,
        },
      });
      if (!mail.success) {
        console.warn('[BCCI Event] Failed to dispatch ticket email:', mail.error);
      }

      console.log(`[BCCI Event] Registered ${email} for event ${eventId} (Ticket: ${ticketId})`);
      return res.status(200).json({
        success: true,
        emailSent: mail.success,
        message: mail.success
          ? 'Registration confirmed! Your official E-Ticket has been sent to your email.'
          : `Registration confirmed, but we could not confirm the E-Ticket email was sent. Please keep your ticket ID (${ticketId}) for entry.`,
        event: result.event,
        attendee: result.attendee,
        ticketId,
      });
    }

    // ── 2d. Check an attendee in at the venue (Admin Only) ───────────
    // The QR on a ticket holds only its ticket ID. That ID carries 40 random
    // bits and is shown to nobody but its holder and the secretariat, so it
    // works as the admission credential without a separate signature.
    if (action === 'check-in') {
      if (!(await requireAdmin(req, res))) return;

      const body = req.body || {};
      const eventId = str(body.eventId, 100);
      const ticketId = str(body.ticketId, 100).toUpperCase();
      // Form-encoded or hand-built clients send "true"; it must still mean undo.
      const checkedIn = !(body.undo === true || body.undo === 'true');
      const method = body.method === 'manual' ? 'manual' : 'scan';

      if (!eventId) {
        return res.status(400).json({ success: false, code: 'invalid', error: 'Event ID is required.' });
      }
      if (!TICKET_ID_PATTERN.test(ticketId)) {
        return res.status(400).json({ success: false, code: 'invalid', error: 'That is not a BCCI ticket code.' });
      }

      const adminEmail = await getAdminSession(req);
      const result = await setAttendeeCheckIn(eventId, ticketId, { checkedIn, by: adminEmail || 'admin', method });
      if (!result.success) {
        // Tickets embed their event's ID, so a pass for another event can be
        // named as such rather than reported as an unknown code.
        const otherEvent = result.code === 'not_found' && !ticketId.startsWith(`TKT-${eventId.replace(/^EVT-/, '')}-`);
        const code = otherEvent ? 'wrong_event' : result.code;
        const status = { invalid: 400, not_found: 404, wrong_event: 404, payment_pending: 409, busy: 503 }[code] || 400;
        return res.status(status).json({
          success: false,
          code,
          error: otherEvent ? 'This ticket belongs to a different event.' : result.error,
          attendee: result.attendee ? attendeeDeskView(result.attendee) : undefined,
        });
      }

      console.log(`[BCCI Event] ${checkedIn ? 'Checked in' : 'Cleared check-in for'} ticket ${ticketId} on event ${eventId} (${method}, already: ${!!result.alreadyCheckedIn})`);
      return res.status(200).json({
        success: true,
        checkedIn,
        alreadyCheckedIn: !!result.alreadyCheckedIn,
        attendee: attendeeDeskView(result.attendee),
      });
    }

    // ── 2c. Remove an attendee (Admin Only) ──────────────────────────
    // Clears fake or duplicate registrations and frees their seats.
    if (action === 'remove-attendee') {
      if (!(await requireAdmin(req, res))) return;

      const body = req.body || {};
      const eventId = str(body.eventId || req.query?.eventId, 100);
      // Ticket IDs are issued in upper case; accept a hand-typed lower-case one.
      const ticketId = str(body.ticketId || req.query?.ticketId, 100).toUpperCase();
      if (!eventId || !ticketId) {
        return res.status(400).json({ success: false, error: 'Event ID and Ticket ID are required.' });
      }

      const result = await removeEventAttendee(eventId, ticketId);
      if (!result.success) {
        const notFound = /not found/i.test(result.error || '');
        return res.status(notFound ? 404 : 409).json({ success: false, error: result.error });
      }
      console.log(`[BCCI Event] Removed ticket ${ticketId} from event ${eventId}`);
      return res.status(200).json({
        success: true,
        message: 'Attendee removed and their seat released.',
        event: result.event,
        ticketId,
      });
    }

    // ── 2b. Secretariat Payment Confirmation (Admin Only) ─────────────
    if (action === 'confirm-payment') {
      if (!(await requireAdmin(req, res))) return;

      const body = req.body || {};
      const eventId = str(body.eventId || req.query?.eventId, 100);
      // Ticket IDs are issued in upper case; accept a hand-typed lower-case one.
      const ticketId = str(body.ticketId || req.query?.ticketId, 100).toUpperCase();
      const adminEmail = await getAdminSession(req);

      if (!eventId || !ticketId) {
        return res.status(400).json({ success: false, error: 'Event ID and Ticket ID are required.' });
      }

      const result = await confirmEventPayment(eventId, ticketId, adminEmail || 'admin');
      if (!result.success) {
        // Same mapping as check-in: a deleted event or an unknown ticket is a
        // 404, a lock held by another writer is a 503 — only a genuinely bad
        // request is a 400.
        const message = result.error || 'Failed to confirm attendee payment.';
        const code = /not found/i.test(message) ? 'not_found' : /busy/i.test(message) ? 'busy' : 'invalid';
        const status = { not_found: 404, busy: 503, invalid: 400 }[code];
        return res.status(status).json({ success: false, code, error: message });
      }

      // Dispatch the confirmed official E-Ticket with real venue / meeting credentials only if not already confirmed
      const mail = await deliverEmailIntent(result.attendee.ticketEmailId);
      const emailSent = mail ? mail.success : null;

      console.log(`[BCCI Event] Payment confirmed for ticket ${ticketId} (${result.attendee.email}) on event ${eventId} (alreadyConfirmed: ${!!result.alreadyConfirmed})`);
      return res.status(200).json({
        success: true,
        message: result.alreadyConfirmed
          ? 'Attendee payment is already verified.'
          : emailSent
            ? 'Attendee payment verified and official E-Ticket issued.'
            : 'Attendee payment verified, but we could not confirm the E-Ticket email was sent. Please share the ticket with the attendee manually.',
        emailSent,
        event: result.event,
        attendee: result.attendee,
        alreadyConfirmed: !!result.alreadyConfirmed,
      });
    }

    // ── 2c. Broadcast New Event (Admin Only) ──────────────────────────
    if (!(await requireAdmin(req, res))) return;

    const body = req.body || {};
    const title = str(body.title || body.name, 200);
    const date = str(body.date, 30);
    const time = str(body.time, 60);
    const mode = str(body.mode, 20).toLowerCase() === 'online' ? 'online' : 'offline';
    const venue = str(body.venue, 300);
    const pricingType = str(body.pricingType, 20).toLowerCase() === 'paid' ? 'paid' : 'free';
    const fee = pricingType === 'paid' ? Math.max(0, Number(body.fee) || 0) : 0;
    const capacityRaw = str(body.capacity, 10);
    const capacity = capacityRaw ? Number(capacityRaw) : 100;
    const description = str(body.description, 4000);

    if (title.length < 3) {
      return res.status(400).json({ success: false, error: 'Event title must be at least 3 characters.' });
    }
    if (!date) {
      return res.status(400).json({ success: false, error: 'Event date is required.' });
    }
    // Stored as YYYY-MM-DD only, so events sort correctly on this string.
    const [ey, em, ed] = date.split('-').map(Number);
    const parsedDate = new Date(Date.UTC(ey, em - 1, ed));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parsedDate.getUTCFullYear() !== ey || parsedDate.getUTCMonth() !== em - 1 || parsedDate.getUTCDate() !== ed) {
      return res.status(400).json({ success: false, error: 'Event date must be a valid date (YYYY-MM-DD).' });
    }
    if (!time) {
      return res.status(400).json({ success: false, error: 'Event time is required.' });
    }
    if (venue.length < 3) {
      return res.status(400).json({ success: false, error: 'Event venue or meeting link is required.' });
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      return res.status(400).json({ success: false, error: 'Capacity must be a whole number of seats (at least 1).' });
    }
    if (pricingType === 'paid' && fee <= 0) {
      return res.status(400).json({ success: false, error: 'Please specify a valid ticket fee for paid events.' });
    }

    const event = {
      id: newEventId(),
      title,
      date,
      time,
      mode,
      venue,
      pricingType,
      fee,
      capacity,
      registeredCount: 0,
      description,
      status: 'published',
      createdAt: new Date().toISOString(),
    };

    await putEvent(event);
    console.log(`[BCCI Event] Broadcasted new event: ${event.id} - ${event.title}`);

    return res.status(201).json({
      success: true,
      message: 'Event broadcasted successfully to BCCI website.',
      event,
    });
  }

  // ── 3. DELETE — Remove / Cancel event (Admin Only) ────────────────
  if (req.method === 'DELETE') {
    if (!(await requireAdmin(req, res))) return;

    const eventId = str(req.query?.id || req.body?.id, 100);
    if (!eventId) {
      return res.status(400).json({ success: false, error: 'Event ID is required to delete.' });
    }
    // deleteEvent is a blind DEL, so a second delete would otherwise report
    // success for an event that is already gone.
    if (!(await getEvent(eventId))) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }

    await deleteEvent(eventId);
    console.log(`[BCCI Event] Deleted event: ${eventId}`);
    return res.status(200).json({ success: true, message: 'Event deleted successfully.' });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('Events', handler);
