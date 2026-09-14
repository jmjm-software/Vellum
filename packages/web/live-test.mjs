import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8801';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failures = 0;
const check = (n, c) => { console.log((c ? '  ok   ' : '  FAIL ') + n); if (!c) failures++; };

await page.goto(`${BASE}/?token=client-dev-token`);
await page.waitForSelector('[data-component-id="shop"]', { timeout: 8000 });
check('publication rendered', true);
check('rev badge', (await page.locator('.app-title').textContent()).includes('rev'));

// SSE connected => no offline badge
await page.waitForTimeout(1500);
check('no offline badge', (await page.locator('.app-badge-offline').count()) === 0);

// toggle first checklist row -> POST /api/actions -> refetch; item should show done
await page.locator('[data-component-id="shop"] .vellum-checklist-row').first().click();
await page.waitForTimeout(2000);
const state = await page.evaluate(async () => {
  const r = await fetch('/api/state', { headers: { Authorization: 'Bearer client-dev-token' } });
  return r.json();
});
const milk = state.datasets[0].value.items.find((i) => i.id === 'milk');
check('toggleItem applied server-side (milk done)', milk.done === true);
check('pending cleared', (await page.locator('.app-badge-pending').count()) === 0);
check('UI shows checked', (await page.locator('[data-component-id="shop"] .vellum-checklist-box-checked').count()) >= 1);

// phone viewport -> phone target
await page.setViewportSize({ width: 360, height: 640 });
await page.waitForTimeout(500);
check('no doc overflow at 360', await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

check('no page errors', errors.length === 0 || console.error(errors));
await browser.close();
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
