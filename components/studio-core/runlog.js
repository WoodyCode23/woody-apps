'use strict';
/* A Launch run's data log (apps/woodr_launch/runlog.js writes it: runs/run-<date>-<time>.json), read for the
 * overlay an editor draws on the clip of that run: the clock, the speed, the pull, the revs and the gear, and
 * each split as it is passed.
 *
 * The file comes from the car, by hand, through a folder: it is read as untrusted text. Sizes are bounded, every
 * number is checked, and nothing but times and the car's own readings is kept.
 *
 *   parse(text) -> { ok, run } or { ok: false, error }
 *     run = { at (ms, wall clock of the green light, or NaN), lead (s from armed to first movement), end (s after
 *             first movement of the last row), t[], kmh[], rpm[], gear[], g[] (rows, t in s after first movement),
 *             green (s after first movement that the light went green: -0.4 is a 0.4 s reaction; null if unknown),
 *             splits: [{ key, label, s }] in the order they were passed, shifts: [{ s, to, rpm }],
 *             peakG, launchRpm, spinKmh, spinAtS, rollout, red }
 *   at(run, s)            -> { kmh, rpm, gear, g } at s seconds after first movement (null where there is nothing)
 *   align(run, track)     -> { at (s into the track where the car first moved), err (km/h) } or null
 *     track = { t[], kmh[] }: the speed a clip (or a whole drive) recorded. The run's own speed is slid along it
 *     and the place where the two agree best is where the run happened. Clocks and time zones play no part.
 *   isRunFile(name)       a file name that is a run log
 */
var MAX_BYTES = 600000, MAX_ROWS = 4000, MAX_END = 120;
var RUN_FILE = /^run-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.json$/i;
var LABELS = { ft60: '60 FT', ft330: '330 FT', mi8: '1/8 MILE', ft1000: '1000 FT', mi4: '1/4 MILE', mi2: '1/2 MILE', mi1: '1 MILE',
    mph30: '0-30 MPH', mph60: '0-60 MPH', mph100: '0-100 MPH', mph60_130: '60-130 MPH', kmh100: '0-100 KM/H', kmh100_200: '100-200 KM/H' };

function fin(v) { return typeof v === 'number' && isFinite(v); }
function within(v, lo, hi) { return fin(v) && v >= lo && v <= hi ? v : null; }

function isRunFile(name) {
    if (typeof name !== 'string') return false;
    var base = name.split(/[\\/]/).pop();
    return RUN_FILE.test(base);
}

function parse(text) {
    if (typeof text !== 'string') return { ok: false, error: 'not text' };
    if (text.length > MAX_BYTES) return { ok: false, error: 'too large' };
    var doc;
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, error: 'not JSON' }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.v !== 1 || !Array.isArray(doc.rows)) return { ok: false, error: 'not a run log' };
    if (doc.rows.length < 5 || doc.rows.length > MAX_ROWS) return { ok: false, error: 'wrong number of rows' };
    var move = within(doc.moveMs, 0, 600000);
    if (move === null) return { ok: false, error: 'no start of the run' };
    var run = { at: NaN, lead: move / 1000, end: 0, t: [], kmh: [], rpm: [], gear: [], g: [], green: null, splits: [], shifts: [], peakG: null, launchRpm: null, spinKmh: null, spinAtS: null, rollout: doc.rollout === true, red: doc.red === true };
    var last = -Infinity;
    for (var i = 0; i < doc.rows.length; i++) {
        var r = doc.rows[i];
        if (!Array.isArray(r) || !fin(r[0]) || r[0] < last || r[0] > 600000) return { ok: false, error: 'rows out of order' };
        last = r[0];
        var kmh = within(r[1], 0, 500);
        if (kmh === null) continue;                        /* a row without a speed says nothing an overlay can use */
        run.t.push((r[0] - move) / 1000); run.kmh.push(kmh);
        run.rpm.push(within(r[2], 0, 12000)); run.gear.push(within(r[3], -1, 10)); run.g.push(within(r[4], -3, 3));
    }
    if (run.t.length < 5) return { ok: false, error: 'no speed in it' };
    run.end = Math.min(MAX_END, run.t[run.t.length - 1]);
    if (run.end <= 0) return { ok: false, error: 'the run never started' };
    var gr = within(doc.greenMs, 0, 600000);
    if (gr !== null && Math.abs(gr - move) <= 30000) run.green = (gr - move) / 1000;      /* s after first movement: negative when the car left after the green */
    if (typeof doc.at === 'string' && doc.at.length < 40) { var at = Date.parse(doc.at); if (fin(at)) run.at = at; }
    var et = doc.et && typeof doc.et === 'object' && !Array.isArray(doc.et) ? doc.et : {};
    Object.keys(LABELS).forEach(function (k) { var s = within(et[k], 0, MAX_END); if (s !== null) run.splits.push({ key: k, label: LABELS[k], s: s }); });
    run.splits.sort(function (a, b) { return a.s - b.s; });
    var sum = doc.summary && typeof doc.summary === 'object' && !Array.isArray(doc.summary) ? doc.summary : {};
    run.peakG = within(sum.peakG, -3, 3); run.launchRpm = within(sum.launchRpm, 0, 12000);
    run.spinKmh = within(sum.spinKmh, 0, 500); run.spinAtS = within(sum.spinAtS, 0, MAX_END);
    if (Array.isArray(sum.shifts)) sum.shifts.slice(0, 10).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var s = within(x.s, 0, MAX_END), to = within(x.to, 1, 10);
        if (s !== null && to !== null) run.shifts.push({ s: s, to: Math.round(to), rpm: within(x.rpm, 0, 12000) });
    });
    return { ok: true, run: run };
}

/* the row at or before s, by halving */
function rowAt(run, s) {
    var lo = 0, hi = run.t.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (run.t[mid] <= s) lo = mid; else hi = mid - 1; }
    return lo;
}
function lerp(a, b, f) { return a === null || b === null ? (f < 0.5 ? a : b) : a + (b - a) * f; }

function at(run, s) {
    var none = { kmh: null, rpm: null, gear: null, g: null };
    if (!run || !Array.isArray(run.t) || !run.t.length || !fin(s)) return none;
    var n = run.t.length;
    if (s <= run.t[0]) return { kmh: run.kmh[0], rpm: run.rpm[0], gear: run.gear[0], g: run.g[0] };
    if (s >= run.t[n - 1]) return { kmh: run.kmh[n - 1], rpm: run.rpm[n - 1], gear: run.gear[n - 1], g: run.g[n - 1] };
    var i = rowAt(run, s), span = run.t[i + 1] - run.t[i], f = span > 0 ? (s - run.t[i]) / span : 0;
    return { kmh: lerp(run.kmh[i], run.kmh[i + 1], f), rpm: lerp(run.rpm[i], run.rpm[i + 1], f), gear: run.gear[f < 0.5 ? i : i + 1], g: lerp(run.g[i], run.g[i + 1], f) };
}

/* the track's speed at t, straight lines between its samples; null outside it */
function trackAt(track, t) {
    var ts = track.t, n = ts.length;
    if (t < ts[0] || t > ts[n - 1]) return null;
    var lo = 0, hi = n - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid - 1; }
    if (lo >= n - 1) return track.kmh[n - 1];
    var span = ts[lo + 1] - ts[lo];
    return span > 0 ? track.kmh[lo] + (track.kmh[lo + 1] - track.kmh[lo]) * (t - ts[lo]) / span : track.kmh[lo];
}

var ALIGN_STEP = 0.1, ALIGN_BEFORE = 1.5, ALIGN_SPAN = 8, ALIGN_EVERY = 0.25, ALIGN_MAX_ERR = 8, ALIGN_MIN_KMH = 20;
function align(run, track) {
    if (!run || !track || !Array.isArray(track.t) || !Array.isArray(track.kmh)) return null;
    var n = Math.min(track.t.length, track.kmh.length);
    if (n < 4 || n > 2000000) return null;
    for (var k = 0; k < n; k++) if (!fin(track.t[k]) || !fin(track.kmh[k]) || (k && track.t[k] < track.t[k - 1])) return null;
    var tr = { t: track.t.slice(0, n), kmh: track.kmh.slice(0, n) };
    var span = Math.min(ALIGN_SPAN, run.end), want = [];
    for (var s = -ALIGN_BEFORE; s <= span; s += ALIGN_EVERY) want.push([s, s < 0 ? (at(run, s).kmh || 0) : at(run, s).kmh]);
    if (at(run, span).kmh < ALIGN_MIN_KMH) return null;        /* a run that barely moved looks like every traffic light */
    var best = null, from = tr.t[0], to = tr.t[n - 1] - Math.min(span, 2);
    for (var o = from; o <= to; o += ALIGN_STEP) {
        var sum = 0, cnt = 0;
        for (var j = 0; j < want.length; j++) {
            var v = trackAt(tr, o + want[j][0]);
            if (v === null) continue;
            var d = v - want[j][1]; sum += d * d; cnt++;
        }
        if (cnt < want.length * 0.6) continue;               /* most of the run has to lie inside the track */
        var err = Math.sqrt(sum / cnt);
        if (!best || err < best.err) best = { at: Math.round(o * 100) / 100, err: Math.round(err * 100) / 100 };
    }
    return best && best.err <= ALIGN_MAX_ERR ? best : null;
}

module.exports = { parse: parse, at: at, align: align, isRunFile: isRunFile, MAX_BYTES: MAX_BYTES, LABELS: LABELS };
