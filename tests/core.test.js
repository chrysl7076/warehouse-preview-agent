// Unit tests for the warehouse core. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/core.js');

const fresh = () => new W.WarehouseModel(W.generateSlots(2026));

test('site generation is deterministic and realistic', () => {
  const a = W.generateSlots(2026), b = W.generateSlots(2026);
  assert.equal(a.length, b.length);
  assert.deepEqual(a[500], b[500]);
  assert.ok(a.length > 9000 && a.length < 12000, `positions: ${a.length}`);
  const ids = new Set(a.map(s => s.id));
  assert.equal(ids.size, a.length, 'location ids are unique');
  assert.match(a[0].id, /^[ACHS]-\d{2}-\d{3}-\d$/);
});

test('every slot sits inside its zone and the building', () => {
  for (const s of W.generateSlots()) {
    const z = W.zoneById(s.zone).bounds;
    assert.ok(s.x > z.x0 && s.x < z.x1 && s.z > z.z0 && s.z < z.z1, s.id);
    assert.ok(Math.abs(s.aisleX - s.x) < 3, s.id);
  }
});

test('zone status adds up', () => {
  const m = fresh();
  for (const z of m.zoneStatus()) {
    assert.equal(z.occupied + z.blocked + z.free_now + z.reserved_in_this_session, z.total_positions);
  }
});

test('chilled goods go to zone C, nearest first, from a reefer dock', () => {
  const m = fresh();
  const r = m.findSpace({ goods: 'Vaccines', pallets: 400, temperature: 'chilled', weight_kg_per_pallet: 450 });
  assert.equal(r.eligible, true);
  assert.equal(r.zone, 'C');
  assert.equal(r.pallets_reserved, 400);
  assert.ok(['D8', 'D9', 'D10'].includes(r.main_dock));
  assert.ok(r.avg_travel_m <= r.max_travel_m);
  // reserved slots are now unavailable
  assert.equal(m.zoneStatus().find(z => z.zone === 'C').reserved_in_this_session, 400);
});

test('no slot is ever reserved twice', () => {
  const m = fresh();
  m.findSpace({ pallets: 300, temperature: 'ambient' });
  m.findSpace({ pallets: 300, temperature: 'ambient' });
  const all = m.plans.flatMap(p => p._slots);
  assert.equal(new Set(all).size, all.length);
});

test('blocked and occupied slots are never used', () => {
  const m = fresh();
  m.findSpace({ pallets: 2000, temperature: 'ambient' });
  for (const s of m.planSlots('P1')) assert.equal(s.status, 'free');
});

test('heavy pallets only use levels whose beams can take them', () => {
  const m = fresh();
  const r = m.findSpace({ pallets: 200, temperature: 'ambient', weight_kg_per_pallet: 950 });
  assert.equal(r.eligible, true);
  for (const s of m.planSlots(r.plan_id)) assert.ok(s.maxKg >= 950 && s.level <= 2);
});

test('rules: frozen, unlicensed DG, chilled DG, overweight, too tall', () => {
  const m = fresh();
  assert.equal(m.findSpace({ pallets: 10, temperature: 'frozen' }).eligible, false);
  assert.equal(m.findSpace({ pallets: 10, hazmat_class: '2.1' }).eligible, false);
  assert.equal(m.findSpace({ pallets: 10, hazmat_class: 'class 4.1' }).eligible, false);
  assert.equal(m.findSpace({ pallets: 10, hazmat_class: '3', temperature: 'chilled' }).eligible, false);
  assert.equal(m.findSpace({ pallets: 10, weight_kg_per_pallet: 1200 }).eligible, false);
  assert.equal(m.findSpace({ pallets: 10, pallet_height_m: 1.9 }).eligible, false);
  assert.equal(m.plans.length, 0, 'rejected requests reserve nothing');
});

test('DG class 9 (lithium batteries) goes to H, high value to S', () => {
  const m = fresh();
  assert.equal(m.findSpace({ pallets: 20, hazmat_class: 'UN3480 class 9' }).zone, 'H');
  assert.equal(m.findSpace({ pallets: 20, high_value: true }).zone, 'S');
  assert.equal(m.findSpace({ pallets: 20, hazmat_class: '9', high_value: true }).zone, 'H');
});

test('shortfall is reported honestly when a zone is too small', () => {
  const m = fresh();
  const r = m.findSpace({ pallets: 5000, high_value: true });
  assert.ok(r.shortfall > 0);
  assert.equal(r.pallets_reserved + r.shortfall, 5000);
  assert.ok(r.suggestion);
});

test('release frees the slots again', () => {
  const m = fresh();
  const before = m.zoneStatus().find(z => z.zone === 'A').free_now;
  const r = m.findSpace({ pallets: 100 });
  m.releasePlan(r.plan_id);
  assert.equal(m.zoneStatus().find(z => z.zone === 'A').free_now, before);
  assert.throws(() => m.releasePlan('P99'));
});

test('routes start at a dock that serves the zone', () => {
  const m = fresh();
  const r = m.findSpace({ pallets: 50, temperature: 'chilled' });
  const route = m.planRoute(r.plan_id);
  assert.equal(route.points[0][1], W.GEOM.dockZ);
  assert.ok(route.distance_m > 0);
  assert.throws(() => m.planRoute(r.plan_id, 'D1'), /does not serve/);
});

test('CSV round trip keeps every slot, and bad rows are rejected', () => {
  const slots = W.generateSlots();
  const back = W.fromCSV(W.toCSV(slots));
  assert.equal(back.errors.length, 0);
  assert.equal(back.slots.length, slots.length);
  assert.deepEqual(back.slots[123], slots[123]);
  const bad = W.fromCSV('location_id,zone\nX,A');
  assert.ok(bad.errors[0].startsWith('Missing columns'));
});

test('a pallet journey starts at a serving dock and ends at the plan\'s nearest slot', () => {
  const m = fresh();
  const r = m.findSpace({ pallets: 30, temperature: 'chilled' });
  const j = m.journey(r.plan_id);
  assert.ok(['D8', 'D9', 'D10'].includes(j.dock));
  assert.equal(j.location, m.planSlots(r.plan_id)[j.slot_index].id);
  const end = j.points[j.points.length - 1];
  assert.equal(end[1], j.slot.z);
  assert.ok(j.distance_m > 0 && j.cycle_seconds > 75);
  assert.throws(() => m.journey('P9'));
});

test('report totals match the plans', () => {
  const m = fresh();
  m.findSpace({ pallets: 120, temperature: 'chilled' });
  m.findSpace({ pallets: 80, hazmat_class: '9' });
  const rep = m.reportData('Acme Pharma');
  assert.equal(rep.plans.length, 2);
  assert.equal(rep.total_pallets_reserved, 200);
});
