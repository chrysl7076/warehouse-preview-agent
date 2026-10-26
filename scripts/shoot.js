// Dev check: opens dist/index.html in headless Chromium (CDNs served from node_modules),
// runs a scripted scenario, and saves screenshots. Run: node scripts/shoot.js [outdir]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'shots');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const errors = [];
  async function open(viewport, scheme) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.route('**/three.min.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
    await page.route('**/OrbitControls.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/examples/js/controls/OrbitControls.js'), contentType: 'text/javascript' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('**/api/health', r => r.fulfill({ status: 404, body: '' }));
    await page.goto('file://' + path.join(root, 'dist/index.html'));
    await page.waitForFunction(() => window.__app && window.__app.brain && !/Looking/.test(document.getElementById('brain-label').textContent), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    return page;
  }
  const page = await open({ width: 1440, height: 860 }, 'light');
  await page.screenshot({ path: path.join(out, '1-overview-light.png') });
  await page.click('.chip >> nth=0');
  await page.waitForFunction(() => !window.__app.busy, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '2-vaccines.png') });
  await page.click('.chip >> nth=1');
  await page.waitForFunction(() => !window.__app.busy, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '3-mixed.png') });
  const chat = await page.$eval('#chat', n => n.innerText);
  fs.writeFileSync(path.join(out, 'chat.txt'), chat);

  const dark = await open({ width: 1280, height: 800 }, 'dark');
  await dark.click('.chip >> nth=2');
  await dark.waitForFunction(() => !window.__app.busy, null, { timeout: 20000 });
  await dark.waitForTimeout(1500);
  await dark.screenshot({ path: path.join(out, '4-phones-dark.png') });

  const phone = await open({ width: 390, height: 844 }, 'light');
  await phone.screenshot({ path: path.join(out, '5-phone.png'), fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('phone horizontal overflow:', overflow);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
