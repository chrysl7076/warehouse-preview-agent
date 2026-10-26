#!/usr/bin/env node
// Runs the test-bench cases from the command line with your API key and
// writes eval/results.md. Same agent loop, tools and scoring as the browser.
//   npm run eval            (Fast model)
//   npm run eval -- --thorough
'use strict';
const fs = require('fs');
const path = require('path');
globalThis.self = globalThis;
globalThis.WarehouseCore = require('../src/core.js');
require('../src/agent.js');
require('../src/eval.js');
const { createServer } = require('../server.js');
const W = globalThis.WarehouseCore, A = globalThis.WarehouseAgent, E = globalThis.WarehouseEval;

const tier = process.argv.includes('--thorough') ? 'default' : 'quick';
const only = process.argv.find(a => /^--case=\d+$/.test(a));

(async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  if (!health.ok) { console.error('No API key. Put GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY in .env (see .env.example).'); process.exit(1); }
  const brain = health.api === 'openai' ? A.OpenAICompatible(`http://127.0.0.1:${port}/api/chat`, () => tier, health.label) : A.AnthropicApi(`http://127.0.0.1:${port}/api/messages`, () => tier);
  const viewer = { showPlan() {}, focus: t => String(t), drawRoute() {}, removePlan() {}, canFocus: t => /^(overview|docks|[ACHS]|D([1-9]|1[0-2])|P\d+)$/i.test(String(t)) };
  const cases = only ? E.CASES.filter(c => c.id === Number(only.split('=')[1])) : E.CASES;
  const rows = [];
  console.log(`Running ${cases.length} cases on ${health.label} ${tier === 'quick' ? health.fast : health.model}\n`);
  for (const c of cases) {
    const model = new W.WarehouseModel(W.generateSlots(2026));
    let history = [];
    if (c.setup) {
      const r = model.findSpace(c.setup.request);
      history = [{ role: 'user', content: c.setup.user }, { role: 'assistant', content: `${r.plan_id}: reserved ${r.pallets_reserved} pallets of ${r.goods} in zone ${r.zone} (${r.zone_name}), ${r.rows}, main dock ${r.main_dock}.` }];
    }
    const sitePrompt = A.instructions(model);
    const log = [];
    const hooks = { onStepStart: () => null, onStepEnd: () => {}, onText: () => {} };
    const t0 = Date.now();
    let text = '', error = null;
    try {
      ({ text } = await brain.turn({ ctx: { model, viewer, ui: { planColor: () => '--plan-1', renderReport() {}, refresh() {} } }, history, userText: c.prompt, hooks, log }));
    } catch (e) { error = e.message || e.code || String(e); }
    const run = { log, text, sources: [sitePrompt, c.prompt, ...history.map(h => h.content), ...log.map(s => s.result || '')], reserved: model.plans.reduce((a, p) => a + p.pallets_reserved, 0), plans: model.plans.length };
    const s = error ? { pass: false, checks: [{ name: 'Agent answered', pass: false, detail: error }] } : E.score(c, run, A.groundingCheck);
    const secs = (Date.now() - t0) / 1000;
    rows.push({ c, s, secs, tools: log.map(l => l.name), text });
    console.log(`${s.pass ? 'PASS' : 'FAIL'}  #${String(c.id).padEnd(2)} ${c.cat.padEnd(16)} ${secs.toFixed(1)}s  ${log.map(l => l.name).join(' → ') || '(no tools)'}`);
    for (const ch of s.checks.filter(x => !x.pass)) console.log(`        ✗ ${ch.name}: ${ch.detail}`);
  }
  server.close();
  const pass = rows.filter(r => r.s.pass).length;
  const grounded = rows.filter(r => r.s.checks.find(x => x.name === 'No invented numbers')?.pass).length;
  const md = [
    `# Test bench results`, '',
    `Model: ${health.label} ${tier === 'quick' ? health.fast : health.model} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
    `**Passed ${pass}/${rows.length}** · no invented numbers ${grounded}/${rows.length} · avg ${(rows.reduce((a, r) => a + r.secs, 0) / rows.length).toFixed(1)} s per case`, '',
    '| # | Type | Request | Result | Failed checks | Tools | Answer |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.c.id} | ${r.c.cat} | ${r.c.prompt.replace(/\|/g, '/')} | ${r.s.pass ? 'Pass' : 'Fail'} | ${r.s.checks.filter(x => !x.pass).map(x => `${x.name}: ${x.detail}`).join('; ').replace(/\|/g, '/') || '–'} | ${r.tools.join(' → ') || '–'} | ${r.text.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 300)} |`),
  ].join('\n');
  fs.mkdirSync(path.join(__dirname, '..', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'eval', `results-${tier === 'quick' ? 'fast' : 'thorough'}.md`), md);
  console.log(`\nPassed ${pass}/${rows.length}. Written to eval/results-${tier === 'quick' ? 'fast' : 'thorough'}.md`);
})();
