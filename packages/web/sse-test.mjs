import { chromium } from 'playwright';
const BASE = 'http://localhost:8801';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/?token=client-dev-token`);
await page.waitForSelector('[data-component-id="shop"]');
const before = await page.locator('[data-component-id="shop"]').textContent();
// external data update via agent API (server-side, no client action)
const res = await fetch(`${BASE}/api/agent/data`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer agent-dev-token' },
  body: JSON.stringify({ op: 'patchItem', datasetId: 'shopping', itemId: 'bread', patch: { done: true } }),
});
console.log('agent patch status:', res.status);
await page.waitForTimeout(2500); // allow SSE event + refetch
const after = await page.locator('[data-component-id="shop"]').textContent();
const checked = await page.locator('[data-component-id="shop"] .vellum-checklist-box-checked').count();
console.log('checked count after SSE update:', checked);
await browser.close();
process.exit(checked >= 2 ? 0 : 1);
