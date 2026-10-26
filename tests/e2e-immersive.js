// Browser test of the immersive features: walk inside (with collisions), follow a pallet,
// site tour, sound toggle. Saves screenshots to shots/. Run: node tests/e2e-immersive.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const out = path.join(root, 'shots');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route('**/three.min.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await page.route('**/OrbitControls.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/examples/js/controls/OrbitControls.js'), contentType: 'text/javascript' }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('file://' + path.join(root, 'dist/index.html'));
  await page.waitForFunction(() => window.__app && window.__app.fx && !/Looking/.test(document.getElementById('brain-label').textContent), null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'i1-overview.png') });

  // Walk inside
  await page.click('#btn-walk');
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__app.fx.mode), 'walk');
  const start = await page.evaluate(() => ({ ...window.__app.fx.walk }));
  await page.mouse.move(700, 400);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => ({ ...window.__app.fx.walk }));
  console.log('walked from', start.z.toFixed(1), 'to', after.z.toFixed(1));
  assert.ok(after.z < start.z - 0.5, 'walking forward moves north');
  await page.screenshot({ path: path.join(out, 'i2-walk-aisle.png') });
  // Collision: try to walk sideways into a rack for 2 s
  await page.keyboard.down('KeyD'); await page.waitForTimeout(2000); await page.keyboard.up('KeyD');
  const inside = await page.evaluate(() => { const f = window.__app.fx, w = f.walk; return f.blocked(w.x, w.z); });
  assert.equal(inside, false, 'never ends up inside a rack');
  const where = await page.$eval('#where', n => n.textContent);
  console.log('location readout:', where);
  assert.ok(/Zone|aisle|Dock|Corridor/.test(where));
  await page.click('[data-cam="C"]');
  await page.waitForTimeout(400);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1200); await page.keyboard.up('KeyW');
  await page.screenshot({ path: path.join(out, 'i3-walk-chilled.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__app.fx.mode), 'orbit');

  // Follow a pallet (guided scenario: find space, then the journey)
  await page.click('.chip:has-text("Watch a pallet arrive")');
  await page.waitForFunction(() => window.__app.fx.mode === 'journey', null, { timeout: 20000 });
  const shots = [[1500, 'i4-journey-truck'], [3500, 'i5-journey-scan'], [5000, 'i6-journey-drive'], [9000, 'i7-journey-lift']];
  let tPrev = 0;
  for (const [t, name] of shots) { await page.waitForTimeout(t - tPrev); tPrev = t; await page.screenshot({ path: path.join(out, name + '.png') }); }
  const cap = await page.$eval('#cap-text', n => n.textContent);
  console.log('journey caption:', cap);
  await page.waitForFunction(() => window.__app.fx.mode === "orbit", null, { timeout: 60000 });
  assert.equal(await page.$eval('#caption', n => n.hidden), true);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'i8-journey-done.png') });
  const follow = await page.$$eval('.follow', n => n.map(x => x.textContent));
  console.log('follow buttons:', follow);
  assert.ok(follow.length >= 1);

  // Site tour + sound
  await page.click('#btn-sound');
  await page.waitForTimeout(300);
  console.log('sound button:', await page.$eval('#btn-sound', n => n.getAttribute('aria-label')));
  await page.click('#btn-tour');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(out, 'i9-tour.png') });
  console.log('tour caption:', await page.$eval('#cap-text', n => n.textContent));
  await page.click('#cap-skip'); await page.waitForTimeout(300);
  console.log('after Next:', await page.$eval('#cap-steps', n => n.querySelectorAll('i.on').length), 'of', await page.$eval('#cap-steps', n => n.children.length));
  await page.click('#btn-tour');
  assert.equal(await page.evaluate(() => window.__app.fx.mode), 'orbit');

  // Phone: walk pad appears
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.on('pageerror', e => errors.push(String(e)));
  await phone.route('**/three.min.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await phone.route('**/OrbitControls.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/examples/js/controls/OrbitControls.js'), contentType: 'text/javascript' }));
  await phone.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await phone.goto('file://' + path.join(root, 'dist/index.html'));
  await phone.waitForFunction(() => window.__app && window.__app.fx, null, { timeout: 20000 });
  await phone.click('#btn-walk');
  await phone.waitForTimeout(500);
  assert.equal(await phone.$eval('#pad', n => n.hidden), false, 'touch pad shows on phones');
  await phone.screenshot({ path: path.join(out, 'i10-phone-walk.png') });

  console.log('errors:', errors.length ? errors : 'none');
  assert.equal(errors.length, 0);
  console.log('E2E IMMERSIVE: PASS');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
