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
} from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  isEmail,
  withErrorHandling,
} from './_lib/http.js';

function newEventId() {
  return `EVT-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;
}

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── 1. GET — List events (public) or single event ────────────────
  if (req.method === 'GET') {
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
        seatsLeft: Math.max(0, capacity - registered),
        isFull: capacity > 0 && registered >= capacity,
      };

      if (req.query?.includeAttendees === 'true') {
        const isAdmin = await requireAdmin(req, res);
        if (!isAdmin) return;
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
      const phone = str(body.phone, 20).replace(/\D/g, '');
      const company = str(body.company, 200) || 'Delegate / Independent';

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

      // Rate limit registrations by IP
      const ip = clientIp(req);
      const ipLimit = await rateLimit(`eventreg:ip:${ip}`, { max: 10, windowSec: 60 });
      if (!ipLimit.ok) {
        return tooManyRequests(res, ipLimit.retryAfter, 'Too many registration requests. Please wait a moment.');
      }

      const result = await registerForEvent(eventId, { name, email, phone, company });
      if (!result.success) {
        return res.status(409).json({ success: false, error: result.error || 'Registration could not be completed.' });
      }

      console.log(`[BCCI Event] Registered ${email} for event ${eventId}`);
      return res.status(200).json({
        success: true,
        message: 'Registration confirmed! We look forward to seeing you.',
        event: result.event,
        attendee: result.attendee,
      });
    }

    // ── 2b. Broadcast New Event (Admin Only) ──────────────────────────
    if (!(await requireAdmin(req, res))) return;

    const body = req.body || {};
    const title = str(body.title || body.name, 200);
    const date = str(body.date, 30);
    const time = str(body.time, 60);
    const mode = str(body.mode, 20).toLowerCase() === 'online' ? 'online' : 'offline';
    const venue = str(body.venue, 300);
    const pricingType = str(body.pricingType, 20).toLowerCase() === 'paid' ? 'paid' : 'free';
    const fee = pricingType === 'paid' ? Math.max(0, Number(body.fee) || 0) : 0;
    const capacity = Math.max(1, parseInt(body.capacity, 10) || 100);
    const description = str(body.description, 4000);

    if (title.length < 3) {
      return res.status(400).json({ success: false, error: 'Event title must be at least 3 characters.' });
    }
    if (!date) {
      return res.status(400).json({ success: false, error: 'Event date is required.' });
    }
    if (!time) {
      return res.status(400).json({ success: false, error: 'Event time is required.' });
    }
    if (venue.length < 3) {
      return res.status(400).json({ success: false, error: 'Event venue or meeting link is required.' });
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

    await deleteEvent(eventId);
    console.log(`[BCCI Event] Deleted event: ${eventId}`);
    return res.status(200).json({ success: true, message: 'Event deleted successfully.' });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('Events', handler);
