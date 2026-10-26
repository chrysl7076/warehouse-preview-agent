// End-to-end check of the Groq / Gemini path (OpenAI-compatible) with a simulated provider:
// real server.js (key kept on the server, per-visitor limit) + real page + scripted model replies.
// Run: node tests/e2e-openai.js
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');

// Simulated provider: /chat/completions in OpenAI format, scripted tool calls
const seen = [];
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b);
    seen.push({ auth: req.headers.authorization, model: body.model, tools: body.tools.length, url: req.url });
    const last = body.messages[body.messages.length - 1];
    let reply;
    if (last.role === 'user') {
      reply = { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_space', arguments: JSON.stringify({ goods: 'Vaccines', pallets: 120, temperature: 'chilled' }) } }] } };
    } else if (last.tool_call_id === 'c1') {
      const plan = JSON.parse(last.content);
      reply = { finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Found space, drawing the route.', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'draw_route', arguments: JSON.stringify({ plan_id: plan.plan_id }) } }] } };
    } else {
      const plan = JSON.parse(body.messages.find(m => m.tool_call_id === 'c1').content);
      const route = JSON.parse(last.content);
      reply = { finish_reason: 'stop', message: { role: 'assistant', content: `${plan.plan_id}: ${plan.pallets_reserved} pallets in zone ${plan.zone}, ${route.distance_m} m from dock ${route.dock}.` } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [reply] }));
  });
});

(async () => {
  await new Promise(r => upstream.listen(4731, r));
  Object.assign(process.env, { PROVIDER: 'groq', GROQ_API_KEY: 'gsk_test_secret', GROQ_BASE_URL: 'http://127.0.0.1:4731', LIMIT_PER_IP: '4' });
  const { createServer } = require('../server.js');
  const app = createServer();
  await new Promise(r => app.listen(4732, '127.0.0.1', r));

  const health = await (await fetch('http://127.0.0.1:4732/api/health')).json();
  console.log('health:', health);
  assert.equal(health.api, 'openai');
  assert.ok(!JSON.stringify(health).includes('gsk_'), 'key never sent to the browser');

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://127.0.0.1:4732/');
  await page.waitForFunction(() => window.__app.brain && window.__app.brain.id === 'openai-compatible', null, { timeout: 20000 });
  console.log('brain label:', await page.$eval('#brain-label', n => n.textContent));
  await page.fill('#input', '120 pallets of vaccines please');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !window.__app.busy && document.querySelector('.badge'), null, { timeout: 20000 });
  const steps = await page.$$eval('.step', n => n.map(x => x.innerText.replace(/\n/g, ' ')));
  const badge = await page.$eval('.badge', n => n.textContent);
  console.log('steps:', steps); console.log('badge:', badge);
  assert.equal(steps.length, 2);
  assert.ok(/traced to data/.test(badge));
  assert.ok(seen.every(s => s.auth === 'Bearer gsk_test_secret' && s.url === '/chat/completions' && s.tools === 8));
  assert.equal(seen[0].model, 'openai/gpt-oss-20b', 'Fast setting uses the fast model');

  // Per-visitor limit: 3 calls used above, the 5th call in 10 minutes is refused politely
  const call = () => fetch('http://127.0.0.1:4732/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [] }) });
  const r4 = await call(), r5 = await call();
  console.log('limit:', r4.status, r5.status, (await r5.json()).error);
  assert.equal(r5.status, 429);

  // The page shows a friendly message on 429
  await page.fill('#input', 'another question');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !window.__app.busy, null, { timeout: 20000 });
  const last = await page.$$eval('.msg.agent .text', n => n[n.length - 1].textContent);
  console.log('after limit:', last);
  assert.ok(/Too many|Wait/i.test(last));

  console.log('errors:', errors.length ? errors : 'none');
  assert.equal(errors.length, 0);
  console.log('E2E OPENAI-COMPATIBLE: PASS');
  await browser.close(); app.close(); upstream.close();
})().catch(e => { console.error(e); process.exit(1); });
