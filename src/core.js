/*
 * Warehouse core — the single source of truth.
 *
 * Pure logic, no UI and no AI: the site model, its storage rules, and the
 * deterministic functions the agent is allowed to call (find space, routes,
 * zone status, reports). The 3D viewer, the agent and the tests all use this
 * file, so every number the agent says can be traced back to it.
 *
 * Works in the browser (window.WarehouseCore) and in Node (require).
 * All data is FICTIONAL sample data for a concept prototype.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WarehouseCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Physical constants (metres) ----------
  const GEOM = {
    width: 160,          // building, x from -80 to 80
    depth: 100,          // building, z from -50 to 50 (docks on the south wall, z = +50)
    aisle: 3.4,          // very-narrow-aisle reach-truck aisle incl. clearance
    rackDepth: 1.1,      // one pallet deep
    slotLength: 1.35,    // one pallet position along the beam (1.2 m pallet + gap)
    levelHeight: 1.7,    // beam pitch
    palletHeight: 1.3,   // drawn pallet height
    crossAisleZ: 32,     // main cross aisle in front of the storage blocks
    chilledCorridorX: 52,// corridor between the DG store and the secure cage
    chilledEntryZ: 2,    // corridor in front of the chilled chamber
    dockZ: 50,
  };

  // ---------- Operating assumptions used in estimates ----------
  const ASSUMPTIONS = {
    forkliftSpeed_mps: 2.0,      // average incl. turns
    handlingPerPallet_s: 75,     // scan, pick up, set down, confirm
    liftPerLevel_s: 8,           // extra time per rack level above floor
    maxPalletHeight_m: 1.6,      // incl. pallet base
  };

  // ---------- Zones and their rules ----------
  const ZONES = [
    {
      id: 'A', name: 'Ambient', short: 'Ambient general goods',
      temp: { min: 15, max: 30 }, levels: 4,
      bounds: { x0: -78, x1: 20, z0: -48, z1: 30 },
      maxKgByLevel: [1000, 1000, 800, 800],
      occupancy: 0.74, docks: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
      accepts: 'General non-hazardous goods (FMCG, apparel, auto parts, retail).',
      features: ['Sprinklered (ESFR)', 'Reach-truck aisles 3.4 m'],
    },
    {
      id: 'C', name: 'Chilled', short: 'Chilled 2–8 °C',
      temp: { min: 2, max: 8 }, levels: 4,
      bounds: { x0: 24, x1: 78, z0: -48, z1: -2 },
      maxKgByLevel: [800, 800, 800, 800],
      occupancy: 0.62, docks: ['D8', 'D9', 'D10'],
      accepts: 'Pharma (GDP), vaccines, fresh food, dairy. Not frozen goods.',
      features: ['Temperature-mapped chamber', '24/7 temperature logging', 'Reefer docks D8–D10'],
    },
    {
      id: 'H', name: 'Dangerous goods', short: 'DG store (classes 3, 8, 9)',
      temp: { min: 15, max: 30 }, levels: 3,
      bounds: { x0: 24, x1: 50, z0: 6, z1: 30 },
      maxKgByLevel: [800, 800, 800],
      occupancy: 0.58, docks: ['D11'],
      hazmatClasses: ['3', '8', '9'],
      accepts: 'DG class 3 (flammable liquids), class 8 (corrosives), class 9 (misc., incl. lithium batteries).',
      features: ['Spill containment', 'Fire-rated walls', 'Locked access'],
    },
    {
      id: 'S', name: 'Secure cage', short: 'High-value secure cage',
      temp: { min: 15, max: 30 }, levels: 3,
      bounds: { x0: 54, x1: 78, z0: 6, z1: 30 },
      maxKgByLevel: [600, 600, 600],
      occupancy: 0.45, docks: ['D12'],
      accepts: 'High-value goods: electronics, phones, luxury, pharma APIs (ambient).',
      features: ['Mesh cage', 'CCTV', 'Access control with audit log'],
    },
  ];

  const NOT_OFFERED = {
    frozen: 'This site has no frozen (−18 °C) storage.',
    hazmatClasses: 'DG classes 1, 2, 4, 5, 6 and 7 are not licensed at this site.',
    chilledHazmat: 'There is no temperature-controlled DG store at this site.',
  };

  // 12 docks on the south wall, 12 m apart.
  const DOCKS = Array.from({ length: 12 }, (_, i) => {
    const id = 'D' + (i + 1);
    const zone = ZONES.find(z => z.docks.includes(id)).id;
    return {
      id, x: -66 + i * 12, z: GEOM.dockZ, zone,
      type: zone === 'C' ? 'Reefer dock, sealed shelter' : 'Dock leveller',
    };
  });

  const SITE = {
    id: 'DC-01',
    name: 'Demo DC-01, Bhiwandi',
    note: 'Fictional sample site for a concept prototype. Not real company data.',
    area_m2: GEOM.width * GEOM.depth,
  };

  // ---------- Deterministic random numbers ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pad = (n, w) => String(n).padStart(w, '0');

  // ---------- Site generation ----------
  function generateSlots(seed = 2026) {
    const rnd = mulberry32(seed);
    const slots = [];
    for (const zone of ZONES) {
      const { x0, x1, z0, z1 } = zone.bounds;
      const pitch = 2 * GEOM.rackDepth + GEOM.aisle;
      let x = x0 + GEOM.aisle;
      let row = 1;
      const rows = [];
      while (x + 2 * GEOM.rackDepth + GEOM.aisle <= x1 + 1e-6) {
        rows.push({ n: row++, x: x + GEOM.rackDepth / 2, aisleX: x - GEOM.aisle / 2 });
        rows.push({ n: row++, x: x + GEOM.rackDepth * 1.5, aisleX: x + 2 * GEOM.rackDepth + GEOM.aisle / 2 });
        x += pitch;
      }
      const bays = Math.floor((z1 - z0 - 2) / GEOM.slotLength);
      // Existing clients fill blocks of bays, which looks like a real site.
      for (const r of rows) {
        let blockFull = rnd() < zone.occupancy;
        for (let b = 1; b <= bays; b++) {
          if (rnd() < 0.12) blockFull = rnd() < zone.occupancy;
          const z = z0 + 1 + GEOM.slotLength * (b - 0.5);
          for (let l = 1; l <= zone.levels; l++) {
            let status = blockFull ? (rnd() < 0.93 ? 'occupied' : 'free') : (rnd() < 0.08 ? 'occupied' : 'free');
            let note = '';
            if (rnd() < 0.004) { status = 'blocked'; note = 'Beam damage, awaiting inspection'; }
            slots.push({
              id: `${zone.id}-${pad(r.n, 2)}-${pad(b, 3)}-${l}`,
              zone: zone.id, row: r.n, bay: b, level: l,
              x: +r.x.toFixed(2), z: +z.toFixed(3), aisleX: +r.aisleX.toFixed(2),
              maxKg: zone.maxKgByLevel[l - 1], status, note,
            });
          }
        }
      }
    }
    return slots;
  }

  // ---------- CSV (the format a real WMS export would be mapped to) ----------
  const CSV_COLUMNS = ['location_id', 'zone', 'row', 'bay', 'level', 'x_m', 'z_m', 'aisle_x_m', 'max_kg', 'status', 'note'];

  function toCSV(slots) {
    const esc = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [CSV_COLUMNS.join(',')];
    for (const s of slots) lines.push([s.id, s.zone, s.row, s.bay, s.level, s.x, s.z, s.aisleX, s.maxKg, s.status, s.note].map(esc).join(','));
    return lines.join('\n');
  }

  function parseCSVLine(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  /** Parse a slot CSV. Returns {slots, errors}. Rejects rows it cannot trust. */
  function fromCSV(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (!lines.length) return { slots: [], errors: ['The file is empty.'] };
    const head = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const missing = CSV_COLUMNS.filter(c => c !== 'note' && !head.includes(c));
    if (missing.length) return { slots: [], errors: ['Missing columns: ' + missing.join(', ')] };
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    const slots = []; const errors = []; const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
      const c = parseCSVLine(lines[i]);
      const zone = (c[ix.zone] || '').trim().toUpperCase();
      const s = {
        id: (c[ix.location_id] || '').trim(), zone,
        row: +c[ix.row], bay: +c[ix.bay], level: +c[ix.level],
        x: +c[ix.x_m], z: +c[ix.z_m], aisleX: +c[ix.aisle_x_m], maxKg: +c[ix.max_kg],
        status: (c[ix.status] || '').trim().toLowerCase(), note: ix.note != null ? (c[ix.note] || '') : '',
      };
      const bad = !s.id || !ZONES.some(z => z.id === zone) || ![s.row, s.bay, s.level, s.x, s.z, s.aisleX, s.maxKg].every(Number.isFinite)
        || !['free', 'occupied', 'blocked'].includes(s.status) || seen.has(s.id);
      if (bad) { if (errors.length < 20) errors.push(`Line ${i + 1}: skipped (invalid or duplicate)`); continue; }
      seen.add(s.id); slots.push(s);
    }
    return { slots, errors };
  }

  // ---------- Geometry helpers ----------
  const zoneById = id => ZONES.find(z => z.id === id);
  const dockById = id => DOCKS.find(d => d.id === String(id).toUpperCase());

  /** Walking path a forklift takes from a dock door to a slot (Manhattan, along aisles). */
  function routePoints(dock, slot) {
    const pts = [[dock.x, GEOM.dockZ], [dock.x, GEOM.crossAisleZ]];
    if (slot.zone === 'C') {
      pts.push([GEOM.chilledCorridorX, GEOM.crossAisleZ], [GEOM.chilledCorridorX, GEOM.chilledEntryZ],
        [slot.aisleX, GEOM.chilledEntryZ], [slot.aisleX, slot.z]);
    } else {
      pts.push([slot.aisleX, GEOM.crossAisleZ], [slot.aisleX, slot.z]);
    }
    return pts;
  }
  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    return d;
  }

  const r1 = n => Math.round(n * 10) / 10;

  /** Compress row numbers like [1,2,3,7,8] into "rows 01–03, 07–08". */
  function rowRanges(zone, rows) {
    const s = [...new Set(rows)].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(i === j ? `${zone}-${pad(s[i], 2)}` : `${zone}-${pad(s[i], 2)} to ${zone}-${pad(s[j], 2)}`);
      i = j;
    }
    if (out.length > 3) return `${zone}-${pad(s[0], 2)} to ${zone}-${pad(s[s.length - 1], 2)} (${s.length} rows)`;
    return out.join(', ');
  }

  function normalizeHazmat(v) {
    if (v === null || v === undefined || v === false) return null;
    const s = String(v).trim().toLowerCase();
    if (!s || s === 'none' || s === 'null' || s === 'no' || s === 'false') return null;
    const m = s.match(/(\d(?:\.\d)?)/);
    return m ? m[1] : s;
  }

  // ---------- The model ----------
  class WarehouseModel {
    constructor(slots) {
      this.load(slots || generateSlots());
    }

    load(slots) {
      this.slots = slots;
      this.byId = new Map(slots.map(s => [s.id, s]));
      this.plans = [];
      this.reserved = new Map(); // slotId -> planId
      this.nextPlan = 1;
    }

    // --- read ---
    zoneStatus() {
      return ZONES.map(z => {
        const zs = this.slots.filter(s => s.zone === z.id);
        const count = st => zs.filter(s => s.status === st).length;
        const reserved = zs.filter(s => this.reserved.has(s.id)).length;
        const free = count('free') - reserved;
        const total = zs.length;
        return {
          zone: z.id, name: z.name, temperature: `${z.temp.min}–${z.temp.max} °C`,
          total_positions: total, occupied: count('occupied'), blocked: count('blocked'),
          reserved_in_this_session: reserved, free_now: free,
          utilisation_pct: total ? Math.round(((total - free) / total) * 100) : 0,
          rack_levels: z.levels, max_kg_per_pallet: Math.max(...z.maxKgByLevel), docks: z.docks.join(', '),
        };
      });
    }

    siteSummary() {
      const st = this.zoneStatus();
      return {
        site: SITE.name, note: SITE.note, building_m: `${GEOM.width} × ${GEOM.depth}`, area_m2: SITE.area_m2,
        pallet_positions: this.slots.length, free_now: st.reduce((a, z) => a + z.free_now, 0),
        docks: DOCKS.length, max_pallet_height_m: ASSUMPTIONS.maxPalletHeight_m,
        zones: st,
        not_offered: Object.values(NOT_OFFERED),
      };
    }

    // --- rules ---
    /** Decide which zone a request belongs to, or why none can take it. */
    eligibility(req) {
      const temp = String(req.temperature || 'ambient').toLowerCase();
      const hz = normalizeHazmat(req.hazmat_class);
      const kg = Number(req.weight_kg_per_pallet) || 500;
      const h = Number(req.pallet_height_m) || 1.4;
      const notes = [];
      if (temp.includes('frozen') || temp.includes('-18') || temp.includes('−18')) {
        return { ok: false, reason: NOT_OFFERED.frozen, suggestion: 'A partner frozen facility would be needed; chilled 2–8 °C is not suitable for frozen goods.' };
      }
      const chilled = /chill|cold|refriger|2\s*[-–]\s*8/.test(temp);
      let zone;
      if (hz) {
        if (chilled) return { ok: false, reason: NOT_OFFERED.chilledHazmat };
        if (!zoneById('H').hazmatClasses.includes(hz.split('.')[0])) {
          return { ok: false, reason: `DG class ${hz} is not licensed here. ${NOT_OFFERED.hazmatClasses}` };
        }
        zone = 'H';
        if (req.high_value) notes.push('DG rules take priority over the secure cage; the DG store has locked access.');
      } else if (chilled) {
        zone = 'C';
        if (req.high_value) notes.push('The chilled chamber has CCTV but no mesh cage.');
      } else if (req.high_value) {
        zone = 'S';
      } else {
        zone = 'A';
      }
      const z = zoneById(zone);
      const maxKg = Math.max(...z.maxKgByLevel);
      if (kg > maxKg) return { ok: false, zone, reason: `${kg} kg per pallet exceeds the ${maxKg} kg beam limit in zone ${zone} (${z.name}).`, suggestion: 'Split loads to lighter pallets or use floor (block) storage, which is not modelled here.' };
      if (h > ASSUMPTIONS.maxPalletHeight_m) return { ok: false, zone, reason: `Pallet height ${h} m exceeds the ${ASSUMPTIONS.maxPalletHeight_m} m slot clearance.`, suggestion: 'Re-stack pallets to 1.6 m or lower.' };
      return { ok: true, zone, notes, kg };
    }

    // --- planning tools ---
    findSpace(req) {
      const pallets = Math.floor(Number(req.pallets));
      if (!Number.isFinite(pallets) || pallets < 1) throw new Error('pallets must be a whole number of at least 1');
      if (pallets > 20000) throw new Error('pallets is unrealistically large for one site (max 20000)');
      const goods = String(req.goods || 'Client goods').slice(0, 80);
      const el = this.eligibility(req);
      if (!el.ok) return { eligible: false, goods, pallets_requested: pallets, reason: el.reason, suggestion: el.suggestion || null };

      const zone = zoneById(el.zone);
      const docks = zone.docks.map(dockById);
      const candidates = [];
      for (const s of this.slots) {
        if (s.zone !== zone.id || s.status !== 'free' || this.reserved.has(s.id) || s.maxKg < el.kg) continue;
        // Distance from the closest of the zone's docks.
        let best = Infinity, bestDock = null;
        for (const d of docks) { const len = pathLength(routePoints(d, s)); if (len < best) { best = len; bestDock = d; } }
        candidates.push({ s, dist: best, dock: bestDock });
      }
      candidates.sort((a, b) => a.dist - b.dist || a.s.level - b.s.level || a.s.id.localeCompare(b.s.id));
      const take = candidates.slice(0, pallets);
      const id = 'P' + this.nextPlan++;
      const dockCount = {};
      take.forEach(c => { dockCount[c.dock.id] = (dockCount[c.dock.id] || 0) + 1; });
      const dock = Object.entries(dockCount).sort((a, b) => b[1] - a[1])[0]?.[0] || zone.docks[0];
      const avg = take.length ? take.reduce((a, c) => a + c.dist, 0) / take.length : 0;
      const max = take.length ? take[take.length - 1].dist : 0;
      const seconds = take.reduce((a, c) => a + (2 * c.dist) / ASSUMPTIONS.forkliftSpeed_mps + ASSUMPTIONS.handlingPerPallet_s + (c.s.level - 1) * ASSUMPTIONS.liftPerLevel_s, 0);
      const levels = [...new Set(take.map(c => c.s.level))].sort();

      const plan = {
        plan_id: id, goods, zone: zone.id, zone_name: zone.name, temperature: `${zone.temp.min}–${zone.temp.max} °C`,
        pallets_requested: pallets, pallets_reserved: take.length, shortfall: pallets - take.length,
        rows: rowRanges(zone.id, take.map(c => c.s.row)), levels_used: levels.join(', '),
        main_dock: dock, avg_travel_m: r1(avg), max_travel_m: r1(max),
        putaway_forklift_hours: r1(seconds / 3600),
        first_location: take[0]?.s.id || null, last_location: take[take.length - 1]?.s.id || null,
        notes: el.notes,
        weight_kg_per_pallet: el.kg,
        hazmat_class: normalizeHazmat(req.hazmat_class), high_value: !!req.high_value,
      };
      if (plan.shortfall > 0) {
        plan.notes = plan.notes.concat(`Only ${take.length} of ${pallets} pallets fit in zone ${zone.id} today.`);
        plan.suggestion = 'Options: phased inbound as space frees up, or confirm whether part of the volume can go to another zone.';
      }
      plan._slots = take.map(c => c.s.id);
      if (take.length) {
        this.plans.push(plan);
        take.forEach(c => this.reserved.set(c.s.id, id));
      }
      return Object.assign({ eligible: true }, this.publicPlan(plan));
    }

    publicPlan(p) {
      const { _slots, ...rest } = p;
      return rest;
    }

    getPlan(id) { return this.plans.find(p => p.plan_id === String(id).toUpperCase()); }

    releasePlan(id) {
      const p = this.getPlan(id);
      if (!p) throw new Error(`No plan ${id}. Current plans: ${this.plans.map(x => x.plan_id).join(', ') || 'none'}`);
      p._slots.forEach(s => this.reserved.delete(s));
      this.plans = this.plans.filter(x => x !== p);
      return { released: p.plan_id, pallets_freed: p._slots.length, zone: p.zone };
    }

    clearAll() {
      const n = this.plans.length;
      this.plans = []; this.reserved.clear();
      return { cleared_plans: n };
    }

    /** Route from a dock to the middle of a plan's slots. */
    planRoute(id, dockId) {
      const p = this.getPlan(id);
      if (!p) throw new Error(`No plan ${id}.`);
      const dock = dockById(dockId || p.main_dock);
      if (!dock) throw new Error(`Unknown dock ${dockId}. Docks are D1–D12.`);
      if (!zoneById(p.zone).docks.includes(dock.id)) throw new Error(`Dock ${dock.id} does not serve zone ${p.zone}. Use ${zoneById(p.zone).docks.join(', ')}.`);
      const mid = this.byId.get(p._slots[Math.floor(p._slots.length / 2)]);
      const pts = routePoints(dock, mid);
      const len = pathLength(pts);
      return {
        plan_id: p.plan_id, dock: dock.id, dock_type: dock.type, to_location: mid.id,
        distance_m: r1(len), one_way_minutes: r1(len / ASSUMPTIONS.forkliftSpeed_mps / 60),
        points: pts,
      };
    }

    planSlots(id) { const p = this.getPlan(id); return p ? p._slots.map(s => this.byId.get(s)) : []; }

    /** One pallet's trip for the "follow my pallet" animation: nearest slot of the plan, from the closest serving dock. */
    journey(id) {
      const p = this.getPlan(id);
      if (!p) throw new Error(`No plan ${id}. Current plans: ${this.plans.map(x => x.plan_id).join(', ') || 'none'}`);
      // Show a pallet going up high when one of the nearest positions is on an upper level (better to watch)
      const near = p._slots.slice(0, 40).map(id => this.byId.get(id));
      const top = Math.max(...near.map(x => x.level));
      const slotIndex = Math.max(0, near.findIndex(x => x.level === top && x.level >= 3));
      const slot = near[slotIndex];
      const z = zoneById(p.zone);
      let dock = null, pts = null, len = Infinity;
      for (const d of z.docks.map(dockById)) {
        const r = routePoints(d, slot), l = pathLength(r);
        if (l < len) { len = l; pts = r; dock = d; }
      }
      const lift = 0.18 + (slot.level - 1) * GEOM.levelHeight;
      const cycle = (2 * len) / ASSUMPTIONS.forkliftSpeed_mps + ASSUMPTIONS.handlingPerPallet_s + (slot.level - 1) * ASSUMPTIONS.liftPerLevel_s;
      return {
        plan_id: p.plan_id, goods: p.goods, dock: dock.id, dock_type: dock.type, location: slot.id,
        zone: z.id, zone_name: z.name, temperature: `${z.temp.min}–${z.temp.max} °C`,
        level: slot.level, lift_height_m: r1(lift), distance_m: r1(len),
        one_way_minutes: r1(len / ASSUMPTIONS.forkliftSpeed_mps / 60), cycle_seconds: Math.round(cycle),
        pallets_in_plan: p.pallets_reserved, putaway_forklift_hours: p.putaway_forklift_hours,
        points: pts, slot, slot_index: slotIndex,
      };
    }

    reportData(clientName) {
      const plans = this.plans.map(p => this.publicPlan(p));
      return {
        client: String(clientName || 'Prospective client').slice(0, 80), site: SITE.name, note: SITE.note,
        plans,
        total_pallets_reserved: plans.reduce((a, p) => a + p.pallets_reserved, 0),
        total_shortfall: plans.reduce((a, p) => a + p.shortfall, 0),
        total_putaway_forklift_hours: r1(plans.reduce((a, p) => a + p.putaway_forklift_hours, 0)),
        assumptions: `Forklift ${ASSUMPTIONS.forkliftSpeed_mps} m/s, ${ASSUMPTIONS.handlingPerPallet_s} s handling per pallet, +${ASSUMPTIONS.liftPerLevel_s} s per level above floor.`,
      };
    }
  }

  return {
    GEOM, ASSUMPTIONS, ZONES, DOCKS, SITE, NOT_OFFERED, CSV_COLUMNS,
    generateSlots, toCSV, fromCSV, routePoints, pathLength, normalizeHazmat,
    zoneById, dockById, WarehouseModel,
  };
});
