// Smoke tests: drive the real site in headless Chrome and check the main features work.
//
//   npm test                      uses your installed Google Chrome
//   CHROME_PATH=/path/to/chrome npm test
//   HEADED=1 npm test             watch it run
//
// WebGL runs on SwiftShader (software), so no GPU is needed (works in CI).
import path from 'path';
import url from 'url';
import fs from 'fs';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/projects.json'), 'utf8'));
const projects = Array.isArray(manifest) ? manifest : manifest.projects;

const server = await startServer({ root });
const BASE = `http://127.0.0.1:${server.address().port}/`;

const launch = {
  headless: !process.env.HEADED,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
};
if(process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
else launch.channel = 'chrome';
const browser = await chromium.launch(launch);

let failed = 0, passed = 0;
const problems = [];

async function newPage(opts = {}){
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, serviceWorkers: 'block', ...opts });
  const page = await context.newPage();
  // Keep the run offline and deterministic: no map tiles from OpenStreetMap
  await page.route(/tile\.openstreetmap\.org/, (r)=> r.abort());
  page.on('pageerror', (e)=> problems.push(`page error: ${e.message}`));
  page.on('console', (m)=>{
    if(m.type() !== 'error') return;
    const t = m.text();
    if(/openstreetmap|net::ERR_FAILED|ERR_BLOCKED|Failed to load resource/i.test(t)) return;
    problems.push(`console error: ${t}`);
  });
  return page;
}

async function test(name, fn){
  const before = problems.length;
  const start = Date.now();
  try {
    await fn();
    if(problems.length > before) throw new Error(problems.slice(before).join('\n    '));
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - start} ms)`);
  } catch(err){
    failed++;
    console.log(`  ✖ ${name}\n    ${String(err?.message || err).split('\n').join('\n    ')}`);
  }
}

function expect(cond, msg){ if(!cond) throw new Error(msg); }

async function waitLoaded(page){
  await page.waitForSelector('#viewerModal[aria-hidden="false"]', { timeout: 20000 });
  await page.waitForSelector('#loadingOverlay', { state: 'hidden', timeout: 45000 });
  await page.waitForTimeout(400);
}

// Average brightness (0–255) of the rendered panorama, measured from a screenshot.
async function canvasBrightness(page){
  const png = await page.locator('#viewerCanvasWrap canvas').first().screenshot();
  return page.evaluate(async (b64)=>{
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for(let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return s / (d.length / 4);
  }, png.toString('base64'));
}

const multi = projects.find((p)=> Array.isArray(p.stages) && p.stages.length >= 2) || projects[0];

console.log(`Progress360 smoke tests: ${BASE}`);

await test('gallery lists every project', async ()=>{
  const page = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('.card');
  const cards = await page.locator('.card').count();
  expect(cards === projects.length, `expected ${projects.length} cards, got ${cards}`);
  await page.fill('#searchInput', multi.title);
  await page.waitForTimeout(250);
  expect(await page.locator('.card').count() >= 1, 'search found nothing');
  await page.context().close();
});

await test('gallery sort and group', async ()=>{
  const page = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('.card');
  await page.selectOption('#sortSelect', 'name');
  const titles = await page.locator('.card .card-title').allTextContents();
  const sorted = [...titles].sort((a, b)=> a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  expect(JSON.stringify(titles) === JSON.stringify(sorted), `not sorted by name: ${titles.join(', ')}`);
  await page.selectOption('#groupSelect', 'site');
  expect(await page.locator('.group-heading').count() >= 1, 'no group headings');
  expect(await page.locator('.card').count() === projects.length, 'grouping lost cards');
  await page.context().close();
});

await test('map view loads', async ()=>{
  const page = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('.card');
  await page.click('#mapViewBtn');
  await page.waitForSelector('#map.leaflet-container', { timeout: 10000 });
  await page.waitForFunction(()=> !/Finding/.test(document.querySelector('#mapNote')?.textContent || ''), null, { timeout: 30000 });
  expect(await page.locator('#gallery').isHidden(), 'gallery still visible in map view');
  await page.click('#gridViewBtn');
  expect(await page.locator('#gallery').isVisible(), 'gallery did not come back');
  await page.context().close();
});

await test('viewer opens, renders and steps through stages', async ()=>{
  const page = await newPage();
  await page.goto(`${BASE}#/${multi.id}`);
  await waitLoaded(page);
  const films = await page.locator('.film').count();
  expect(films >= 2, `expected ≥2 stages for ${multi.id}, got ${films}`);
  const b = await canvasBrightness(page);
  expect(b > 25, `panorama looks black (brightness ${b.toFixed(1)})`);
  const first = await page.textContent('#viewerStageLabel');
  await page.click('#nextBtn');
  await page.waitForTimeout(900);
  const second = await page.textContent('#viewerStageLabel');
  expect(first !== second, `stage label did not change (${first})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#viewerModal[aria-hidden="true"]', { state: 'attached', timeout: 5000 });
  await page.context().close();
});

await test('split view', async ()=>{
  const page = await newPage();
  await page.goto(`${BASE}#/${multi.id}`);
  await waitLoaded(page);
  await page.click('#splitBtn');
  await page.waitForSelector('#splitUi', { state: 'visible' });
  expect(await page.locator('#viewerModal.is-split').count() === 1, 'viewer not in split mode');
  const box = await page.locator('#viewerCanvasWrap').boundingBox();
  const h = await page.locator('#splitHandle').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, h.y + h.height / 2, { steps: 5 });
  await page.mouse.up();
  const pos = await page.locator('#splitUi').evaluate((el)=> parseFloat(el.style.getPropertyValue('--split')));
  expect(pos > 15 && pos < 35, `divider at ${pos}% after dragging to 25%`);
  await page.keyboard.press('s');
  expect(await page.locator('#splitUi').isHidden(), 'S did not close split view');
  await page.context().close();
});

await test('share link restores stage and view', async ()=>{
  const page = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await page.goto(`${BASE}#/${multi.id}?stage=2&yaw=90&pitch=0`);
  await waitLoaded(page);
  const label = await page.textContent('#viewerStageLabel');
  const film2 = await page.locator('.film').nth(1).getAttribute('aria-current');
  expect(film2 === 'step', `stage=2 did not select the second stage (${label})`);
  await page.click('#shareBtn');
  await page.click('[data-share="link"]');
  await page.waitForTimeout(300);
  const link = await page.evaluate(()=> navigator.clipboard.readText());
  expect(link.includes(`#/${multi.id}?stage=2`), `unexpected share link ${link}`);
  const yaw = +new URL(link.replace('#/', '')).searchParams.get('yaw');
  expect(Math.abs(yaw - 90) <= 2, `yaw not preserved: ${link}`);
  await page.context().close();
});

await test('embed mode', async ()=>{
  const page = await newPage();
  await page.goto(`${BASE}?embed=1#/${multi.id}`);
  await waitLoaded(page);
  expect(await page.locator('body.embed').count() === 1, 'body.embed missing');
  expect(await page.locator('#closeViewer').isHidden(), 'close button visible in embed');
  expect(await page.locator('#openFullBtn').isVisible(), '"open in Progress360" button hidden in embed');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await page.getAttribute('#viewerModal', 'aria-hidden') === 'false', 'Esc closed the embedded viewer');
  await page.context().close();
});

await test('editor: hotspot draft and JSON export', async ()=>{
  const page = await newPage();
  await page.goto(`${BASE}?edit#/${multi.id}`);
  await waitLoaded(page);
  if(!(await page.locator('#editorPanel').isVisible())) await page.click('#sidebarBtn');
  await page.waitForSelector('#editorPanel', { state: 'visible' });
  const before = await page.locator('.hotspot').count();
  await page.fill('#edHsTitle', 'Smoke test hotspot');
  await page.click('#edHsAdd');
  await page.waitForTimeout(200);
  expect(await page.locator('.hotspot').count() === before + 1, 'hotspot was not added');
  const json = await page.inputValue('#edJson');
  expect(json.includes('"hotspots"') && json.includes('Smoke test hotspot'), 'JSON export missing the hotspot');
  JSON.parse(`{${json.replace(/,\s*$/, '')}}`);
  page.on('dialog', (d)=> d.accept());
  await page.click('#edDiscard');
  await page.waitForTimeout(200);
  expect(await page.locator('.hotspot').count() === before, 'discard did not remove the hotspot');
  await page.context().close();
});

await test('phone: loads the 4K copy and thumbnail preview', async ()=>{
  const page = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const requested = [];
  page.on('request', (r)=> requested.push(r.url()));
  await page.goto(`${BASE}#/${multi.id}`);
  await waitLoaded(page);
  const has4k = fs.readdirSync(path.join(root, multi.folder)).some((f)=> /-4k\.jpe?g$/i.test(f));
  if(has4k) expect(requested.some((u)=> /-4k\.jpe?g/i.test(u)), 'phone did not request a -4k image');
  const b = await canvasBrightness(page);
  expect(b > 25, `panorama looks black on phone (brightness ${b.toFixed(1)})`);
  await page.context().close();
});

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
