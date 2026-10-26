/* App wiring: model + 3D viewer + agent chat + tabs. */
(function () {
  'use strict';
  const W = window.WarehouseCore, A = window.WarehouseAgent;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const fmt = n => Number(n).toLocaleString('en-IN');

  const state = {
    model: new W.WarehouseModel(W.generateSlots(2026)),
    viewer: null, brain: null, tier: 'quick', history: [], busy: false, ctl: null, currentMsg: null,
  };
  window.__app = state; // handy for debugging and the test bench

  // ---------- 3D ----------
  function startViewer() {
    if (!window.THREE || !THREE.OrbitControls) {
      $('#loading').textContent = 'The 3D library could not load. Check your connection and reload.';
      return;
    }
    state.viewer = new WarehouseViewer($('#stage'), state.model, { onSelect: showSlot });
    $('#loading').remove();
    state.fx = state.viewer.fx = new WarehouseImmersive(state.viewer, state.model, { onMode, caption, location: whereAmI });
  }

  // ---------- Immersive UI ----------
  const HINTS = {
    orbit: 'Drag to rotate · scroll to zoom · click a pallet',
    walk: 'W A S D or arrows to move · drag to look · Shift to run · Esc to leave',
    journey: 'Esc to skip',
    tour: 'Esc for the next stop',
  };
  const touchy = () => window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 860;
  function setBtn(id, pressed, label) {
    const b = $(id); b.setAttribute('aria-pressed', String(pressed)); b.setAttribute('aria-label', label); b.querySelector('span').textContent = label;
  }
  function onMode(mode) {
    const st = $('#stage');
    st.classList.remove('mode-orbit', 'mode-walk', 'mode-journey', 'mode-tour');
    st.classList.add('mode-' + mode);
    $('#hint').textContent = HINTS[mode] || HINTS.orbit;
    setBtn('#btn-walk', mode === 'walk', mode === 'walk' ? 'Exit walk' : 'Walk inside');
    setBtn('#btn-tour', mode === 'tour', mode === 'tour' ? 'Stop tour' : 'Site tour');
    $('#pad').hidden = !(mode === 'walk' && touchy());
    $('#slot-card').hidden = true;
  }
  function caption(c) {
    const box = $('#caption');
    if (!c) { box.hidden = true; return; }
    $('#cap-title').textContent = c.title || '';
    $('#cap-text').textContent = c.text || '';
    const steps = $('#cap-steps'); steps.innerHTML = '';
    for (let i = 1; i <= (c.steps || 0); i++) steps.append(el('i', { class: i <= c.step ? 'on' : '' }));
    $('#cap-skip').textContent = c.skipLabel || 'Skip';
    $('#cap-skip').onclick = c.onSkip || null;
    box.hidden = false;
  }
  function whereAmI(text) { $('#where').textContent = text; $('#where').hidden = !text; }
  function followButton(planId) {
    const b = el('button', { class: 'follow', type: 'button' });
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1v10l9-5z" fill="currentColor"/></svg>';
    b.append(`Follow a pallet of ${planId}`);
    b.addEventListener('click', () => {
      if (!state.fx) return;
      if (!state.model.getPlan(planId)) { b.textContent = `${planId} was released`; b.disabled = true; return; }
      showTab('preview'); state.fx.followPallet(planId);
    });
    return b;
  }
  const tourText = log => log.filter(s => s.name === 'give_tour' && s.ok && s.input && Array.isArray(s.input.stops)).flatMap(s => s.input.stops.map(x => String(x.caption || ''))).join(' ');

  function showSlot(slot, planId, e) {
    const card = $('#slot-card');
    if (!slot) { card.hidden = true; return; }
    const z = W.zoneById(slot.zone);
    const plan = planId ? state.model.getPlan(planId) : null;
    card.innerHTML = '';
    card.append(
      el('h4', { text: slot.id }),
      el('dl', {},
        el('dt', { text: 'Zone' }), el('dd', { text: `${z.id} ${z.name} (${z.temp.min}–${z.temp.max} °C)` }),
        el('dt', { text: 'Row · bay · level' }), el('dd', { text: `${slot.row} · ${slot.bay} · ${slot.level}` }),
        el('dt', { text: 'Beam limit' }), el('dd', { text: `${slot.maxKg} kg per pallet` }),
        el('dt', { text: 'Status' }), el('dd', { text: plan ? `Reserved for ${plan.plan_id} (${plan.goods})` : slot.status === 'blocked' ? `Blocked: ${slot.note}` : 'Occupied by an existing client' }),
      ));
    const r = $('#stage').getBoundingClientRect();
    card.hidden = false;
    const x = Math.min(e.clientX - r.left + 14, r.width - card.offsetWidth - 8);
    const y = Math.min(e.clientY - r.top + 14, r.height - card.offsetHeight - 8);
    card.style.left = Math.max(8, x) + 'px'; card.style.top = Math.max(8, y) + 'px';
  }

  // ---------- Capacity strip ----------
  function refresh() {
    const box = $('#capacity');
    box.querySelectorAll('.cap-row').forEach(n => n.remove());
    for (const z of state.model.zoneStatus()) {
      const used = ((z.occupied + z.blocked) / z.total_positions) * 100;
      const res = (z.reserved_in_this_session / z.total_positions) * 100;
      box.append(el('div', { class: 'cap-row', title: `${z.name}: ${z.free_now} free of ${z.total_positions}` },
        el('b', { style: `background:var(--zone-${z.zone})`, text: z.zone }),
        el('div', { class: 'bar', role: 'img', 'aria-label': `${z.name}: ${Math.round(used)}% occupied, ${Math.round(res)}% reserved by your plans` },
          el('i', { class: 'used', style: `width:${used}%` }), el('i', { class: 'res', style: `width:${res}%` })),
        el('span', { class: 'num', text: `${fmt(z.free_now)} free` })));
    }
  }

  const planColor = id => A.PLAN_COLORS[(parseInt(String(id).replace(/\D/g, ''), 10) - 1) % A.PLAN_COLORS.length];

  // ---------- Report ----------
  function renderReport(rep) {
    const host = state.currentMsg || $('#chat');
    const rows = rep.plans.map(p => el('tr', {},
      el('td', {}, el('span', { class: 'sw', style: `display:inline-block;vertical-align:-1px;margin-right:5px;background:var(${planColor(p.plan_id)})` }), p.plan_id),
      el('td', { text: p.goods }),
      el('td', { text: `${p.zone} ${p.zone_name}` }),
      el('td', { text: `${fmt(p.pallets_reserved)} / ${fmt(p.pallets_requested)}` }),
      el('td', { class: 'mono', text: p.rows }),
      el('td', { text: p.main_dock }),
      el('td', { text: `${p.avg_travel_m} m` }),
      el('td', { text: `${p.putaway_forklift_hours} h` })));
    const notes = rep.plans.flatMap(p => (p.notes || []).map(n => `${p.plan_id}: ${n}`));
    const asText = () => [
      `Client summary — ${rep.client}`, `${rep.site} (${rep.note})`, '',
      ...rep.plans.map(p => `${p.plan_id} ${p.goods}: ${p.pallets_reserved}/${p.pallets_requested} pallets, zone ${p.zone} ${p.zone_name} (${p.temperature}), ${p.rows}, dock ${p.main_dock}, avg travel ${p.avg_travel_m} m, put-away ${p.putaway_forklift_hours} forklift-hours${p.shortfall ? `, short by ${p.shortfall}` : ''}`),
      '', `Total reserved: ${rep.total_pallets_reserved} pallets. Shortfall: ${rep.total_shortfall}. Put-away: ${rep.total_putaway_forklift_hours} forklift-hours.`,
      ...(notes.length ? ['', 'Notes:', ...notes] : []),
      ...(rep.open_questions.length ? ['', 'To confirm:', ...rep.open_questions.map(q => '- ' + q)] : []),
      '', `Assumptions: ${rep.assumptions}`].join('\n');
    const copyBtn = el('button', { class: 'btn', type: 'button', text: 'Copy as text' });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(asText()); copyBtn.textContent = 'Copied'; }
      catch { const ta = el('textarea'); ta.value = asText(); document.body.append(ta); ta.select(); try { document.execCommand('copy'); copyBtn.textContent = 'Copied'; } catch { copyBtn.textContent = 'Select and copy manually'; } ta.remove(); }
      setTimeout(() => (copyBtn.textContent = 'Copy as text'), 1800);
    });
    host.append(el('div', { class: 'report' },
      el('h3', { text: `Client summary · ${rep.client}` }),
      el('div', { class: 'sub', text: `${rep.site} · ${rep.note}` }),
      el('div', { class: 'tw' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Plan', 'Goods', 'Zone', 'Pallets', 'Rows', 'Dock', 'Avg travel', 'Put-away'].map(h => el('th', { text: h })))),
        el('tbody', {}, ...rows))),
      el('p', { style: 'margin:8px 0 0', text: `Total reserved ${fmt(rep.total_pallets_reserved)} pallets · shortfall ${fmt(rep.total_shortfall)} · put-away ${rep.total_putaway_forklift_hours} forklift-hours` }),
      notes.length ? el('ul', {}, ...notes.map(n => el('li', { text: n }))) : null,
      rep.open_questions.length ? el('div', {}, el('p', { style: 'margin:8px 0 0;font-weight:600', text: 'To confirm with you' }), el('ul', {}, ...rep.open_questions.map(q => el('li', { text: q })))) : null,
      el('p', { class: 'note', style: 'margin-top:8px', text: `Assumptions: ${rep.assumptions}` }),
      el('div', { class: 'actions' }, copyBtn)));
    scrollChat();
  }

  // ---------- Chat ----------
  const ICONS = {
    run: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 18"/></svg>',
    ok: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--good)"/><path d="M4.5 8.2l2.2 2.2 4.8-4.8" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',
    fail: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--critical)"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8"/></svg>',
  };
  const scrollChat = () => { const c = $('#chat'); c.scrollTop = c.scrollHeight; };

  function addUser(text) {
    $('#welcome') && $('#welcome').remove();
    $('#chat').append(el('div', { class: 'msg user', text }));
    scrollChat();
  }

  function addAgent() {
    const steps = el('ol', { class: 'steps', hidden: '' });
    const text = el('div', { class: 'text thinking', text: 'Thinking…' });
    const msg = el('div', { class: 'msg agent' }, el('div', { class: 'who' }, el('span', { text: 'Agent' })), steps, text);
    $('#chat').append(msg);
    scrollChat();
    return { msg, steps, text };
  }

  async function send(userText, scenario) {
    if (state.busy || !state.brain) return;
    if (!state.viewer) { addUser(userText); addAgent().text.textContent = 'The 3D view is not available, so I cannot plan in it right now.'; return; }
    state.busy = true;
    setBusy(true);
    addUser(userText);
    const ui = addAgent();
    state.currentMsg = ui.msg;
    const log = [];
    const hooks = {
      onStepStart({ tool, input }) {
        ui.steps.hidden = false;
        const li = el('li', { class: 'step run' });
        li.dataset.tool = tool.name;
        li.innerHTML = ICONS.run;
        li.append(el('div', {}, el('span', { class: 'name', text: tool.label }), el('span', { class: 'res', text: tool.pending(input || {}) + '…' })));
        ui.steps.append(li);
        scrollChat();
        return li;
      },
      onStepEnd(li, r) {
        li.className = 'step ' + (r.ok ? 'ok' : 'fail');
        li.querySelector('.ic').outerHTML = r.ok ? ICONS.ok : ICONS.fail;
        li.querySelector('.res').textContent = r.summary;
        if (li.dataset.tool === 'find_space' && r.ok && r.result.eligible && r.result.pallets_reserved > 0) li.after(followButton(r.result.plan_id));
        scrollChat();
      },
      onText(t) { ui.text.classList.remove('thinking'); ui.text.textContent = t; scrollChat(); },
    };
    const sitePrompt = A.instructions(state.model); // snapshot used for the grounding check
    state.ctl = new AbortController();
    try {
      const { text, truncated } = await state.brain.turn({
        ctx: { model: state.model, viewer: state.viewer, ui: { planColor, renderReport, refresh } },
        history: state.history.slice(-10), userText, scenario, hooks, signal: state.ctl.signal, log,
      });
      ui.text.classList.remove('thinking');
      ui.text.textContent = text;
      if (truncated) ui.msg.append(el('div', { class: 'note', text: 'The answer was cut short. Ask for less at a time.' }));
      const g = A.groundingCheck(text + ' ' + tourText(log), [sitePrompt, userText, ...log.map(s => s.result || '')]);
      ui.msg.append(el('span', { class: 'badge ' + (g.ungrounded.length ? 'warn' : 'ok'), title: 'Numbers in this answer were compared with the tool results and site data.' },
        g.ungrounded.length ? `Check: ${g.ungrounded.join(', ')} not found in the data` : `${g.checked} number${g.checked === 1 ? '' : 's'} traced to data · ${log.length} tool call${log.length === 1 ? '' : 's'}`));
      state.history.push({ role: 'user', content: userText }, { role: 'assistant', content: text });
    } catch (e) {
      const code = e && e.code;
      ui.text.classList.remove('thinking');
      if (code === 'cancelled') ui.text.textContent = (e.text || '') + (e.text ? '\n\n' : '') + 'Stopped.';
      else if (['not_granted', 'sampling_disabled', 'tools_unavailable', 'not_declared', 'capability_disabled'].includes(code)) {
        ui.text.textContent = 'AI chat is not available in this view, so I switched to the guided demo. Pick a scenario below to watch the same tools run.';
        setBrain(A.GuidedDemo());
      } else if (code === 'rate_limited') ui.text.textContent = 'Too many requests just now. Wait a minute and send again.';
      else if (code === 'session_expired') ui.text.textContent = 'Your Claude session expired. Sign in again, then resend.';
      else ui.text.textContent = (e.text ? e.text + '\n\n' : '') + `Something went wrong reaching the AI${e.message ? ` (${e.message})` : ''}. Send again, or use a guided scenario.`;
    } finally {
      state.busy = false; state.currentMsg = null;
      if (state.pendingBrain) { setBrain(state.pendingBrain); state.pendingBrain = null; }
      setBusy(false);
      refresh();
    }
  }

  function setBusy(b) {
    $('#send').hidden = b; $('#stop').hidden = !b;
    $('#input').disabled = b;
    document.querySelectorAll('.chip').forEach(c => (c.disabled = b));
  }

  function setBrain(brain) {
    state.brain = brain;
    const live = brain.id !== 'guided';
    $('#brain-dot').className = 'dot ' + (live ? 'live' : 'demo');
    $('#brain-label').textContent = brain.label;
    $('#input').placeholder = live ? 'e.g. 400 pallets of vaccines at 2–8 °C' : 'AI is off here. Try a scenario above.';
    $('#input').disabled = !live;
    $('#send').disabled = !live;
    document.querySelector('.composer .meta .seg').parentElement.hidden = !live;
  }

  async function detectBrain() {
    const tier = () => state.tier;
    if (window.claude && typeof window.claude.use === 'function') {
      try {
        const sample = await window.claude.use('sample');
        if (sample) {
          const lim = await sample.limits().catch(() => null);
          if (lim && lim.tools) return A.ClaudeInArtifact(sample, tier);
        }
      } catch { /* fall through */ }
    }
    if (location.protocol !== 'file:') try {
      const r = await fetch('api/health', { cache: 'no-store' });
      const h = r.ok ? await r.json() : null;
      if (h && h.ok && h.api === 'openai') return A.OpenAICompatible('api/chat', tier, `${h.label} · ${h.model}`);
      if (h && h.ok) return Object.assign(A.AnthropicApi('api/messages', tier), { label: `Claude API · ${h.model}` });
    } catch { /* not served by server.js */ }
    return A.GuidedDemo();
  }

  // ---------- Tabs ----------
  const TABS = ['preview', 'tests', 'about'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'preview';
    for (const t of TABS) {
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
      $('#view-' + t).hidden = t !== name;
    }
    if (name === 'preview' && state.viewer) state.viewer.resize();
    if (name === 'tests' && window.WarehouseEval) window.WarehouseEval.mount($('#tests-root'), api);
    if (name === 'about' && window.WarehouseAbout) window.WarehouseAbout.mount($('#about-root'), api);
  }

  // Public surface for the test bench and the About page
  const api = {
    state, send, refresh, planColor, renderReport, showTab, setBrain,
    reset() {
      state.fx && state.fx.stopAll();
      state.model.clearAll(); state.viewer && state.viewer.clearPlans(); state.history = []; refresh();
    },
    loadSlots(slots) {
      state.model.load(slots); state.history = [];
      if (state.viewer) { state.fx && state.fx.stopAll(); state.viewer.rebuild(); state.fx && state.fx.rebuild(); }
      refresh();
    },
  };
  window.__api = api;

  // ---------- Boot ----------
  function boot() {
    startViewer();
    refresh();
    const chips = $('#chips');
    for (const s of A.SCENARIOS) chips.append(el('button', { class: 'chip', type: 'button', text: s.chip, onclick: () => send(s.prompt, s) }));
    $('#form').addEventListener('submit', e => { e.preventDefault(); const t = $('#input').value.trim(); if (t) { $('#input').value = ''; send(t); } });
    $('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
    $('#input').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
    $('#stop').addEventListener('click', () => state.ctl && state.ctl.abort());
    $('#reset').addEventListener('click', () => {
      api.reset(); state.viewer && state.viewer.focus('overview');
      $('#chat').append(el('div', { class: 'note', text: 'Plans cleared. All reserved positions are free again.' })); scrollChat();
    });
    for (const t of ['quick', 'default']) $('#tier-' + t).addEventListener('click', () => {
      state.tier = t;
      $('#tier-quick').setAttribute('aria-pressed', String(t === 'quick'));
      $('#tier-default').setAttribute('aria-pressed', String(t === 'default'));
    });
    document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => {
      if (!state.viewer) return;
      if (state.fx && state.fx.mode === 'walk' && state.fx.teleport(b.dataset.cam)) return;
      state.viewer.focus(b.dataset.cam);
    }));
    $('#btn-walk').addEventListener('click', () => { if (!state.fx) return; state.fx.mode === 'walk' ? state.fx.exitWalk() : state.fx.enterWalk(); });
    $('#btn-tour').addEventListener('click', () => { if (!state.fx) return; state.fx.mode === 'tour' ? state.fx.stopTour() : state.fx.startTour(state.fx.defaultTour(), 'Site tour'); });
    $('#btn-sound').addEventListener('click', async () => {
      if (!state.fx) return;
      const on = await state.fx.sound.toggle();
      setBtn('#btn-sound', on, on ? 'Sound on' : 'Sound off');
    });
    const PAD = { f: [1, 0, 0], b: [-1, 0, 0], l: [0, -1, 0], r: [0, 1, 0], tl: [0, 0, 1], tr: [0, 0, -1] };
    document.querySelectorAll('[data-pad]').forEach(b => {
      const go = e => { e.preventDefault(); state.fx && state.fx.setPad(...PAD[b.dataset.pad]); };
      const stop = () => state.fx && state.fx.setPad(0, 0, 0);
      b.addEventListener('pointerdown', go); b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
    });
    if (state.fx) onMode('orbit');
    TABS.forEach(t => $('#tab-' + t).addEventListener('click', () => showTab(t)));
    showTab((location.hash || '').slice(1));
    // Guided demo works at once; upgrade to the live AI as soon as it is found.
    setBrain(A.GuidedDemo());
    $('#brain-label').textContent = 'Looking for AI…';
    detectBrain().then(b => { if (!state.busy || b.id === 'guided') setBrain(b); else state.pendingBrain = b; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
