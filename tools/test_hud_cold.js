'use strict';
/* node tools/test_hud_cold.js   (Node 8 on the car: npx -y node@8.16.2 tools/test_hud_cold.js)
 * The rev bar's lower red while the oil is cold (apps/woodr_hud/strip.js coldZones), and when Warm-Up HUD's
 * low-tyre warning is on the display (apps/woodr_warmhud/lowtyre.js). */
const path = require('path');
const { coldZones } = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'strip.js'));
const { LowTyre, SHOW_MS } = require(path.join(__dirname, '..', 'apps', 'woodr_warmhud', 'lowtyre.js'));

let failed = 0;
const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name); } };
const SET = { green: 4000, yellow: 5500, red: 6300, shift: 6800 };
const z = (oil, readyAt) => coldZones(SET, { oil: oil, readyAt: readyAt === undefined ? 90 : readyAt });

ok('warm oil, or nothing known: the zones as set', [z(90), z(110), coldZones(SET, null), coldZones(SET, {}), z('x'), z(NaN), z(50, 'x'), z(50, 10)]
    .every((r) => r.red === 6300 && r.yellow === 5500 && r.green === 4000 && r.shift === 6800 && r.cold === false));
ok('stone cold: red from 3000, and never under it', z(20).red === 3000 && z(-15).red === 3000 && z(20).cold === true);
ok('the red climbs with the oil, in hundreds', z(55).red === 4700 && z(72).red === 5500 && z(89).red === 6300);
ok('it only climbs', (() => { let last = 0; for (let t = -20; t <= 95; t++) { const r = z(t).red; if (r < last || r % 100) return false; last = r; } return last === 6300; })());
ok('yellow, green and the flash keep their order below it', [20, 40, 60, 80].every((t) => { const r = z(t); return r.green < r.yellow && r.yellow < r.red && r.red < r.shift && r.shift <= 6800 && r.yellow <= 5500 && r.green <= 4000; }));
ok('defaults stand in for settings never saved', coldZones({}, { oil: 20, readyAt: 90 }).red === 3000 && coldZones({}, null).red === 6300);
ok('a red already set at or under the cold figure is left alone', coldZones({ red: 3000 }, { oil: 20, readyAt: 90 }).red === 3000 && coldZones({ red: 3000 }, { oil: 20, readyAt: 90 }).cold === false);

const low = new LowTyre();
ok('a tyre at its target: no warning', low.show(0.05, 0.2, 0) === false && low.show(null, 0.2, 0) === false);
ok('found low: shown, for a while', low.show(0.25, 0.2, 1000) === true && low.show(0.25, 0.2, 1000 + SHOW_MS - 1) === true && low.show(0.25, 0.2, 1000 + SHOW_MS) === false);
ok('still that low an hour on: not shown again', low.show(0.27, 0.2, 3600000) === false);
ok('lower by another tenth of a bar: shown again', low.show(0.36, 0.2, 3600000) === true && low.show(0.36, 0.2, 3600000 + SHOW_MS + 1) === false);
ok('pumped up, then low again: a new warning', low.show(0.1, 0.2, 4000000) === false && low.show(0.22, 0.2, 4100000) === true);
ok('switched off: never', new LowTyre().show(1, 0, 0) === false && new LowTyre().show(1, undefined, 0) === false);
ok('a reading on the line does not flap', (() => { const l = new LowTyre(); l.show(0.21, 0.2, 0); l.show(0.19, 0.2, SHOW_MS + 5); return l.show(0.21, 0.2, SHOW_MS + 10) === false; })());

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
