// js/checkin.js
// Venue check-in desk for the secretariat: scans ticket QR codes with the
// phone camera, falls back to typed codes and name search, and keeps scans
// made while the venue network is down so none are lost.
//
// Every value from the server is written with textContent, never innerHTML:
// attendee names are typed in by the public.

import { el, timeLabel as timeOf } from './dom.js?v=1.0.1';
import { QrScanner } from './qr-scanner.js?v=1.0.0';

const QUEUE_KEY = 'bcci:checkin-queue';
const RESCAN_COOLDOWN_MS = 3000;
const SYNC_INTERVAL_MS = 15000;
const MAX_LIST_ROWS = 60;
const TICKET_IN_TEXT = /TKT-[A-Z0-9-]{6,80}/i;

/** The ticket code inside whatever a QR held (a bare code or a /pass link). */
function extractTicketId(text) {
  const match = String(text || '').match(TICKET_IN_TEXT);
  return match ? match[0].toUpperCase() : null;
}

const isPending = (a) => a.status === 'pending' || a.paymentStatus === 'pending_verification';

function readQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

export class CheckInDesk {
  /**
   * @param {{ root: HTMLElement, store: { checkInAttendee: Function }, event: object, attendees: object[] }} opts
   */
  constructor({ root, store, event, attendees }) {
    this.root = root;
    this.store = store;
    this.event = event;
    this.attendees = new Map(attendees.map((a) => [a.ticketId, { ...a }]));
    this.scanner = null;
    this.syncTimer = null;
    this.busy = false;
    this.syncing = false;
    this.onOnline = () => this.flushQueue();
  }

  mount() {
    const ui = {};
    ui.count = el('strong', { className: 'checkin-count' });
    ui.pending = el('span', { className: 'checkin-sync', hidden: true });
    ui.video = el('video', { className: 'checkin-video', playsinline: true, muted: true, 'aria-label': 'Camera view for scanning ticket QR codes' });
    ui.video.muted = true;
    ui.cameraBtn = el('button', { type: 'button', className: 'btn-primary checkin-camera-btn', text: 'Start camera' });
    ui.result = el('div', { className: 'checkin-result', role: 'status', 'aria-live': 'assertive', text: 'Scan a ticket QR, or search below.' });
    ui.search = el('input', {
      type: 'search',
      className: 'form-control',
      id: 'checkinSearch',
      placeholder: 'Ticket code, name, company or phone',
      autocomplete: 'off',
      'aria-label': 'Find an attendee by ticket code, name, company or phone',
    });
    ui.list = el('ul', { className: 'checkin-list', 'aria-label': 'Attendees' });
    ui.exportBtn = el('button', { type: 'button', className: 'btn-secondary', text: 'Export attendance CSV' });
    ui.closeBtn = el('button', { type: 'button', className: 'btn-secondary', id: 'modalCloseBtn', text: 'Close' });

    this.root.replaceChildren(
      el('div', { className: 'checkin-desk' },
        el('div', { className: 'checkin-summary' }, ui.count, ui.pending),
        el('div', { className: 'checkin-scanner' }, ui.video, ui.cameraBtn),
        ui.result,
        el('label', { for: 'checkinSearch', className: 'form-label', text: 'Find attendee' }),
        ui.search,
        ui.list,
        el('div', { className: 'checkin-footer' }, ui.exportBtn, ui.closeBtn),
      ),
    );
    this.ui = ui;

    this.scanner = new QrScanner({ video: ui.video, onText: (text) => this.onDecoded(text), repeatMs: RESCAN_COOLDOWN_MS });
    ui.cameraBtn.addEventListener('click', () => (this.scanner.running ? this.stopCamera() : this.startCamera()));
    ui.search.addEventListener('input', () => this.renderList());
    ui.search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = extractTicketId(ui.search.value);
      if (code) this.submit(code, 'manual');
    });
    ui.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ticket]');
      if (!btn) return;
      this.submit(btn.dataset.ticket, 'manual', { undo: btn.dataset.undo === '1' });
    });
    ui.exportBtn.addEventListener('click', () => this.exportCsv());

    window.addEventListener('online', this.onOnline);
    this.syncTimer = setInterval(() => this.flushQueue(), SYNC_INTERVAL_MS);

    this.renderSummary();
    this.renderList();
    this.flushQueue();
  }

  destroy() {
    this.stopCamera();
    clearInterval(this.syncTimer);
    this.syncTimer = null;
    window.removeEventListener('online', this.onOnline);
  }

  // ── Camera ──────────────────────────────────────────────────────

  async startCamera() {
    const { cameraBtn } = this.ui;
    cameraBtn.disabled = true;
    cameraBtn.textContent = 'Starting camera…';
    try {
      await this.scanner.start();
      cameraBtn.textContent = 'Stop camera';
      this.show('idle', 'Point the camera at a ticket QR code.');
    } catch (err) {
      this.stopCamera();
      this.show('error', `${err.message} Type the ticket code or search by name instead.`);
    } finally {
      cameraBtn.disabled = false;
    }
  }

  stopCamera() {
    this.scanner?.stop();
    if (this.ui) this.ui.cameraBtn.textContent = 'Start camera';
  }

  async onDecoded(text) {
    const code = extractTicketId(text);
    if (!code) {
      this.show('error', 'That QR code is not a BCCI event ticket.');
      return;
    }
    await this.submit(code, 'scan');
  }

  // ── Check-in ────────────────────────────────────────────────────

  async submit(ticketId, method, { undo = false } = {}) {
    if (this.busy) return;
    this.busy = true;
    let result;
    try {
      // Only the network call sits in the try. Merge, render and vibrate run
      // once the scan is known to have succeeded, so a slip in them can never
      // send an accepted check-in down the failure path and queue it as lost.
      result = await this.store.checkInAttendee(this.event.id, ticketId, { method, undo });
    } catch (err) {
      this.busy = false;
      try {
        this.handleFailure(err, ticketId, method, undo);
      } finally {
        this.renderSummary();
        this.renderList();
      }
      return;
    }
    this.busy = false;
    this.merge(result.attendee);
    const who = this.describe(result.attendee);
    if (undo) this.show('idle', `Check-in cleared for ${who}.`);
    else if (result.alreadyCheckedIn) this.show('warn', `Already checked in at ${timeOf(result.attendee.checkedInAt)} — ${who}`);
    else {
      this.show('ok', `Checked in: ${who}`);
      navigator.vibrate?.(120);
    }
    this.renderSummary();
    this.renderList();
  }

  handleFailure(err, ticketId, method, undo) {
    if (!err?.status) {
      // The server was never reached. Check-in is idempotent, so replaying
      // the scan later is always safe.
      if (undo) {
        this.show('error', 'No connection. Clearing a check-in needs the network — try again shortly.');
        return;
      }
      const queue = readQueue();
      if (!queue.some((q) => q.eventId === this.event.id && q.ticketId === ticketId)) {
        queue.push({ eventId: this.event.id, ticketId, method, at: new Date().toISOString() });
      }
      const saved = writeQueue(queue);
      const known = this.attendees.get(ticketId);
      if (known && saved) this.attendees.set(ticketId, { ...known, queued: true });
      this.show('warn', saved
        ? `No connection — ${known ? this.describe(known) : ticketId} saved and will sync automatically.`
        : 'No connection, and this browser cannot store scans offline. Note the ticket code and retry.');
      return;
    }

    const data = err.data || {};
    if (data.attendee) this.merge(data.attendee);
    const who = data.attendee ? this.describe(data.attendee) : ticketId;
    if (err.status === 401) this.show('error', 'Your admin session has expired. Sign in again to keep checking people in.');
    else if (data.code === 'payment_pending') this.show('error', `Payment not verified — ${who}. Send them to the payment desk.`);
    else if (data.code === 'wrong_event') this.show('error', `This ticket is for a different event (${ticketId}).`);
    else if (data.code === 'not_found') this.show('error', `No registration found for ${ticketId}.`);
    else this.show('error', err.message || 'Check-in failed.');
  }

  async flushQueue() {
    if (this.syncing) return;
    const queue = readQueue();
    if (!queue.length) {
      this.renderSummary();
      return;
    }
    this.syncing = true;
    const remaining = [];
    const problems = [];
    let synced = 0;
    let offline = false;
    for (const item of queue) {
      if (offline) {
        remaining.push(item);
        continue;
      }
      try {
        const result = await this.store.checkInAttendee(item.eventId, item.ticketId, { method: item.method });
        if (item.eventId === this.event.id) this.merge(result.attendee);
        synced++;
      } catch (err) {
        const status = Number(err?.status) || 0;
        // A definitive client error (400, 403, 404, 409, 422 …) is the only
        // thing the server will never take: everything else — a dead network,
        // an expired session, a timeout, a rate limit, any 5xx — can still
        // succeed later, so the scan is kept.
        const definitive = status >= 400 && status < 500
          && status !== 401 && status !== 408 && status !== 429;
        if (!definitive) {
          remaining.push(item);
          // A dead connection or a dead session stops the batch; one 5xx must
          // not strand every scan queued behind it.
          if (!status || status === 401) offline = true;
          continue;
        }
        problems.push(`${err.data?.attendee?.name || item.ticketId}: ${err.message}`);
        const known = this.attendees.get(item.ticketId);
        if (known) this.attendees.set(item.ticketId, { ...known, queued: false });
      }
    }
    // Scans queued while this flush was awaiting the network are in storage
    // but not in the snapshot; writing back only `remaining` would drop them.
    const queueKey = (q) => `${q.eventId}|${q.ticketId}`;
    const flushed = new Set(queue.map(queueKey));
    writeQueue([...remaining, ...readQueue().filter((q) => !flushed.has(queueKey(q)))]);
    this.syncing = false;
    if (problems.length) this.show('error', `Offline scans that could not be checked in — ${problems.join('; ')}`);
    else if (synced) this.show('ok', `Synced ${synced} offline scan${synced === 1 ? '' : 's'}.`);
    this.renderSummary();
    this.renderList();
  }

  // ── Rendering ───────────────────────────────────────────────────

  merge(attendee) {
    if (!attendee?.ticketId) return;
    const prev = this.attendees.get(attendee.ticketId) || {};
    this.attendees.set(attendee.ticketId, { ...prev, ...attendee, queued: false });
  }

  describe(a) {
    return [a.name, a.company].filter(Boolean).join(' — ') || a.ticketId;
  }

  show(kind, message) {
    this.ui.result.className = `checkin-result checkin-result--${kind}`;
    this.ui.result.textContent = message;
  }

  renderSummary() {
    const all = [...this.attendees.values()];
    const admissible = all.filter((a) => !isPending(a)).length;
    const present = all.filter((a) => a.checkedInAt).length;
    this.ui.count.textContent = `Checked in ${present} of ${admissible}${admissible !== all.length ? ` (${all.length - admissible} awaiting payment)` : ''}`;
    const waiting = readQueue().filter((q) => q.eventId === this.event.id).length;
    this.ui.pending.hidden = waiting === 0;
    this.ui.pending.textContent = waiting ? `${waiting} offline scan${waiting === 1 ? '' : 's'} waiting to sync` : '';
  }

  renderList() {
    const q = this.ui.search.value.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matches = [...this.attendees.values()]
      .filter((a) => !q
        || [a.name, a.company, a.email, a.ticketId].some((f) => String(f || '').toLowerCase().includes(q))
        || (digits.length >= 4 && String(a.phone || '').includes(digits)))
      .sort((a, b) => Number(Boolean(a.checkedInAt)) - Number(Boolean(b.checkedInAt)) || String(a.name).localeCompare(String(b.name)));

    const rows = matches.slice(0, MAX_LIST_ROWS).map((a) => {
      let status;
      let action;
      if (a.checkedInAt) {
        status = el('span', { className: 'checkin-badge checkin-badge--in', text: `In at ${timeOf(a.checkedInAt)}` });
        action = el('button', { type: 'button', className: 'btn-secondary checkin-row-btn', 'data-ticket': a.ticketId, 'data-undo': '1', text: 'Undo', 'aria-label': `Undo check-in for ${a.name}` });
      } else if (a.queued) {
        status = el('span', { className: 'checkin-badge checkin-badge--queued', text: 'Waiting to sync' });
      } else if (isPending(a)) {
        status = el('span', { className: 'checkin-badge checkin-badge--pending', text: 'Payment pending' });
      } else {
        action = el('button', { type: 'button', className: 'btn-primary checkin-row-btn', 'data-ticket': a.ticketId, text: 'Check in', 'aria-label': `Check in ${a.name}` });
      }
      return el('li', { className: 'checkin-row' },
        el('div', { className: 'checkin-row-who' },
          el('strong', { text: a.name || '—' }),
          el('small', { text: [a.company, a.ticketId].filter(Boolean).join(' · ') }),
        ),
        status,
        action,
      );
    });

    if (!rows.length) rows.push(el('li', { className: 'checkin-empty', text: q ? 'No attendee matches that search.' : 'No one has registered for this event yet.' }));
    else if (matches.length > MAX_LIST_ROWS) rows.push(el('li', { className: 'checkin-empty', text: `${matches.length - MAX_LIST_ROWS} more — narrow the search.` }));
    this.ui.list.replaceChildren(...rows);
  }

  exportCsv() {
    // Scans that never reached the server would otherwise be exported as
    // absentees, which is the one thing a register must not get wrong.
    const waiting = readQueue().filter((q) => q.eventId === this.event.id);
    if (waiting.length) {
      const many = waiting.length !== 1;
      const question = `${waiting.length} offline scan${many ? 's' : ''} for this event ${many ? 'have' : 'has'} not synced yet. `
        + `The CSV will mark ${many ? 'them' : 'it'} "Queued (unsynced)" instead of absent. Export anyway?`;
      if (typeof window.confirm === 'function' && !window.confirm(question)) {
        this.show('warn', `${waiting.length} offline scan${many ? 's are' : ' is'} still waiting to sync — the export was cancelled.`);
        return;
      }
    }
    // A cell starting with =, +, - or @ runs as a formula in Excel and Sheets;
    // names here are typed by the public, so prefix them.
    const cell = (value) => {
      const s = String(value ?? '');
      const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${guarded.replace(/"/g, '""')}"`;
    };
    // attendeeDeskView may or may not carry the desk user yet, and it could be
    // an object on the day it does; never print "[object Object]" in a cell.
    const deskUser = (a) => (typeof a.checkedInBy === 'string'
      ? a.checkedInBy
      : a.checkedInBy?.email || a.checkedInBy?.name || '');
    const headers = ['Ticket ID', 'Name', 'Company', 'Email', 'Phone', 'Payment', 'Attended', 'Checked In At', 'Method', 'Checked In By'];
    const rows = [...this.attendees.values()].map((a) => [
      a.ticketId, a.name, a.company, a.email, a.phone,
      isPending(a) ? 'Pending' : 'Confirmed',
      a.checkedInAt ? 'Yes' : a.queued ? 'Queued (unsynced)' : 'No',
      a.checkedInAt ? new Date(a.checkedInAt).toLocaleString('en-IN') : '',
      a.checkInMethod || '', deskUser(a),
    ].map(cell).join(','));
    const csv = '﻿' + [headers.map(cell).join(','), ...rows].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = el('a', { href: url, download: `BCCI_Attendance_${this.event.id}_${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
