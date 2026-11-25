'use strict';
/* node tools/test_hud_cold.js   (Node 8 on the car: npx -y node@8.16.2 tools/test_hud_cold.js)
 * The rev bar's lower red while the oil is cold (apps/woodr_hud/strip.js coldZones), and when Warm-Up HUD's
 * low-tyre warning is on the display (apps/woodr_warmhud/lowtyre.js). */
const path = require('path');
const { coldZones, gearText, GEAR, CARD, MARKS, MARK_LABEL, MARKBAR, markAt, markStep } = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'strip.js'));
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

ok('gear: the engaged gear in drive, with D small above it', JSON.stringify(gearText({ gear: 4, stage: 'D' })) === '{"big":"4","small":"D"}' && gearText({ gear: 7 }).big === '7' && gearText({ gear: 7 }).small === '');
ok('gear: P, R and N are the figure themselves, whatever the gear field says', ['P', 'R', 'N'].every((s) => gearText({ gear: 3, stage: s }).big === s) && gearText({ gear: -1 }).big === 'R' && gearText({ gear: 0 }).big === 'N' && gearText({ stage: 'D' }).big === 'D');
ok('gear: nothing known is nothing shown', [null, {}, { gear: NaN }, { gear: 'x' }, { gear: 14 }, { gear: -5 }].every((d) => gearText(d) === null));
ok('gear: it sits in the gap between the car\'s speed and the song card, in the same row', GEAR.x >= 342 && GEAR.x + GEAR.w <= CARD.x - 4 && GEAR.y === CARD.y && GEAR.h === CARD.h);
ok('mark: five choices in the order the roller meets them, each with a label', MARKS.join() === 'police,fire,ambulance,other,none' && MARKS.every((m) => typeof MARK_LABEL[m] === 'string' && MARK_LABEL[m].length <= 12));
ok('mark: the bar starts on the guess, an unknown guess on "other"', markAt('police') === 0 && markAt('ambulance') === 2 && markAt('tank') === 3 && markAt(undefined) === 3);
ok('mark: the roller steps one at a time and wraps both ways', markStep(0, true) === 1 && markStep(4, true) === 0 && markStep(0, false) === 4 && markStep(2, false) === 1);
ok('mark: the bar sits right of Scout\'s first card, clear of the song row and inside the display\'s window', MARKBAR.x >= 220 + 260 && MARKBAR.x + MARKBAR.w <= 690 && MARKBAR.y + MARKBAR.h <= CARD.y);

const low = new LowTyre();
ok('a tyre at its target: no warning', low.show(0.05, 0.2, 0) === false && low.show(null, 0.2, 0) === false);
ok('found low: shown, for a while', low.show(0.25, 0.2, 1000) === true && low.show(0.25, 0.2, 1000 + SHOW_MS - 1) === true && low.show(0.25, 0.2, 1000 + SHOW_MS) === false);
ok('still that low an hour on: not shown again', low.show(0.27, 0.2, 3600000) === false);
ok('lower by another tenth of a bar: shown again', low.show(0.36, 0.2, 3600000) === true && low.show(0.36, 0.2, 3600000 + SHOW_MS + 1) === false);
ok('pumped up, then low again: a new warning', low.show(0.1, 0.2, 4000000) === false && low.show(0.22, 0.2, 4100000) === true);
ok('switched off: never', new LowTyre().show(1, 0, 0) === false && new LowTyre().show(1, undefined, 0) === false);
ok('a reading on the line does not flap', (() => { const l = new LowTyre(); l.show(0.21, 0.2, 0); l.show(0.19, 0.2, SHOW_MS + 5); return l.show(0.21, 0.2, SHOW_MS + 10) === false; })());

/* ---- something seen with no alert behind it (a sighting) */
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'strip.js'));
const hudMain = fs.readFileSync(path.join(__dirname, '..', 'apps', 'woodr_hud', 'main.js'), 'utf8');
ok('sighting: four kinds, never "nothing"', S.SEEN.join() === 'police,fire,ambulance,other' && S.SEEN.every((k) => MARKS.indexOf(k) >= 0 && MARK_LABEL[k]));
ok('sighting: each kind has a sign that stays inside its box, and the bar draws with and without one', (() => {
    const boxes = [];
    const cv = { roundRect: (x, y, w, h) => boxes.push([x, y, w, h]), text: () => {} };
    return S.SEEN.every((k) => { boxes.length = 0; S.drawIcon(cv, k, 10, 20, 24); return boxes.length >= 1 && boxes.every((b) => b[0] >= 10 && b[1] >= 20 && b[0] + b[2] <= 34 && b[1] + b[3] <= 44); })
        && (S.drawMark(cv, MARKBAR.w, MARKBAR.h, 0, '', '') || true) && (S.drawMark(cv, MARKBAR.w, MARKBAR.h, 0, 'POLICE', 'police') || true) && (S.drawMark(cv, MARKBAR.w, MARKBAR.h, 4, 'MARKED', 'tank') || true);
})());
ok('sighting: the rows show only while Scout says its box takes them, right under Highlight', /const seen = mk\.sight \? SEEN\.map\(/.test(hudMain) && /mk\.sight = !!\(m && m\.sighting === true\);/.test(hudMain) && hudMain.indexOf(".concat(seen)") < hudMain.indexOf(".concat(groups.map("));
ok('sighting: only the choice is handed over, and the menu gets out of the way', /shared\.write\('hud\.scoutmark\.json', \{ n: mk\.sent, sighting: true, as: as \}\)/.test(hudMain) && /if \(!mk\.sight \|\| SEEN\.indexOf\(as\) < 0\)/.test(hudMain) && /log\.info\('sighting: ' \+ as\);\n        closeMenu\(\);/.test(hudMain.replace(/\r\n/g, '\n')));

/* ---- the rev bar drawn 30 times a second: only the changed part is sent, and the revs carry on between reports */
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));
ok('rev bar: sending only the changed part gives the same picture as sending all of it, whichever way the revs go', (() => {
    const W = 562, H = 30, zs = { yellow: 5500, red: 6300 };
    const pic = (fill) => { const cv = new Canvas(W, H); S.drawBar(cv, W, H, fill, zs); return cv.d; };
    const fills = [0, 1, 2, 40, 41, 43, 70, 68, 139, 141, 300, 299, 372, 380, 520, 545, 544, 60, 0];
    let shown = Buffer.from(pic(fills[0]));
    for (let i = 1; i < fills.length; i++) {
        const now = pic(fills[i]), r = S.barDirty(W, H, fills[i - 1], fills[i]), rows = S.rowsOf(now, W, r);
        if (rows.length !== r.w * r.h * 4 || r.x < 0 || r.x + r.w > W) return false;
        for (let y = 0; y < r.h; y++) rows.copy(shown, ((r.y + y) * W + r.x) * 4, y * r.w * 4, (y + 1) * r.w * 4);
        if (Buffer.compare(shown, Buffer.from(now)) !== 0) return false;
    }
    return S.barDirty(W, H, 100, 101).w < 80;
})());
ok('rev bar: between two reports it carries on along the climb, and a new report replaces the guess', (() => {
    const m = new S.Smooth();
    m.at(3000, 1000, 6800); m.at(3200, 1060, 6800);                 /* 200 rpm in 60 ms */
    const mid = m.at(3200, 1090, 6800), next = m.at(3350, 1120, 6800);
    return mid > 3250 && mid < 3350 && next === 3350;
})());
ok('rev bar: it never guesses past the limit, for long, from a glitch, or when the revs are steady', (() => {
    const a = new S.Smooth(); a.at(6500, 1000, 6800); a.at(6790, 1060, 6800);
    const capped = a.at(6790, 1100, 6800) <= 6800;
    const b = new S.Smooth(); b.at(3000, 1000, 6800); b.at(3200, 1060, 6800);
    const stale = b.at(3200, 1400, 6800) === 3200;
    const c = new S.Smooth(); c.at(1000, 1000, 6800); c.at(6000, 1050, 6800);
    const glitch = c.at(6000, 1080, 6800) === 6000;
    const d = new S.Smooth(); d.at(2000, 1000, 6800); d.at(2005, 1060, 6800);
    const steady = d.at(2005, 1090, 6800) === 2005;
    const e = new S.Smooth(); e.at(5000, 1000, 6800); e.at(4700, 1060, 6800);
    const falling = e.at(4700, 1090, 6800) < 4700 && e.at(4700, 1090, 6800) >= 0;
    return capped && stale && glitch && steady && falling && new S.Smooth().at(null, 1, 1) === null;
})());
ok('rev bar: the bar has its own timer at 30 a second and the slower one only says what to show', /const BAR_FPS = 30, BAR_MS = 33;/.test(hudMain) && /fps: BAR_FPS/.test(hudMain) && /barWant = \{ test: /.test(hudMain) && /\}, BAR_MS\);/.test(hudMain) && !/fps: 8, sampling/.test(hudMain));

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
