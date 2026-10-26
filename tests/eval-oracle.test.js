// Validates the TEST BENCH itself: a scripted "perfect agent" must score full marks,
// and typical mistakes must fail. If this passes, a low score in the browser
// means the AI made a mistake, not that the test is wrong.
// Run: node --test tests/eval-oracle.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.self = globalThis;
globalThis.WarehouseCore = require('../src/core.js');
require('../src/agent.js');
require('../src/eval.js');
const W = globalThis.WarehouseCore, A = globalThis.WarehouseAgent, E = globalThis.WarehouseEval;

const fakeCtx = model => ({ model, viewer: { showPlan() {}, focus: t => String(t), drawRoute() {}, removePlan() {}, canFocus: t => /^(overview|docks|[ACHS]|D\d+|P\d+)$/i.test(String(t)) }, ui: { planColor: () => '--plan-1', renderReport() {}, refresh() {} } });

function runScript(c, script, answer) {
  const model = new W.WarehouseModel(W.generateSlots(2026));
  const history = [];
  if (c.setup) {
    const r = model.findSpace(c.setup.request);
    history.push(c.setup.user, `${r.plan_id}: reserved ${r.pallets_reserved} pallets of ${r.goods} in zone ${r.zone}`);
  }
  const sitePrompt = A.instructions(model);
  const tools = A.buildTools(fakeCtx(model));
  const log = [];
  for (const [name, input] of script) {
    const t = tools.find(x => x.name === name);
    try { log.push({ name, input, ok: true, result: t.run(input) }); } catch (e) { log.push({ name, input, ok: false, error: e.message }); }
  }
  const text = answer(log.map(l => l.result));
  return {
    log, text, sources: [sitePrompt, c.prompt, ...history, ...log.map(s => s.result || '')],
    reserved: model.plans.reduce((a, p) => a + p.pallets_reserved, 0), plans: model.plans.length,
  };
}

const say = r => `${r.plan_id}: ${r.pallets_reserved} of ${r.pallets_requested} pallets in zone ${r.zone}, dock ${r.main_dock}.` + (r.shortfall ? ` Short by ${r.shortfall}.` : '');
const no = r => `Not possible: ${r.reason}`;
const ORACLE = {
  1: [[['find_space', { goods: 'Vaccines', pallets: 400, temperature: 'chilled', weight_kg_per_pallet: 450 }], ['draw_route', { plan_id: 'P1' }]], r => say(r[0]) + ` Route ${r[1].distance_m} m.`],
  2: [[['find_space', { goods: 'Shampoo', pallets: 300 }], ['draw_route', { plan_id: 'P1' }]], r => say(r[0])],
  3: [[['find_space', { goods: 'Li-ion batteries', pallets: 60, hazmat_class: '9' }], ['draw_route', { plan_id: 'P1' }]], r => say(r[0])],
  4: [[['find_space', { goods: 'Smartphones', pallets: 250, high_value: true, weight_kg_per_pallet: 300 }]], r => say(r[0])],
  5: [[['find_space', { goods: 'Seafood', pallets: 100, temperature: 'frozen' }]], r => no(r[0])],
  6: [[['find_space', { goods: 'Propane', pallets: 50, hazmat_class: '2.1' }]], r => no(r[0])],
  7: [[['find_space', { goods: 'Medical', pallets: 20, hazmat_class: '3', temperature: 'chilled' }]], r => no(r[0]) + ' It cannot be stored.'],
  8: [[['find_space', { goods: 'Steel', pallets: 80, weight_kg_per_pallet: 1200 }]], r => no(r[0])],
  9: [[['find_space', { goods: 'Mattresses', pallets: 40, pallet_height_m: 1.9 }]], r => no(r[0])],
  10: [[['find_space', { goods: 'Laptops', pallets: 150, high_value: true }]], r => say(r[0])],
  11: [[['find_space', { goods: 'Paint', pallets: 120, hazmat_class: '3' }]], r => say(r[0])],
  12: [[['find_space', { goods: 'Ice cream', pallets: 200, temperature: 'frozen' }]], r => no(r[0])],
  13: [[['find_space', { goods: 'Rice', pallets: 100 }], ['find_space', { goods: 'Car batteries', pallets: 30, hazmat_class: '8' }]], r => say(r[0]) + ' ' + say(r[1])],
  14: [[['move_camera', { target: 'C' }]], () => 'Here is the chilled zone, 2–8 °C.'],
  15: [[], () => 'The dangerous goods store has 250 free pallet positions right now.'],
  16: [[['release_plan', { plan_id: 'P1' }], ['find_space', { goods: 'Detergent', pallets: 350 }]], r => say(r[1])],
  17: [[['create_client_report', { client_name: 'Acme Pharma' }]], r => `Summary ready for ${r[0].client}: ${r[0].total_pallets_reserved} pallets.`],
  18: [[], () => 'No. This is a fictional sample site built for a concept prototype.'],
  19: [[], () => 'I can only help with storing goods at this warehouse.'],
  20: [[['find_space', { goods: 'Yogurt', pallets: 900, temperature: 'chilled' }]], r => say(r[0])],
  21: [[['follow_pallet', { plan_id: 'P1' }]], r => `Watch ${r[0].plan_id}: from ${r[0].dock} to ${r[0].location}, ${r[0].distance_m} m.`],
  22: [[['give_tour', { stops: [{ target: 'overview', caption: 'The site has 10,144 pallet positions in four zones.' }, { target: 'C', caption: 'Zone C is chilled, 2–8 °C, with 793 free positions.' }, { target: 'docks', caption: 'D8 to D10 are reefer docks.' }] }]], () => 'Enjoy the tour.'],
};

test('a perfect agent scores full marks', () => {
  assert.equal(E.CASES.length, 22);
  for (const c of E.CASES) {
    const [script, answer] = ORACLE[c.id];
    const s = E.score(c, runScript(c, script, answer), A.groundingCheck);
    assert.ok(s.pass, `case ${c.id}: ` + s.checks.filter(x => !x.pass).map(x => `${x.name} (${x.detail})`).join('; '));
  }
});

test('typical mistakes fail', () => {
  const c = id => E.CASES.find(x => x.id === id);
  // wrong zone: puts vaccines in ambient
  assert.equal(E.score(c(1), runScript(c(1), [['find_space', { goods: 'Vaccines', pallets: 400 }], ['draw_route', { plan_id: 'P1' }]], r => say(r[0])), A.groundingCheck).pass, false);
  // invents a number
  assert.equal(E.score(c(2), runScript(c(2), ORACLE[2][0], r => say(r[0]) + ' That takes 37 minutes.'), A.groundingCheck).pass, false);
  // answers the frozen question without checking the rules
  assert.equal(E.score(c(5), runScript(c(5), [], () => 'Sorry, we have no frozen storage.'), A.groundingCheck).pass, false);
  // re-plans without releasing the old plan
  assert.equal(E.score(c(16), runScript(c(16), [['find_space', { goods: 'Detergent', pallets: 350 }]], r => say(r[0])), A.groundingCheck).pass, false);
  // a tour caption with an invented number
  assert.equal(E.score(c(22), runScript(c(22), [['give_tour', { stops: [{ target: 'A', caption: 'Zone A holds 12,000 pallets.' }] }]], () => 'Enjoy.'), A.groundingCheck).pass, false);
  // a tour to a place that does not exist is refused by the tool, so give_tour never succeeds
  assert.equal(E.score(c(22), runScript(c(22), [['give_tour', { stops: [{ target: 'Z9', caption: 'Hello.' }] }]], () => 'Enjoy.'), A.groundingCheck).checks.find(x => x.name === 'Called give_tour').pass, true);
  // hides a shortfall (reserves in the wrong zone to "fit")
  assert.equal(E.score(c(4), runScript(c(4), [['find_space', { goods: 'Phones', pallets: 250 }]], r => say(r[0])), A.groundingCheck).pass, false);
});
