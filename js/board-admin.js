// js/board-admin.js
// The superadmin's "Board & Meetings" tab: board member profiles, meetings,
// each meeting's attendance (with overrides), the Excel register, and the
// full-screen projector view that shows the attendance QR and meeting PIN.
//
// Names and designations are typed by people, so everything is rendered
// through el() / textContent, never innerHTML.

import { el, dayLabel, timeLabel } from './dom.js?v=1.0.1';

const DESIGNATIONS = [
  'President', 'Vice President', 'Joint Vice President', 'Hon. Secretary', 'Joint Secretary',
  'Hon. Treasurer', 'Joint Treasurer', 'Immediate Past President', 'Executive Committee Member',
  'Director', 'Co-opted Member', 'Special Invitee',
];

const MEETING_CHIP = {
  scheduled: ['board-chip board-chip--upcoming', 'Scheduled'],
  open: ['board-chip board-chip--open', 'Taking attendance'],
  closed: ['board-chip board-chip--closed', 'Closed'],
};
const ATTEND_CHIP = {
  present: ['board-chip board-chip--present', 'Present'],
  leave: ['board-chip board-chip--leave', 'Leave'],
  absent: ['board-chip board-chip--absent', 'Absent'],
};

const chip = ([className, text]) => el('span', { className, text });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (text, className = 'btn-secondary', attrs = {}) => el('button', { type: 'button', className: `${className} board-btn`, text, ...attrs });

function field(id, label, input, hint) {
  return el('div', { className: 'form-group' },
    el('label', { className: 'form-label', for: id }, label, input.required ? el('span', { className: 'req', text: ' *' }) : null),
    input,
    hint ? el('small', { className: 'form-hint', text: hint }) : null);
}

export class BoardAdmin {
  /**
   * @param {{ root: HTMLElement, store: object, ui: { toast: Function, showModal: Function, closeModal: Function } }} opts
   */
  constructor({ root, store, ui }) {
    this.root = root;
    this.store = store;
    this.ui = ui;
    this.members = [];
    this.meetings = [];
    this.projector = null;
  }

  api(action, { method = 'GET', body, query = '' } = {}) {
    return this.store.apiCall(`/api/board?action=${action}${query}`, { method, body, auth: 'admin' });
  }

  async mount() {
    this.membersBox = el('div');
    this.meetingsBox = el('div');
    const download = button('Download attendance register (Excel)', 'btn-primary');
    download.prepend(el('i', { className: 'fas fa-file-excel', 'aria-hidden': 'true' }), ' ');
    download.addEventListener('click', () => this.downloadRegister(download));
    const sticker = button('Print attendance QR sticker', 'btn-primary');
    sticker.prepend(el('i', { className: 'fas fa-qrcode', 'aria-hidden': 'true' }), ' ');
    sticker.addEventListener('click', () => this.printQrSticker());

    this.root.replaceChildren(el('div', { className: 'board-admin' },
      el('div', { className: 'board-admin-head' },
        el('h3', { className: 'board-admin-title' }, el('i', { className: 'fas fa-user-tie', 'aria-hidden': 'true' }), ' Board & Meetings'),
        el('p', { className: 'board-admin-lead', text: 'Create a profile for each board member. At a meeting, open attendance: members scan the attendance QR — the printed sticker or the one on the projector — with their phone camera, enter the meeting PIN shown in the room, and tap their name. The projector QR carries the PIN, so only sticker scans type it. Each phone can mark one name.' })),
      el('div', { className: 'board-admin-forms' },
        el('section', { className: 'board-admin-card' },
          el('h4', { className: 'board-admin-card-title', text: 'Add a board member' }),
          this.memberForm(null, () => this.refresh())),
        el('section', { className: 'board-admin-card' },
          el('h4', { className: 'board-admin-card-title', text: 'Schedule a meeting' }),
          this.meetingForm(null, () => this.refresh()))),
      el('section', { className: 'board-admin-section' },
        el('div', { className: 'board-admin-section-head' },
          el('h4', { className: 'board-admin-card-title', text: 'Meetings' }),
          el('div', { className: 'board-actions' }, sticker, download)),
        this.meetingsBox),
      el('section', { className: 'board-admin-section' },
        el('h4', { className: 'board-admin-card-title', text: 'Board members' }),
        this.membersBox),
    ));
    await this.refresh();
  }

  async refresh() {
    try {
      const [m, mt] = await Promise.all([this.api('members'), this.api('meetings')]);
      this.members = m.members || [];
      this.meetings = mt.meetings || [];
    } catch (err) {
      this.ui.toast(err.message || 'Could not load the board.', 'error');
      return;
    }
    this.renderMembers();
    this.renderMeetings();
  }

  // ── Members ────────────────────────────────────────────────────

  memberForm(member, onSaved) {
    const uid = member ? `e${member.id}` : 'new';
    const inputs = {
      name: el('input', { type: 'text', id: `bm-name-${uid}`, className: 'form-control', required: true, minlength: '2', maxlength: '120', autocomplete: 'off', value: member?.name || '' }),
      designation: el('input', { type: 'text', id: `bm-desig-${uid}`, className: 'form-control', required: true, maxlength: '80', list: 'boardDesignations', autocomplete: 'off', value: member?.designation || '', placeholder: 'e.g. Hon. Treasurer' }),
      email: el('input', { type: 'email', id: `bm-email-${uid}`, className: 'form-control', required: true, maxlength: '254', autocomplete: 'off', value: member?.email || '' }),
      mobile: el('input', { type: 'tel', id: `bm-mobile-${uid}`, className: 'form-control', required: true, inputmode: 'numeric', maxlength: '14', autocomplete: 'off', value: member?.mobile || '', placeholder: '10-digit mobile' }),
      company: el('input', { type: 'text', id: `bm-company-${uid}`, className: 'form-control', maxlength: '200', autocomplete: 'off', value: member?.company || '' }),
    };
    if (!document.getElementById('boardDesignations')) {
      document.body.append(el('datalist', { id: 'boardDesignations' }, ...DESIGNATIONS.map((d) => el('option', { value: d }))));
    }
    const submit = el('button', { type: 'submit', className: 'btn-primary', text: member ? 'Save changes' : 'Create profile' });
    const form = el('form', { className: 'board-admin-form', novalidate: true },
      el('div', { className: 'form-grid' },
        field(inputs.name.id, 'Full name', inputs.name),
        field(inputs.designation.id, 'Designation', inputs.designation),
        field(inputs.email.id, 'Email', inputs.email, 'Used for the welcome email and the optional Board Portal sign-in.'),
        field(inputs.mobile.id, 'Mobile', inputs.mobile),
        field(inputs.company.id, 'Company / firm', inputs.company)),
      el('div', { className: 'board-admin-form-actions' }, submit));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
      if (member) body.id = member.id;
      submit.disabled = true;
      try {
        const result = await this.api('member-save', { method: 'POST', body });
        if (!member) {
          this.ui.toast(result.welcomeSent
            ? `Profile created. A welcome email went to ${result.member.email}.`
            : 'Profile created, but the welcome email could not be sent. Use "Resend welcome" later.', result.welcomeSent ? 'success' : 'warning');
          form.reset();
        } else {
          this.ui.toast('Profile updated.', 'success');
        }
        await onSaved(result.member);
      } catch (err) {
        this.ui.toast(err.message || 'The profile could not be saved.', 'error');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  renderMembers() {
    const active = this.members.filter((m) => m.status === 'active').length;
    if (!this.members.length) {
      this.membersBox.replaceChildren(el('p', { className: 'board-empty', text: 'No board members yet. Add the first profile above.' }));
      return;
    }
    const rows = this.members.map((m) => {
      const actions = el('div', { className: 'board-actions' });
      const edit = button('Edit');
      edit.addEventListener('click', () => this.openMemberEditor(m));
      actions.append(edit);
      if (m.status === 'active') {
        const welcome = button('Resend welcome');
        welcome.addEventListener('click', () => this.runAction(welcome, () => this.api('member-welcome', { method: 'POST', body: { id: m.id } }), `Welcome email sent to ${m.email}.`));
        const remove = button('Remove from board', 'btn-action-reject');
        remove.addEventListener('click', () => {
          if (!confirm(`Remove ${m.name} from the board? They are signed out and will not be counted at future meetings. Their past attendance stays in the register.`)) return;
          this.runAction(remove, () => this.api('member-status', { method: 'POST', body: { id: m.id, status: 'inactive' } }), `${m.name} removed from the board.`);
        });
        actions.append(welcome, remove);
      } else {
        const restore = button('Restore');
        restore.addEventListener('click', () => this.runAction(restore, () => this.api('member-status', { method: 'POST', body: { id: m.id, status: 'active' } }), `${m.name} is back on the board.`));
        actions.append(restore);
      }
      return el('tr', { className: m.status === 'active' ? '' : 'board-row-inactive' },
        el('td', {}, el('strong', { text: m.name }), m.company ? el('small', { className: 'board-cell-sub', text: m.company }) : null),
        el('td', { text: m.designation }),
        el('td', { text: m.email }),
        el('td', { text: m.mobile }),
        el('td', {}, chip(m.status === 'active' ? ['board-chip board-chip--present', 'Active'] : ['board-chip board-chip--closed', 'Removed'])),
        el('td', {}, actions));
    });
    this.membersBox.replaceChildren(
      el('p', { className: 'board-admin-count', text: `${active} active board member${active === 1 ? '' : 's'}` }),
      el('div', { className: 'table-responsive board-scroll' },
        el('table', { className: 'data-table board-table' },
          el('thead', {}, el('tr', {}, ...['Member', 'Designation', 'Email', 'Mobile', 'Status', 'Actions'].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...rows))));
  }

  openMemberEditor(member) {
    this.ui.showModal({ title: `Edit ${esc(member.name)}`, content: '<div id="boardModalRoot"></div>' });
    document.getElementById('boardModalRoot')?.append(this.memberForm(member, async () => {
      this.ui.closeModal();
      await this.refresh();
    }));
  }

  // ── Meetings ───────────────────────────────────────────────────

  meetingForm(meeting, onSaved) {
    const uid = meeting ? `e${meeting.id}` : 'new';
    const inputs = {
      title: el('input', { type: 'text', id: `mt-title-${uid}`, className: 'form-control', required: true, maxlength: '160', autocomplete: 'off', value: meeting?.title || '', placeholder: 'e.g. Board Meeting — September' }),
      date: el('input', { type: 'date', id: `mt-date-${uid}`, className: 'form-control', required: true, value: meeting?.date || '' }),
      time: el('input', { type: 'time', id: `mt-time-${uid}`, className: 'form-control', required: true, value: meeting?.time || '' }),
      venue: el('input', { type: 'text', id: `mt-venue-${uid}`, className: 'form-control', maxlength: '200', autocomplete: 'off', value: meeting?.venue || '', placeholder: 'e.g. BCCI Board Room' }),
    };
    const submit = el('button', { type: 'submit', className: 'btn-primary', text: meeting ? 'Save changes' : 'Schedule meeting' });
    const form = el('form', { className: 'board-admin-form', novalidate: true },
      el('div', { className: 'form-grid' },
        field(inputs.title.id, 'Meeting title', inputs.title),
        field(inputs.date.id, 'Date', inputs.date),
        field(inputs.time.id, 'Start time', inputs.time),
        field(inputs.venue.id, 'Venue', inputs.venue)),
      el('div', { className: 'board-admin-form-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
      if (meeting) body.id = meeting.id;
      submit.disabled = true;
      try {
        const result = await this.api('meeting-save', { method: 'POST', body });
        this.ui.toast(meeting ? 'Meeting updated.' : `Meeting scheduled for ${dayLabel(result.meeting.date)}.`, 'success');
        if (!meeting) form.reset();
        await onSaved(result.meeting);
      } catch (err) {
        this.ui.toast(err.message || 'The meeting could not be saved.', 'error');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  renderMeetings() {
    if (!this.meetings.length) {
      this.meetingsBox.replaceChildren(el('p', { className: 'board-empty', text: 'No meetings yet. Schedule one above.' }));
      return;
    }
    const rows = this.meetings.map((m) => {
      const actions = el('div', { className: 'board-actions' });
      if (m.status === 'scheduled') {
        const open = button('Open attendance & show QR', 'btn-primary');
        open.addEventListener('click', async () => {
          open.disabled = true;
          try {
            await this.api('meeting-open', { method: 'POST', body: { id: m.id } });
            await this.refresh();
            this.openProjector(m.id);
          } catch (err) {
            this.ui.toast(err.message, 'error');
            open.disabled = false;
          }
        });
        const edit = button('Edit');
        edit.addEventListener('click', () => {
          this.ui.showModal({ title: `Edit ${esc(m.title)}`, content: '<div id="boardModalRoot"></div>' });
          document.getElementById('boardModalRoot')?.append(this.meetingForm(m, async () => {
            this.ui.closeModal();
            await this.refresh();
          }));
        });
        const del = button('Delete', 'btn-action-reject');
        del.addEventListener('click', () => {
          if (!confirm(`Delete "${m.title}" on ${dayLabel(m.date)}? This cannot be undone.`)) return;
          this.runAction(del, () => this.api('meeting-delete', { method: 'POST', body: { id: m.id } }), 'Meeting deleted.');
        });
        actions.append(open, edit, del);
      } else if (m.status === 'open') {
        const show = button('Show QR on projector', 'btn-primary');
        show.addEventListener('click', () => this.openProjector(m.id));
        const view = button('Attendance');
        view.addEventListener('click', () => this.openAttendance(m.id));
        const close = button('Close attendance', 'btn-action-reject');
        close.addEventListener('click', () => {
          if (!confirm(`Close attendance for "${m.title}"? Members can no longer scan in. You can reopen it later.`)) return;
          this.runAction(close, () => this.api('meeting-close', { method: 'POST', body: { id: m.id } }), 'Attendance closed.');
        });
        actions.append(show, view, close);
      } else {
        const view = button('Attendance');
        view.addEventListener('click', () => this.openAttendance(m.id));
        const reopen = button('Reopen');
        reopen.addEventListener('click', () => {
          if (!confirm(`Reopen "${m.title}" for attendance? Its roster stays as it was when the meeting closed.`)) return;
          this.runAction(reopen, () => this.api('meeting-reopen', { method: 'POST', body: { id: m.id } }), 'Meeting reopened.');
        });
        actions.append(view, reopen);
      }
      return el('tr', {},
        el('td', {}, el('strong', { text: dayLabel(m.date) }), el('small', { className: 'board-cell-sub', text: m.time })),
        el('td', {}, el('strong', { text: m.title }), m.venue ? el('small', { className: 'board-cell-sub', text: m.venue }) : null),
        el('td', {}, chip(MEETING_CHIP[m.status] || MEETING_CHIP.scheduled),
          m.status === 'open' && m.pin ? el('small', { className: 'board-cell-sub', text: `PIN ${m.pin}` }) : null),
        el('td', { text: m.status === 'scheduled' ? '—' : `${m.presentCount} of ${m.rosterCount}` }),
        el('td', {}, actions));
    });
    this.meetingsBox.replaceChildren(el('div', { className: 'table-responsive board-scroll' },
      el('table', { className: 'data-table board-table' },
        el('thead', {}, el('tr', {}, ...['Date', 'Meeting', 'Status', 'Present', 'Actions'].map((h) => el('th', { text: h })))),
        el('tbody', {}, ...rows))));
  }

  // ── One meeting's attendance ───────────────────────────────────

  async openAttendance(meetingId) {
    let detail;
    try {
      detail = await this.api('meeting', { query: `&id=${encodeURIComponent(meetingId)}` });
    } catch (err) {
      this.ui.toast(err.message, 'error');
      return;
    }
    const { meeting, rows, counts } = detail;
    this.ui.showModal({ title: `Attendance: ${esc(meeting.title)}`, content: '<div id="boardModalRoot"></div>', wide: true });
    const root = document.getElementById('boardModalRoot');
    if (!root) return;

    const reload = async () => {
      this.ui.closeModal();
      await this.refresh();
      await this.openAttendance(meetingId);
    };

    const body = rows.map((r) => {
      const actionsCell = el('td', {});
      const showButtons = () => {
        if (meeting.status !== 'open') {
          actionsCell.replaceChildren(el('small', { className: 'board-cell-sub', text: meeting.status === 'closed' ? 'Reopen to change' : 'Open attendance first' }));
          return;
        }
        const actions = el('div', { className: 'board-actions' });
        for (const status of ['present', 'leave', 'absent']) {
          if (status === r.status) continue;
          const b = button(ATTEND_CHIP[status][1]);
          b.setAttribute('aria-label', `Mark ${r.name} ${ATTEND_CHIP[status][1].toLowerCase()}`);
          b.addEventListener('click', () => showReason(status));
          actions.append(b);
        }
        actionsCell.replaceChildren(actions);
      };
      const showReason = (status) => {
        const reason = el('input', {
          type: 'text', className: 'form-control board-reason', maxlength: '300', 'aria-label': `Reason for marking ${r.name} ${status}`,
          placeholder: status === 'present' ? 'Why by hand? e.g. No phone with them' : status === 'leave' ? 'e.g. Travelling, informed in advance' : 'Why? e.g. Marked present by mistake',
        });
        const save = button('Save', 'btn-primary');
        const cancel = button('Cancel');
        cancel.addEventListener('click', showButtons);
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            await this.api('mark', { method: 'POST', body: { meetingId, memberId: r.memberId, status, reason: reason.value.trim() } });
            this.ui.toast(`${r.name} marked ${ATTEND_CHIP[status][1].toLowerCase()}.`, 'success');
            await reload();
          } catch (err) {
            this.ui.toast(err.message, 'error');
            save.disabled = false;
          }
        });
        actionsCell.replaceChildren(el('div', { className: 'board-actions' }, reason, save, cancel));
        reason.focus();
      };
      showButtons();
      const how = r.method === 'qr' ? 'Scanned QR' : r.method === 'name' ? 'Tapped name' : r.method === 'secretary' ? `By secretary: ${r.reason || ''}` : '—';
      return el('tr', {},
        el('td', {}, el('strong', { text: r.name }), el('small', { className: 'board-cell-sub', text: r.designation })),
        el('td', {}, chip(ATTEND_CHIP[r.status] || ATTEND_CHIP.absent)),
        el('td', { text: r.at && r.status !== 'absent' ? timeLabel(r.at) : '—' }),
        el('td', { text: how }),
        actionsCell);
    });

    const close = button('Close');
    close.addEventListener('click', () => this.ui.closeModal());
    root.append(
      el('p', { className: 'board-admin-count', text: `${dayLabel(meeting.date)} · ${meeting.time}${meeting.venue ? ` · ${meeting.venue}` : ''} — ${counts.present} present, ${counts.leave} on leave, ${counts.absent} absent of ${counts.roster}` }),
      rows.length
        ? el('div', { className: 'table-responsive board-modal-table board-scroll' },
          el('table', { className: 'data-table board-table' },
            el('thead', {}, el('tr', {}, ...['Member', 'Status', 'Time', 'How', 'Change'].map((h) => el('th', { text: h })))),
            el('tbody', {}, ...body)))
        : el('p', { className: 'board-empty', text: 'There is nobody on the board roster yet.' }),
      el('div', { className: 'board-admin-form-actions' }, close));
  }

  // ── Register and projector ─────────────────────────────────────

  async downloadRegister(btn) {
    btn.disabled = true;
    try {
      const name = await this.store.downloadFile('/api/board?action=register', { fallbackName: 'BCCI_Board_Attendance_Register.xlsx' });
      this.ui.toast(`Downloaded ${name}.`, 'success');
    } catch (err) {
      this.ui.toast(err.message || 'The register could not be downloaded.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  openProjector(meetingId) {
    this.projector?.stop();
    this.projector = new Projector({
      api: (a, o) => this.api(a, o),
      meetingId,
      onPrintSticker: () => this.printQrSticker(),
      onExit: () => {
        this.projector = null;
        this.refresh();
      },
    });
    this.projector.start();
  }

  /**
   * The permanent attendance QR, print-ready: stick it on a wall or a stand
   * so members can scan in even when the projector is not available. It only
   * works while a meeting is open.
   */
  printQrSticker() {
    // Opened from a full-screen projector, the sheet would sit hidden behind it.
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const qrBox = el('div', { className: 'board-sticker-qr', role: 'img', 'aria-label': 'Attendance QR code' });
    const printBtn = button('Print', 'btn-primary');
    const closeBtn = button('Close');
    const overlay = el('div', { className: 'board-sticker-overlay' },
      el('div', { className: 'board-sticker-sheet' },
        el('h2', { className: 'board-sticker-title', text: 'BCCI Board Meeting — Attendance' }),
        qrBox,
        el('p', { className: 'board-sticker-how', text: 'Scan with your phone camera, enter the meeting PIN shown in the room, then tap your name. Works only while a meeting is open.' }),
        el('div', { className: 'board-sticker-actions' }, printBtn, closeBtn)));
    const remove = () => overlay.remove();
    printBtn.addEventListener('click', () => window.print());
    closeBtn.addEventListener('click', remove);
    window.addEventListener('afterprint', remove, { once: true });
    document.body.append(overlay);
    if (typeof QRCode === 'undefined') {
      qrBox.append(el('p', { className: 'board-projector-banner', text: 'The QR library did not load. Reload the page.' }));
      return;
    }
    new QRCode(qrBox, { text: `${location.origin}/board?attend=live`, width: 512, height: 512, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    qrBox.removeAttribute('title');
    qrBox.querySelectorAll('img, canvas').forEach((n) => n.setAttribute('aria-hidden', 'true'));
  }

  async runAction(btn, fn, successMessage) {
    btn.disabled = true;
    try {
      await fn();
      this.ui.toast(successMessage, 'success');
      await this.refresh();
    } catch (err) {
      this.ui.toast(err.message || 'That did not work.', 'error');
      btn.disabled = false;
    }
  }
}

/**
 * The full-screen view for the meeting room's projector: the attendance QR
 * (the same permanent one as the sticker), and names appearing as members
 * scan in. Polls the server every few seconds; keeps the screen awake while
 * it is up.
 */
class Projector {
  constructor({ api, meetingId, onPrintSticker, onExit }) {
    this.api = api;
    this.meetingId = meetingId;
    this.onPrintSticker = onPrintSticker;
    this.onExit = onExit;
    this.qrPin = null;
    this.closed = false;
    this.timer = null;
    this.wakeLock = null;
    this.stopped = false;
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && !this.stopped) this.keepAwake();
    };
  }

  start() {
    this.qrBox = el('div', { className: 'board-projector-qr', role: 'img', 'aria-label': 'Attendance QR code' });
    this.title = el('h2', { className: 'board-projector-title', text: 'Loading…' });
    this.meta = el('p', { className: 'board-projector-meta' });
    this.count = el('div', { className: 'board-projector-count', 'aria-live': 'polite' });
    this.list = el('ol', { className: 'board-projector-list' });
    this.banner = el('div', { className: 'board-projector-banner', role: 'status', hidden: true });
    this.pinValue = el('strong', { className: 'board-projector-pin-value', text: '····' });
    this.pinLine = el('p', { className: 'board-projector-pin', 'aria-live': 'polite' }, 'Meeting PIN ', this.pinValue);

    const fullscreen = button('Full screen');
    fullscreen.addEventListener('click', () => this.overlay.requestFullscreen?.().catch(() => {}));
    const sticker = button('Print sticker');
    sticker.addEventListener('click', () => this.onPrintSticker());
    this.pinBtn = button('New PIN');
    this.pinBtn.addEventListener('click', () => this.newPin());
    this.closeBtn = button('Close attendance', 'btn-action-reject');
    this.closeBtn.addEventListener('click', () => this.closeAttendance());
    const exit = button('Exit');
    exit.addEventListener('click', () => this.stop());

    this.overlay = el('div', { className: 'board-projector', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Meeting attendance QR' },
      el('div', { className: 'board-projector-top' },
        el('div', {}, this.title, this.meta),
        el('div', { className: 'board-projector-controls' }, fullscreen, sticker, this.pinBtn, this.closeBtn, exit)),
      this.banner,
      el('div', { className: 'board-projector-body' },
        el('div', { className: 'board-projector-left' },
          this.qrBox,
          this.pinLine,
          el('p', { className: 'board-projector-how', text: 'Scan with your phone camera, then tap your name. Scanning the sticker? Enter the PIN above.' })),
        el('div', { className: 'board-projector-right' }, this.count, this.list)));

    document.body.append(this.overlay);
    document.body.classList.add('modal-open');
    document.addEventListener('visibilitychange', this.onVisibility);
    this.keepAwake();
    this.poll();
  }

  async keepAwake() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch (err) {
      console.warn('[Projector] screen may sleep:', err.message);
    }
  }

  async poll() {
    if (this.stopped) return;
    let data;
    try {
      data = await this.api('live', { query: `&id=${encodeURIComponent(this.meetingId)}` });
    } catch (err) {
      if (this.stopped || this.closed) return;
      if (err.status === 409 || err.status === 404) {
        this.showClosed(err.message);
        return;
      }
      if (err.status === 401) {
        // Retrying cannot help once the admin session has ended.
        this.showClosed('Your admin session has ended. Exit, sign in again and reopen the projector.');
        return;
      }
      this.banner.hidden = false;
      this.banner.textContent = 'Connection lost. Retrying… the present list may be stale.';
      this.schedulePoll();
      return;
    }
    // Closed or exited while this poll was in flight: leave the closed screen alone.
    if (this.stopped || this.closed) return;
    // Too many wrong PINs locked it: nobody can mark in until there is a new one.
    this.banner.hidden = !data.pinLocked;
    if (data.pinLocked) this.banner.textContent = 'Too many wrong PINs were tried, so the PIN is locked. Tap "New PIN" to let members in again.';

    const m = data.meeting;
    this.title.textContent = m.title;
    this.meta.textContent = [dayLabel(m.date), m.time, m.venue].filter(Boolean).join(' · ');
    const pin = m.pin || '';
    if (pin !== this.qrPin) {
      this.qrPin = pin;
      this.pinValue.textContent = pin || '····';
      // The projector's QR carries the PIN, so its scanners need not type it.
      this.drawQr(`${location.origin}/board?attend=live${pin ? `&pin=${pin}` : ''}`);
    }
    this.renderPresent(data.present, data.counts);
    this.schedulePoll();
  }

  /**
   * The next refresh in three seconds. Clearing first keeps a single loop
   * even when two polls overlap (New PIN polls at once while one is in flight).
   */
  schedulePoll() {
    clearTimeout(this.timer);
    if (!this.stopped && !this.closed) this.timer = setTimeout(() => this.poll(), 3000);
  }

  drawQr(payload) {
    this.qrBox.replaceChildren();
    if (typeof QRCode === 'undefined') {
      this.qrBox.append(el('p', { className: 'board-projector-banner', text: 'The QR library did not load. Reload the page.' }));
      return;
    }
    new QRCode(this.qrBox, { text: payload, width: 512, height: 512, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    this.qrBox.removeAttribute('title');
    this.qrBox.querySelectorAll('img, canvas').forEach((n) => n.setAttribute('aria-hidden', 'true'));
  }

  renderPresent(present, counts) {
    const parts = [
      el('span', { className: 'board-projector-number', text: String(counts.present) }),
      el('span', { text: ` of ${counts.roster} present` }),
    ];
    if (counts.leave) parts.push(el('small', { text: ` · ${counts.leave} on leave` }));
    this.count.replaceChildren(...parts);
    this.list.replaceChildren(...present.map((p) => el('li', {},
      el('strong', { text: p.name }),
      el('span', { text: ` ${p.designation}` }),
      el('time', { text: timeLabel(p.at) }))));
  }

  /** A fresh PIN, for one that leaked outside the room or locked. */
  async newPin() {
    if (!confirm('Make a new meeting PIN? The current PIN stops working at once.')) return;
    this.pinBtn.disabled = true;
    try {
      await this.api('meeting-pin', { method: 'POST', body: { id: this.meetingId } });
      clearTimeout(this.timer);
      await this.poll();
    } catch (err) {
      this.banner.hidden = false;
      this.banner.textContent = err.message;
    } finally {
      // Attendance may have closed meanwhile; then there is no PIN to change.
      this.pinBtn.disabled = !!this.closed;
    }
  }

  async closeAttendance() {
    if (!confirm('Close attendance now? Members can no longer scan in.')) return;
    this.closeBtn.disabled = true;
    try {
      await this.api('meeting-close', { method: 'POST', body: { id: this.meetingId } });
      this.showClosed('Attendance is closed.');
    } catch (err) {
      this.banner.hidden = false;
      this.banner.textContent = err.message;
      this.closeBtn.disabled = false;
    }
  }

  showClosed(message) {
    clearTimeout(this.timer);
    this.timer = null;
    this.closed = true;
    this.qrPin = null;
    this.pinValue.textContent = '····';
    this.pinBtn.disabled = true;
    this.qrBox.replaceChildren(el('p', { className: 'board-projector-closed', text: message || 'Attendance is closed.' }));
    this.closeBtn.disabled = true;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.wakeLock?.release?.().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay?.remove();
    document.body.classList.remove('modal-open');
    this.onExit?.();
  }
}
