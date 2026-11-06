// Focused regression smoke test. Run against the local dev sandbox only.
// SITE_URL=http://localhost:3147 node scripts/leadership-browser-test.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.SITE_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use a local sandbox');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/about`);
  await page.waitForSelector('#leadershipGrid .team-card');
  assert.equal(await page.locator('#leadershipGrid .team-card').count(), 16);
  // Cards with and without a bio/LinkedIn must share one footer line per row.
  for (const width of [1440, 1200, 1100, 1025, 1024, 900, 820, 769, 768, 600, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Two frames: let the resize reflow (and container queries) settle before measuring.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const footerRows = await page.evaluate(() => {
      const rows = new Map();
      for (const card of document.querySelectorAll('#leadershipGrid .team-card')) {
        const footers = card.querySelectorAll('.team-footer');
        if (footers.length !== 1) return null;
        const top = Math.round(card.getBoundingClientRect().top);
        rows.set(top, [...(rows.get(top) || []), footers[0].getBoundingClientRect().top]);
      }
      // Unrounded: a sub-pixel drift between footers in one row is a real misalignment.
      return [...rows.values()].map((tops) => Math.max(...tops) - Math.min(...tops));
    });
    assert.ok(footerRows && footerRows.every((drift) => drift < 0.1), `card footers line up within each row at ${width}px`);
  }
  await page.locator('.team-card').filter({ hasText: 'DR. MAHESH R. VASHI' }).getByRole('button', { name: 'Read bio' }).click();
  await page.waitForSelector('#modalBackdrop.show');
  assert.match(await page.locator('#modalContainer').innerText(), /CSR & Skill Development/i);
  await page.locator('#modalCloseIcon').click();
  const urjit = page.locator('.team-card').filter({ hasText: 'MR. URJIT BHUPENDRABHAI PATEL' });
  await urjit.getByRole('button', { name: 'Read bio' }).click();
  await page.waitForSelector('#modalBackdrop.show');
  assert.match(await page.locator('#modalContainer').innerText(), /SLD Infrastructure Private Limited/);
  await page.locator('.leader-profile-img').evaluate((img) => img.decode());
  assert.equal(await page.locator('.leader-profile-img').evaluate((img) => img.naturalWidth), 500);
  await page.locator('#modalCloseIcon').click();
  const checks = await page.evaluate(async () => {
    const { App } = await import('/js/app.js');
    const app = Object.create(App.prototype);
    app.showModal({ title: '<img src=x onerror=alert(1)> Shah & Sons', content: '<p>Content</p>' });
    const safe = !document.querySelector('.modal-title img') && document.querySelector('.modal-title').textContent.includes('<img');
    app.closeModal();
    const { BoardAdmin } = await import('/js/board-admin.js');
    const admin = new BoardAdmin({ root: document.createElement('div'), store: {}, ui: {} });
    admin.websiteRoster = [
      { name: 'Dr Test', role: 'Member', portalId: null },
      { name: 'Other', role: 'Member', portalId: 'BM-1', portalStatus: 'inactive' },
    ];
    const warning = admin.rosterWarning().textContent;
    let qr;
    const original = window.QRCode;
    window.QRCode = class {
      static CorrectLevel = { M: 0 };
      constructor(box, options) { qr = options.text; }
    };
    admin.api = async () => ({
      meeting: { id: 'MTG-1', title: 'Test', date: '2026-11-03', time: '10:00', pin: '1234' },
      pinLocked: false, present: [], counts: { present: 0, roster: 1 },
    });
    admin.refresh = () => {};
    try {
      admin.openProjector('MTG-1');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const displayedPin = document.querySelector('.board-projector-pin-value').textContent;
      return { safe, warning, qr, displayedPin };
    } finally {
      admin.projector.stop();
      window.QRCode = original;
    }
  });
  assert.ok(checks.safe);
  assert.match(checks.warning, /no portal profile/);
  assert.match(checks.warning, /inactive/);
  assert.equal(checks.qr, `${new URL(base).origin}/board?attend=live`);
  assert.equal(checks.displayedPin, '1234');
  for (const image of await page.locator('#leadershipGrid img').all()) {
    await image.scrollIntoViewIfNeeded();
    await image.evaluate((img) => img.decode());
  }
  for (const width of [1200, 820, 769, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      portraits: [...document.querySelectorAll('#leadershipGrid img')].every((img) => img.complete && img.naturalWidth > 0),
    }));
    assert.ok(!layout.overflow, `page overflow at ${width}`);
    assert.ok(layout.portraits, `portraits load at ${width}`);
    console.log(`PASS About ${width}px: portraits load, no page overflow`);
  }
  for (const [route, view] of [
    ['/', 'home'], ['/about', 'about'], ['/services', 'services'], ['/events', 'events'],
    ['/gallery', 'gallery'], ['/qr', 'qrcode'], ['/enquiry', 'enquiry'],
    ['/membership', 'membership'], ['/card', 'card'], ['/signin', 'signin'],
    ['/board', 'board'], ['/admin-bcci', 'signin'], ['/verify', 'verify'],
  ]) {
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`#view-${view}`, { state: 'visible' });
    if (route === '/events') {
      // Exercise the populated layout even in a fresh, empty sandbox.
      await page.evaluate(async () => {
        const { App } = await import('/js/app.js');
        App.prototype.renderEventsGrid.call({}, [{ id: 'smoke-event', title: 'Browser smoke event', mode: 'offline', pricingType: 'free', date: '2026-11-03', time: '10:00', capacity: 25, registeredCount: 1 }]);
      });
    }
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflow at ${width}px`);
    }
    console.log(`PASS ${route}: active view, no overflow at desktop/tablet/phone widths`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS profile dialog, modal escaping, roster warning, PIN separate from QR, no browser exceptions');
} finally {
  await browser.close();
}
