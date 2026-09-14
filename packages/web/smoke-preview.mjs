// Smoke test: serve packages/web/dist statically, load preview.html with a spec,
// verify __vellumReady, data-component-id attributes, toggleItem recording, image placeholder.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const dist = new URL('./dist/', import.meta.url).pathname;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = createServer((req, res) => {
  const path = join(dist, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (existsSync(path) && !path.includes('..')) {
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    res.end(readFileSync(path));
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(8899, r));

const content = {
  formatVersion: 1,
  catalogueVersion: '1.0.0',
  datasets: ['tasks', 'stats', 'series', 'rows'],
  root: {
    id: 'root',
    type: 'grid',
    props: { columns: 12, gap: 12 },
    children: [
      {
        id: 'list1',
        type: 'checklist',
        props: { dataset: 'tasks', maxVisible: 6, overflow: 'showMore', showCompleted: true, completedCollapsed: true },
      },
      { id: 'm1', type: 'metric', props: { dataset: 'stats', field: 'cpu', label: 'CPU', unit: '%', target: 100 } },
      { id: 'c1', type: 'chart', props: { dataset: 'series', chartType: 'line', xField: 't', yFields: ['v'] } },
      { id: 't1', type: 'table', props: { dataset: 'rows', maxRows: 10, overflow: 'paginate' } },
      { id: 'txt1', type: 'text', props: { content: 'hello', style: 'body' } },
      { id: 'img1', type: 'image', props: { assetId: 'asset1', alt: 'x', fit: 'contain' } },
      { id: 'btn1', type: 'button', props: { label: 'Go', action: { kind: 'event', type: 'go' }, variant: 'primary' } },
      {
        id: 'tabs1',
        type: 'tabs',
        props: { labels: { card1: 'Card' } },
        children: [
          { id: 'card1', type: 'card', props: { title: 'Inner' }, children: [{ id: 'txt2', type: 'text', props: { content: 'inside' } }] },
          { id: 'txt3', type: 'text', props: { content: 'more tab' } },
        ],
      },
    ],
  },
  overrides: { phone: { m1: { span: 12 }, c1: { hidden: true } } },
};

const datasets = [
  {
    id: 'tasks', title: 'Tasks', ownership: 'dashboard', schema: { kind: 'list' }, updatedAt: 0, version: 1,
    value: { kind: 'list', items: [{ id: 'a', label: 'Task A', done: false }, { id: 'b', label: 'Task B', done: true }] },
  },
  {
    id: 'stats', title: 'Stats', ownership: 'dashboard', schema: { kind: 'metric', fields: [{ name: 'cpu', unit: '%' }] }, updatedAt: 0, version: 1,
    value: { kind: 'metric', values: { cpu: 42 } },
  },
  {
    id: 'series', title: 'Series', ownership: 'dashboard', schema: { kind: 'timeseries', series: [{ name: 'v' }] }, updatedAt: 0, version: 1,
    value: { kind: 'timeseries', samples: [{ t: 1, values: { v: 3 } }, { t: 2, values: { v: 7 } }, { t: 3, values: { v: 5 } }] },
  },
  {
    id: 'rows', title: 'Rows', ownership: 'dashboard', schema: { kind: 'records', columns: [{ name: 'name', type: 'string' }, { name: 'n', type: 'number' }] }, updatedAt: 0, version: 1,
    value: { kind: 'records', rows: Array.from({ length: 25 }, (_, i) => ({ name: `r${i}`, n: i })) },
  },
];

const spec = { content, datasets, target: 'desktop', profile: 'desktop' };
const b64 = Buffer.from(JSON.stringify(spec)).toString('base64url');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
}

await page.goto(`http://localhost:8899/preview.html?spec=${b64}`);
await page.waitForFunction('window.__vellumReady === true', null, { timeout: 5000 });
check('ready flag', true);

for (const id of ['root', 'list1', 'm1', 'c1', 't1', 'txt1', 'img1', 'btn1', 'tabs1', 'card1']) {
  const n = await page.locator(`[data-component-id="${id}"]`).count();
  check(`component ${id} present`, n >= 1);
}

check('image placeholder (no network)', await page.locator('[data-component-id="img1"].vellum-image-placeholder').count() === 1);
check('svg chart', await page.locator('[data-component-id="c1"] svg path').count() >= 1);
check('metric value 42', (await page.locator('[data-component-id="m1"]').textContent()).includes('42'));

// checklist click -> toggleItem recorded
await page.locator('[data-component-id="list1"] .vellum-checklist-row').first().click();
// button click -> event recorded
await page.locator('[data-component-id="btn1"]').click();
const actions = await page.evaluate('window.__vellumActions');
check('toggleItem recorded', actions.some((a) => a.action.kind === 'toggleItem' && a.action.itemId === 'a' && a.ctx.componentId === 'list1'));
check('event recorded', actions.some((a) => a.action.kind === 'event' && a.action.type === 'go' && a.ctx.componentId === 'btn1'));

// table pagination
const next = page.locator('[data-component-id="t1"] .vellum-paginate button', { hasText: 'Next' });
check('paginate next exists', (await next.count()) === 1);
await next.first().click();
check('page 2 shown', (await page.locator('[data-component-id="t1"]').textContent()).includes('2 /'));

// tabs
await page.locator('[data-component-id="tabs1"] .vellum-tab', { hasText: 'More' }).click();
check('tabs More panel', (await page.locator('[data-component-id="tabs1"] .vellum-tab-panel').textContent()).includes('more tab'));

// phone target: chart hidden via override
const specPhone = { ...spec, target: 'phone' };
const b64p = Buffer.from(JSON.stringify(specPhone)).toString('base64url');
await page.goto(`http://localhost:8899/preview.html?spec=${b64p}`);
await page.waitForFunction('window.__vellumReady === true', null, { timeout: 5000 });
check('phone: chart hidden', (await page.locator('[data-component-id="c1"]').count()) === 0);

// no horizontal overflow at 360px phone
await page.setViewportSize({ width: 360, height: 640 });
const overflow = await page.evaluate(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('[data-component-id]')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el).overflowX !== 'scroll') {
      bad.push(el.getAttribute('data-component-id') + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
  }
  return { bad, doc: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
check('no component overflow at 360px', overflow.bad.length === 0 || console.error('   overflow:', overflow.bad));
check('no document overflow at 360px', !overflow.doc);

await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`http://localhost:8899/preview.html?spec=${b64}`);
await page.waitForFunction('window.__vellumReady === true');
const overflow2 = await page.evaluate(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('[data-component-id]')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el).overflowX !== 'scroll') {
      bad.push(el.getAttribute('data-component-id') + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
  }
  return { bad, doc: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
check('no component overflow at 1280px', overflow2.bad.length === 0 || console.error('   overflow:', overflow2.bad));
check('no document overflow at 1280px', !overflow2.doc);

check('no console errors', errors.length === 0 || console.error('   errors:', errors));

await browser.close();
server.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
