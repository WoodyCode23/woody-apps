'use strict';
/* The speed, and only the speed, out of the car's data file beside a clip.
 *
 * That file also says who the car is and where it was, many times a second. Editors need neither: this is the one
 * place the file is read, it takes each sample's speed and the first and last timestamps, and what it hands back
 * holds two lists of numbers and nothing else. Keep it that way.
 *
 * The file: an object, or a list whose first item is one, with entries: [{ date: "DD.MM.YYYY", time: "HH:MM:SS",
 * velocity: km/h, ... }]. The samples are taken to be evenly spread (the PC Studio's read_meta does the same). */

var KMH_PER_MPH = 1.609344;
var MAX_SAMPLES = 100000;     /* a clip is about 40 s at 30 samples a second; far past that is not one */

function stamp(e) {
    if (!e || typeof e.date !== 'string' || typeof e.time !== 'string') return NaN;
    var d = /^\s*(\d\d)\.(\d\d)\.(\d{4})\s*$/.exec(e.date), t = /^\s*(\d\d):(\d\d):(\d\d)\s*$/.exec(e.time);
    return d && t ? Date.UTC(+d[3], +d[2] - 1, +d[1], +t[1], +t[2], +t[3]) : NaN;
}

/* -> { t: [seconds from the clip's start], kmh: [...] }; both empty when the file is not what we expect */
function fromMeta(doc) {
    var none = { t: [], kmh: [] };
    var top = Array.isArray(doc) ? doc[0] : doc;
    var entries = top && typeof top === 'object' ? top.entries : null;
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SAMPLES) return none;
    var first = stamp(entries[0]), last = stamp(entries[entries.length - 1]);
    if (isNaN(first) || isNaN(last)) return none;
    var n = entries.length, span = Math.max(1, (last - first) / 1000 + 1), t = [], kmh = [];
    for (var i = 0; i < n; i++) {
        var raw = entries[i] ? entries[i].velocity : 0;
        var v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;      /* never Number(an object): that can throw */
        t.push(i * span / n);
        kmh.push(isFinite(v) && v > 0 ? v : 0);
    }
    return { t: t, kmh: kmh };
}

/* a list item as a number, 0 for anything else: a track handed in from outside may hold anything, and comparing or
 * adding an object can throw */
function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

/* km/h at t seconds into the clip: a straight line between samples, the end values outside them */
function at(track, t) {
    var ts = track && Array.isArray(track.t) ? track.t : [], vs = track && Array.isArray(track.kmh) ? track.kmh : [];
    var n = Math.min(ts.length, vs.length);
    if (!n || typeof t !== 'number' || isNaN(t)) return 0;
    if (t <= num(ts[0])) return num(vs[0]);
    if (t >= num(ts[n - 1])) return num(vs[n - 1]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (num(ts[mid]) <= t) lo = mid; else hi = mid; }
    var t0 = num(ts[lo]), t1 = num(ts[hi]), w = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return num(vs[lo]) + (num(vs[hi]) - num(vs[lo])) * w;
}

/* the number to draw, in the recipe's unit */
function show(kmh, unit) {
    if (typeof kmh !== 'number' || !isFinite(kmh)) return 0;
    return Math.round(unit === 'kmh' ? kmh : kmh / KMH_PER_MPH);
}

module.exports = { fromMeta: fromMeta, at: at, show: show };
