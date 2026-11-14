// Capture proof screenshots of the built app at desktop (1440) and mobile (375, touch) for the board
// and a job page, plus console/network checks. Needs the demo server running on PORT.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PM_DEMO_PORT || 4155);
const OUT = process.env.PM_SHOTS || join(tmpdir(), 'proof-market-shots');
mkdirSync(OUT, { recursive: true });
const base = `http://127.0.0.1:${PORT}`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];

async function shot(name, { width, height, mobile, path = '/' }) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
  await page.setViewport({ width, height, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.goto(`${base}/#${path}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
  // a page wider than its viewport scrolls sideways on a phone
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`[${name}] page is ${overflow}px wider than the viewport`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${name} (${width}x${height}${mobile ? ' touch' : ''}) -> ${name}.png | text: ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 120))}`);
  await page.close();
}

await shot('board-desktop', { width: 1440, height: 900, path: '/' });
await shot('board-mobile', { width: 375, height: 812, mobile: true, path: '/' });
await shot('job-caught-desktop', { width: 1440, height: 1100, path: '/job/5' });
await shot('job-caught-mobile', { width: 375, height: 812, mobile: true, path: '/job/5' });
await shot('job-appeal-desktop', { width: 1440, height: 1100, path: '/job/6' });
await shot('job-appeal-mobile', { width: 375, height: 812, mobile: true, path: '/job/6' });
await shot('job-slashed-desktop', { width: 1440, height: 1100, path: '/job/2' });
await shot('job-honest-desktop', { width: 1440, height: 1000, path: '/job/0' });

await browser.close();
console.log(`\nconsole/page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);
process.exit(errors.length ? 1 : 0);
