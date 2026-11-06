// api/_lib/board-register.js
// The board attendance register: one Excel workbook holding every meeting.
// Built fresh from the records on each download, so it can never fall out
// of date and an edited copy can never change the record.
//
//   Board Register  one row per board member, one column per meeting (P/L/A)
//   Meetings        one row per meeting, with its counts
//   Scan Log        every mark, by QR, by tapped name or by the secretary, with the reason

import { registerData } from './board.js';
import { buildWorkbook } from './xlsx.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARK = { present: { v: 'P', s: 'present' }, leave: { v: 'L', s: 'leave' }, absent: { v: 'A', s: 'absent' } };
const STATUS_WORD = { present: 'Present', leave: 'Leave', absent: 'Absent' };

/** "2026-08-15" → "15 Aug 2026", without a time-zone shift. */
function dayLabel(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS.at(m - 1)} ${y}` : String(isoDate || '');
}

/** A timestamp in India time, e.g. "15 Aug 2026, 10:42 am". */
function istLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const header = (v) => ({ v, s: 'header' });

/** Builds the workbook. Returns { buffer, filename }. */
export async function buildRegister() {
  const { members, columns } = await registerData();
  const onAnyRoster = new Set(columns.flatMap((c) => [...c.rosterIds]));
  const people = members
    .filter((m) => m.status === 'active' || onAnyRoster.has(m.id))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));

  // ── Board Register ──
  const registerRows = [
    [header('Board member'), header('Designation'), ...columns.map((c) => header(dayLabel(c.meeting.date))),
      header('Present'), header('Leave'), header('Absent'), header('Meetings held'), header('Attendance')],
    [header(''), header(''), ...columns.map((c) => header(c.meeting.title)), header(''), header(''), header(''), header(''), header('')],
  ];
  for (const m of people) {
    const tally = { present: 0, leave: 0, absent: 0 };
    const cells = columns.map((c) => {
      if (!c.rosterIds.has(m.id)) return { v: '—', s: 'none' };
      const status = c.marks.get(m.id)?.status || 'absent';
      tally[status]++;
      return MARK[status];
    });
    const held = tally.present + tally.leave + tally.absent;
    registerRows.push([
      m.name,
      m.status === 'active' ? m.designation : `${m.designation} (former)`,
      ...cells,
      tally.present, tally.leave, tally.absent, held,
      held ? { v: tally.present / held, s: 'percent' } : '',
    ]);
  }
  registerRows.push([], ['P = present   L = leave granted   A = absent   — = not on the board at the time']);

  // ── Meetings ──
  const meetingRows = [[
    header('Date'), header('Start'), header('Meeting'), header('Venue'), header('Status'),
    header('On roster'), header('Present'), header('Leave'), header('Absent'), header('Attendance'),
    header('Attendance opened'), header('Closed'),
  ]];
  for (const c of [...columns].reverse()) {
    const counts = { present: 0, leave: 0, absent: 0 };
    for (const id of c.rosterIds) counts[c.marks.get(id)?.status || 'absent']++;
    const roster = c.rosterIds.size;
    meetingRows.push([
      dayLabel(c.meeting.date), c.meeting.time, c.meeting.title, c.meeting.venue || '',
      c.meeting.status === 'closed' ? 'Closed' : 'Taking attendance',
      roster, counts.present, counts.leave, counts.absent,
      roster ? { v: counts.present / roster, s: 'percent' } : '',
      istLabel(c.meeting.openedAt), istLabel(c.meeting.closedAt),
    ]);
  }

  // ── Scan Log ──
  const byId = new Map(members.map((m) => [m.id, m]));
  const logEntries = [];
  for (const c of columns) {
    for (const [memberId, rec] of c.marks) {
      for (const h of rec.history || []) logEntries.push({ h, meeting: c.meeting, member: byId.get(memberId) });
    }
  }
  logEntries.sort((a, b) => String(a.h.at).localeCompare(String(b.h.at)));
  const logRows = [[
    header('When (India time)'), header('Meeting date'), header('Meeting'), header('Board member'), header('Designation'),
    header('Marked'), header('How'), header('Recorded by'), header('Reason'),
  ]];
  for (const { h, meeting, member } of logEntries) {
    logRows.push([
      istLabel(h.at), dayLabel(meeting.date), meeting.title, member?.name || '', member?.designation || '',
      STATUS_WORD[h.status] || h.status, h.method === 'qr' ? 'Scanned QR' : h.method === 'name' ? 'Tapped name' : 'By secretary', h.by || '', { v: h.reason || '', s: 'wrap' },
    ]);
  }

  const buffer = buildWorkbook([
    {
      name: 'Board Register',
      rows: registerRows,
      cols: [28, 24, ...columns.map(() => 14), 9, 9, 9, 14, 12],
      freeze: { rows: 2, cols: 2 },
    },
    { name: 'Meetings', rows: meetingRows, cols: [13, 7, 34, 24, 18, 10, 9, 9, 9, 11, 22, 22], freeze: { rows: 1 } },
    { name: 'Scan Log', rows: logRows, cols: [22, 13, 30, 26, 20, 10, 13, 28, 40], freeze: { rows: 1 } },
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `BCCI_Board_Attendance_Register_${stamp}.xlsx` };
}
