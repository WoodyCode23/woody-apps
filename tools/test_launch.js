'use strict';
/**
 * test_launch.js - Launch (apps/woodr_launch) checked on a PC, no car and no head unit:
 *
 *   node tools/test_launch.js
 *
 *   - the timing maths against speed traces with known answers (constant acceleration has closed-form split
 *     times), fed at an uneven 48 to 70 samples a second in the car's own 1/64 km/h steps
 *   - rollout on and off, a jump start, runs that never get anywhere, a bad sample, the 60 s limit
 *   - the tree's schedule, the saved history (trimming, best markers), the demo car
 *   - where the cluster and head-up display pictures sit, and how much they upload
 *   - every page drawn on the kit's canvas (the kit in this repository): no text off the picture
 *   - the app's source scanned for syntax the head unit's Node 8 does not have
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', 'apps', 'woodr_launch');
const T = require(path.join(APP, 'timing'));
const H = require(path.join(APP, 'history'));
const D = require(path.join(APP, 'draw'));
const { DemoCar } = require(path.join(APP, 'demo'));

let failed = 0, passed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.message || e).split('\n')[0]); }
}
const near = (a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': got ' + a + ', want ' + b + ' +-' + tol);

/* a small seeded random number generator, so every run of the tests feeds the same uneven samples */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Drive a timer: the car stands, the tree is armed at armAt, and from startAt speed follows speedAt(ms since
 * the start) in km/h. Samples come 1000/70 to 1000/48 ms apart, rounded to the signal's 1/64 km/h; the clock's
 * tick runs every 20 ms. Stops when the timer is done or at endAt.
 */
function drive(o) {
    const rnd = rng(o.seed || 1), tm = new T.LaunchTimer({ rollout: !!o.rollout });
    const sched = T.treeSchedule(o.tree || 'sportsman', o.pre || 1500);
    let t = 0, nextTick = 0, armed = false;
    while (t < (o.endAt || 120000) && tm.state !== 'done') {
        t += 1000 / 70 + rnd() * (1000 / 48 - 1000 / 70);
        while (nextTick <= t) {
            if (!armed && nextTick >= o.armAt) { armed = tm.arm(nextTick, sched); assert(armed, 'the timer did not arm'); }
            tm.tick(nextTick); nextTick += 20;
        }
        const kmh = t < o.startAt ? 0 : Math.max(0, o.speedAt(t - o.startAt));
        if (o.quiet && kmh === 0 && t > 100) continue;            /* a standing car sends nothing new */
        tm.sample(t, T.kmhFromRaw(Math.round(kmh * 64)));
        if (o.rpmAt) tm.rpm(o.rpmAt(t - o.startAt));
    }
    return { tm: tm, r: tm.result, green: o.armAt + sched.green, sched: sched };
}

/* closed forms for constant acceleration a (m/s2) from a standstill at time 0, clock started at MOVE_KMH */
function closed(a, rollout) {
    const v0 = T.MOVE_KMH / 3.6, tMove = v0 / a;
    const tauD = (d) => (-v0 + Math.sqrt(v0 * v0 + 2 * a * d)) / a;      /* s after tMove at distance d from there */
    const tauV = (kmh) => (kmh / 3.6 - v0) / a;
    const off = rollout ? T.ROLLOUT_M : 0, t0 = rollout ? tauD(off) : 0;
    return {
        tMove: tMove * 1000,
        dist: (m) => tauD(off + m) - t0,
        speed: (kmh) => tauV(kmh) - t0,
        between: (a1, b1) => tauV(b1) - tauV(a1),
        kmhAt: (m) => (v0 + a * tauD(off + m)) * 3.6,
        trap: (m) => T.TRAP_M / (tauD(off + m) - tauD(off + m - T.TRAP_M)) * 3.6,
    };
}

/* ---------------- units and the tree ---------------- */
check('1/64 km/h: raw counts become km/h, the signal\'s "no value" becomes null', () => {
    assert.strictEqual(T.kmhFromRaw(0), 0);
    assert.strictEqual(T.kmhFromRaw(64), 1);
    assert.strictEqual(T.kmhFromRaw(6400), 100);
    assert.strictEqual(T.kmhFromRaw(32), 0.5);
    near(T.kmhFromRaw(Math.round(60 * T.MPH * 64)) / T.MPH, 60, 0.01, '60 mph through the raw count');
    assert.strictEqual(T.kmhFromRaw(65535), null);
    assert.strictEqual(T.kmhFromRaw(-1), null);
    assert.strictEqual(T.kmhFromRaw(undefined), null);
    assert.strictEqual(T.kmhFromRaw(NaN), null);
    assert.strictEqual(T.kmhFromRaw('64'), null);
});
check('tree: sportsman is three ambers 0.5 s apart then green, pro is all ambers then green 0.4 s later', () => {
    const s = T.treeSchedule('sportsman', 1200);
    assert.deepStrictEqual(s.ambers, [1200, 1700, 2200]); assert.strictEqual(s.green, 2700);
    const p = T.treeSchedule('pro', 1200);
    assert.deepStrictEqual(p.ambers, [1200, 1200, 1200]); assert.strictEqual(p.green, 1600);
    assert.deepStrictEqual(T.treeLights(s, 1199), { ambers: [false, false, false], green: false, red: false });
    assert.deepStrictEqual(T.treeLights(s, 1200).ambers, [true, false, false]);
    assert.deepStrictEqual(T.treeLights(s, 1700).ambers, [false, true, false]);
    assert.deepStrictEqual(T.treeLights(s, 2699).ambers, [false, false, true]);
    assert.deepStrictEqual(T.treeLights(s, 2700), { ambers: [false, false, false], green: true, red: false });
    assert.deepStrictEqual(T.treeLights(p, 1300).ambers, [true, true, true]);
    assert.strictEqual(T.treeLights(p, 1599).green, false);
    assert.strictEqual(T.treeLights(p, 1600).green, true);
});
check('tree: the pre-stage delay is 1.0 to 2.5 s over the whole random range', () => {
    assert.strictEqual(T.preStageDelay(0), 1000); assert.strictEqual(T.preStageDelay(1), 2500);
    for (let i = 0; i <= 100; i++) { const d = T.preStageDelay(i / 100); assert(d >= 1000 && d <= 2500, String(d)); }
    assert.strictEqual(T.preStageDelay(7), 2500); assert.strictEqual(T.preStageDelay(-3), 1000);
});

/* ---------------- timing against closed forms ---------------- */
const TOL = 0.004;      /* seconds: "a few ms", with uneven samples and 1/64 km/h steps */
[false, true].forEach((rollout) => [3, 5.5].forEach((a) => [11, 29, 73].forEach((seed) => {
    check('constant ' + a + ' m/s2, rollout ' + (rollout ? 'on' : 'off') + ', sample jitter seed ' + seed + ': every split within ' + TOL * 1000 + ' ms', () => {
        const startAt = 6000 + seed, c = closed(a, rollout);
        const x = drive({ seed: seed, rollout: rollout, armAt: 2000, startAt: startAt, speedAt: (ms) => Math.min(440, a * ms / 1000 * 3.6) });
        const r = x.r;
        assert(r, 'no result'); assert.strictEqual(r.aborted, false); assert.strictEqual(r.rollout, rollout); assert.strictEqual(r.red, false);
        near(r.rt, (startAt + c.tMove - x.green) / 1000, TOL, 'reaction');
        T.DIST.forEach((m) => {
            const want = c.dist(m.m);
            if (c.kmhAt(m.m) > 438) return;                      /* past the trace's top speed: not a constant-acceleration mark */
            near(r.et[m.key], want, TOL, m.label);
            near(r.kmh[m.key], c.kmhAt(m.m), 0.15, m.label + ' speed at the mark');
            if (m.trap) near(r.trap[m.key], c.trap(m.m), 0.15, m.label + ' trap speed (66 ft average)');
        });
        near(r.et.mph30, c.speed(30 * T.MPH), TOL, '0-30 mph');
        near(r.et.mph60, c.speed(60 * T.MPH), TOL, '0-60 mph');
        near(r.et.mph100, c.speed(100 * T.MPH), TOL, '0-100 mph');
        near(r.et.mph60_130, c.between(60 * T.MPH, 130 * T.MPH), TOL, '60-130 mph');
        near(r.et.kmh100, c.speed(100), TOL, '0-100 km/h');
        near(r.et.kmh100_200, c.between(100, 200), TOL, '100-200 km/h');
        assert(r.hz >= 48 && r.hz <= 70, 'sample rate seen ' + r.hz);
        assert(r.maxGapMs <= 21, 'longest gap ' + r.maxGapMs);
    });
})));
check('times are not stepped to the sample period: 200 runs at shifted starts give 60 ft within 2 ms of each other', () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 200; i++) {
        const x = drive({ seed: 1000 + i, armAt: 1000, startAt: 5000 + i * 0.37, speedAt: (ms) => (ms > 6000 ? 5 * 6 * 3.6 - (ms - 6000) / 100 : 5 * ms / 1000 * 3.6) });
        lo = Math.min(lo, x.r.et.ft60); hi = Math.max(hi, x.r.et.ft60);
    }
    assert(hi - lo < 0.002, 'spread ' + ((hi - lo) * 1000).toFixed(2) + ' ms');
    near((lo + hi) / 2, closed(5, false).dist(60 * T.FT), 0.002, '60 ft');
});
check('rollout: on starts the clock one foot in, so every time is shorter by the time that foot took', () => {
    const f = (ms) => (ms > 12000 ? 4.5 * 12 * 3.6 - (ms - 12000) / 50 : 4.5 * ms / 1000 * 3.6);
    const off = drive({ seed: 5, rollout: false, armAt: 1000, startAt: 5000, speedAt: f }).r;
    const on = drive({ seed: 5, rollout: true, armAt: 1000, startAt: 5000, speedAt: f }).r;
    const foot = closed(4.5, false).dist(T.FT);
    assert(foot > 0.3 && foot < 0.4, 'the first foot at 4.5 m/s2 takes ' + foot);
    near(off.et.mph60 - on.et.mph60, foot, 0.003, '0-60 difference');
    near(off.et.ft60 - on.et.ft60, foot - (closed(4.5, false).dist(61 * T.FT) - closed(4.5, false).dist(60 * T.FT)), 0.003, '60 ft difference');
    near(off.rt, on.rt, 1e-9, 'reaction is first movement minus green either way');
    assert.strictEqual(off.rollout, false); assert.strictEqual(on.rollout, true);
});

/* ---------------- how runs start and end ---------------- */
check('jump start: moving before green is a red light, reported with how early, and the run is still timed', () => {
    const x = drive({ seed: 3, armAt: 2000, pre: 2000, startAt: 4900, speedAt: (ms) => (ms > 5000 ? 5 * 5 * 3.6 - (ms - 5000) / 50 : 5 * ms / 1000 * 3.6) });
    assert.strictEqual(x.green, 5500);
    assert.strictEqual(x.r.red, true);
    near(x.r.rt, (4900 + closed(5, false).tMove - 5500) / 1000, TOL, 'reaction (negative)');
    assert(x.r.rt < 0);
    near(x.r.et.ft60, closed(5, false).dist(60 * T.FT), TOL, '60 ft');
});
check('jump start: the tree shows red once the car has really gone, not at the first twitch', () => {
    const tm = new T.LaunchTimer({});
    tm.sample(0, 0); tm.tick(1000);
    assert(tm.arm(1000, T.treeSchedule('pro', 1500, 2500)));        /* green at 3500 */
    assert.deepStrictEqual(tm.lights(2600).ambers, [true, true, true]);
    tm.sample(2600, 0.2); tm.sample(2620, 2.0);
    assert.strictEqual(tm.state, 'armed', '2 km/h for a moment is not a start');
    assert.strictEqual(tm.lights(2630).red, false);
    tm.sample(2640, 6.5);
    assert.strictEqual(tm.state, 'run');
    assert(tm.tMove > 2600 && tm.tMove < 2620, 'timed from where it first moved: ' + tm.tMove);
    assert.deepStrictEqual(tm.lights(2700), { ambers: [false, false, false], green: false, red: true });
    assert.deepStrictEqual(tm.lights(9000), { ambers: [false, false, false], green: false, red: true });
});
/* a car held on the brake against the engine: it lurches, the brakes catch it, and it leaves on green */
function bumpRun(bump) {
    const tm = new T.LaunchTimer({});
    tm.sample(0, 0); tm.tick(1000);
    assert(tm.arm(1000, T.treeSchedule('sportsman', 1500, 1000)));        /* green at 5500 */
    let t = 1000;
    const feed = (to, speedAt) => { for (; t < to; t += 20) { tm.tick(t); const v = speedAt(t); if (v !== null) tm.sample(t + 7, v); } };      /* a sample never lands on the tick's own instant */
    feed(3000, () => null);
    bump(feed);
    feed(5800, () => null);                                             /* standing: nothing new from the car; 0.3 s after green */
    const go = t;
    feed(20000, (x) => (tm.state === 'done' ? null : Math.min(160, (x - go) / 1000 * 5 * 3.6)));
    return { tm: tm, r: tm.result, go: go };
}
check('a bump against the brakes before green is not a red light: the run is timed from the real start', () => {
    const x = bumpRun((feed) => { feed(3300, (t) => 3 * Math.sin(Math.PI * (t - 3000) / 300)); feed(3320, () => 0); });      /* up to 3 km/h for 0.3 s: about 16 cm */
    assert(x.r, 'the run finished');
    assert.strictEqual(x.r.red, false); assert.strictEqual(x.r.bumps, 1);
    assert(x.r.rt > 0.25 && x.r.rt < 0.4, 'reaction from green to the real start: ' + x.r.rt);
    assert(x.r.et.ft60 > 1.5 && x.r.et.ft60 < 3.5 && x.r.et.mph60 > 5 && x.r.et.mph60 < 5.6, JSON.stringify(x.r.et));
    assert.strictEqual(x.tm.lights(4000).red, false);
});
check('two bumps are two bumps; the tree never showed red for them', () => {
    const x = bumpRun((feed) => { feed(3200, () => 2); feed(3400, () => 0); feed(4000, () => null); feed(4150, () => 2.5); feed(4170, () => 0); });
    assert.strictEqual(x.r.red, false); assert.strictEqual(x.r.bumps, 2);
});
check('a bump that keeps going is a start: more than a foot, or faster than a crawl, before green is red', () => {
    const far = bumpRun((feed) => { feed(4200, () => 3); });                  /* 3 km/h for 1.2 s is a metre */
    assert.strictEqual(far.r.red, true); assert(far.r.rt < -2.3 && far.r.rt > -2.6, 'reported from where it first moved: ' + far.r.rt);
    const fast = bumpRun((feed) => { feed(3100, (t) => (t - 3000) / 100 * 8); });
    assert.strictEqual(fast.r.red, true);
    assert(T.CREEP_M <= 0.31 && T.CREEP_KMH <= 5, 'the allowance stays small');
});
check('still creeping a little when the light goes green: started at green, not before it', () => {
    const tm = new T.LaunchTimer({});
    tm.sample(0, 0); tm.tick(1000);
    assert(tm.arm(1000, T.treeSchedule('pro', 1500)));                       /* green at 2900 */
    tm.tick(2790);                                                           /* standing until now, as the clock carries it */
    for (let t = 2800; t < 2900; t += 20) tm.sample(t, 1.5);                 /* 4 cm in the last tenth of a second */
    assert.strictEqual(tm.state, 'armed');
    tm.sample(2910, 2.5); tm.sample(2930, 9);
    assert.strictEqual(tm.state, 'run');
    assert.strictEqual(tm.tMove, 2900); assert.strictEqual(tm.lights(3000).red, false); assert.strictEqual(tm.lights(3000).green, true);
});
check('the tree can be slowed for practice: the same order, further apart; a strip\'s half second is still there', () => {
    assert.deepStrictEqual(T.treeSchedule('sportsman', 1000).ambers, [1000, 1500, 2000]); assert.strictEqual(T.treeSchedule('sportsman', 1000).green, 2500);
    const slow = T.treeSchedule('sportsman', 1000, 1000);
    assert.deepStrictEqual([slow.ambers, slow.green, slow.gapMs], [[1000, 2000, 3000], 4000, 1000]);
    assert.strictEqual(T.treeSchedule('pro', 1000).green, 1400); assert.strictEqual(T.treeSchedule('pro', 1000, 1000).green, 1800);
    assert.deepStrictEqual(T.treeLights(slow, 2500).ambers, [false, true, false]);
    [NaN, 'x', -5, 0].forEach((g) => assert(T.treeSchedule('sportsman', 1000, g).green >= 1000 + 3 * 300));
    assert.strictEqual(T.treeSchedule('sportsman', 1000, 99999).gapMs, 3000);
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8')), s = spec.settings.filter((x) => x.key === 'treeGap')[0];
    assert(s && s.default === 1000 && s.options.some((o) => o[0] === 500), 'slower by default, the strip\'s pace a choice');
});
check('arming from the head-up display menu: Launch reads a small file, HUD offers the row only while Launch runs', () => {
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8'), hud = fs.readFileSync(path.join(APP, '..', 'woodr_hud', 'main.js'), 'utf8');
    assert(/statSync\(path\.join\(shared\.DIR, 'launch\.arm\.json'\)\)/.test(main) && /Date\.now\(\) - at > 5000/.test(main), 'only a fresh press counts');
    assert(/shared\.write\('launch\.state\.json'/.test(main) && /shared\.read\('launch\.state\.json', 5000\)/.test(hud));
    assert(/shared\.write\('launch\.arm\.json', \{ from: 'hud' \}\)/.test(hud) && /key: 'launch'/.test(hud));
    assert(/noticeSeen'\) !== true\) \{ hint\(/.test(main), 'never before the first-run notice was accepted');
});
check('a clean start shows green and no red', () => {
    const tm = new T.LaunchTimer({});
    tm.sample(0, 0);
    assert(tm.arm(100, T.treeSchedule('sportsman', 1000)));
    tm.tick(2700); tm.sample(2710, 0.3); tm.sample(2730, 1.5);
    assert.strictEqual(tm.state, 'run');
    assert.deepStrictEqual(tm.lights(2800), { ambers: [false, false, false], green: true, red: false });
});
check('arming is refused while the car moves, before any speed is known, and twice', () => {
    const tm = new T.LaunchTimer({});
    assert.strictEqual(tm.arm(0, T.treeSchedule('pro', 1000)), false);
    tm.sample(10, 12);
    assert.strictEqual(tm.arm(20, T.treeSchedule('pro', 1000)), false);
    tm.sample(30, 0);
    assert.strictEqual(tm.arm(40, T.treeSchedule('pro', 1000)), true);
    assert.strictEqual(tm.arm(50, T.treeSchedule('pro', 1000)), false);
    tm.cancel();
    assert.strictEqual(tm.state, 'idle'); assert.strictEqual(tm.note, 'cancelled');
});
check('aborted run: a creep that stops before any split ends with no time and is flagged', () => {
    const x = drive({ seed: 8, armAt: 1000, startAt: 5000, speedAt: (ms) => (ms < 1000 ? 4 * ms / 1000 : Math.max(0, 4 - (ms - 1000) / 250)) });
    assert.strictEqual(x.r.aborted, true); assert.strictEqual(x.r.end, 'stopped');
    assert.deepStrictEqual(x.r.et, {});
    assert.strictEqual(T.headline(x.r), null);
});
check('aborted run, rollout on: stopping inside the first foot still ends the run', () => {
    const tm = new T.LaunchTimer({ rollout: true });
    tm.sample(0, 0); assert(tm.arm(10, T.treeSchedule('pro', 1000)));
    tm.sample(2000, 0.3); tm.sample(2020, 0.8); tm.sample(2040, 0.9); tm.sample(2060, 0.2);
    assert.strictEqual(tm.state, 'done'); assert.strictEqual(tm.result.aborted, true); assert.strictEqual(tm.result.end, 'stopped');
});
check('armed and never launched: disarms 30 s after green, with no result', () => {
    const tm = new T.LaunchTimer({});
    tm.sample(0, 0); assert(tm.arm(0, T.treeSchedule('sportsman', 1000)));
    for (let t = 20; t <= 2500 + 30000; t += 20) tm.tick(t);
    assert.strictEqual(tm.state, 'armed');
    tm.tick(2500 + 30020);
    assert.strictEqual(tm.state, 'idle'); assert.strictEqual(tm.note, 'no launch'); assert.strictEqual(tm.result, null);
});
check('lift: the run ends 2 s after the last new top speed, once past 60 ft, and keeps its splits', () => {
    const x = drive({ seed: 21, armAt: 1000, startAt: 5000, speedAt: (ms) => (ms < 10000 ? 5 * ms / 1000 * 3.6 : 180 - (ms - 10000) / 1000 * 3) });
    assert.strictEqual(x.r.end, 'lift');
    near(x.r.durS, 10 - closed(5, false).tMove / 1000 + 2, 0.06, 'run length');
    near(x.r.peakKmh, 180, 0.3, 'peak speed');
    near(x.r.et.mi8, closed(5, false).dist(660 * T.FT), TOL, '1/8 mile');
    assert.strictEqual(x.r.et.mi4, undefined, '1/4 mile was never reached');
    assert.strictEqual(T.headline(x.r).key, 'mi8');
});
check('lift before 60 ft does not end the run; braking to a stop does', () => {
    const x = drive({ seed: 22, armAt: 1000, startAt: 5000, speedAt: (ms) => (ms < 1500 ? 10 * ms / 1500 : ms < 9000 ? 10 : Math.max(0, 10 - (ms - 9000) / 100)) });
    assert.strictEqual(x.r.end, 'lift');           /* a steady 10 km/h passes 60 ft at about 7.3 s; 2 s later, with no new top speed, the run ends */
    assert(x.r.et.ft60 > 7 && x.r.et.ft60 < 7.6, '60 ft at ' + x.r.et.ft60);
    near(x.r.durS, x.r.et.ft60 + 2, 0.05, 'ends 2 s after the 60 ft mark');
    const y = drive({ seed: 22, armAt: 1000, startAt: 5000, speedAt: (ms) => (ms < 1500 ? 10 * ms / 1500 : ms < 4000 ? 10 : Math.max(0, 10 - (ms - 4000) / 100)) });
    assert.strictEqual(y.r.end, 'stopped'); assert.strictEqual(y.r.et.ft60, undefined);
    assert.strictEqual(y.r.aborted, true);
});
check('60 s limit: a run that keeps creeping faster ends at the cap, by the clock', () => {
    const x = drive({ seed: 4, armAt: 1000, startAt: 4000, speedAt: (ms) => 1 + ms / 1000 * 0.4 });
    assert.strictEqual(x.r.end, 'cap');
    near(x.r.durS, 60, 0.03, 'run length');
    assert(x.r.et.ft60 > 0 && x.r.et.mph30 === undefined);
});
check('a zero sample at speed is thrown away as a bad sample, not taken as a stop', () => {
    let n = 0;
    const clean = drive({ seed: 9, armAt: 1000, startAt: 5000, speedAt: (ms) => (ms > 7000 ? 126 - (ms - 7000) / 50 : 5 * ms / 1000 * 3.6) }).r;
    const x = drive({ seed: 9, armAt: 1000, startAt: 5000, speedAt: (ms) => { const v = ms > 7000 ? 126 - (ms - 7000) / 50 : 5 * ms / 1000 * 3.6; return ms > 3000 && ms < 7000 && ++n % 40 === 0 ? 0 : v; } }).r;
    assert(x.glitches >= 3, 'bad samples seen: ' + x.glitches);
    assert.strictEqual(x.end, 'lift');
    near(x.et.mph60, clean.et.mph60, 0.002, '0-60 with bad samples');
    near(x.et.ft330, clean.et.ft330, 0.002, '330 ft with bad samples');
});
check('a standing car that sends nothing: the standstill is carried forward by the clock, the start is still right', () => {
    const x = drive({ seed: 31, quiet: true, armAt: 1000, startAt: 9000, speedAt: (ms) => (ms > 6000 ? 4 * 6 * 3.6 - (ms - 6000) / 50 : 4 * ms / 1000 * 3.6) });
    near(x.r.rt, (9000 + closed(4, false).tMove - x.green) / 1000, 0.006, 'reaction');
    near(x.r.et.ft60, closed(4, false).dist(60 * T.FT), 0.006, '60 ft');
    near(x.r.et.mph30, closed(4, false).speed(30 * T.MPH), 0.006, '0-30 mph');
});
check('samples out of order, non-numbers and impossible speeds are ignored', () => {
    const tm = new T.LaunchTimer({});
    tm.sample(100, 0); tm.sample(90, 50); tm.sample(110, NaN); tm.sample(120, -4); tm.sample(130, 900); tm.sample(NaN, 3);
    assert.deepStrictEqual(tm.prev, { t: 100, v: 0 });
    assert.strictEqual(tm.stopped(), true);
});
check('peak revs are kept for the run only', () => {
    const x = drive({ seed: 2, armAt: 1000, startAt: 4000, speedAt: (ms) => (ms > 5000 ? 90 - (ms - 5000) / 50 : 5 * ms / 1000 * 3.6), rpmAt: (ms) => (ms < 0 ? 9000 : ms < 5000 ? 2000 + ms : 3000) });
    assert(x.r.peakRpm > 6900 && x.r.peakRpm <= 7000, 'peak rpm ' + x.r.peakRpm);
});
check('every split never reached is absent (the screens then show a dash)', () => {
    const x = drive({ seed: 6, armAt: 1000, startAt: 4000, speedAt: (ms) => (ms > 3000 ? 54 - (ms - 3000) / 50 : 5 * ms / 1000 * 3.6) });
    assert.deepStrictEqual(Object.keys(x.r.et).sort(), ['ft60', 'mph30']);
    assert.strictEqual(D.secs(x.r.et.mi4), '-'); assert.strictEqual(D.distValue(x.r, 'mi4', 'mph'), '-');
    assert.strictEqual(D.secs(1.234), '1.23');
});

/* ---------------- the demo car ---------------- */
check('demo car: armed, it leaves after green and gives a believable full run', () => {
    const car = new DemoCar(), tm = new T.LaunchTimer({});
    const rnd = rng(77);
    let t = 0;
    tm.sample(0, 0);
    const sched = T.treeSchedule('sportsman', 1800);
    assert(tm.arm(0, sched));
    car.go(sched.green, 0.5);
    while (tm.state !== 'done' && t < 60000) { t += 14 + rnd() * 7; const s = car.step(t); tm.sample(t, T.kmhFromRaw(s.raw)); tm.rpm(s.rpm); tm.tick(t); }
    const r = tm.result;
    assert(r && !r.aborted && !r.red, 'no clean result');
    near(r.rt, 0.29, 0.02, 'reaction');
    assert(r.et.mph60 > 3.0 && r.et.mph60 < 4.6, '0-60 ' + r.et.mph60);
    assert(r.et.mi4 > 10.8 && r.et.mi4 < 12.8, '1/4 mile ' + r.et.mi4);
    assert(r.trap.mi4 / T.MPH > 110 && r.trap.mi4 / T.MPH < 135, 'trap ' + r.trap.mi4 / T.MPH);
    assert(r.et.ft60 > 1.6 && r.et.ft60 < 2.3, '60 ft ' + r.et.ft60);
    assert.strictEqual(r.end, 'lift');
    assert(r.peakRpm > 6500 && r.peakRpm < 7100, 'peak rpm ' + r.peakRpm);
    while (car.phase !== 'staged' && t < 90000) { t += 16; car.step(t); }
    assert.strictEqual(car.step(t + 16).raw, 0, 'the demo car stages again');
});

/* ---------------- history ---------------- */
const run = (o) => Object.assign({ v: 1, at: '2026-01-01T00:00:00.000Z', tree: 'sportsman', rollout: false, rt: 0.3, red: false, et: {}, kmh: {}, trap: {} }, o);
check('history: a result is saved rounded, with its settings and no place', () => {
    const rec = H.record({ tree: 'pro', rollout: true, rt: 0.31234, red: false, et: { ft60: 1.98765, mi4: 11.62349 }, kmh: { mi4: 199.96 }, trap: { mi4: 198.44 },
        peakKmh: 201.337, peakRpm: 7012.6, end: 'lift', hz: 58.26, maxGapMs: 22 }, { at: '2026-03-04T05:06:07.000Z', unit: 'mph', shiftRpm: 6800 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rec)), { v: 1, at: '2026-03-04T05:06:07.000Z', tree: 'pro', rollout: true, rt: 0.312, red: false,
        et: { ft60: 1.988, mi4: 11.623 }, kmh: { mi4: 200 }, trap: { mi4: 198.4 }, peakKmh: 201.3, peakRpm: 7013, end: 'lift', unit: 'mph', shiftRpm: 6800, tempC: null, hz: 58.3, gapMs: 22 });
    assert(!/lat|lon|gps|place|position/i.test(Object.keys(rec).join(' ')), 'a place-like field');
});
check('history: one JSON line a run, the last 50 kept, bad lines skipped, a missing file is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
    try {
        const file = path.join(dir, 'runs.jsonl');
        const h = new H.History(file);
        assert.deepStrictEqual(h.load(), []);
        for (let i = 1; i <= 50; i++) assert(h.add(run({ n: i, et: { ft60: 2 + i / 100 } })));
        assert.strictEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 50);
        for (let i = 51; i <= 57; i++) assert(h.add(run({ n: i, et: { ft60: 2 + i / 100 } })));
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 50);
        assert.strictEqual(JSON.parse(lines[0]).n, 8); assert.strictEqual(JSON.parse(lines[49]).n, 57);
        assert.deepStrictEqual(fs.readdirSync(dir), ['runs.jsonl'], 'a temp file was left behind');
        fs.appendFileSync(file, '{"torn": tru\n\nnot json\n{"no":"et"}\n');
        const again = new H.History(file);
        assert.strictEqual(again.load().length, 50);
        assert.strictEqual(again.runs[49].n, 57);
        const small = new H.History(file, 5);
        assert.deepStrictEqual(small.load().map((r) => r.n), [53, 54, 55, 56, 57]);
        assert.deepStrictEqual(H.trim([1, 2, 3], 2), [2, 3]); assert.deepStrictEqual(H.trim([1, 2], 5), [1, 2]);
    } finally { fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f))); fs.rmdirSync(dir); }
});
check('history: a folder that cannot be written reports false, it does not throw', () => {
    const h = new H.History(path.join(os.tmpdir(), 'launch-test-no-such-folder-' + process.pid, 'runs.jsonl'));
    assert.strictEqual(h.add(run({})), false);
    assert(h.error.length > 0);
});
check('history: best markers, kept apart by rollout setting, never from demo runs or red-light reactions', () => {
    const a = run({ rt: 0.40, et: { ft60: 2.00, mph60: 3.90, mi4: 12.00 } });
    const b = run({ rt: 0.25, et: { ft60: 1.95, mph60: 4.00 } });
    const c = run({ rt: -0.10, red: true, et: { ft60: 1.90, mph60: 3.95, mi4: 11.90 } });
    const ro = run({ rollout: true, rt: 0.30, et: { ft60: 1.70, mph60: 3.60 } });
    const demo = run({ demo: true, rt: 0.01, et: { ft60: 1.00, mph60: 2.00, mi4: 9.00 } });
    const all = [a, b, c, ro, demo];
    assert.deepStrictEqual(H.bests(all, false), { ft60: 1.90, mph60: 3.90, mi4: 11.90, rt: 0.25 });
    assert.deepStrictEqual(H.bests(all, true), { ft60: 1.70, mph60: 3.60, rt: 0.30 });
    assert.deepStrictEqual(H.marks(a, all), { mph60: true });
    assert.deepStrictEqual(H.marks(b, all), { rt: true });
    assert.deepStrictEqual(H.marks(c, all), { ft60: true, mi4: true });
    assert.deepStrictEqual(H.marks(ro, all), { ft60: true, mph60: true, rt: true });
    assert.deepStrictEqual(H.marks(demo, all), {});
    assert.deepStrictEqual(H.bests([], false), {});
});

/* ---------------- the cluster and head-up display pictures ---------------- */
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
check('placement: the cluster picture is inside the safe area, the HUD picture and flash inside the clear slot', () => {
    assert.deepStrictEqual(D.MAP_SAFE, { x: 286, y: 72, w: 504, h: 368 });
    assert.deepStrictEqual(D.HUD_WINDOW, { x: 120, y: 100, w: 570, h: 278 });
    assert(inside(D.CLUSTER, D.MAP_SAFE), 'cluster box');
    assert(inside(D.MAP_SAFE, { x: 0, y: 0, w: 1088, h: 480 }));
    assert(inside(D.HUD_SLOT, D.HUD_WINDOW), 'slot in window');
    assert(inside(D.HUD, D.HUD_SLOT), 'HUD box');
    assert(inside(D.FLASH, D.HUD), 'flash bar');
    assert(inside(D.HUD_WINDOW, { x: 0, y: 0, w: 800, h: 480 }));
});
check('placement on the whole cluster: two small layers in the middle the dials leave free, never the panel itself', () => {
    assert.deepStrictEqual(D.PANEL_STAGE, { x: 700, y: 150, w: 660, h: 450 });
    assert(inside(D.PANEL_STAGE, { x: 0, y: 0, w: D.PANEL_SIZE.w, h: D.PANEL_SIZE.h }));
    assert(inside(D.PANEL_MAIN, D.PANEL_STAGE), 'main picture'); assert(inside(D.PANEL_POP, D.PANEL_STAGE), 'pop-up');
    assert(D.PANEL_MAIN.y + D.PANEL_MAIN.h <= D.PANEL_POP.y, 'the pop-up sits under the main picture');
    const sx = D.PANEL_MAIN.w / D.CLUSTER.w, sy = D.PANEL_MAIN.h / D.CLUSTER.h, px = D.PANEL_POP.w / D.POP.w, py = D.PANEL_POP.h / D.POP.h;
    assert(Math.abs(sx - sy) < 0.02 && Math.abs(px - py) < 0.02 && Math.abs(sx - px) < 0.02, 'one scale, not stretched: ' + [sx, sy, px, py].join(' '));
    assert((D.PANEL_MAIN.w * D.PANEL_MAIN.h + D.PANEL_POP.w * D.PANEL_POP.h) < D.PANEL_SIZE.w * D.PANEL_SIZE.h / 4, 'far smaller than the panel');
    const src = fs.readFileSync(path.join(APP, 'screens.js'), 'utf8');
    assert(!/target: 'map'|target: t\.name|contend|exclusive: ?(1|true)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no map-slot layer, nothing exclusive');
});
check('upload: both pictures at their fastest stay under 40 % of the shared 5500 KB/s', () => {
    const kb = (b) => b.w * b.h * 4 / 1024;
    const src = fs.readFileSync(path.join(APP, 'screens.js'), 'utf8');
    const hudMs = Number(/HUD_MS = (\d+)/.exec(src)[1]), mapMs = Number(/MAP_MS = (\d+)/.exec(src)[1]);
    const rate = kb(D.HUD) * 1000 / hudMs + kb(D.CLUSTER) * 1000 / mapMs;
    assert(rate < 5500 * 0.4, Math.round(rate) + ' KB/s');
    console.log('     (' + Math.round(kb(D.HUD)) + ' KB x ' + (1000 / hudMs).toFixed(1) + '/s on the HUD + ' + Math.round(kb(D.CLUSTER)) + ' KB x ' + (1000 / mapMs).toFixed(1) + '/s on the cluster = ' + Math.round(rate) + ' KB/s)');
});

/* ---------------- every page drawn: no text off the picture ---------------- */
const KIT = path.join(__dirname, '..', 'kit', 'runtime', 'canvas.js');
if (fs.existsSync(KIT)) {
    const { Canvas } = require(KIT);
    /* a canvas that also notes where each text landed */
    function probe(w, h) {
        const cv = new Canvas(w, h), text = cv.text.bind(cv);
        cv.texts = [];
        cv.text = (s, x, y, size, c, o) => {
            const tw = cv.textWidth(s, size, o), left = o && o.align === 'center' ? x - tw / 2 : o && o.align === 'right' ? x - tw : x;
            cv.texts.push({ s: String(s), left: left, right: left + tw, top: y - size * 0.78, base: y, size: size });
            return text(s, x, y, size, c, o);
        };
        return cv;
    }
    function within(cv, x0, y0, x1, y1, what) {
        cv.texts.forEach((t) => assert(t.left >= x0 - 0.5 && t.right <= x1 + 0.5 && t.top >= y0 - 0.5 && t.base <= y1 + 0.5,
            what + ': "' + t.s + '" spans x ' + Math.round(t.left) + '..' + Math.round(t.right) + ', y ' + Math.round(t.top) + '..' + Math.round(t.base)));
    }
    /* texts on one line (same baseline) must not run into each other */
    function apart(cv, what) {
        const t = cv.texts;
        for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
            if (Math.abs(t[i].base - t[j].base) > Math.min(t[i].size, t[j].size) * 0.6) continue;
            assert(t[i].right <= t[j].left + 1 || t[j].right <= t[i].left + 1, what + ': "' + t[i].s + '" and "' + t[j].s + '" overlap');
        }
    }
    const full = { rt: 0.312, red: false, tree: 'sportsman', rollout: false, peakKmh: 288.8, peakRpm: 7240, end: 'complete', when: '23:59', at: '2026-12-28T23:59:00.000Z',
        et: { ft60: 11.98, ft330: 14.87, mi8: 17.52, ft1000: 19.74, mi4: 21.62, mi2: 28.11, mi1: 47.25, mph30: 11.42, mph60: 13.48, mph100: 17.61, mph60_130: 18.92, kmh100: 13.61, kmh100_200: 17.85 },
        kmh: { ft60: 54, ft330: 110, mi8: 152, ft1000: 180, mi4: 199, mi2: 255, mi1: 288 }, trap: { mi8: 151.2, mi4: 298.4 } };
    const allBest = {}; Object.keys(full.et).concat(['rt']).forEach((k) => { allBest[k] = true; });
    const lights = [{ ambers: [false, false, false] }, { ambers: [true, true, true] }, { ambers: [false, false, false], green: true }, { ambers: [false, false, false], red: true }];
    const base = (o) => Object.assign({ page: 'main', phase: 'staging', unit: 'mph', tree: 'sportsman', rollout: false, shiftRpm: 6800, demo: true, wheel: true,
        ready: { stopped: true, engine: true, gear: 'ok', gearText: 'D1', kmh: 0, rpm: 850, all: true }, lights: lights[0], rpm: 7100, blinkOn: true, gearText: 'D8' }, o);
    const pages = [];
    ['mph', 'kmh'].forEach((unit) => [false, true].forEach((rollout) => {
        const tag = ' (' + unit + ', rollout ' + (rollout ? 'on' : 'off') + ')';
        pages.push(['notice' + tag, base({ notice: true, unit: unit, rollout: rollout })]);
        pages.push(['staging, ready' + tag, base({ unit: unit, rollout: rollout, lastRun: full, marks: allBest, tree: 'pro' })]);
        pages.push(['staging, not ready, gear unknown' + tag, base({ unit: unit, rollout: rollout, hint: 'NO LAUNCH WITHIN 30 S OF GREEN: DISARMED', ready: { stopped: false, engine: false, gear: 'unknown', gearText: '', kmh: 288, rpm: 7300, all: false } })]);
        pages.push(['staging, waiting for the car' + tag, base({ unit: unit, rollout: rollout, waiting: true, demo: false, ready: { stopped: null, engine: null, gear: 'unknown', gearText: '', kmh: null, rpm: null, all: false } })]);
        lights.forEach((L, i) => pages.push(['tree ' + i + tag, base({ phase: 'tree', unit: unit, rollout: rollout, lights: L, lastRun: full, marks: allBest })]));
        pages.push(['run' + tag, base({ phase: 'run', unit: unit, rollout: rollout, lights: lights[2], rt: 0.312,
            view: { elapsed: 59.99, kmh: 288.8, distM: 1609.3, et: full.et, speeds: full.kmh, trap: full.trap, last: { label: '100-200 KM/H', s: 17.85 }, peakKmh: 288.8 } })]);
        pages.push(['run, red light, first foot' + tag, base({ phase: 'run', unit: unit, rollout: rollout, lights: lights[3], rt: -1.234, view: { elapsed: 0, kmh: 3, distM: 0.1, et: {}, speeds: {}, trap: {}, last: null, peakKmh: 3 } })]);
        pages.push(['timeslip, everything reached, all best' + tag, base({ phase: 'slip', unit: unit, rollout: rollout, result: Object.assign({}, full, { rollout: rollout }), marks: allBest, saved: false, headline: T.headline(full) })]);
        pages.push(['timeslip, red light, nothing reached' + tag, base({ phase: 'slip', unit: unit, rollout: rollout, result: { rt: -0.2, red: true, et: {}, kmh: {}, trap: {}, peakKmh: 3, peakRpm: null, end: 'stopped', aborted: true, rollout: rollout, when: '09:05' }, marks: {}, headline: null })]);
        const many = []; for (let i = 0; i < 23; i++) many.push(Object.assign({}, full, { when: '12-28 23:59', marks: allBest, red: i === 1, demo: i === 2, rollout: i % 2 === 0, tree: i % 3 ? 'pro' : 'sportsman' }));
        pages.push(['history, full page' + tag, base({ page: 'history', unit: unit, rollout: rollout, history: { runs: many, page: 0, bests: full.et } })]);
        pages.push(['history, last page' + tag, base({ page: 'history', unit: unit, rollout: rollout, history: { runs: many, page: 2, bests: {} } })]);
        pages.push(['history, empty' + tag, base({ page: 'history', unit: unit, rollout: rollout, history: { runs: [], page: 0, bests: {} } })]);
    }));
    check('centre screen: ' + pages.length + ' page states drawn, every text inside the visible 12..1588 x 38..520 and none overlapping on a line', () => {
        pages.forEach((p) => { const cv = probe(D.W, D.H); D.centre(cv, p[1]); assert(cv.texts.length > 3, p[0] + ': nothing drawn'); within(cv, 12, 38, 1588, 520, p[0]); apart(cv, p[0]); });
    });
    const small = [];
    ['mph', 'kmh'].forEach((unit) => {
        lights.forEach((L, i) => small.push(['tree ' + i, { phase: 'tree', lights: L }]));
        small.push(['run ' + unit, { phase: 'run', lights: lights[2], elapsed: 59.99, kmh: 399, unit: unit, last: { label: '100-200 KM/H', s: 17.85 }, rpm: 7300, shiftRpm: 6800, shift: true }]);
        small.push(['run, red ' + unit, { phase: 'run', lights: lights[3], red: true, elapsed: 0, kmh: 0, unit: unit, last: null, rpm: 900, shiftRpm: 6800, shift: 'under' }]);
        small.push(['done ' + unit, { phase: 'done', headline: { key: 'mi4', label: '1/4 MILE', s: 21.62 }, rt: 0.312, red: false, at: '298.4 ' + D.unitName(unit) }]);
        small.push(['done, red, no time ' + unit, { phase: 'done', headline: null, rt: -0.2, red: true, at: '' }]);
    });
    check('head-up display picture: ' + small.length + ' states, every text inside its ' + D.HUD.w + 'x' + D.HUD.h, () => {
        small.forEach((p) => { const cv = probe(D.HUD.w, D.HUD.h); D.hud(cv, p[1]); within(cv, 0, 0, D.HUD.w, D.HUD.h, 'hud ' + p[0]); apart(cv, 'hud ' + p[0]); });
    });
    check('cluster picture: ' + small.length + ' states, every text inside its ' + D.CLUSTER.w + 'x' + D.CLUSTER.h, () => {
        small.forEach((p) => { const cv = probe(D.CLUSTER.w, D.CLUSTER.h); D.cluster(cv, p[1]); within(cv, 0, 0, D.CLUSTER.w, D.CLUSTER.h, 'cluster ' + p[0]); apart(cv, 'cluster ' + p[0]); });
    });
    const pops = [];
    T.DIST.concat(T.SPEED).forEach((m) => { pops.push({ label: m.label, s: 21.62, at: '', best: false }); if (m.trap) ['298 MPH', '480 KM/H'].forEach((at) => pops.push({ label: m.label, s: 21.62, at: at, best: true })); });
    check('split pop-up: ' + pops.length + ' of them, every text inside its ' + D.POP.w + 'x' + D.POP.h + ' and none run together', () => {
        pops.forEach((p) => { const cv = probe(D.POP.w, D.POP.h); D.pop(cv, p); within(cv, 0, 0, D.POP.w, D.POP.h, 'pop-up ' + p.label + ' ' + p.at); apart(cv, 'pop-up ' + p.label + ' ' + p.at); });
    });

    check('the whole-cluster backdrop: a small picture, cheap enough beside the other two, and it draws whatever it is given', () => {
        const kb = (b) => b.w * b.h * 4 / 1024;
        const src = fs.readFileSync(path.join(APP, 'screens.js'), 'utf8');
        const hudMs = Number(/HUD_MS = (\d+)/.exec(src)[1]), mapMs = Number(/MAP_MS = (\d+)/.exec(src)[1]), backMs = Number(/BACK_MS = \{ run: (\d+)/.exec(src)[1]);
        const wingMs = Number(/WING_MS = (\d+)/.exec(src)[1]);
    const rate = kb(D.HUD) * 1000 / hudMs + kb(D.CLUSTER) * 1000 / mapMs + kb(D.BACK) * 1000 / backMs + 2 * kb(D.WING) * 1000 / wingMs;
        assert(rate < 5500 * 0.7, Math.round(rate) + ' KB/s with the backdrop');
        assert(Math.abs(D.BACK.w / D.BACK.h - D.PANEL_BACK.w / D.PANEL_BACK.h) < 0.02, 'the shape it is shown in, so nothing is stretched one way');
        assert.deepStrictEqual(D.PANEL_BACK, { x: 0, y: 0, w: 1920, h: 646 }, 'the whole width, and never over the gear strip at the bottom');
        assert(D.PANEL_POP.y + D.PANEL_POP.h <= D.PANEL_BACK.h, 'the run\'s own pictures are inside it');
        const lit = (cv) => { let n = 0; for (let i = 0; i < cv.d.length; i += 4) if (cv.d[i] + cv.d[i + 1] + cv.d[i + 2] > 120) n++; return n; };
        const a = new Canvas(D.BACK.w, D.BACK.h), b = new Canvas(D.BACK.w, D.BACK.h);
        D.backdrop(a, { phase: 0, hot: false }); D.backdrop(b, { phase: 0.5, hot: false });
        assert(lit(a) > 500 && lit(a) < D.BACK.w * D.BACK.h / 3, 'lines on a dark ground, not a lit screen: ' + lit(a));
        assert(!Buffer.from(a.d.buffer).equals(Buffer.from(b.d.buffer)), 'the rings move with the phase');
        D.backdrop(b, { phase: D.RINGS, hot: false });
        assert(Buffer.from(a.d.buffer).equals(Buffer.from(b.d.buffer)), 'and come round again');
        for (let i = 3; i < a.d.length; i += 4) assert.strictEqual(a.d[i], 255, 'every pixel opaque: it replaces what is under it');
        D.backdrop(b, { phase: 1.3, hot: true });
        let red = 0, blue = 0; for (let i = 0; i < b.d.length; i += 4) { if (b.d[i] > 150 && b.d[i + 2] < 100) red++; if (b.d[i + 2] > 150 && b.d[i] < 100) blue++; }
        assert(red > 200 && blue === 0, 'red at the shift point');
        [null, undefined, {}, { phase: NaN }, { phase: -3.7 }, { phase: 1e9 }, { phase: 'x', hot: 'y' }].forEach((v) => D.backdrop(b, v));
    });
    /* screens.js against a stand-in for the cluster renderer: which layers it makes, where, and when the pop-up shows */
    check('cluster layers: the run in the middle of the panel, a pop-up per split for three seconds, all taken down after', () => {
        const Module = require('module'), EventEmitter = require('events');
        const made = [], sets = [], drops = [], draws = [];
        class Fake extends EventEmitter {
            constructor() { super(); this.targets = 'hud,map,panel'; }
            connect() { this.emit('ready'); }
            image(o) { made.push(Object.assign({ id: made.length + 1 }, o)); return made.length; }
            pixels(id, r, buf) { draws.push({ id: id, bytes: buf.length }); return true; }
            set(id, o) { sets.push(Object.assign({ id: id }, o)); }
            drop(id) { drops.push(id); }
            close() {}
        }
        const stubs = { './kit/canvas': require(KIT), './kit/hud_claim': { HudClaim: function () { this.hold = () => {}; } }, './cluster_render_client': { ClusterRender: Fake } };
        const real = Module._load;
        Module._load = function (request, parent) { return parent && parent.filename && parent.filename.indexOf(APP) === 0 && stubs[request] ? stubs[request] : real.apply(this, arguments); };
        let Remote;
        try { delete require.cache[require.resolve(path.join(APP, 'screens'))]; Remote = require(path.join(APP, 'screens')).Remote; } finally { Module._load = real; }
        const warns = [];
        let look;
        const r = new Remote({ log: { info: () => {}, warn: (m) => warns.push(m) }, settings: { get: (k) => (k === 'screens' ? 'cluster' : k === 'clusterLook' ? look : undefined) } }, 'woodr_launch');
        assert(r.start());
        const lights = { ambers: [1, 0, 0], green: false, red: false };
        r.update({ phase: 'tree', lights: lights }, 1000);
        assert.strictEqual(made.length, 2, 'the main picture and the pop-up, no HUD layer when only the cluster is chosen');
        const main = made[0], pop = made[1];
        made.forEach((m) => { assert.strictEqual(m.target, 'panel'); assert(inside(m, D.PANEL_STAGE), 'inside the stage'); assert(m.w * m.h < D.PANEL_SIZE.w * D.PANEL_SIZE.h / 4); assert(!m.exclusive && !m.contend); });
        assert.deepStrictEqual([main.x, main.y, main.w, main.h, main.iw, main.ih], [730, 150, 600, 357, 336, 200]);
        assert.deepStrictEqual([pop.x, pop.y, pop.w, pop.h, pop.iw, pop.ih, pop.visible], [730, 512, 600, 86, 336, 48, false]);
        assert.strictEqual(draws.filter((d) => d.id === pop.id).length, 0, 'no pop-up before a split');
        const run = (last, extra) => Object.assign({ phase: 'run', lights: { green: true }, elapsed: 2, kmh: 80, unit: 'mph', rpm: 5000, shiftRpm: 6800, shift: true, last: last }, extra || {});
        r.update(run(null), 2000);
        assert.strictEqual(sets.length, 0, 'a run with no split yet shows no pop-up');
        r.update(run({ key: 'ft60', label: '60 FT', s: 1.84 }, { lastBest: true }), 2500);
        assert.deepStrictEqual(sets, [{ id: pop.id, visible: true }]);
        assert.strictEqual(draws.filter((d) => d.id === pop.id).length, 1);
        assert.strictEqual(draws.filter((d) => d.id === pop.id)[0].bytes, 336 * 48 * 4);
        r.update(run({ key: 'ft60', label: '60 FT', s: 1.84 }), 4000);
        assert.strictEqual(sets.length, 1, 'still up inside its three seconds, and not drawn again');
        assert.strictEqual(draws.filter((d) => d.id === pop.id).length, 1);
        r.update(run({ key: 'ft60', label: '60 FT', s: 1.84 }), 5600);
        assert.deepStrictEqual(sets[1], { id: pop.id, visible: false }, 'down after three seconds');
        r.update(run({ key: 'mph60', label: '0-60 MPH', s: 3.9 }), 6000);
        r.update(run({ key: 'mi8', label: '1/8 MILE', s: 7.6 }, { lastAt: '98 MPH' }), 7000);
        assert.strictEqual(sets.length, 3, 'a second split while the first is still up replaces it without a flicker');
        assert.strictEqual(draws.filter((d) => d.id === pop.id).length, 3);
        r.update({ phase: 'done', headline: { key: 'mi8', label: '1/8 MILE', s: 7.6 }, rt: 0.3, red: false, at: '98 MPH' }, 7500);
        assert.deepStrictEqual(sets[3], { id: pop.id, visible: false }, 'the pop-up goes when the slip comes up');
        r.update(null, 20000);
        assert(drops.indexOf(main.id) >= 0 && drops.indexOf(pop.id) >= 0, 'both layers taken down when there is nothing to show');
        assert(made.every((m) => m.w < D.PANEL_SIZE.w), 'no panel-size layer unless the whole cluster is chosen');
        r.update({ phase: 'tree', lights: lights }, 30000);
        assert.strictEqual(made.length, 4, 'and made again for the next run');
        /* the whole cluster, when chosen: one more layer the size of the panel under the other two */
        look = 'whole';
        r.update({ phase: 'tree', lights: lights }, 30100);
        assert.strictEqual(made.length, 7, 'chosen while the tree is up: the backdrop and the two gauges come up with the next picture');
        const back = made[4], wl = made[5], wr = made[6];
        assert.deepStrictEqual([wl.x, wl.y, wl.w, wl.h, wl.iw, wl.ih], [180, 110, 400, 400, D.WING.w, D.WING.h]);
        assert.deepStrictEqual([wr.x, wr.y, wr.w, wr.h], [1440, 110, 400, 400]);
        [wl, wr].forEach((w) => { assert(w.y + w.h <= D.PANEL_BACK.h && w.x >= 0 && w.x + w.w <= 1920, 'on the glass, above the gear strip'); assert(w.x + w.w <= D.PANEL_MAIN.x || w.x >= D.PANEL_MAIN.x + D.PANEL_MAIN.w, 'beside the run\'s picture, not over it'); assert(Math.abs(w.w / w.h - D.WING.w / D.WING.h) < 0.02); });
        assert.strictEqual(draws.filter((d) => d.id === wl.id).length, 1); assert.strictEqual(draws.filter((d) => d.id === wr.id).length, 1);
        assert.deepStrictEqual([back.target, back.x, back.y, back.w, back.h, back.iw, back.ih, back.z], ['panel', 0, 0, 1920, 646, D.BACK.w, D.BACK.h, 49]);
        assert(back.z < made[2].z && back.klass === 'overlay' && !back.exclusive && !back.contend, 'under the run\'s own picture, nothing exclusive');
        const backDraws = () => draws.filter((d) => d.id === back.id).length;
        assert.strictEqual(backDraws(), 1); assert.strictEqual(draws.filter((d) => d.id === back.id)[0].bytes, D.BACK.w * D.BACK.h * 4);
        r.update({ phase: 'tree', lights: lights }, 30150);
        assert.strictEqual(backDraws(), 1, 'paced: not a picture on every tick');
        for (let t = 31000; t < 32000; t += 20) r.update(run(null), t);
        assert(backDraws() >= 6 && backDraws() <= 8, 'about six a second in a run: ' + backDraws());
        assert.strictEqual(draws.filter((d) => d.id === wl.id).length, 2, 'the speed gauge is drawn again only when its number changes (0 on the tree, 50 mph in this run)');
        const before = draws.filter((d) => d.id === wr.id).length;
        for (let t = 32000; t < 32090; t += 20) r.update(run(null, { rpm: 6900, gear: 2 }), t);
        assert.strictEqual(draws.filter((d) => d.id === wr.id).length, before + 1, 'the rev gauge follows the revs, paced');
        look = 'middle';
        r.update(run(null), 32100);
        assert(drops.indexOf(back.id) >= 0 && drops.indexOf(wl.id) >= 0 && drops.indexOf(wr.id) >= 0 && drops.indexOf(made[2].id) < 0, 'switched back in the middle of a run: the backdrop and its gauges go, the run stays');
        look = 'whole';
        r.update(run(null), 32200);
        assert.strictEqual(made.length, 10);
        r.update({ phase: 'done', headline: { key: 'mi8', label: '1/8 MILE', s: 7.6 }, rt: 0.3, red: false, at: '98 MPH' }, 33000);
        assert(drops.indexOf(made[8].id) >= 0 && drops.indexOf(made[9].id) >= 0 && drops.indexOf(made[7].id) < 0, 'on the result the gauges go and the tunnel stays');
        r.update(null, 40000);
        assert(drops.indexOf(made[7].id) >= 0, 'and it is taken down with the rest when there is nothing to show');
        r.stop();
        assert.deepStrictEqual(warns, []);
    });
} else console.log('skip the drawing checks: ' + KIT + ' is not there');

/* ---------------- the head unit runs Node 8.16 ---------------- */
/* source with comments, strings and regular expressions blanked, so only code is searched */
function codeOnly(src) {
    let out = '', i = 0, last = '';
    const n = src.length;
    const skipTo = (end) => { const j = src.indexOf(end, i + 2); const stop = j < 0 ? n : j + end.length; out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; };
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const stop = j < 0 ? n : j; out += ' '.repeat(stop - i); i = stop; continue; }
        if (c === '/' && d === '*') { skipTo('*/'); continue; }
        if (c === '\'' || c === '"' || c === '`' || (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(last) >= 0 || /\breturn$|\btypeof$/.test(out.slice(-8).trim())))) {
            /* a string, a template (its ${ } parts are blanked too: the app keeps code out of them) or a regular expression */
            let j = i + 1, cls = false;
            while (j < n) {
                if (src[j] === '\\') { j += 2; continue; }
                if (c === '/' && src[j] === '[') cls = true;
                else if (c === '/' && src[j] === ']') cls = false;
                else if (src[j] === c && !cls) break;
                else if (src[j] === '\n' && c !== '`') break;
                j++;
            }
            out += c + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + (j < n ? src[j] : '');
            i = j + 1; last = 'x';
            continue;
        }
        out += c;
        if (!/\s/.test(c)) last = c;
        i++;
    }
    return out;
}
const FORBIDDEN = [
    [/\?\.(?!\d)/, 'optional chaining ?.'],
    [/\?\?/, 'nullish ??'],
    [/\.\.\./, 'spread or rest ... (object spread is not in Node 8; the app uses none at all)'],
    [/\.flat\s*\(|\.flatMap\s*\(/, 'Array flat / flatMap'],
    [/Object\.fromEntries/, 'Object.fromEntries'],
    [/\bcatch\s*\{/, 'catch without a binding'],
    [/\b\d+_\d/, 'numeric separator'],
    [/\b\d+n\b|\bBigInt\b/, 'BigInt'],
    [/\.matchAll\s*\(|\.replaceAll\s*\(|\.trimStart\s*\(|\.trimEnd\s*\(|\.at\s*\(/, 'a string or array method newer than Node 8'],
    [/Promise\.(allSettled|any)\b|\.finally\s*\(/, 'Promise.allSettled / any / finally'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bfor\s+await\b|\basync\s+function\s*\*/, 'async iteration'],
    [/\bimport\s*\(|^\s*import\s|^\s*export\s/m, 'ES modules'],
    [/\(\?<[=!a-zA-Z]/, 'regular expression lookbehind or named group'],
    [/^\s*(static\s+)?#?[A-Za-z_$][\w$]*\s*=\s*[^=>]/m, null],      /* class fields: checked inside class bodies only, below */
    [/\bfs\.(rmSync|rm|promises|cpSync|opendirSync)\b|recursive\s*:/, 'an fs call newer than Node 8'],
    [/hrtime\.bigint|worker_threads|\bqueueMicrotask\b|\bstructuredClone\b|\bAbortController\b|\bTextDecoder\b|\bURLSearchParams\b(?!\s*=)/, 'a runtime API newer than Node 8'],
    [/\*\*=?/, 'exponent operator (kept out to stay conservative)'],
    [/[|&?]{2}=/, 'logical assignment'],
];
function scan(src) {
    const code = codeOnly(src), hits = [];
    FORBIDDEN.forEach((f) => {
        if (f[1] === null) return;
        const m = f[0].exec(code);
        if (m) hits.push(f[1] + ' at line ' + code.slice(0, m.index).split('\n').length + ': ' + src.split('\n')[code.slice(0, m.index).split('\n').length - 1].trim().slice(0, 80));
    });
    /* class fields: a line inside a class body, at its member depth, that assigns */
    let depth = 0, classDepth = -1;
    code.split('\n').forEach((line, i) => {
        if (classDepth < 0 && /\bclass\s+[A-Za-z_$]/.test(line)) classDepth = depth + 1;
        if (classDepth >= 0 && depth === classDepth && /^\s*(static\s+)?#?[A-Za-z_$][\w$]*\s*(=[^=>]|;)/.test(line)) hits.push('class field at line ' + (i + 1) + ': ' + line.trim().slice(0, 80));
        for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth < classDepth) classDepth = -1; } }
    });
    return hits;
}
check('the syntax scan itself: it finds each forbidden form, and not the same text in a string or comment', () => {
    const bad = ['a?.b', 'a ?? b', 'f({...x})', '[1].flat()', 'Object.fromEntries(x)', 'try { x(); } catch { y(); }', 'const n = 1_000;', 'x.replaceAll(a, b)', 'p.finally(f)',
        'class A {\n    count = 0;\n}', 'class A {\n    static x = 1;\n    m() { return 1; }\n}', 'fs.mkdirSync(d, { recursive: true })', 'a ||= b', 'const y = 2 ** 3;', 'x.at(-1)'];
    bad.forEach((s) => assert(scan(s).length > 0, 'not caught: ' + s));
    const fine = ['const s = "a?.b ?? c ...";', '// a?.b ?? {...x}', '/* catch { */ const a = b ? .5 : 1;', 'const r = /\\?\\?/.test(x) ? 1 : 2;', 'const t = `a ?? ${1}`;',
        'class A {\n    constructor() { this.x = 1; }\n    m() { const y = 2; return y; }\n}', 'async function f() { try { await g(); } catch (e) { return e; } }', 'const o = Object.assign({}, a, { b: 1 });'];
    fine.forEach((s) => assert.deepStrictEqual(scan(s), [], 'wrongly caught: ' + s));
});
const files = fs.readdirSync(APP).filter((f) => /\.js$/.test(f)).sort();
check('Node 8 syntax scan: ' + files.join(', '), () => {
    assert(files.indexOf('main.js') >= 0 && files.indexOf('cluster_render_client.js') >= 0);
    const hits = [];
    files.forEach((f) => scan(fs.readFileSync(path.join(APP, f), 'utf8')).forEach((h) => hits.push(f + ': ' + h)));
    assert.deepStrictEqual(hits, []);
});
check('every callback in main.js, screens.js and wheel.js has its own try/catch', () => {
    ['main.js', 'screens.js', 'wheel.js'].forEach((f) => {
        const code = codeOnly(fs.readFileSync(path.join(APP, f), 'utf8'));
        /* timers, signal handlers, emitter listeners and button handlers: the body must open with try, or be one guarded call */
        const re = /(setInterval|setTimeout|\.on|onClick|onSample)\(\s*(?:'[^']*'\s*,\s*)?(?:async\s*)?\(([^)]*)\)\s*=>\s*(\{?)\s*([^\n]{0,60})/g;
        let m;
        while ((m = re.exec(code))) {
            const body = m[4];
            const ok = /^try\b/.test(body) || /^this\.available = false; \}\)/.test(body);
            assert(ok, f + ': a ' + m[1] + ' callback without try/catch near "' + body.trim() + '"');
        }
    });
    const wheel = fs.readFileSync(path.join(APP, 'wheel.js'), 'utf8');
    assert(/statusRotaryPress: \(v\) => \{\s*try \{/.test(wheel), 'the wheel signal handler');
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    assert(/function onSpeed\(v\) \{\s*try \{/.test(main), 'the speed signal handler');
});

/* ---------------- the rules for what is written and declared ---------------- */
/* ---------------- the run's data log ---------------- */
const RL = require(path.join(APP, 'runlog.js'));
/* a made-up launch: armed at 0, moves at 2000 ms, pulls `g` for `secs`; the speed signal runs `spin(s)` km/h ahead of the body */
function fakeRun(g, secsLong, spin, bias) {
    const rows = [];
    for (let ms = 0; ms <= 2000 + secsLong * 1000; ms += 40) {
        const s = (ms - 2000) / 1000, body = s > 0 ? g * 9.80665 * 3.6 * s : 0;
        rows.push([ms, s > 0 ? body + (spin ? spin(s) : 0) : 0, s > 0 ? 3000 + 900 * (s % 3) : 2800, s < 3 ? 1 : s < 6 ? 2 : 3, (s > 0 ? g : 0) + (bias || 0), 0.01, 500]);
    }
    return rows;
}
check('data log: a clean launch shows its pull and no wheelspin', () => {
    const a = RL.analyse(fakeRun(0.9, 8, null, 0), 2000);
    assert(Math.abs(a.peakG - 0.9) < 0.01, 'peak ' + a.peakG);
    assert(a.spinKmh !== null && a.spinKmh < 1 && a.spinS === 0, 'spin ' + a.spinKmh + ' for ' + a.spinS);
    assert.deepStrictEqual(a.shifts.map((x) => x.to), [2, 3]);
    assert(Math.abs(a.shifts[0].s - 3) < 0.05 && a.shifts[0].rpm > 5000, 'the shift and the revs it was made at: ' + JSON.stringify(a.shifts[0]));
    assert(a.launchRpm >= 2800 && a.launchRpm < 3200 && a.rows === 251 && Math.abs(a.hz - 25) < 0.2);
    assert.strictEqual(RL.line(a, 'mph').indexOf('NO WHEELSPIN SEEN') > 0, true);
});
check('data log: wheels running ahead of the car are found, with how far and when', () => {
    const spin = (s) => (s < 1.5 ? 20 * Math.sin(Math.PI * s / 1.5) : 0);       /* up to 20 km/h ahead, 0.75 s in */
    const a = RL.analyse(fakeRun(0.7, 8, spin, 0), 2000);
    assert(Math.abs(a.spinKmh - 20) < 1.5 && Math.abs(a.spinAtS - 0.75) < 0.1, JSON.stringify(a));
    assert(a.spinS > 1.0 && a.spinS < 1.5, 'time spent spinning ' + a.spinS);
    assert(/WHEELSPIN EST 1[23] MPH AT 0\.[78] S/.test(RL.line(a, 'mph')), RL.line(a, 'mph'));
    assert(/WHEELSPIN EST (19|20|21) KM\/H/.test(RL.line(a, 'kmh')), RL.line(a, 'kmh'));
});
check('data log: standing on a slope (a sensor that does not read zero at rest) is not taken for wheelspin or pull', () => {
    const a = RL.analyse(fakeRun(0.8, 6, null, 0.06), 2000);
    assert(Math.abs(a.peakG - 0.8) < 0.01 && a.spinKmh < 1, JSON.stringify(a));
});
check('data log: a car that gives no acceleration still gets its rows and shifts, and no made-up figures', () => {
    const rows = fakeRun(0.8, 6, null, 0).map((r) => [r[0], r[1], r[2], r[3], null, null, null]);
    const a = RL.analyse(rows, 2000);
    assert(a.peakG === null && a.spinKmh === null && a.spinS === null && a.shifts.length === 2);
    assert(!/WHEELSPIN|PEAK/.test(RL.line(a, 'mph')));
    [null, undefined, [], [[0]], 'x'].forEach((v) => RL.analyse(v, 0));
    assert.strictEqual(RL.line(null, 'mph'), ''); assert.strictEqual(RL.line({}, 'mph'), '');
});
check('data log: one file per run, the last ' + RL.KEEP + ' kept, bounded, and nothing in it but times and the car\'s numbers', () => {
    const dir = path.join(require('os').tmpdir(), 'launch-runlog-' + process.pid);
    const rl = new RL.RunLog(path.join(dir, 'runs'));
    fs.mkdirSync(dir);
    try {
        assert.strictEqual(rl.finish({}), null, 'nothing armed, nothing written');
        rl.sample(5, { kmh: 1 });
        assert.strictEqual(rl.rows, null, 'samples before arming are dropped');
        let last = null;
        for (let n = 0; n < RL.KEEP + 3; n++) {
            rl.arm(1000);
            for (let t = 1000; t < 1000 + 9000; t += 7) rl.sample(t, { kmh: Math.max(0, (t - 3000) / 50), rpm: 3000.4, gear: 1, gLong: 0.5123456, gLat: undefined, torque: NaN });
            assert(rl.rows.length <= 9000 / RL.STEP_MS + 1, 'one row every ' + RL.STEP_MS + ' ms however fast the samples come: ' + rl.rows.length);
            last = rl.finish({ at: '2026-11-15T20:' + (n < 10 ? '0' : '') + n + ':00.000Z', greenMs: 2900, moveMs: 3000, rollout: false, et: { ft60: 1.9 } });
            assert(last && /^run-2026-11-15-20-\d\d-00\.json$/.test(last.file), JSON.stringify(last));
        }
        const files = fs.readdirSync(path.join(dir, 'runs')).sort();
        assert.strictEqual(files.length, RL.KEEP); assert.strictEqual(files[files.length - 1], last.file); assert(files.every((f) => /^run-[\d-]+\.json$/.test(f)), 'no temp files left');
        const text = fs.readFileSync(path.join(dir, 'runs', last.file), 'utf8'), doc = JSON.parse(text);
        assert(text.length < 120000, 'a nine second run is ' + text.length + ' bytes');
        assert.deepStrictEqual(doc.cols, ['ms', 'kmh', 'rpm', 'gear', 'gLong', 'gLat', 'torque']);
        assert.deepStrictEqual(doc.rows[0], [0, 0, 3000, 1, 0.512, null, null]);
        assert.strictEqual(doc.moveMs, 2000); assert.strictEqual(doc.greenMs, 1900); assert.strictEqual(doc.summary.rows, doc.rows.length);
        assert(!/vin|lat|lon|position|gps/i.test(Object.keys(doc).join(' ').replace('gLat', '')), 'no place, no identity');
        rl.arm(0);
        for (let t = 0; t < 200000; t += 40) rl.sample(t, { kmh: 1 });
        assert.strictEqual(rl.rows.length, RL.MAX_ROWS, 'never more rows than the limit');
        rl.cancel(); assert.strictEqual(rl.finish({}), null);
        const bad = new RL.RunLog(path.join(dir, 'runs', last.file, 'under-a-file'));
        bad.arm(0); for (let t = 0; t < 1000; t += 40) bad.sample(t, { kmh: 1 });
        assert.strictEqual(bad.finish({}), null); assert(bad.error, 'a folder that cannot be made is reported, not thrown');
    } finally {
        try { fs.readdirSync(path.join(dir, 'runs')).forEach((f) => fs.unlinkSync(path.join(dir, 'runs', f))); fs.rmdirSync(path.join(dir, 'runs')); fs.rmdirSync(dir); } catch (e) { /* temp */ }
    }
});
check('launches are marked on the dashcam: Launch writes its own request file, and the dashcam watches for it', () => {
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8'), cam = fs.readFileSync(path.join(APP, '..', 'woodr_dashcam', 'main.js'), 'utf8');
    assert(/!demo && settings\.get\('highlight'\) !== false\) .*shared\.write\('dashcam\.highlight\.launch\.json'/.test(main), 'only real launches, and only when not switched off');
    assert(/'dashcam\.highlight\.launch\.json'\)\)\.mtime/.test(cam) && /highlight\('launch'\)/.test(cam));
    assert.strictEqual(fs.readFileSync(path.join(APP, 'shared.js'), 'utf8'), fs.readFileSync(path.join(APP, '..', 'woodr_dashcam', 'shared.js'), 'utf8'), 'one shared.js');
    const keys = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8')).settings.filter((x) => x.key === 'highlight');
    assert(keys.length === 1 && keys[0].default === true);
});
check('app.json: version, logging id, required signals only where another installed app already requires them', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    assert.strictEqual(spec.id, 'woodr_launch'); assert.strictEqual(spec.title, 'Launch'); assert.strictEqual(spec.version, '0.7.0'); assert.strictEqual(spec.loggingId, 'OAB4');
    const required = [];
    Object.keys(spec.signals).forEach((i) => { if (!spec.signals[i]._optional) Object.keys(spec.signals[i]).forEach((f) => { if (/r/.test(spec.signals[i][f])) required.push(i.split('.').pop() + '.' + f); }); });
    assert.deepStrictEqual(required.sort(), ['CDS.statusEngineSpeed2', 'Vehicle2.statusCarSpeed2']);
    Object.keys(spec.signals).forEach((i) => Object.keys(spec.signals[i]).forEach((f) => { if (f !== '_optional') assert(/^(rs|s)$/.test(spec.signals[i][f]), i + '.' + f + ' has a flag that writes or calls'); }));
    const keys = spec.settings.map((s) => s.key);
    ['tree', 'rollout', 'shiftRpm', 'speedUnit', 'screens'].forEach((k) => assert(keys.indexOf(k) >= 0, 'setting ' + k));
    assert.strictEqual(spec.settings.find((s) => s.key === 'rollout').default, false);
    assert.strictEqual(spec.autostart, undefined);
});
check('read-only: no diagnostic request, setter or method call anywhere in the app\'s own code', () => {
    files.filter((f) => f !== 'cluster_render_client.js').forEach((f) => {
        const code = codeOnly(fs.readFileSync(path.join(APP, f), 'utf8'));
        assert(!/signals\.(proxy|call|set|on)\b|setValue|callMethod|kit\/diag|readonly-diag|kit\/dids|child_process|require\(\s*.(net|http|https|dgram)/.test(code), f + ' reaches for something that is not a signal watch');
    });
});
check('wording: no em-dash, and neither the maker\'s name nor the model on any screen text', () => {
    const docs = [path.join(__dirname, '..', 'docs', 'launch-car-test.md'), __filename];
    files.filter((f) => f !== 'cluster_render_client.js').map((f) => path.join(APP, f)).concat([path.join(APP, 'app.json')], docs.filter((f) => fs.existsSync(f)))
        .forEach((f) => assert(fs.readFileSync(f, 'utf8').indexOf(String.fromCharCode(0x2014)) < 0, path.basename(f) + ' has an em-dash'));
    const maker = String.fromCharCode(66, 77, 87), model = 'M' + '3';
    [path.join(APP, 'draw.js'), path.join(APP, 'app.json')].forEach((f) => {
        const s = fs.readFileSync(f, 'utf8');
        assert(s.indexOf(maker) < 0 && !new RegExp('\\b' + model + '\\b').test(s), path.basename(f) + ' names the maker or the model');
    });
});

console.log(failed ? '\n' + failed + ' FAILED, ' + passed + ' passed' : '\nlaunch: all ' + passed + ' ok');
process.exit(failed ? 1 : 0);
