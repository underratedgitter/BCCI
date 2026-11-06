// js/board-portal.js
// The board member's side of meeting attendance, at /board.
//
// No sign-in needed to mark attendance: scanning the attendance QR (the
// printed sticker or the projector) with the phone's camera opens
// /board?attend=live; the member enters the meeting PIN shown in the room,
// then taps their name. Each phone gets one response per meeting.
//
// Signing in (email → 6-digit code) is optional: a signed-in member's scan
// marks them straight away, and they can see their attendance history.

import { el, dayLabel, timeLabel } from './dom.js?v=1.0.2';
import { QrScanner } from './qr-scanner.js?v=1.0.1';

const ATTEND_IN_TEXT = /[?&]attend=live(?![A-Za-z0-9_-])/;
const PIN_IN_TEXT = /[?&]pin=(\d{4})(?!\d)/;

/**
 * The attendance QR's URL (/board?attend=live), or null. Older projector
 * links may still carry the PIN (&pin=1234); new ones do not.
 */
export function parseAttendQr(text) {
  const value = String(text || '');
  if (!ATTEND_IN_TEXT.test(value)) return null;
  return { pin: PIN_IN_TEXT.exec(value)?.[1] || '' };
}

/** Server answers that mean "ask for the PIN (again)". */
const PIN_RETRY = new Set(['pin_required', 'pin_wrong']);

const DEVICE_KEY = 'bcci_board_device';

/**
 * A random id for this browser, kept in localStorage, so the server can allow
 * one response per phone per meeting. Null when storage is unavailable.
 */
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9-]{20,64}$/.test(id)) {
      // getRandomValues works on older phones that lack crypto.randomUUID.
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const STATUS_CHIP = {
  present: ['board-chip board-chip--present', 'Present'],
  leave: ['board-chip board-chip--leave', 'Leave'],
  absent: ['board-chip board-chip--absent', 'Absent'],
};

export class BoardPortal {
  /** @param {{ root: HTMLElement, store: object }} opts */
  constructor({ root, store }) {
    this.root = root;
    this.store = store;
    this.scanner = null;
    this.pendingAttend = null;
    this.email = '';
    this.busy = false;
  }

  /** @param {{ attend?: { pin: string } | null }} opts */
  async mount({ attend = null } = {}) {
    this.pendingAttend = attend;
    if (this.store.getBoardSession()) await this.showSignedIn();
    else if (attend) await this.showNameList(attend.pin);
    else this.showSignIn();
  }

  destroy() {
    this.scanner?.stop();
    this.scanner = null;
  }

  // ── Mark by name (no sign-in) ──────────────────────────────────

  /**
   * After a scan: the meeting PIN (unless the QR carried it), then the
   * board's names, and one tap to mark yours present.
   */
  async showNameList(pin = '', notice = '') {
    this.destroy();
    const card = el('div', { className: 'board-card board-names' },
      el('h2', { className: 'board-title', text: 'Mark your attendance' }));
    this.root.replaceChildren(card);

    const device = deviceId();
    if (!device) {
      card.append(el('p', { className: 'board-result board-result--error', text: 'This browser is blocking site storage (private mode?). Open the link in your normal browser, or sign in instead.' }), this.signInLink());
      return;
    }
    if (!pin) {
      card.append(this.pinForm((value) => this.showNameList(value), notice), this.signInLink());
      card.querySelector('input')?.focus();
      return;
    }
    card.append(el('p', { className: 'board-lead', text: 'Loading the meeting…' }));

    let data;
    try {
      data = await this.store.apiCall('/api/board?action=names', { method: 'POST', body: { deviceId: device, pin } });
    } catch (err) {
      const reason = err.data?.code;
      if (PIN_RETRY.has(reason)) {
        await this.showNameList('', err.message);
        return;
      }
      const text = reason === 'not_open' ? 'Attendance is not open right now. Wait for the secretary to open the meeting, then scan again.' : (err.message || 'The meeting could not be loaded.');
      card.replaceChildren(card.firstChild, el('p', { className: 'board-result board-result--error', role: 'alert', text }), this.signInLink());
      return;
    }
    this.renderNameList(card, data, device);
  }

  /**
   * The meeting PIN field. The PIN is shown only in the meeting room, so it
   * is what proves this phone is there; the QR itself never changes.
   */
  pinForm(onPin, notice = '') {
    const message = el('p', { className: 'board-message', role: 'status', 'aria-live': 'polite' });
    const input = el('input', { type: 'text', id: 'boardPin', className: 'form-control board-code-input', autocomplete: 'off', inputmode: 'numeric', maxlength: '4', pattern: '\\d{4}', required: true, placeholder: '••••' });
    const submit = el('button', { type: 'submit', className: 'btn-primary board-wide-btn', text: 'Continue' });
    const form = el('form', { className: 'board-form board-pin-form', novalidate: true },
      el('p', { className: 'board-lead', text: 'Enter the 4-digit meeting PIN shown in the meeting room (on the projector, or ask the secretary).' }),
      el('label', { for: 'boardPin', className: 'form-label', text: 'Meeting PIN' }), input, submit, message);
    if (notice) this.say(message, 'error', notice);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.replace(/\s/g, '');
      if (!/^\d{4}$/.test(value)) {
        this.say(message, 'error', 'The meeting PIN is 4 digits.');
        input.focus();
        return;
      }
      submit.disabled = true;
      onPin(value);
    });
    return form;
  }

  /**
   * The list from one scan. Going back to it reuses `data`: the pass lasts
   * five minutes even if attendance closes or reopens meanwhile.
   */
  renderNameList(card, data, device, notice = '') {
    const message = el('p', { className: 'board-message', role: 'status', 'aria-live': 'polite' });
    const when = [dayLabel(data.meeting.date), data.meeting.time].filter(Boolean).join(' · ');
    const heading = el('p', { className: 'board-lead' }, el('strong', { text: data.meeting.title }), when ? ` — ${when}` : '');
    if (data.markedByThisPhone) {
      card.replaceChildren(card.firstChild, heading,
        el('p', { className: 'board-result board-result--ok', role: 'status', text: `This phone has already marked ${data.markedByThisPhone} present. Each phone can mark one name.` }));
      return;
    }

    const list = el('ul', { className: 'board-name-list', 'aria-label': 'Board members' });
    for (const m of data.members) {
      const btn = el('button', { type: 'button', className: 'board-name-btn', disabled: m.marked, 'aria-label': m.marked ? `${m.name}, already marked` : `Mark ${m.name} present` },
        el('span', { text: m.name }), m.marked ? el('span', { className: 'board-chip board-chip--present', text: 'Marked' }) : null);
      btn.addEventListener('click', () => this.confirmName(card, heading, data, m, device, message));
      list.append(el('li', {}, btn));
    }
    card.replaceChildren(card.firstChild, heading,
      el('p', { className: 'board-lead', text: 'Tap your name. This phone can mark only one name, once.' }),
      list, message, this.signInLink());
    if (notice) this.say(message, 'error', notice);
  }

  confirmName(card, heading, data, member, device, message) {
    const yes = el('button', { type: 'button', className: 'btn-primary board-wide-btn', text: `Yes, I am ${member.name}` });
    const back = el('button', { type: 'button', className: 'board-link-btn', text: 'Back to the list' });
    const panel = el('div', { className: 'board-form' },
      el('p', { className: 'board-lead', text: `Mark ${member.name} present? This cannot be changed from this phone.` }), yes, back, message);
    card.replaceChildren(card.firstChild, heading, panel);
    yes.focus();
    back.addEventListener('click', () => this.renderNameList(card, data, device));
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      yes.textContent = 'Marking…';
      try {
        const result = await this.store.apiCall('/api/board?action=mark-name', { method: 'POST', body: { pass: data.pass, memberId: member.id, deviceId: device } });
        navigator.vibrate?.(150);
        card.replaceChildren(card.firstChild, heading,
          el('p', { className: 'board-result board-result--ok', role: 'status', text: `${result.member.name} is marked present at ${timeLabel(result.at)}. Thank you.` }));
      } catch (err) {
        const reason = err.data?.code;
        if (reason === 'already_marked') {
          // Someone has that name already; this phone can still pick its own.
          member.marked = true;
          this.renderNameList(card, data, device, err.message);
          return;
        }
        card.replaceChildren(card.firstChild, heading,
          el('p', { className: 'board-result board-result--error', role: 'alert', text: reason === 'expired' ? 'This page has expired. Scan the attendance QR again.' : err.message }));
      }
    });
  }

  signInLink() {
    const link = el('button', { type: 'button', className: 'board-link-btn', text: 'Board member with an account? Sign in instead' });
    link.addEventListener('click', () => this.showSignIn());
    return link;
  }

  // ── Signed out ─────────────────────────────────────────────────

  showSignIn(step = 'email') {
    this.destroy();
    const message = el('p', { className: 'board-message', role: 'status', 'aria-live': 'polite' });
    const card = el('div', { className: 'board-card board-signin' },
      el('h2', { className: 'board-title', text: 'BCCI Board Portal' }),
      el('p', { className: 'board-lead', text: this.pendingAttend
        ? 'Sign in to mark your attendance for this meeting.'
        : 'To mark attendance, scan the attendance QR with your phone camera; no sign-in needed. Sign in here to see your attendance history.' }),
    );

    if (step === 'email') {
      const input = el('input', { type: 'email', id: 'boardEmail', className: 'form-control', autocomplete: 'email', inputmode: 'email', required: true, value: this.email, placeholder: 'you@example.com' });
      const button = el('button', { type: 'submit', className: 'btn-primary board-wide-btn', text: 'Send sign-in code' });
      const form = el('form', { className: 'board-form', novalidate: true },
        el('label', { for: 'boardEmail', className: 'form-label', text: 'Email address' }), input, button);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          this.say(message, 'error', 'Enter a valid email address.');
          input.focus();
          return;
        }
        button.disabled = true;
        button.textContent = 'Sending…';
        try {
          await this.store.apiCall('/api/board?action=request-code', { method: 'POST', body: { email } });
          this.email = email;
          this.showSignIn('code');
        } catch (err) {
          this.say(message, 'error', err.message);
          button.disabled = false;
          button.textContent = 'Send sign-in code';
        }
      });
      card.append(form, message);
      this.root.replaceChildren(card);
      input.focus();
      return;
    }

    const codeInput = el('input', { type: 'text', id: 'boardCode', className: 'form-control board-code-input', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6', pattern: '\\d{6}', required: true, placeholder: '123456' });
    const button = el('button', { type: 'submit', className: 'btn-primary board-wide-btn', text: 'Sign in' });
    const back = el('button', { type: 'button', className: 'board-link-btn', text: 'Use a different email' });
    const form = el('form', { className: 'board-form', novalidate: true },
      el('p', { className: 'board-lead', text: `If ${this.email} belongs to a board member, a 6-digit code is on its way. It expires in 10 minutes.` }),
      el('label', { for: 'boardCode', className: 'form-label', text: 'Sign-in code' }), codeInput, button, back);
    back.addEventListener('click', () => this.showSignIn('email'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeInput.value.replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) {
        this.say(message, 'error', 'Enter the 6-digit code from the email.');
        codeInput.focus();
        return;
      }
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        const result = await this.store.apiCall('/api/board?action=verify-code', { method: 'POST', body: { email: this.email, code } });
        this.store.setBoardSession(result.session, result.member);
        await this.showSignedIn();
      } catch (err) {
        this.say(message, 'error', err.message);
        button.disabled = false;
        button.textContent = 'Sign in';
        codeInput.select();
      }
    });
    card.append(form, message);
    this.root.replaceChildren(card);
    codeInput.focus();
  }

  // ── Signed in ──────────────────────────────────────────────────

  async showSignedIn() {
    this.root.replaceChildren(el('div', { className: 'board-card', text: 'Loading your board profile…' }));
    let data;
    try {
      data = await this.store.apiCall('/api/board?action=me', { auth: 'board' });
    } catch (err) {
      if (err.status === 401) {
        this.showSignIn();
        return;
      }
      this.root.replaceChildren(el('div', { className: 'board-card' },
        el('p', { className: 'board-message board-message--error', text: err.message }),
        el('button', { type: 'button', className: 'btn-secondary', text: 'Try again', id: 'boardRetry' })));
      this.root.querySelector('#boardRetry').addEventListener('click', () => this.showSignedIn());
      return;
    }
    this.data = data;
    this.render();

    if (this.pendingAttend) {
      const pending = this.pendingAttend;
      this.pendingAttend = null;
      await this.attend(pending);
    }
  }

  render() {
    const { member, items, stats } = this.data;
    const initials = member.name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const signOut = el('button', { type: 'button', className: 'board-link-btn', text: 'Sign out' });
    signOut.addEventListener('click', async () => {
      await this.store.clearBoardSession();
      this.showSignIn();
    });

    const profile = el('div', { className: 'board-card board-profile' },
      el('div', { className: 'board-avatar', 'aria-hidden': 'true', text: initials || '•' }),
      el('div', { className: 'board-profile-text' },
        el('h2', { className: 'board-name', text: member.name }),
        el('div', { className: 'board-designation', text: member.designation }),
        member.company ? el('div', { className: 'board-meta', text: member.company }) : null,
        el('div', { className: 'board-meta', text: `${member.email} · ${member.mobile}` }),
      ),
      signOut,
    );

    // ── Scan ──
    this.resultBox = el('div', { className: 'board-result', role: 'status', 'aria-live': 'assertive', hidden: true });
    this.pinBox = el('div', { className: 'board-pin-box', hidden: true });
    this.video = el('video', { className: 'board-video', playsinline: true, muted: true, hidden: true, 'aria-label': 'Camera view for scanning the meeting QR code' });
    this.scanBtn = el('button', { type: 'button', className: 'btn-primary board-scan-btn' }, el('i', { className: 'fas fa-qrcode', 'aria-hidden': 'true' }), ' Scan meeting QR');
    this.cancelBtn = el('button', { type: 'button', className: 'btn-secondary', text: 'Cancel', hidden: true });
    this.scanBtn.addEventListener('click', () => this.startScan());
    this.cancelBtn.addEventListener('click', () => this.stopScan());

    const open = items.filter((i) => i.meeting.status === 'open');
    const openNote = open.map((i) => el('p', { className: i.status === 'present' ? 'board-open board-open--done' : 'board-open' },
      i.status === 'present'
        ? `${i.meeting.title}: you are marked present (${timeLabel(i.at)}).`
        : `Attendance is open for ${i.meeting.title}. Scan the attendance QR to be marked present.`));

    const scan = el('div', { className: 'board-card board-scan' },
      el('h3', { className: 'board-section-title', text: 'Mark your attendance' }),
      ...openNote,
      this.scanBtn,
      this.video,
      this.cancelBtn,
      this.pinBox,
      this.resultBox,
    );

    // ── History ──
    const held = stats.held;
    const statLine = held
      ? `Attended ${stats.attended} of ${held} meeting${held === 1 ? '' : 's'} (${Math.round(stats.rate * 100)}%)`
      : items.length
        ? 'Your totals update once the secretary closes a meeting.'
        : 'No meetings yet.';
    const list = el('ul', { className: 'board-history' });
    for (const item of items) {
      const m = item.meeting;
      let chip;
      if (m.status === 'scheduled') chip = el('span', { className: 'board-chip board-chip--upcoming', text: 'Upcoming' });
      else if (m.status === 'open' && item.status !== 'present') chip = el('span', { className: 'board-chip board-chip--open', text: 'Open now' });
      else {
        const [cls, label] = STATUS_CHIP[item.status] || STATUS_CHIP.absent;
        chip = el('span', { className: cls, text: label });
      }
      list.append(el('li', { className: 'board-history-row' },
        el('div', {},
          el('strong', { text: m.title }),
          el('small', { text: [dayLabel(m.date), m.time, m.venue].filter(Boolean).join(' · ') })),
        chip));
    }
    if (!items.length) list.append(el('li', { className: 'board-empty', text: 'No meetings yet.' }));

    const history = el('div', { className: 'board-card' },
      el('h3', { className: 'board-section-title', text: 'My attendance' }),
      el('p', { className: 'board-stat', text: statLine }),
      list);

    this.root.replaceChildren(profile, scan, history);
  }

  // ── Scanning ───────────────────────────────────────────────────

  async startScan() {
    this.showResult(null);
    this.scanBtn.disabled = true;
    this.video.hidden = false;
    this.cancelBtn.hidden = false;
    // render() replaces the video element, so a scanner bound to an older one is rebuilt.
    if (!this.scanner || this.scanner.video !== this.video) {
      this.scanner?.stop();
      this.scanner = new QrScanner({ video: this.video, onText: (text) => this.onScanned(text), repeatMs: 2500 });
    }
    this.scanner.reset();
    try {
      await this.scanner.start();
      this.showResult('idle', 'Point your camera at the attendance QR.');
    } catch (err) {
      this.stopScan();
      this.showResult('error', `${err.message} You can also scan the attendance QR with your phone's camera app.`);
    }
  }

  stopScan() {
    this.scanner?.stop();
    if (!this.video) return;
    this.video.hidden = true;
    this.cancelBtn.hidden = true;
    this.scanBtn.disabled = false;
  }

  async onScanned(text) {
    const target = parseAttendQr(text);
    if (!target) {
      this.showResult('error', 'That is not the BCCI attendance QR. Scan the QR on the sticker or the projector screen.');
      return;
    }
    await this.attend(target);
  }

  /** Asks for the meeting PIN in the scan card, then marks attendance with it. */
  askPin(notice = '') {
    if (!this.pinBox) return;
    this.pinBox.hidden = false;
    this.pinBox.replaceChildren(this.pinForm((pin) => {
      this.pinBox.hidden = true;
      this.pinBox.replaceChildren();
      this.attend({ pin });
    }, notice));
    this.pinBox.querySelector('input')?.focus();
  }

  async attend({ pin = '' } = {}) {
    if (this.busy) return;
    if (!pin) {
      // The sticker's QR has no PIN in it.
      this.stopScan();
      this.showResult(null);
      this.askPin();
      return;
    }
    this.busy = true;
    try {
      const result = await this.store.apiCall('/api/board?action=attend', {
        method: 'POST', body: { pin }, auth: 'board', retries: 1,
      });
      this.stopScan();
      const when = timeLabel(result.at);
      if (result.alreadyMarked) this.showResult('warn', `You were already marked present for ${result.meeting.title} at ${when}.`);
      else {
        this.showResult('ok', `You are marked present for ${result.meeting.title} at ${when}.`);
        navigator.vibrate?.(150);
      }
      await this.refreshData();
    } catch (err) {
      if (err.status === 401) {
        this.stopScan();
        this.pendingAttend = { pin };
        this.showSignIn();
        return;
      }
      this.stopScan();
      if (PIN_RETRY.has(err.data?.code)) {
        this.showResult(null);
        this.askPin(err.message);
        return;
      }
      this.showResult('error', err.message || 'Your attendance could not be recorded.');
    } finally {
      this.busy = false;
    }
  }

  async refreshData() {
    try {
      this.data = await this.store.apiCall('/api/board?action=me', { auth: 'board' });
      const result = this.resultBox;
      this.render();
      this.resultBox.replaceWith(result);
      this.resultBox = result;
    } catch (err) {
      if (err.status === 401) {
        // The session has ended (the store forgets it): a signed-in page would
        // only be stale from here, so ask them to sign in again instead.
        this.data = null;
        this.showSignIn();
        return;
      }
      console.warn('[BoardPortal] could not refresh history:', err.message);
    }
  }

  showResult(kind, text) {
    if (!this.resultBox) return;
    this.resultBox.hidden = !kind;
    this.resultBox.className = kind ? `board-result board-result--${kind}` : 'board-result';
    this.resultBox.textContent = text || '';
  }

  say(node, kind, text) {
    node.className = `board-message board-message--${kind}`;
    node.textContent = text;
  }
}
