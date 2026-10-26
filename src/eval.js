/*
 * Test bench — 22 realistic client requests with automatic scoring.
 * Each case starts from the same fresh site, sends one message to the agent,
 * then checks what the agent DID (tool calls, reservations) and SAID
 * (required facts, no invented numbers). Deterministic tool tests run first
 * and need no AI.
 */
(function (root) {
  'use strict';
  const W = root.WarehouseCore;

  // ---------- Cases ----------
  // expect keys: zones (find_space zones, in any order), reserved (total pallets reserved after),
  // ineligible (a find_space returned eligible:false), plans (number of plans after),
  // calls (tools that must be called), noCalls (tools that must NOT be called),
  // says (regexes the answer must match), grounded (default true)
  const CASES = [
    { id: 1, cat: 'Basic', prompt: 'We need to store 400 pallets of vaccines at 2–8 °C, about 450 kg each. Where would they go?', expect: { zones: ['C'], reserved: 400, calls: ['find_space', 'draw_route'] } },
    { id: 2, cat: 'Basic', prompt: 'Can you take 300 pallets of shampoo?', expect: { zones: ['A'], reserved: 300, calls: ['draw_route'] } },
    { id: 3, cat: 'Dangerous goods', prompt: '60 pallets of lithium-ion batteries, UN3480.', expect: { zones: ['H'], reserved: 60 } },
    { id: 4, cat: 'Capacity limit', prompt: 'We import smartphones and need secure storage for 250 pallets, about 300 kg each.', expect: { zones: ['S'], reserved: 186, says: [/64|186/] } },
    { id: 5, cat: 'Rules', prompt: 'Could you store 100 pallets of frozen seafood at −18 °C?', expect: { ineligible: true, plans: 0, says: [/frozen|−18|-18|freez/i] } },
    { id: 6, cat: 'Rules', prompt: 'We have 50 pallets of propane cylinders, DG class 2.1.', expect: { ineligible: true, plans: 0, says: [/2\.1|not licen|cannot|can't|unable/i] } },
    { id: 7, cat: 'Rules', prompt: '20 pallets of a flammable (class 3) medical product that must be kept at 2–8 °C.', expect: { ineligible: true, plans: 0 } },
    { id: 8, cat: 'Rules', prompt: '80 pallets of steel parts, 1,200 kg per pallet.', expect: { ineligible: true, plans: 0, says: [/1[,.]?000|weight|heavy|beam/i] } },
    { id: 9, cat: 'Rules', prompt: '40 pallets of mattresses, each pallet is 1.9 m tall.', expect: { ineligible: true, plans: 0, says: [/1\.6|height|tall/i] } },
    { id: 10, cat: 'Reasoning', prompt: 'We need space for 150 pallets of laptops.', expect: { zones: ['S'], reserved: 150 } },
    { id: 11, cat: 'Dangerous goods', prompt: '120 pallets of solvent-based paint (flammable liquid, class 3).', expect: { zones: ['H'], reserved: 120 } },
    { id: 12, cat: 'Reasoning', prompt: 'We sell ice cream. Can you take 200 pallets?', expect: { ineligible: true, plans: 0, says: [/frozen|freez|−18|-18/i] } },
    { id: 13, cat: 'Multi-step', prompt: 'Two products: 100 pallets of rice and 30 pallets of car batteries (corrosive, class 8). Place both.', expect: { zones: ['A', 'H'], reserved: 130, plans: 2 } },
    { id: 14, cat: 'Navigation', prompt: 'Show me the chilled zone.', expect: { calls: ['move_camera'], noCalls: ['find_space'] } },
    { id: 15, cat: 'Facts', prompt: 'How many free pallet positions does the dangerous goods store have right now?', expect: { noCalls: ['find_space'], says: [/250/] } },
    {
      id: 16, cat: 'Re-planning', prompt: 'Actually, make that 350 pallets instead of 200.',
      setup: { request: { goods: 'Detergent', pallets: 200, temperature: 'ambient' }, user: 'We need space for 200 pallets of detergent.' },
      expect: { calls: ['release_plan', 'find_space'], reserved: 350, plans: 1 },
    },
    {
      id: 17, cat: 'Report', prompt: 'Please write a client summary for Acme Pharma.',
      setup: { request: { goods: 'Vaccines', pallets: 100, temperature: 'chilled' }, user: 'We need 100 pallets of vaccines at 2–8 °C.' },
      expect: { calls: ['create_client_report'], noCalls: ['find_space'], reserved: 100 },
    },
    { id: 18, cat: 'Honesty', prompt: 'Is this a real DHL warehouse?', expect: { noCalls: ['find_space'], says: [/sample|fictional|not real|demo/i] } },
    { id: 19, cat: 'Off-topic', prompt: 'Write me a poem about cats.', expect: { noCalls: ['find_space', 'draw_route', 'create_client_report'] } },
    { id: 20, cat: 'Capacity limit', prompt: 'We have 900 pallets of chilled yogurt.', expect: { zones: ['C'], reserved: 793, says: [/107|793|short/i] } },
    {
      id: 21, cat: 'Immersive', prompt: 'Show me how one of those pallets would get from the truck to its shelf.',
      setup: { request: { goods: 'Vaccines', pallets: 100, temperature: 'chilled' }, user: 'We need 100 pallets of vaccines at 2–8 °C.' },
      expect: { calls: ['follow_pallet'], noCalls: ['find_space'], reserved: 100 },
    },
    { id: 22, cat: 'Immersive', prompt: 'Give me a short guided tour of the site.', expect: { calls: ['give_tour'], noCalls: ['find_space'] } },
  ];

  // ---------- Scoring ----------
  function score(c, run, groundingCheck) {
    const e = c.expect;
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    const finds = run.log.filter(s => s.name === 'find_space' && s.ok);
    const called = new Set(run.log.map(s => s.name));
    if (e.zones) {
      const got = finds.filter(f => f.result.eligible).map(f => f.result.zone).sort();
      add('Right zone', JSON.stringify(got) === JSON.stringify([...e.zones].sort()), `expected ${e.zones.join('+')}, got ${got.join('+') || 'none'}`);
    }
    if (e.reserved != null) add('Right quantity', run.reserved === e.reserved, `expected ${e.reserved} reserved, got ${run.reserved}`);
    if (e.ineligible) add('Applied the rule', finds.some(f => !f.result.eligible), finds.length ? 'checked with find_space' : 'never checked with find_space');
    if (e.plans != null) add('No wrong reservation', run.plans === e.plans, `expected ${e.plans} plan(s), got ${run.plans}`);
    for (const t of e.calls || []) add(`Called ${t}`, called.has(t), called.has(t) ? 'yes' : 'not called');
    for (const t of e.noCalls || []) add(`Did not call ${t}`, !called.has(t), called.has(t) ? 'called it' : 'correct');
    for (const re of e.says || []) add('Said the key fact', re.test(run.text), `answer ${re.test(run.text) ? 'matches' : 'does not match'} ${re}`);
    if (e.grounded !== false) {
      const captions = run.log.filter(s => s.name === 'give_tour' && s.ok && s.input && Array.isArray(s.input.stops)).flatMap(s => s.input.stops.map(x => String(x.caption || ''))).join(' ');
      const g = groundingCheck(run.text + ' ' + captions, run.sources);
      add('No invented numbers', g.ungrounded.length === 0, g.ungrounded.length ? `not in data: ${g.ungrounded.join(', ')}` : `${g.checked} checked`);
    }
    return { pass: checks.every(x => x.pass), checks };
  }

  // ---------- Deterministic tool tests (no AI) ----------
  function toolTests() {
    const out = [];
    const t = (name, fn) => { try { const r = fn(); out.push({ name, pass: r !== false }); } catch (e) { out.push({ name, pass: false, detail: e.message }); } };
    const fresh = () => new W.WarehouseModel(W.generateSlots(2026));
    t('Site loads with 10,000+ pallet positions', () => fresh().slots.length > 10000);
    t('Zone totals add up', () => fresh().zoneStatus().every(z => z.occupied + z.blocked + z.free_now === z.total_positions));
    t('Chilled goods only go to zone C', () => fresh().findSpace({ pallets: 50, temperature: 'chilled' }).zone === 'C');
    t('Class 9 batteries go to the DG store', () => fresh().findSpace({ pallets: 5, hazmat_class: '9' }).zone === 'H');
    t('Frozen goods are refused', () => fresh().findSpace({ pallets: 5, temperature: 'frozen' }).eligible === false);
    t('Unlicensed DG class 2.1 is refused', () => fresh().findSpace({ pallets: 5, hazmat_class: '2.1' }).eligible === false);
    t('Overweight pallets are refused', () => fresh().findSpace({ pallets: 5, weight_kg_per_pallet: 1200 }).eligible === false);
    t('Heavy pallets avoid weak upper beams', () => { const m = fresh(); const r = m.findSpace({ pallets: 100, weight_kg_per_pallet: 950 }); return m.planSlots(r.plan_id).every(s => s.maxKg >= 950); });
    t('Occupied and blocked slots are never used', () => { const m = fresh(); const r = m.findSpace({ pallets: 1500 }); return m.planSlots(r.plan_id).every(s => s.status === 'free'); });
    t('No slot is reserved twice', () => { const m = fresh(); m.findSpace({ pallets: 800 }); m.findSpace({ pallets: 800 }); const a = m.plans.flatMap(p => p._slots); return new Set(a).size === a.length; });
    t('Shortfall is reported, never hidden', () => { const r = fresh().findSpace({ pallets: 1000, high_value: true }); return r.shortfall > 0 && r.pallets_reserved + r.shortfall === 1000; });
    t('Releasing a plan frees every slot', () => { const m = fresh(); const before = m.zoneStatus()[0].free_now; m.releasePlan(m.findSpace({ pallets: 70 }).plan_id); return m.zoneStatus()[0].free_now === before; });
    t('Routes start at a dock that serves the zone', () => { const m = fresh(); const r = m.findSpace({ pallets: 10, temperature: 'chilled' }); return ['D8', 'D9', 'D10'].includes(m.planRoute(r.plan_id).dock); });
    t('CSV export and import round-trip', () => { const s = W.generateSlots(); return W.fromCSV(W.toCSV(s)).slots.length === s.length; });
    return out;
  }

  // ---------- UI ----------
  let mounted = false, running = false, stopFlag = false, results = [];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  function mount(host, api) {
    if (mounted) { updateAvailability(api); return; }
    mounted = true;
    const tt = toolTests();
    const ttPass = tt.filter(x => x.pass).length;
    host.append(
      el('div', {}, el('h2', { text: 'Test bench' }),
        el('p', { style: 'margin-top:8px', text: `Proof that the agent behaves: ${CASES.length} realistic client requests, each scored on what the agent did and what it said. Every case starts from the same fresh site.` })),
      el('div', { class: 'grid2' },
        el('div', { class: 'card' },
          el('div', { class: 'score' },
            el('div', {}, el('div', { class: 'big', id: 'ev-score', text: '–' }), el('div', { class: 'lbl', text: 'Agent cases passed' })),
            el('div', {}, el('div', { class: 'big', id: 'ev-grounded', text: '–' }), el('div', { class: 'lbl', text: 'Answers with no invented numbers' })),
            el('div', {}, el('div', { class: 'big', id: 'ev-time', text: '–' }), el('div', { class: 'lbl', text: 'Avg seconds per case' }))),
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center' },
            el('button', { class: 'btn primary', id: 'ev-run', type: 'button', text: `Run all ${CASES.length} cases` }),
            el('button', { class: 'btn', id: 'ev-stop', type: 'button', text: 'Stop', hidden: '' }),
            el('button', { class: 'btn', id: 'ev-copy', type: 'button', text: 'Copy results', disabled: '' }),
            el('span', { class: 'note', id: 'ev-status' })),
          el('p', { class: 'note', id: 'ev-avail', style: 'margin-top:10px' })),
        el('div', { class: 'card' },
          el('h3', { text: `Tool tests: ${ttPass}/${tt.length} passed` }),
          el('p', { class: 'note', style: 'margin-bottom:8px', text: 'Run in your browser on every load. They test the deterministic tools the agent uses, with no AI involved.' }),
          el('ul', { style: 'margin:0;padding-left:0;list-style:none;font-size:13.5px;display:grid;gap:2px' }, ...tt.map(x => el('li', { style: x.pass ? '' : 'color:var(--critical)', text: (x.pass ? '✓ ' : '✗ ') + x.name + (x.detail ? ` (${x.detail})` : '') }))))),
      el('div', { class: 'card tablewrap' },
        el('table', { class: 'data', id: 'ev-table' },
          el('thead', {}, el('tr', {}, ...['#', 'Type', 'Client request', 'Result', 'Checks', 'Tools used'].map(h => el('th', { text: h })))),
          el('tbody', {}, ...CASES.map(c => el('tr', { id: 'ev-row-' + c.id },
            el('td', { text: String(c.id) }), el('td', { text: c.cat }),
            el('td', { style: 'min-width:240px', text: c.prompt + (c.setup ? `  (follow-up to: "${c.setup.user}")` : '') }),
            el('td', {}, el('span', { class: 'pill wait', text: 'Not run' })),
            el('td', { class: 'note', style: 'min-width:220px' }), el('td', { class: 'note mono' })))))),
      el('p', { class: 'note', text: 'Scoring is automatic and strict: a case passes only if every check passes. "No invented numbers" compares every number in the answer (except small counts up to 10) with the tool results and site data.' }));
    host.querySelector('#ev-run').addEventListener('click', () => runAll(api));
    host.querySelector('#ev-stop').addEventListener('click', () => { stopFlag = true; api.state.evalCtl && api.state.evalCtl.abort(); });
    host.querySelector('#ev-copy').addEventListener('click', e => copyResults(e.target));
    updateAvailability(api);
  }

  function updateAvailability(api) {
    const live = api.state.brain && api.state.brain.id !== 'guided';
    document.getElementById('ev-run').disabled = !live || running;
    document.getElementById('ev-avail').textContent = live
      ? `Runs on: ${api.state.brain.label}, ${api.state.tier === 'quick' ? 'Fast' : 'Thorough'} model (switch on the Preview tab). Uses your Claude usage: about ${CASES.length} short conversations.`
      : 'Agent cases need the AI, which is not available in this view. The tool tests on the right still run.';
  }

  function setRow(id, status, checks, tools) {
    const row = document.getElementById('ev-row-' + id);
    const cells = row.children;
    cells[3].innerHTML = '';
    cells[3].append(el('span', { class: 'pill ' + (status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'wait'), text: status === 'pass' ? 'Pass' : status === 'fail' ? 'Fail' : status }));
    cells[4].innerHTML = '';
    if (checks) cells[4].append(...checks.map(ch => el('div', { style: ch.pass ? '' : 'color:var(--critical)', text: `${ch.pass ? '✓' : '✗'} ${ch.name}${ch.pass ? '' : ': ' + ch.detail}` })));
    cells[5].textContent = tools || '';
  }

  async function runAll(api) {
    if (running) return;
    const { state } = api;
    running = true; stopFlag = false; results = [];
    document.getElementById('ev-run').hidden = true;
    document.getElementById('ev-stop').hidden = false;
    document.getElementById('ev-copy').disabled = true;
    const status = document.getElementById('ev-status');
    const A = root.WarehouseAgent;
    if (state.model.slots.length !== W.generateSlots(2026).length) api.loadSlots(W.generateSlots(2026));
    for (const c of CASES) setRow(c.id, 'Queued');
    for (const c of CASES) {
      if (stopFlag) { setRow(c.id, 'Skipped'); continue; }
      status.textContent = `Running case ${c.id} of ${CASES.length}…`;
      setRow(c.id, 'Running…');
      api.reset();
      let history = [];
      if (c.setup) {
        const r = state.model.findSpace(c.setup.request);
        state.viewer && state.viewer.showPlan(r.plan_id, state.model.planSlots(r.plan_id), api.planColor(r.plan_id));
        history = [{ role: 'user', content: c.setup.user }, { role: 'assistant', content: `${r.plan_id}: reserved ${r.pallets_reserved} pallets of ${r.goods} in zone ${r.zone} (${r.zone_name}), ${r.rows}, main dock ${r.main_dock}.` }];
      }
      const sitePrompt = A.instructions(state.model);
      const log = [];
      const t0 = performance.now();
      const hooks = { onStepStart: () => null, onStepEnd: () => {}, onText: () => {} };
      state.evalCtl = new AbortController();
      let text = '', error = null;
      try {
        const r = await state.brain.turn({
          ctx: { model: state.model, viewer: state.viewer, ui: { planColor: api.planColor, renderReport: () => {}, refresh: api.refresh } },
          history, userText: c.prompt, hooks, signal: state.evalCtl.signal, log,
        });
        text = r.text;
      } catch (e) { error = e && (e.code || e.message) || 'error'; text = (e && e.text) || ''; }
      const secs = (performance.now() - t0) / 1000;
      const run = {
        log, text, sources: [sitePrompt, c.prompt, ...history.map(h => h.content), ...log.map(s => s.result || '')],
        reserved: state.model.plans.reduce((a, p) => a + p.pallets_reserved, 0), plans: state.model.plans.length,
      };
      const s = error ? { pass: false, checks: [{ name: 'Agent answered', pass: false, detail: String(error) }] } : score(c, run, A.groundingCheck);
      const grounded = !error && s.checks.find(x => x.name === 'No invented numbers')?.pass;
      results.push({ id: c.id, cat: c.cat, prompt: c.prompt, pass: s.pass, grounded, secs, checks: s.checks, tools: log.map(x => x.name), answer: text });
      setRow(c.id, s.pass ? 'pass' : 'fail', s.checks, log.map(x => x.name).join(' → ') || '(none)');
      updateScore();
      if (error === 'rate_limited' || error === 'not_granted' || error === 'cancelled') { stopFlag = true; status.textContent = error === 'cancelled' ? 'Stopped.' : `Stopped: ${error}.`; }
    }
    api.reset();
    running = false;
    document.getElementById('ev-run').hidden = false;
    document.getElementById('ev-stop').hidden = true;
    document.getElementById('ev-copy').disabled = !results.length;
    if (!stopFlag) status.textContent = `Finished ${new Date().toLocaleString()}.`;
    updateAvailability(api);
  }

  function updateScore() {
    const n = results.length;
    const pass = results.filter(r => r.pass).length;
    const g = results.filter(r => r.grounded).length;
    document.getElementById('ev-score').textContent = `${pass}/${n}`;
    document.getElementById('ev-grounded').textContent = `${g}/${n}`;
    document.getElementById('ev-time').textContent = n ? (results.reduce((a, r) => a + r.secs, 0) / n).toFixed(1) : '–';
  }

  async function copyResults(btn) {
    const n = results.length, pass = results.filter(r => r.pass).length;
    const md = [`Warehouse Preview Agent — test bench results (${new Date().toLocaleDateString()})`, `Passed ${pass}/${n} · no invented numbers ${results.filter(r => r.grounded).length}/${n}`, '',
      '| # | Type | Result | Failed checks | Tools |', '|---|---|---|---|---|',
      ...results.map(r => `| ${r.id} | ${r.cat} | ${r.pass ? 'Pass' : 'Fail'} | ${r.checks.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`).join('; ') || '–'} | ${r.tools.join(' → ') || '–'} |`)].join('\n');
    try { await navigator.clipboard.writeText(md); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => (btn.textContent = 'Copy results'), 1800);
  }

  root.WarehouseEval = { CASES, score, toolTests, mount };
})(typeof self !== 'undefined' ? self : this);
