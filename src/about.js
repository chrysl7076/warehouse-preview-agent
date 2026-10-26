/* "How it works" page: architecture, what is real vs sample, load your own site (CSV), roadmap. */
(function (root) {
  'use strict';
  const W = root.WarehouseCore;
  let mounted = false;

  const DIAGRAM = `
<svg viewBox="0 0 900 360" role="img" aria-label="The agent decides, tools compute, the 3D view shows the result">
  <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>
  <g font-family="var(--font-body)" font-size="13" fill="var(--ink)">
    <rect x="16" y="120" width="150" height="72" rx="6" fill="var(--surface-2)" stroke="var(--line)"/>
    <text x="91" y="150" text-anchor="middle" font-weight="600">Client</text>
    <text x="91" y="170" text-anchor="middle" fill="var(--ink-2)" font-size="12">asks in plain words</text>

    <rect x="216" y="104" width="190" height="104" rx="6" fill="var(--safety-soft)" stroke="var(--safety)" stroke-width="2"/>
    <text x="311" y="134" text-anchor="middle" font-weight="600">AI agent (Claude)</text>
    <text x="311" y="156" text-anchor="middle" fill="var(--ink-2)" font-size="12">plans · picks tools</text>
    <text x="311" y="174" text-anchor="middle" fill="var(--ink-2)" font-size="12">re-plans · explains</text>
    <text x="311" y="192" text-anchor="middle" fill="var(--ink-2)" font-size="12">never does the maths</text>

    <rect x="460" y="40" width="210" height="282" rx="6" fill="var(--surface)" stroke="var(--line)"/>
    <text x="476" y="66" font-weight="600">Tools (deterministic code)</text>
    <g font-family="var(--font-mono)" font-size="12" fill="var(--ink-2)">
      <text x="476" y="94">find_space</text><text x="476" y="118">draw_route</text><text x="476" y="142">move_camera</text>
      <text x="476" y="166">get_site_status</text><text x="476" y="190">release_plan</text><text x="476" y="214">create_client_report</text>
      <text x="476" y="238">follow_pallet</text><text x="476" y="262">give_tour</text>
    </g>
    <text x="476" y="300" fill="var(--ink-3)" font-size="11.5">rules · capacity · routes · experience</text>

    <rect x="720" y="40" width="164" height="96" rx="6" fill="var(--surface)" stroke="var(--line)"/>
    <text x="802" y="70" text-anchor="middle" font-weight="600">Site data</text>
    <text x="802" y="92" text-anchor="middle" fill="var(--ink-2)" font-size="12">slots.csv (WMS export)</text>
    <text x="802" y="110" text-anchor="middle" fill="var(--ink-2)" font-size="12">zone rules · docks</text>

    <rect x="720" y="176" width="164" height="96" rx="6" fill="var(--surface)" stroke="var(--line)"/>
    <text x="802" y="206" text-anchor="middle" font-weight="600">3D view</text>
    <text x="802" y="228" text-anchor="middle" fill="var(--ink-2)" font-size="12">built from the data</text>
    <text x="802" y="246" text-anchor="middle" fill="var(--ink-2)" font-size="12">walk · journeys · tours</text>

    <rect x="216" y="252" width="190" height="56" rx="6" fill="var(--surface)" stroke="var(--good)"/>
    <text x="311" y="276" text-anchor="middle" font-weight="600">Number check</text>
    <text x="311" y="294" text-anchor="middle" fill="var(--ink-2)" font-size="12">every figure traced to data</text>
  </g>
  <g stroke="var(--ink-3)" stroke-width="1.4" fill="none">
    <path d="M166 150H214" marker-end="url(#ar)"/><path d="M214 166H168" marker-end="url(#ar)"/>
    <path d="M406 140H458" marker-end="url(#ar)"/><path d="M458 172H408" marker-end="url(#ar)"/>
    <path d="M670 88H718" marker-end="url(#ar)" marker-start="url(#ar)"/>
    <path d="M670 224H718" marker-end="url(#ar)"/>
    <path d="M311 208V250" marker-end="url(#ar)"/>
  </g>
  <g font-family="var(--font-body)" font-size="11.5" fill="var(--ink-3)">
    <text x="432" y="132" text-anchor="middle">calls</text><text x="432" y="190" text-anchor="middle">results</text>
  </g>
</svg>`;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  function table(head, rows) {
    return el('div', { class: 'tablewrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...head.map(h => el('th', { text: h })))),
      el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map(c => el('td', { text: c })))))));
  }

  function mount(host, api) {
    if (mounted) return;
    mounted = true;
    const status = el('p', { class: 'note', id: 'csv-status', style: 'margin-top:8px' });
    const file = el('input', { type: 'file', id: 'csv-file', accept: '.csv,text/csv' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 15e6) { status.textContent = 'That file is over 15 MB. Split it by zone and try again.'; return; }
      const { slots, errors } = W.fromCSV(await f.text());
      if (!slots.length) { status.textContent = `Could not load it. ${errors.join(' ')}`; return; }
      if (slots.length > 60000) { status.textContent = `${slots.length} positions is more than this prototype draws smoothly (60,000). Load one building at a time.`; return; }
      api.loadSlots(slots);
      status.textContent = `Loaded ${slots.length.toLocaleString('en-IN')} pallet positions from ${f.name}` + (errors.length ? `, skipped some rows (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}).` : '.') + ' The 3D view and the agent now use this data.';
    });
    const header = W.CSV_COLUMNS.join(',');
    const copyHead = el('button', { class: 'btn', type: 'button', text: 'Copy CSV header' });
    copyHead.addEventListener('click', async () => { try { await navigator.clipboard.writeText(header + '\nA-01-001-1,A,1,1,1,-73.53,-46.325,-76.3,1000,free,'); copyHead.textContent = 'Copied'; } catch { copyHead.textContent = 'Copy failed'; } setTimeout(() => (copyHead.textContent = 'Copy CSV header'), 1600); });
    const restore = el('button', { class: 'btn', type: 'button', text: 'Restore sample site' });
    restore.addEventListener('click', () => { api.loadSlots(W.generateSlots(2026)); status.textContent = 'Sample site restored.'; });

    host.append(
      el('div', {}, el('h2', { text: 'How it works' }),
        el('p', { style: 'margin-top:8px', text: 'The AI decides what to do. Deterministic tools do every calculation. The 3D view shows the result. That split is what makes the answers trustworthy enough for a client conversation.' })),
      el('div', { class: 'card diagram', html: DIAGRAM }),
      el('div', { class: 'grid2' },
        el('div', { class: 'card' }, el('h3', { text: 'One agent turn' }),
          el('ol', { style: 'margin:0;padding-left:20px;display:grid;gap:4px' },
            el('li', { text: 'The agent reads the request together with live site data: free space, zone rules, docks.' }),
            el('li', { text: 'It decides which tools to call, for example one find_space per type of goods.' }),
            el('li', { text: 'The tools apply the rules, reserve positions and update the 3D view, then return results.' }),
            el('li', { text: 'It reads the results and continues: draws routes, re-plans after a "no", or writes the report.' }),
            el('li', { text: 'It answers in plain words. The page then checks every number against the data.' }))),
        el('div', { class: 'card' }, el('h3', { text: 'Three ways it runs' }),
          table(['Mode', 'When', 'Brain'], [
            ['In Claude', 'This shared link, signed in to Claude', 'Claude, via the page'],
            ['Own API key', 'Hosted online or on a laptop', 'Groq, Gemini or Claude'],
            ['Guided demo', 'No AI available', 'Scripted, same tools'],
          ]))),
      el('div', { class: 'card' }, el('h3', { text: 'The immersive experience' }),
        table(['Feature', 'What the client gets'], [
          ['Walk inside', 'Eye-level walking through the aisles (keyboard, mouse or touch), with a live "you are here" readout'],
          ['Follow a pallet', 'Truck docks, forklift carries one pallet along the real route and lifts it into its slot, captioned with the plan’s numbers'],
          ['Guided tour', 'Camera stops with captions, read aloud when sound is on; the agent can write a tour for a specific client'],
          ['Living site', 'Roof and lights from inside, trucks at the docks, forklifts at work, reversing beepers and hall ambience'],
        ]),
        el('p', { class: 'note', style: 'margin-top:8px', text: 'Captions are built from the same data and tools as the chat, and tour captions written by the agent go through the same number check.' })),
      el('div', { class: 'card' }, el('h3', { text: "What's real and what's sample" }),
        table(['Part', 'Status'], [
          ['Warehouse layout, occupancy, client goods', 'Sample: fictional site "Demo DC-01, Bhiwandi"'],
          ['Zone rules (temperature, DG classes, beam loads, height)', 'Real logic, typical values; set per site'],
          ['AI agent and tool calling', 'Real: Claude chooses and calls the tools live'],
          ['3D view', 'Real: generated from the data, nothing hand-placed'],
          ['Travel and put-away estimates', `Estimates: ${W.ASSUMPTIONS.forkliftSpeed_mps} m/s forklift, ${W.ASSUMPTIONS.handlingPerPallet_s} s handling, +${W.ASSUMPTIONS.liftPerLevel_s} s per level`],
        ])),
      el('div', { class: 'card' }, el('h3', { text: 'Load your own site' }),
        el('p', { text: 'Export pallet locations from a warehouse management system, map the columns below, and load the file. Data stays in this browser tab.' }),
        el('pre', { class: 'mono', style: 'overflow-x:auto;background:var(--surface-2);padding:8px 10px;border-radius:6px;margin:10px 0' }, header),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, el('label', { for: 'csv-file', class: 'note', text: 'CSV file:' }), file, copyHead, restore),
        status),
      el('div', { class: 'card' }, el('h3', { text: 'Next steps for a production version' }),
        el('ul', { style: 'margin:0;padding-left:20px;display:grid;gap:4px' },
          el('li', { text: 'Live occupancy from the warehouse management system API instead of a CSV snapshot.' }),
          el('li', { text: 'Floor plan in, layout out: a vision model drafts the rack layout from a drawing, a validator checks it, a person approves.' }),
          el('li', { text: 'Photo-real building: overlay the data on a 3D scan (Gaussian splat) of the real site.' }),
          el('li', { text: 'Quote support: storage and handling cost per plan, multi-site comparison.' }),
          el('li', { text: 'Enterprise controls: single sign-on, per-client data isolation, audit log of every tool call.' }))),
      el('p', { class: 'note', text: 'Concept prototype built for a hiring assignment. Not an official product of any company. All site data is fictional.' }));
  }

  root.WarehouseAbout = { mount };
})(typeof self !== 'undefined' ? self : this);
