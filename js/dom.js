// js/dom.js
// Builds DOM nodes from plain values. Text always goes in through
// textContent, never innerHTML, so names typed by the public render as text.

// Only URLs that cannot smuggle a script into the page: http(s), a same-site
// path or fragment ("/a/b", "./a", "../a", "#top" — not "//host"), mail, and
// the blob:/image-data: forms the download links and receipt previews use.
const SAFE_URL = /^(?:https?:\/\/|\/(?!\/)|\.\.?\/|#|mailto:|blob:|data:image\/)/i;
const URL_ATTRS = new Set(['href', 'src', 'action']);

/**
 * el('button', { className: 'btn-primary', text: 'Save', type: 'button' }, child, …)
 * Attributes set to false, null or undefined are left off; true sets an
 * empty (boolean) attribute.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (URL_ATTRS.has(k)) {
      // A javascript:/vbscript: href is a script sink waiting for the first
      // unescaped value; drop the attribute instead of writing it.
      const url = String(v).trim();
      if (!SAFE_URL.test(url)) {
        console.warn(`[dom] Refused an unsafe ${k} value:`, url);
        continue;
      }
      node.setAttribute(k, url);
    } else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** "2026-08-15" → "15 Aug 2026" without a time-zone shift. */
export function dayLabel(isoDate) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const raw = String(isoDate ?? '');
  // A date, or a full ISO timestamp whose time part is ignored — never parsed
  // through Date, which would shift the day in a negative-offset time zone.
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(raw);
  if (!match) return raw;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // A corrupt record ("2026-13-45") should show as it is, not as "45 undefined 2026".
  if (m < 1 || m > 12 || d < 1 || d > 31) return raw;
  return `${d} ${months[m - 1]} ${y}`;
}

/** A timestamp as a local time of day, e.g. "10:42 am". */
export function timeLabel(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
