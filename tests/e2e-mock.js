// End-to-end check of BOTH agent loops with a simulated model (no API key needed):
//  1. the claude.ai artifact path (window.claude.use('sample') with page tools)
//  2. the Anthropic Messages API path through server.js (/api/messages, tool_use blocks)
// The fake model follows a fixed script, so this tests the plumbing, not intelligence.
// Run: node tests/e2e-mock.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/health')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url.startsWith('/api/messages')) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body);
      const last = b.messages[b.messages.length - 1];
      let reply;
      if (typeof last.content === 'string') {
        reply = { stop_reason: 'tool_use', content: [
          { type: 'text', text: 'Checking the chilled zone.' },
          { type: 'tool_use', id: 't1', name: 'find_space', input: { goods: 'Vaccines', pallets: 120, temperature: 'chilled' } }] };
      } else {
        const r = JSON.parse(last.content[0].content);
        if (r.plan_id && !b.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.name === 'draw_route'))) {
          reply = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'draw_route', input: { plan_id: r.plan_id } }] };
        } else {
          const plan = JSON.parse(b.messages.find(m => Array.isArray(m.content) && m.content[0].type === 'tool_result').content[0].content);
          reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: `${plan.plan_id}: ${plan.pallets_reserved} pallets in zone ${plan.zone}, dock ${plan.main_dock}, ${r.distance_m} m away.` }] };
        }
      }
      assert.ok(b.system.includes('SITE DATA'), 'system prompt carries site data');
      assert.equal(b.tools.length, 8);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    return;
  }
  const file = req.url === '/' ? 'dist/index.html' : req.url.slice(1);
  fs.readFile(path.join(root, file), (e, d) => { res.writeHead(e ? 404 : 200); res.end(d); });
});

// Fake `sample` capability: calls find_space, then draw_route, then answers — one invented number (999) to test the check.
const fakeClaude = () => {
  window.claude = {
    use: async name => {
      if (name !== 'sample') return null;
      const sample = async (turns, opts) => {
        if (!turns[0].content.includes('SITE DATA')) throw { code: 'invalid_request', message: 'no site data' };
        const t = n => opts.tools.find(x => x.name === n);
        const plan = await t('find_space').execute({ goods: 'Phones', pallets: 40, high_value: true });
        const route = await t('draw_route').execute({ plan_id: plan.plan_id });
        try { await t('draw_route').execute({ plan_id: 'P77' }); } catch { /* the model sees errors and carries on */ }
        const text = `${plan.plan_id}: ${plan.pallets_reserved} pallets in zone ${plan.zone}. Route ${route.distance_m} m. About 999 staff on site.`;
        opts.onText({ text, delta: text });
        return { text, truncated: false };
      };
      sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
      return sample;
    },
  };
};

(async () => {
  await new Promise(r => server.listen(4719, r));
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const prep = async page => {
    await page.route('**/three.min.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
    await page.route('**/OrbitControls.js', r => r.fulfill({ path: path.join(root, 'node_modules/three/examples/js/controls/OrbitControls.js'), contentType: 'text/javascript' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  };
  const errors = [];

  // 1. claude.ai artifact path
  const p1 = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  p1.on('pageerror', e => errors.push(String(e)));
  await prep(p1);
  await p1.addInitScript(fakeClaude);
  await p1.goto('http://localhost:4719/');
  await p1.waitForFunction(() => window.__app.brain && window.__app.brain.id === 'claude-artifact', null, { timeout: 15000 });
  await p1.fill('#input', 'We need secure space for 40 pallets of phones');
  await p1.press('#input', 'Enter');
  await p1.waitForFunction(() => !window.__app.busy && document.querySelector('.badge'), null, { timeout: 15000 });
  const steps1 = await p1.$$eval('.step', n => n.map(x => x.className + ' | ' + x.innerText.replace(/\n/g, ' ')));
  const badge1 = await p1.$eval('.badge', n => n.textContent);
  console.log('artifact path steps:', steps1);
  console.log('artifact path badge:', badge1);
  assert.equal(steps1.length, 3);
  assert.ok(steps1[2].includes('fail'), 'a failing tool call is shown as failed');
  assert.ok(badge1.includes('999'), 'the invented number is flagged');
  await p1.screenshot({ path: path.join(root, 'shots/6-artifact-mock.png') });

  // Test bench runs all 20 cases through the same loop and scores them
  await p1.click('#tab-tests');
  await p1.click('#ev-run');
  await p1.waitForFunction(() => /Finished/.test(document.getElementById('ev-status').textContent), null, { timeout: 60000 });
  const pills = await p1.$$eval('#ev-table .pill', n => n.map(x => x.textContent));
  const score = await p1.$eval('#ev-score', n => n.textContent);
  console.log('test bench pills:', pills.join(' '), '| score', score);
  assert.equal(pills.filter(p => p === 'Pass' || p === 'Fail').length, 22);
  assert.equal(await p1.evaluate(() => window.__app.model.plans.length), 0, 'bench leaves the site clean');
  await p1.screenshot({ path: path.join(root, 'shots/7-testbench.png'), fullPage: true });
  await p1.click('#tab-about');
  await p1.waitForTimeout(300);
  await p1.screenshot({ path: path.join(root, 'shots/8-about.png'), fullPage: true });
  await p1.click('#tab-preview');

  // 2. own-API-key path (server.js)
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  p2.on('pageerror', e => errors.push(String(e)));
  await prep(p2);
  await p2.goto('http://localhost:4719/');
  await p2.waitForFunction(() => window.__app.brain && window.__app.brain.id === 'anthropic-api', null, { timeout: 15000 });
  await p2.fill('#input', '120 pallets of vaccines please');
  await p2.press('#input', 'Enter');
  await p2.waitForFunction(() => !window.__app.busy && document.querySelector('.badge'), null, { timeout: 15000 });
  const steps2 = await p2.$$eval('.step', n => n.map(x => x.innerText.replace(/\n/g, ' ')));
  const badge2 = await p2.$eval('.badge', n => n.textContent);
  console.log('api path steps:', steps2);
  console.log('api path badge:', badge2);
  assert.equal(steps2.length, 2);
  assert.ok(badge2.includes('traced to data'), 'all numbers grounded');

  console.log('page errors:', errors.length ? errors : 'none');
  assert.equal(errors.length, 0);
  console.log('E2E MOCK: PASS');
  await browser.close();
  server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
