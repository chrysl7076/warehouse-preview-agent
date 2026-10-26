/*
 * The agent: tools + instructions + an agent loop that works with three "brains".
 *
 *  1. ClaudeInArtifact — when the page runs inside claude.ai, Claude is reached
 *     through the page's `sample` capability (tools run here, in the page).
 *  2. AnthropicApi     — when the page is served by server.js with your own
 *     API key, this file runs the classic tool-use loop against the
 *     Messages API (plan → call tools → read results → repeat → answer).
 *  3. GuidedDemo       — no AI available: scripted scenarios call the SAME
 *     tools so the demo never breaks; clearly labelled as scripted.
 *
 * Tools are deterministic (WarehouseCore). The model decides WHICH tools to
 * call and how to explain the result; it never computes capacity itself.
 */
(function (root) {
  'use strict';
  const W = root.WarehouseCore;

  const PLAN_COLORS = ['--plan-1', '--plan-2', '--plan-3', '--plan-4'];

  // ---------- Instructions ----------
  function instructions(model) {
    const summary = model.siteSummary();
    const plans = model.plans.map(p => model.publicPlan(p));
    return [
      'You are the Warehouse Preview Agent. A prospective logistics client is looking at a live 3D model of a warehouse next to this chat, and you change what they see by calling tools.',
      'The site is FICTIONAL sample data ("Demo DC-01, Bhiwandi") built for a concept prototype. If asked whether it is real, say it is sample data and that real site data can be loaded as a CSV.',
      '',
      'How to work:',
      '- Every capacity, location, distance, time or rule you mention must come from a tool result or the SITE DATA below. Never estimate or invent numbers.',
      '- When the client describes goods, call find_space once per distinct type of goods (in the same turn when there are several), then draw_route for each new plan, then answer. find_space already highlights the slots in the 3D view and moves the camera.',
      '- If find_space returns eligible:false, explain the reason and the suggestion plainly. Do not put the goods in a zone the rules forbid.',
      '- If the client changes a requirement, call release_plan on the old plan first, then plan again.',
      '- Missing details: assume ambient, 500 kg and 1.4 m per pallet, not dangerous, not high value. State the assumption in one short sentence.',
      '- Use plan IDs (P1, P2…) so the client can match them to the colours on screen. State any shortfall clearly.',
      '- Answer in at most 110 words of plain sentences. No headings, tables or bullet lists.',
      '- After a plan, offer a client summary. Call create_client_report only when the client asks for a report or summary.',
      '- To let the client experience the site: call follow_pallet when they want to see how their goods arrive, travel or get stored (it needs an existing plan); call give_tour when they ask for a tour, a walkthrough or an overview of the site. Tour captions are shown and read aloud: at most 25 words each, only facts from SITE DATA or tool results.',
      '- After a plan you may also offer to show a pallet\'s journey.',
      '- For questions unrelated to warehousing for this client, decline briefly and steer back.',
      '',
      'SITE DATA (live):',
      JSON.stringify(summary),
      '',
      'PLANS ALREADY MADE IN THIS SESSION:',
      plans.length ? JSON.stringify(plans) : 'none',
    ].join('\n');
  }

  // ---------- Tools ----------
  function buildTools(ctx) {
    // ctx: { model, viewer, ui }  — ui.planColor(id), ui.renderReport(data), ui.refresh()
    const { model, viewer, ui } = ctx;
    const tools = [
      {
        name: 'find_space',
        label: 'Find space',
        description: 'Applies the site rules to the goods, picks the right zone, and reserves the nearest free pallet positions to the dock. Highlights them in 3D and moves the camera. Returns eligible:false with a reason when the site cannot take the goods; otherwise the plan (plan_id, zone, pallets reserved, shortfall, rows, dock, travel distances, put-away forklift hours).',
        inputSchema: {
          type: 'object',
          properties: {
            goods: { type: 'string', description: 'Short label, e.g. "Vaccines" or "Lithium batteries"' },
            pallets: { type: 'integer', minimum: 1, description: 'Number of pallets' },
            temperature: { type: 'string', enum: ['ambient', 'chilled', 'frozen'], description: 'chilled = 2–8 °C; frozen = −18 °C' },
            hazmat_class: { type: 'string', description: 'Dangerous-goods class such as "3", "8", "9", "2.1". Leave out if the goods are not dangerous.' },
            high_value: { type: 'boolean', description: 'True for high-value goods needing a secure cage (electronics, phones, luxury)' },
            weight_kg_per_pallet: { type: 'number', description: 'Default 500' },
            pallet_height_m: { type: 'number', description: 'Including the pallet base. Default 1.4' },
          },
          required: ['goods', 'pallets'],
        },
        run(input) {
          const r = model.findSpace(input);
          if (r.eligible && r.pallets_reserved > 0) {
            viewer.showPlan(r.plan_id, model.planSlots(r.plan_id), ui.planColor(r.plan_id));
            viewer.focus(r.plan_id);
          }
          ui.refresh();
          return r;
        },
        summarize(input, r) {
          if (!r.eligible) return `Not possible: ${r.reason}`;
          return `${r.plan_id}: reserved ${r.pallets_reserved}/${r.pallets_requested} in zone ${r.zone} (${r.zone_name}) · ${r.rows} · dock ${r.main_dock}` + (r.shortfall ? ` · short by ${r.shortfall}` : '');
        },
        pending: input => `Checking rules and free space for ${input.pallets ?? '?'} pallets of ${input.goods || 'goods'}`,
      },
      {
        name: 'draw_route',
        label: 'Draw route',
        description: 'Draws the forklift route from a dock to the middle of a plan in the 3D view and returns distance_m and one_way_minutes. Uses the plan\'s main dock unless a dock (D1–D12) that serves the zone is given.',
        inputSchema: {
          type: 'object',
          properties: { plan_id: { type: 'string' }, dock: { type: 'string', description: 'Optional, e.g. "D9"' } },
          required: ['plan_id'],
        },
        run(input) {
          const r = model.planRoute(String(input.plan_id), input.dock ? String(input.dock) : undefined);
          viewer.drawRoute(r.plan_id, r.points, ui.planColor(r.plan_id));
          const { points, ...rest } = r;
          return rest;
        },
        summarize: (i, r) => `${r.plan_id}: ${r.dock} → ${r.to_location}, ${r.distance_m} m (${r.one_way_minutes} min one way)`,
        pending: i => `Drawing the route for ${i.plan_id}`,
      },
      {
        name: 'move_camera',
        label: 'Move camera',
        description: 'Flies the 3D camera to "overview", "docks", a zone ("A", "C", "H", "S"), a dock ("D1"–"D12") or a plan id ("P1").',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        run(input) { return { now_showing: viewer.focus(String(input.target)) }; },
        summarize: (i, r) => `Showing ${r.now_showing}`,
        pending: i => `Moving the camera to ${i.target}`,
      },
      {
        name: 'get_site_status',
        label: 'Check site status',
        description: 'Returns live free, occupied, blocked and reserved positions per zone, plus the plans made so far. Use after plans change.',
        inputSchema: { type: 'object', properties: {} },
        run() { return { zones: model.zoneStatus(), plans: model.plans.map(p => model.publicPlan(p)) }; },
        summarize: (i, r) => r.zones.map(z => `${z.zone} ${z.free_now} free`).join(' · '),
        pending: () => 'Reading live zone status',
      },
      {
        name: 'release_plan',
        label: 'Release plan',
        description: 'Cancels a plan, frees its reserved positions and removes it from the 3D view. Use before re-planning changed requirements.',
        inputSchema: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] },
        run(input) {
          const r = model.releasePlan(String(input.plan_id));
          viewer.removePlan(r.released);
          ui.refresh();
          return r;
        },
        summarize: (i, r) => `Released ${r.released} (${r.pallets_freed} positions freed)`,
        pending: i => `Releasing ${i.plan_id}`,
      },
      {
        name: 'follow_pallet',
        label: 'Follow a pallet',
        description: 'Plays an animated journey of one pallet of an existing plan in the 3D view: the truck docks, a forklift carries the pallet along the route and lifts it into its slot, with captions. Returns the facts of that trip (dock, location, level, lift height, distance, one-way minutes, cycle seconds).',
        inputSchema: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] },
        run(input) {
          const id = String(input.plan_id);
          const j = viewer.fx ? viewer.fx.followPallet(id) : model.journey(id);
          const { points, slot, ...rest } = j;
          return Object.assign(rest, { playing_in_3d: !!viewer.fx });
        },
        summarize: (i, r) => `${r.plan_id}: ${r.dock} → ${r.location}, level ${r.level} (${r.lift_height_m} m), ${r.distance_m} m`,
        pending: i => `Starting the pallet journey for ${i.plan_id}`,
      },
      {
        name: 'give_tour',
        label: 'Guided tour',
        description: 'Plays a narrated camera tour in the 3D view. Give 3–6 stops in order; each has a target ("overview", "docks", a zone "A", "C", "H" or "S", a dock "D1"–"D12", or a plan id) and a caption of at most 25 words using only facts from SITE DATA or tool results. Returns the stops accepted.',
        inputSchema: {
          type: 'object',
          properties: { stops: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: { target: { type: 'string' }, caption: { type: 'string' } }, required: ['target', 'caption'] } } },
          required: ['stops'],
        },
        run(input) {
          const stops = (Array.isArray(input.stops) ? input.stops : []).slice(0, 6).map(x => ({ target: String((x && x.target) || ''), caption: String((x && x.caption) || '').slice(0, 240) }));
          if (!stops.length) throw new Error('Give at least one stop.');
          const bad = stops.filter(x => !viewer.canFocus(x.target));
          if (bad.length) throw new Error(`Unknown target(s): ${bad.map(b => b.target).join(', ')}. Use overview, docks, A, C, H, S, D1–D12 or a plan id.`);
          if (viewer.fx) viewer.fx.startTour(stops, 'Guided tour');
          return { started: true, stops: stops.length, targets: stops.map(x => x.target) };
        },
        summarize: (i, r) => `${r.stops} stops: ${r.targets.join(' → ')}`,
        pending: () => 'Preparing a guided tour',
      },
      {
        name: 'create_client_report',
        label: 'Write client report',
        description: 'Builds a one-page client summary from all current plans (zones, locations, docks, travel, put-away effort, shortfalls, assumptions) and shows it in the panel. Returns the totals.',
        inputSchema: {
          type: 'object',
          properties: {
            client_name: { type: 'string' },
            open_questions: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short questions the client should confirm' },
          },
        },
        run(input) {
          const rep = model.reportData(input.client_name);
          rep.open_questions = Array.isArray(input.open_questions) ? input.open_questions.slice(0, 4).map(String) : [];
          if (!rep.plans.length) throw new Error('There are no plans yet. Plan space first with find_space.');
          ui.renderReport(rep);
          const { plans, ...totals } = rep;
          return Object.assign(totals, { plans: plans.length });
        },
        summarize: (i, r) => `Report for ${r.client}: ${r.total_pallets_reserved} pallets across ${r.plans} plan(s)`,
        pending: () => 'Writing the client report',
      },
    ];
    return tools;
  }

  // ---------- Grounding check: is every number in the answer traceable? ----------
  const NUM_RE = /(?<![A-Za-z0-9\-–])\d[\d,]*(?:\.\d+)?(?![\d])/g;
  function numbersIn(text) {
    return (String(text).match(NUM_RE) || []).map(s => s.replace(/,/g, '')).map(Number).filter(Number.isFinite);
  }
  function groundingCheck(answer, sources) {
    const pool = new Set();
    for (const src of sources) for (const n of numbersIn(typeof src === 'string' ? src : JSON.stringify(src))) pool.add(n);
    const found = numbersIn(answer);
    const checked = found.filter(n => !(Number.isInteger(n) && n <= 10)); // small counts ("2 plans") are exempt
    const ungrounded = checked.filter(n => {
      if (pool.has(n)) return false;
      for (const p of pool) if (Math.round(p) === n || Math.abs(p - n) < 0.051) return false; // rounding of a real value
      return true;
    });
    return { checked: checked.length, ungrounded: [...new Set(ungrounded)] };
  }

  // ---------- Brains ----------
  async function runTool(tool, input, hooks, signal) {
    const step = hooks.onStepStart({ tool, input });
    try {
      if (signal && signal.aborted) throw new Error('Stopped');
      const result = tool.run(input || {});
      hooks.onStepEnd(step, { ok: true, result, summary: tool.summarize(input || {}, result) });
      return { ok: true, result };
    } catch (e) {
      hooks.onStepEnd(step, { ok: false, error: e.message, summary: e.message });
      return { ok: false, error: e.message };
    }
  }

  /** Brain 1: Claude inside claude.ai via the artifact `sample` capability. */
  function ClaudeInArtifact(sample, tier) {
    return {
      id: 'claude-artifact', label: 'Claude (in claude.ai)',
      async turn({ ctx, history, userText, hooks, signal, log }) {
        const tools = buildTools(ctx).map(t => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          execute: async input => {
            const r = await runTool(t, input, hooks, signal);
            log.push({ name: t.name, input, ...r });
            if (!r.ok) throw new Error(r.error);
            return r.result;
          },
        }));
        const turns = [{ role: 'user', content: instructions(ctx.model) }, ...history, { role: 'user', content: userText }];
        const { text, truncated } = await sample(turns, {
          tools, signal, modelTier: tier(),
          onText: ({ text }) => hooks.onText(text),
        });
        return { text, truncated };
      },
    };
  }

  /** Brain 2: your own Anthropic API key through server.js (classic tool-use loop). */
  function AnthropicApi(endpoint, tier) {
    return {
      id: 'anthropic-api', label: 'Claude API (your key)',
      async turn({ ctx, history, userText, hooks, signal, log }) {
        const toolList = buildTools(ctx);
        const messages = [...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: userText }];
        let text = '';
        for (let round = 0; round < 8; round++) {
          const res = await fetch(endpoint, {
            method: 'POST', signal, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              tier: tier(), max_tokens: 1200, system: instructions(ctx.model), messages,
              tools: toolList.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw { code: 'upstream_error', message: data.error?.message || data.error || `API error ${res.status}` };
          messages.push({ role: 'assistant', content: data.content });
          const said = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          if (said) { text = text ? text + '\n\n' + said : said; hooks.onText(text); }
          if (data.stop_reason !== 'tool_use') return { text, truncated: data.stop_reason === 'max_tokens' };
          const calls = data.content.filter(b => b.type === 'tool_use');
          const results = await Promise.all(calls.map(async c => {
            const tool = toolList.find(t => t.name === c.name);
            const r = tool ? await runTool(tool, c.input, hooks, signal) : { ok: false, error: `Unknown tool ${c.name}` };
            log.push({ name: c.name, input: c.input, ...r });
            return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(r.ok ? r.result : { error: r.error }), is_error: !r.ok };
          }));
          messages.push({ role: 'user', content: results });
        }
        return { text: text || 'I stopped after 8 tool rounds. Try a narrower question.', truncated: true };
      },
    };
  }

  /** Brain 3: any OpenAI-compatible model (Groq, Gemini) through server.js — the same tool-use loop. */
  function OpenAICompatible(endpoint, tier, label) {
    return {
      id: 'openai-compatible', label: label || 'AI (own key)',
      async turn({ ctx, history, userText, hooks, signal, log }) {
        const toolList = buildTools(ctx);
        const messages = [
          { role: 'system', content: instructions(ctx.model) },
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: userText },
        ];
        const tools = toolList.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        let text = '';
        for (let round = 0; round < 8; round++) {
          const res = await fetch(endpoint, {
            method: 'POST', signal, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tier: tier(), max_tokens: 1200, messages, tools }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw { code: res.status === 429 ? 'rate_limited' : 'upstream_error', message: data.error?.message || data.error || `API error ${res.status}` };
          const choice = (data.choices || [])[0] || {};
          const msg = choice.message || {};
          const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
          messages.push(Object.assign({ role: 'assistant', content: msg.content || '' }, calls.length ? { tool_calls: calls } : {}));
          const said = String(msg.content || '').trim();
          if (said) { text = text ? text + '\n\n' + said : said; hooks.onText(text); }
          if (!calls.length) return { text: text || 'Done.', truncated: choice.finish_reason === 'length' };
          for (const c of calls) {
            const name = c.function && c.function.name;
            let input = {};
            try { input = JSON.parse((c.function && c.function.arguments) || '{}') || {}; } catch { input = {}; }
            const tool = toolList.find(t => t.name === name);
            const r = tool ? await runTool(tool, input, hooks, signal) : { ok: false, error: `Unknown tool ${name}` };
            log.push({ name, input, ...r });
            messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r.ok ? r.result : { error: r.error }) });
          }
        }
        return { text: text || 'I stopped after 8 tool rounds. Try a narrower question.', truncated: true };
      },
    };
  }

  // ---------- Guided demo (no AI): same tools, scripted calls ----------
  const SCENARIOS = [
    {
      id: 'vaccines', chip: '400 pallets of vaccines, 2–8 °C',
      prompt: 'We are a pharma company. We need to store 400 pallets of vaccines at 2–8 °C, about 450 kg per pallet. Where would they go?',
      script: [['find_space', { goods: 'Vaccines', pallets: 400, temperature: 'chilled', weight_kg_per_pallet: 450 }], ['draw_route', { plan_id: '$1' }]],
    },
    {
      id: 'mixed', chip: 'Shampoo + lithium batteries',
      prompt: 'We have 300 pallets of shampoo and 60 pallets of lithium-ion batteries (UN3480, class 9). Can you place both?',
      script: [['find_space', { goods: 'Shampoo', pallets: 300, temperature: 'ambient' }], ['find_space', { goods: 'Lithium-ion batteries', pallets: 60, hazmat_class: '9' }], ['draw_route', { plan_id: '$1' }], ['draw_route', { plan_id: '$2' }], ['move_camera', { target: 'overview' }]],
    },
    {
      id: 'phones', chip: '250 pallets of smartphones',
      prompt: 'We import smartphones. We need secure storage for 250 pallets, about 300 kg each.',
      script: [['find_space', { goods: 'Smartphones', pallets: 250, high_value: true, weight_kg_per_pallet: 300 }], ['draw_route', { plan_id: '$1' }]],
    },
    {
      id: 'journey', chip: 'Watch a pallet arrive',
      prompt: 'Show me how one pallet of our vaccines would get from the truck to its shelf. We have 100 pallets at 2–8 °C.',
      script: [['find_space', { goods: 'Vaccines', pallets: 100, temperature: 'chilled' }], ['follow_pallet', { plan_id: '$1' }]],
    },
    {
      id: 'frozen', chip: 'Frozen seafood?',
      prompt: 'Could you also take 100 pallets of frozen seafood at −18 °C?',
      script: [['find_space', { goods: 'Frozen seafood', pallets: 100, temperature: 'frozen' }]],
    },
  ];

  function narrate(log) {
    const parts = [];
    for (const step of log) {
      if (step.name !== 'find_space' || !step.ok) continue;
      const r = step.result;
      if (!r.eligible) { parts.push(`${r.goods}: not possible here. ${r.reason}${r.suggestion ? ' ' + r.suggestion : ''}`); continue; }
      const route = log.find(s => s.name === 'draw_route' && s.ok && s.result.plan_id === r.plan_id);
      parts.push(`${r.plan_id} (${r.goods}): ${r.pallets_reserved} of ${r.pallets_requested} pallets reserved in zone ${r.zone} (${r.zone_name}, ${r.temperature}), ${r.rows}. Main dock ${r.main_dock}` +
        (route ? `, ${route.result.distance_m} m to the middle of the block` : '') +
        `. Put-away is about ${r.putaway_forklift_hours} forklift-hours.` + (r.shortfall ? ` Short by ${r.shortfall} pallets: ${r.suggestion}` : ''));
    }
    for (const step of log) {
      if (step.name !== 'follow_pallet' || !step.ok) continue;
      const r = step.result;
      parts.push(`Watch one pallet of ${r.plan_id}: from dock ${r.dock}, ${r.distance_m} m to ${r.location}, lifted to level ${r.level} (${r.lift_height_m} m). One round trip takes about ${r.cycle_seconds} s.`);
    }
    parts.push('Scripted walkthrough: the same tools the AI uses, with fixed inputs.');
    return parts.join('\n\n');
  }

  function GuidedDemo() {
    return {
      id: 'guided', label: 'Guided demo (no AI)',
      async turn({ ctx, scenario, hooks, signal, log }) {
        if (!scenario) return { text: 'AI chat is not available in this view, so typed questions cannot be answered. Pick one of the guided scenarios to watch the same tools run.' };
        const tools = buildTools(ctx);
        const ids = [];
        for (const [name, raw] of scenario.script) {
          const input = JSON.parse(JSON.stringify(raw).replace(/"\$(\d)"/g, (_, n) => JSON.stringify(ids[n - 1] || 'P0')));
          await new Promise(r => setTimeout(r, 650));
          const r = await runTool(tools.find(t => t.name === name), input, hooks, signal);
          log.push({ name, input, ...r });
          if (name === 'find_space' && r.ok && r.result.plan_id) ids.push(r.result.plan_id);
        }
        const text = narrate(log);
        hooks.onText(text);
        return { text };
      },
    };
  }

  root.WarehouseAgent = { instructions, buildTools, groundingCheck, numbersIn, ClaudeInArtifact, AnthropicApi, OpenAICompatible, GuidedDemo, SCENARIOS, PLAN_COLORS };
})(typeof self !== 'undefined' ? self : this);
