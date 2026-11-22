'use strict';
/* node tools/test_studio_runlog.js
 * The Studio core's reader for Launch's data logs (components/studio-core/runlog.js): that a file the Launch app
 * writes is read back, that a damaged or hostile one is refused or bounded, that a run's readings are found for
 * any moment, and that a run is found in a drive from its speed alone. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const R = require(path.join(__dirname, '..', 'components', 'studio-core', 'runlog.js'));
const L = require(path.join(__dirname, '..', 'components', 'studio-core', 'library.js'));
const APP = require(path.join(__dirname, '..', 'apps', 'woodr_launch', 'runlog.js'));

let failed = 0;
function ok(name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }

/* a launch as the car would log it: armed at 0, moves at 2.5 s, pulls 0.8 g for `secs` seconds */
const speedAt = (s) => (s <= 0 ? 0 : 0.8 * 9.80665 * 3.6 * s);
function carFile(secs) {
    const dir = path.join(os.tmpdir(), 'studio-runlog-' + process.pid + '-' + Math.round(secs * 10));
    const rl = new APP.RunLog(dir);
    rl.arm(1000);
    for (let t = 1000; t <= 3500 + secs * 1000; t += 20) { const s = (t - 3500) / 1000; rl.sample(t, { kmh: speedAt(s), rpm: 3000 + 800 * (Math.max(0, s) % 3), gear: s < 3 ? 1 : 2, gLong: s > 0 ? 0.8 : 0, gLat: 0, torque: 500 }); }
    const made = rl.finish({ at: '2026-11-15T22:10:00.000Z', greenMs: 3200, moveMs: 3500, rollout: false, red: false, et: { ft60: 1.95, mph60: 3.4, mi8: 7.6, junk: 4, mph30: 'x' } });
    const text = fs.readFileSync(path.join(dir, made.file), 'utf8');
    fs.unlinkSync(path.join(dir, made.file)); fs.rmdirSync(dir);
    return { text: text, name: made.file };
}
const car = carFile(9);

ok('a file the Launch app wrote is read back: times from first movement, splits in order, the summary', () => {
    const p = R.parse(car.text);
    assert(p.ok, p.error);
    const run = p.run;
    assert.strictEqual(run.at, Date.parse('2026-11-15T22:10:00.000Z')); assert.strictEqual(run.lead, 2.5);
    assert(Math.abs(run.end - 9) < 0.05, 'end ' + run.end); assert(run.t[0] === -2.5 && run.t.length > 200);
    assert.deepStrictEqual(run.splits, [{ key: 'ft60', label: '60 FT', s: 1.95 }, { key: 'mph60', label: '0-60 MPH', s: 3.4 }, { key: 'mi8', label: '1/8 MILE', s: 7.6 }]);
    assert(Math.abs(run.peakG - 0.8) < 0.01 && run.launchRpm >= 3000 && run.shifts.length === 1 && run.shifts[0].to === 2);
    assert(R.isRunFile(car.name) && R.isRunFile('runs/' + car.name) && !R.isRunFile('run-notes.json') && !R.isRunFile('2026-11-14 18.41.07.json') && !R.isRunFile(null));
});
ok('the readings at any moment: between rows, before the start, after the end', () => {
    const run = R.parse(car.text).run;
    const a = R.at(run, 2.01);
    assert(Math.abs(a.kmh - speedAt(2.01)) < 0.5 && a.gear === 1 && Math.abs(a.g - 0.8) < 0.001 && a.rpm > 3000, JSON.stringify(a));
    assert.strictEqual(R.at(run, -30).kmh, 0); assert(Math.abs(R.at(run, 500).kmh - speedAt(9)) < 1); assert.strictEqual(R.at(run, 4).gear, 2);
    [NaN, undefined, 'x'].forEach((v) => assert.deepStrictEqual(R.at(run, v), { kmh: null, rpm: null, gear: null, g: null }));
    assert.deepStrictEqual(R.at(null, 1), { kmh: null, rpm: null, gear: null, g: null });
});
ok('a damaged or hostile file is refused, never half-read', () => {
    const doc = JSON.parse(car.text);
    const bad = (change, why) => { const d = JSON.parse(car.text); change(d); const p = R.parse(JSON.stringify(d)); assert(!p.ok, why + ' was accepted'); };
    [null, 5, {}, '', 'not json', '[]', '{"v":1}', '{"v":2,"rows":[]}'].forEach((t) => assert(!R.parse(t).ok));
    bad((d) => { d.rows = d.rows.slice(0, 3); }, 'three rows');
    bad((d) => { d.rows[10][0] = -5; }, 'time going backwards');
    bad((d) => { d.rows[10] = 'row'; }, 'a row that is text');
    bad((d) => { d.moveMs = 'soon'; }, 'no start');
    bad((d) => { d.rows.forEach((r) => { r[1] = null; }); }, 'no speed at all');
    bad((d) => { const big = []; for (let i = 0; i < 5000; i++) big.push([i, 1, 1, 1, 0, 0, 0]); d.rows = big; }, 'five thousand rows');
    assert(!R.parse('x'.repeat(R.MAX_BYTES + 1)).ok, 'too large');
    doc.rows[20] = [doc.rows[20][0], 1e9, -4, 99, 50, 'x', {}]; doc.et = { ft60: -1, mph60: 1e9, mi4: 11.5, __proto__: { mi8: 3 } }; doc.summary = { peakG: 99, launchRpm: 'high', spinKmh: -3, shifts: [{ s: 2, to: 2 }, { s: 'x' }, null, 7, { s: 1, to: 50 }] }; doc.at = 'tomorrow'; doc.extra = { vin: 'X', lat: 1 };
    const p = R.parse(JSON.stringify(doc));
    assert(p.ok, p.error);
    assert.deepStrictEqual(p.run.splits, [{ key: 'mi4', label: '1/4 MILE', s: 11.5 }]);
    assert(isNaN(p.run.at) && p.run.peakG === null && p.run.launchRpm === null && p.run.spinKmh === null);
    assert.deepStrictEqual(p.run.shifts, [{ s: 2, to: 2, rpm: null }]);
    assert(!/vin|"lat"|extra/.test(JSON.stringify(p.run)), 'nothing but the readings is kept');
    assert(p.run.kmh.every((v) => v >= 0 && v <= 500), 'the impossible speed was left out');
});

/* a drive's speed as the dash cam records it: 12 samples a second, a launch starting 73.4 s in, traffic before and after */
function drive(startAt, noise) {
    const t = [], kmh = [];
    let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let x = 0; x <= 180; x += 1 / 12) {
        let v;
        if (x < 20) v = 40; else if (x < 30) v = 40 - (x - 20) * 4; else if (x < 40) v = 0;           /* slows to a stop */
        else if (x < 50) v = (x - 40) * 2.5; else if (x < 60) v = 25 - (x - 50) * 2.5;                /* a gentle pull-away, like any junction */
        else if (x < startAt) v = 0; else if (x < startAt + 9) v = speedAt(x - startAt); else v = Math.max(0, speedAt(9) - (x - startAt - 9) * 25);
        t.push(x); kmh.push(Math.max(0, v + (noise ? rnd() * noise : 0)));
    }
    return { t: t, kmh: kmh };
}
ok('a run is found in a drive from its speed alone, to about a tenth of a second', () => {
    const run = R.parse(car.text).run;
    const hit = R.align(run, drive(73.4, 0));
    assert(hit && Math.abs(hit.at - 73.4) <= 0.15 && hit.err < 2, JSON.stringify(hit));
    const noisy = R.align(run, drive(121.7, 3));
    assert(noisy && Math.abs(noisy.at - 121.7) <= 0.2, 'with a jittery speed signal: ' + JSON.stringify(noisy));
});
ok('a drive the run is not in gives nothing, and so does a run too gentle to tell from a junction', () => {
    const run = R.parse(car.text).run;
    const calm = { t: [], kmh: [] }; for (let x = 0; x <= 120; x += 0.1) { calm.t.push(x); calm.kmh.push(x < 60 ? 50 : 50 - (x - 60) * 0.5); }
    assert.strictEqual(R.align(run, calm), null);
    const d = JSON.parse(car.text); d.rows.forEach((r) => { r[1] = Math.min(r[1], 12); });
    assert.strictEqual(R.align(R.parse(JSON.stringify(d)).run, drive(73.4, 0)), null, 'a crawl');
    [null, {}, { t: [1, 2], kmh: [1, 2] }, { t: [3, 2, 1, 0], kmh: [0, 0, 0, 0] }, { t: [0, 1, 2, 3], kmh: [0, NaN, 1, 2] }].forEach((tr) => assert.strictEqual(R.align(run, tr), null));
    assert.strictEqual(R.align(null, drive(73.4, 0)), null);
});
ok('a folder listing tells run logs from clips, edits and clip data', () => {
    const s = L.sort(['2026-11-15 22.09.40.mp4', '2026-11-15 22.09.40.json', 'Evening.edit.json', car.name, 'runs/run-2026-11-15-22-14-05.json', 'run-old.json']);
    assert.strictEqual(s.clips.length, 1); assert.strictEqual(s.clips[0].meta, 1); assert.deepStrictEqual(s.recipes, [2]); assert.deepStrictEqual(s.runs, [3, 4]); assert.strictEqual(s.other, 1);
    assert.deepStrictEqual(L.sort([]).runs, []);
});
ok('the green light is read as seconds from first movement, and a wild one is dropped', () => {
    assert.ok(Math.abs(R.parse(car.text).run.green - -0.3) < 1e-9);
    const doc = JSON.parse(car.text); doc.greenMs = 'soon'; assert.strictEqual(R.parse(JSON.stringify(doc)).run.green, null);
    doc.greenMs = doc.moveMs + 90000; assert.strictEqual(R.parse(JSON.stringify(doc)).run.green, null);
    delete doc.greenMs; assert.strictEqual(R.parse(JSON.stringify(doc)).run.green, null);
});

console.log(failed ? 'FAILED: ' + failed : 'runlog: all ok');
process.exit(failed ? 1 : 0);
