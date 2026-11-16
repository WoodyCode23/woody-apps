'use strict';
/**
 * timing.js - the launch timer's maths. No kit imports and no clock of its own: every time comes in as a
 * number of milliseconds, so the whole thing runs under plain Node in tools/test_launch.js.
 *
 *   const T = require('./timing');
 *   const tm = new T.LaunchTimer({ rollout: false });
 *   tm.sample(t, T.kmhFromRaw(raw));              every speed sample, with the moment it arrived
 *   tm.rpm(value);                                every engine speed sample
 *   tm.tick(t);                                   often (every 20 ms): the checks that go by the clock
 *   tm.arm(t, T.treeSchedule('sportsman', T.preStageDelay(Math.random())));
 *   tm.lights(t)   -> { ambers: [bool, bool, bool], green, red }
 *   tm.view(t)     -> the live numbers while state is 'run'
 *   tm.result      -> the finished run once state is 'done'
 *
 * States: idle  - nothing armed
 *         armed - the tree is counting (pre-stage delay, ambers, green), waiting for the car to move
 *         run   - timing
 *         done  - a run ended, tm.result has it; reset() goes back to idle
 *
 * How a run is timed:
 *   - The clock starts when speed passes MOVE_KMH, the moment found by interpolating between the two samples
 *     around it. With rollout on, it starts after the first foot of travel instead.
 *   - Reaction time is first movement minus green. Movement before green is a red light; the run is still timed.
 *   - A bump is not a start. A car held on the brake against the engine can lurch a hand's width before the
 *     brakes catch it again. Before green, movement counts as a start only once the car has gone CREEP_M or
 *     reached CREEP_KMH; less than that, and coming to rest again, is forgotten. A car still creeping that
 *     little when the light goes green is taken to start at green.
 *   - Distance is speed added up over time (trapezoid). Between two samples speed is taken as a straight line,
 *     so the moment a distance mark is passed is the root of a quadratic, not a guess at a sample edge.
 *   - A run ends when the car stops, when no new top speed was seen for LIFT_MS after the 60 ft mark (the
 *     driver lifted), when every split is in, or MAX_RUN_MS after the clock started.
 *
 * The crossing interpolation, the rollout foot and the standstill carried forward by the clock are adapted
 * from run_timer.js in the app kit:
 *
 *   MIT License. Copyright (c) cauliflowermossgrape (idrive7-apps).
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 *   KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR
 *   ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const RAW_PER_KMH = 64;          /* the speed signal counts in 1/64 km/h */
const RAW_INVALID = 65535;       /* the signal's "no value" */
const MPH = 1.609344;            /* km/h in one mph */
const FT = 0.3048;               /* metres in one foot */
const MOVE_KMH = 0.5;            /* speed that counts as "moving" (the kit's figure) */
const CREEP_M = FT;                /* before green, less travel than this (a strip's staging beam allows about a foot) ... */
const CREEP_KEEP = 300;           /* samples of a creep kept, should it turn into a start (about five seconds) */
const CREEP_KMH = 5;              /* ... at less than this speed is a bump against the brakes, not a start */
const TREE_GAP_MS = 500;          /* a strip's tree: half a second from one light to the next */
const ROLLOUT_M = FT;            /* one foot of rollout, as a drag strip's staging beam gives */
const TRAP_M = 66 * FT;          /* a strip's speed trap: the average over the last 66 ft before the line */
const MAX_RUN_MS = 60000;
const LIFT_MS = 2000;
const GREEN_WAIT_MS = 30000;     /* armed, green shown, and the car never moved: disarm */
const GLITCH_FROM_KMH = 30;      /* a zero straight after a speed above this is a bad sample, not a stop */
const MAX_KMH = 450;

/* distance marks, in running order */
const DIST = [
    { key: 'ft60', label: '60 FT', m: 60 * FT },
    { key: 'ft330', label: '330 FT', m: 330 * FT },
    { key: 'mi8', label: '1/8 MILE', m: 660 * FT, trap: true },
    { key: 'ft1000', label: '1000 FT', m: 1000 * FT },
    { key: 'mi4', label: '1/4 MILE', m: 1320 * FT, trap: true },
    { key: 'mi2', label: '1/2 MILE', m: 2640 * FT },
    { key: 'mi1', label: '1 MILE', m: 5280 * FT },
];
/* speed splits, km/h */
const SPEED = [
    { key: 'mph30', label: '0-30 MPH', from: 0, to: 30 * MPH },
    { key: 'mph60', label: '0-60 MPH', from: 0, to: 60 * MPH },
    { key: 'mph100', label: '0-100 MPH', from: 0, to: 100 * MPH },
    { key: 'mph60_130', label: '60-130 MPH', from: 60 * MPH, to: 130 * MPH },
    { key: 'kmh100', label: '0-100 KM/H', from: 0, to: 100 },
    { key: 'kmh100_200', label: '100-200 KM/H', from: 100, to: 200 },
];
const SPLIT_KEYS = DIST.map((d) => d.key).concat(SPEED.map((s) => s.key));

const num = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** The speed signal's raw count as km/h, or null for "no value". */
function kmhFromRaw(raw) {
    if (!num(raw) || raw < 0 || raw >= RAW_INVALID) return null;
    return raw / RAW_PER_KMH;
}

/** Pre-stage delay in ms from a random number 0..1: 1.0 to 2.5 s, so the first amber cannot be anticipated. */
function preStageDelay(rnd) {
    return 1000 + Math.round(clamp(num(rnd) ? rnd : 0.5, 0, 1) * 1500);
}

/**
 * When each light comes on, in ms after arming.
 *   sportsman: three ambers 0.5 s apart, green 0.5 s after the last
 *   pro:       all three ambers together, green 0.4 s later
 * gapMs stretches it for practice: the time from one light to the next (500 on a strip); the pro tree's wait
 * for green grows by the same ratio.
 */
function treeSchedule(type, preMs, gapMs) {
    const pro = type === 'pro';
    const pre = num(preMs) ? preMs : 1500;
    const gap = num(gapMs) ? clamp(gapMs, 300, 3000) : TREE_GAP_MS;
    return {
        type: pro ? 'pro' : 'sportsman', preMs: pre,
        gapMs: gap,
        ambers: pro ? [pre, pre, pre] : [pre, pre + gap, pre + 2 * gap],
        green: pro ? pre + Math.round(gap * 0.8) : pre + 3 * gap,
    };
}

/** Which lights are on, ms after arming. Each amber goes out as the next light comes on. */
function treeLights(s, ms) {
    const out = { ambers: [false, false, false], green: false, red: false };
    if (!s || !num(ms)) return out;
    if (ms >= s.green) { out.green = true; return out; }
    for (let i = 0; i < 3; i++) {
        const off = s.type === 'pro' || i === 2 ? s.green : s.ambers[i + 1];
        out.ambers[i] = ms >= s.ambers[i] && ms < off;
    }
    return out;
}

class LaunchTimer {
    constructor(opts) {
        this.rollout = !!(opts && opts.rollout);
        this.state = 'idle';
        this.prev = null;            /* the last good speed sample { t, v } */
        this.note = '';              /* why the last arming ended without a run */
        this.result = null;
        this._clear();
    }

    _clear() {
        this.sched = null; this.tArm = null; this.tGreen = null;
        this.tMove = null; this.t0 = null; this.off = 0;
        this.dist = 0; this.vmax = 0; this.tPeak = null; this.rpmMax = 0;
        this.et = {};                /* split key -> seconds */
        this.kmh = {};               /* distance key -> km/h as the mark is passed */
        this.trap = {};              /* mi8 / mi4 -> km/h averaged over the 66 ft before the mark */
        this.cross = {};             /* speed target -> ms */
        this.trapIn = {};            /* distance key -> ms the trap's start was passed */
        this.t60 = null;
        this.samples = 0; this.maxGapMs = 0; this.glitches = 0;
        this.trace = [];             /* [seconds, km/h] every 0.1 s, for a small graph */
        this.last = null;            /* the newest split: { key, label, s } */
        this.creep = null;           /* moving a little before green: { d: metres so far, buf: its samples } */
        this.bumps = 0;              /* bumps before green that came to rest again */
    }

    setRollout(on) { if (this.state === 'idle' || this.state === 'done') this.rollout = !!on; }

    /** Is the car known to be standing still right now? */
    stopped() { return !!this.prev && this.prev.v < MOVE_KMH; }

    /** Start the tree. False when the car is not known to be standing, or something is already going. */
    arm(t, sched) {
        if (this.state !== 'idle' || !this.stopped() || !sched || !num(t)) return false;
        this._clear();
        this.result = null; this.note = '';
        this.sched = sched; this.tArm = t; this.tGreen = t + sched.green;
        this.prev = { t: t, v: this.prev.v };
        this.state = 'armed';
        return true;
    }

    cancel() { if (this.state === 'armed') { this.state = 'idle'; this.note = 'cancelled'; this._clear(); } }

    /** Back to idle from anywhere; a run in progress is thrown away. */
    reset() { this.state = 'idle'; this.result = null; this.note = ''; this._clear(); }

    lights(t) {
        if (this.state === 'idle' || !this.sched) return { ambers: [false, false, false], green: false, red: false };
        if (this.tMove !== null && this.tMove < this.tGreen) return { ambers: [false, false, false], green: false, red: true };
        return treeLights(this.sched, t - this.tArm);
    }

    rpm(v) { if (this.state === 'run' && num(v) && v > this.rpmMax) this.rpmMax = v; }

    sample(t, v) {
        if (!num(t) || !num(v) || v < 0 || v > MAX_KMH) return;
        const p = this.prev;
        if (p && t <= p.t) return;
        if (this.state === 'run') {
            if (v < MOVE_KMH && p && p.v > GLITCH_FROM_KMH) { this.glitches++; return; }
            this.prev = { t: t, v: v };
            if (p) this._step(p, this.prev);
            if (this.state === 'run' && v < MOVE_KMH) this._finish('stopped', t);
            return;
        }
        this.prev = { t: t, v: v };
        if (this.state !== 'armed' || !p) return;
        if (v < MOVE_KMH) {
            if (this.creep) { this.creep = null; this.bumps++; }      /* it lurched and the brakes caught it: forgotten */
            return;
        }
        if (t < this.tGreen) {
            /* moving before green: a start only once it has gone far enough or fast enough to be one */
            if (!this.creep) this.creep = { d: 0, buf: [p] };
            const k = this.creep;
            k.d += (p.v + v) / 2 / 3.6 * (t - p.t) / 1000;
            k.buf.push(this.prev);
            if (k.buf.length > CREEP_KEEP) k.buf.shift();
            if (k.d >= CREEP_M || v >= CREEP_KMH) {
                /* a real start before green: timed from where it first moved, sample by sample, as any run is */
                this._launch(k.buf[0], k.buf[1]);
                for (let i = 2; i < k.buf.length && this.state === 'run'; i++) this._step(k.buf[i - 1], k.buf[i]);
            }
            return;
        }
        /* green is on. A car that was still creeping when it came on started at green, not before it. */
        this._launch(p, this.prev, this.creep ? this.tGreen : undefined);
    }

    /**
     * The checks that go by the clock. A standing car sends no new speed (the value does not change), so the
     * standstill is carried forward to now: the launch is then interpolated from the last moment the car was
     * known to stand, not from a sample that may be seconds old.
     */
    tick(t) {
        if (!num(t)) return;
        if (this.state === 'run') {
            const from = this.t0 !== null ? this.t0 : this.tMove;
            if (t - from > MAX_RUN_MS) this._finish('cap', t);
            else if (this._lifted(t)) this._finish('lift', t);
            return;
        }
        /* only a true zero is carried: a small speed on its way up is a real sample and keeps its own time */
        const p = this.prev;
        if (p && p.v === 0 && t > p.t) this.prev = { t: t, v: 0 };
        if (this.state === 'armed' && t - this.tGreen > GREEN_WAIT_MS) { this.state = 'idle'; this._clear(); this.note = 'no launch'; }
    }

    _lifted(t) {
        return this.t60 !== null && this.tPeak !== null && t - Math.max(this.tPeak, this.t60) > LIFT_MS;
    }

    _launch(p, c, notBefore) {
        const f = c.v > p.v ? (MOVE_KMH - p.v) / (c.v - p.v) : 0;
        this.tMove = p.t + clamp(f, 0, 1) * (c.t - p.t);
        if (num(notBefore) && this.tMove < notBefore) this.tMove = Math.min(notBefore, c.t);
        this.creep = null;
        this.state = 'run';
        this.dist = 0;
        if (!this.rollout) this.t0 = this.tMove;
        this._step({ t: this.tMove, v: MOVE_KMH }, c);
        if (this.state === 'run' && c.v < MOVE_KMH) this._finish('stopped', c.t);
    }

    _step(p, c) {
        const dtMs = c.t - p.t, dt = dtMs / 1000;
        if (dt <= 0) return;
        this.samples++;
        if (dtMs > this.maxGapMs) this.maxGapMs = dtMs;
        const v0 = p.v / 3.6, v1 = c.v / 3.6, a = (v1 - v0) / dt;
        const d0 = this.dist, d1 = d0 + (v0 + v1) / 2 * dt;
        this.dist = d1;
        /* the moment distance D is reached inside this step (d0 < D <= d1), speed a straight line from v0 to v1 */
        const tAt = (D) => {
            const x = D - d0;
            let tau;
            if (Math.abs(a) < 1e-9) tau = v0 > 0 ? x / v0 : dt;
            else tau = (-v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * x))) / a;
            return p.t + clamp(tau, 0, dt) * 1000;
        };
        const vAt = (ms) => p.v + (c.v - p.v) * ((ms - p.t) / dtMs);

        if (c.v > this.vmax) { this.vmax = c.v; this.tPeak = c.t; }
        if (this.t0 === null) {
            /* rollout: the clock starts after the first foot, and every distance is measured from there */
            if (d1 < ROLLOUT_M) return;
            this.t0 = tAt(ROLLOUT_M);
            this.off = ROLLOUT_M;
        }
        const t0 = this.t0, secs = (ms) => (ms - t0) / 1000;
        const lastTr = this.trace[this.trace.length - 1];
        if (this.trace.length < 700 && (!lastTr || secs(c.t) - lastTr[0] >= 0.1)) this.trace.push([secs(c.t), c.v]);

        if (d1 > d0) {
            for (let i = 0; i < DIST.length; i++) {
                const m = DIST[i], D = this.off + m.m;
                if (m.trap && this.trapIn[m.key] === undefined && d1 >= D - TRAP_M) this.trapIn[m.key] = d0 >= D - TRAP_M ? p.t : tAt(D - TRAP_M);
                if (this.et[m.key] !== undefined || d1 < D) continue;
                const at = d0 >= D ? p.t : tAt(D);
                this.et[m.key] = secs(at);
                this.kmh[m.key] = vAt(at);
                if (m.trap && at > this.trapIn[m.key]) this.trap[m.key] = TRAP_M / ((at - this.trapIn[m.key]) / 1000) * 3.6;
                if (m.key === 'ft60') this.t60 = at;
                this.last = { key: m.key, label: m.label, s: this.et[m.key] };
            }
        }
        for (let i = 0; i < SPEED.length; i++) {
            const s = SPEED[i], ends = [s.from, s.to];
            for (let k = 0; k < 2; k++) {
                const target = ends[k];
                if (!target || this.cross[target] !== undefined || c.v < target) continue;
                this.cross[target] = p.v < target ? p.t + (target - p.v) / (c.v - p.v) * dtMs : p.t;
            }
            if (this.et[s.key] === undefined && this.cross[s.to] !== undefined && (!s.from || this.cross[s.from] !== undefined)) {
                this.et[s.key] = (this.cross[s.to] - (s.from ? this.cross[s.from] : t0)) / 1000;
                this.last = { key: s.key, label: s.label, s: this.et[s.key] };
            }
        }
        if (c.t - t0 > MAX_RUN_MS) this._finish('cap', c.t);
        else if (SPLIT_KEYS.every((k) => this.et[k] !== undefined)) this._finish('complete', c.t);
        else if (this._lifted(c.t)) this._finish('lift', c.t);
    }

    _finish(reason, t) {
        const got = Object.keys(this.et).length;
        const from = this.t0 !== null ? this.t0 : this.tMove;
        const dur = clamp(t - from, 0, MAX_RUN_MS) / 1000;
        this.result = {
            tree: this.sched ? this.sched.type : 'sportsman',
            rollout: this.rollout,
            rt: (this.tMove - this.tGreen) / 1000,
            red: this.tMove < this.tGreen,
            et: Object.assign({}, this.et),
            kmh: Object.assign({}, this.kmh),
            trap: Object.assign({}, this.trap),
            peakKmh: this.vmax,
            peakRpm: this.rpmMax || null,
            distM: Math.max(0, this.dist - this.off),
            durS: dur,
            end: reason,
            aborted: got === 0,
            samples: this.samples,
            hz: dur > 0 ? this.samples / dur : 0,
            maxGapMs: Math.round(this.maxGapMs),
            glitches: this.glitches,
            bumps: this.bumps,
        };
        this.state = 'done';
    }

    /** The live numbers for the screens. */
    view(t) {
        const running = this.state === 'run';
        const from = this.t0;
        return {
            state: this.state,
            elapsed: running ? (from !== null && num(t) ? clamp(t - from, 0, MAX_RUN_MS) / 1000 : 0) : this.result ? this.result.durS : 0,
            kmh: this.prev ? this.prev.v : null,
            distM: Math.max(0, this.dist - this.off),
            et: this.et, speeds: this.kmh, trap: this.trap,
            last: this.last,
            peakKmh: this.vmax,
            rpmMax: this.rpmMax,
        };
    }
}

/** The headline of a finished run: the furthest mark of note that was reached. */
function headline(r) {
    if (!r || !r.et) return null;
    const order = [['mi4', '1/4 MILE'], ['mi8', '1/8 MILE'], ['mph60', '0-60 MPH'], ['kmh100', '0-100 KM/H'], ['ft60', '60 FT'], ['mph30', '0-30 MPH']];
    for (let i = 0; i < order.length; i++) if (num(r.et[order[i][0]])) return { key: order[i][0], label: order[i][1], s: r.et[order[i][0]] };
    return null;
}

module.exports = {
    LaunchTimer, kmhFromRaw, preStageDelay, treeSchedule, treeLights, headline, CREEP_M, CREEP_KMH, TREE_GAP_MS,
    DIST, SPEED, SPLIT_KEYS, MPH, FT, MOVE_KMH, ROLLOUT_M, TRAP_M, MAX_RUN_MS, LIFT_MS, GREEN_WAIT_MS, RAW_INVALID,
};
