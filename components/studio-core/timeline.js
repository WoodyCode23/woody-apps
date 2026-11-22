'use strict';
/* Timeline arithmetic. An editor shows a drive as one long strip ("drive seconds", the clips end to end); a recipe
 * stores per-clip parts, so it does not depend on which clips a place happens to have. This turns one into the
 * other, and answers what is on screen at a time in the finished edit.
 *
 *   clips: [{ clip, dur }]                  the drive's clips in playing order, dur in seconds
 *   segs:  [{ a, b, view, rate }]           pieces in drive seconds
 *   parts: [{ clip, t0, t1, view, rate }]   pieces in clip seconds (what the recipe holds)
 *
 * Nothing here throws: a bad list is an empty list, a bad piece is left out. */

var MIN = 0.05;               /* seconds: the same floor as the recipe's */
var JOIN = 0.02;              /* two pieces closer than this, same camera and rate, were one piece cut by a clip join */

function isNum(n) { return typeof n === 'number' && isFinite(n) && Math.abs(n) <= 1e9; }      /* the recipe's limit */
function r3(x) { return Math.floor(x * 1000 + 0.5) / 1000; }
function list(x) { return Array.isArray(x) ? x : []; }
function durOf(c) { return c && isNum(c.dur) && c.dur > 0 ? c.dur : 0; }
function rateOf(p) { return isNum(p.rate) && p.rate > 0 ? p.rate : 1; }

function offsets(clips) {
    var out = [], at = 0;
    list(clips).forEach(function (c) { out.push(at); at += durOf(c); });
    return out;
}

function segsToParts(segs, clips) {
    var cl = list(clips), offs = offsets(cl), out = [];
    list(segs).forEach(function (s) {
        if (!s || !isNum(s.a) || !isNum(s.b) || s.b <= s.a) return;
        for (var i = 0; i < cl.length; i++) {
            var o = offs[i], t0 = r3(Math.max(s.a, o) - o), t1 = r3(Math.min(s.b, o + durOf(cl[i])) - o);
            if (t1 - t0 >= MIN) out.push({ clip: cl[i].clip, t0: t0, t1: t1, view: s.view || 'all', rate: rateOf(s) });
        }
    });
    return out;
}

/* -> { segs, missing }: missing holds the parts whose clip is not among clips, as they were, so a place that lacks
 * a clip can still save the edit without losing them */
function partsToSegs(parts, clips) {
    var cl = list(clips), offs = offsets(cl), segs = [], missing = [], joinable = false;
    list(parts).forEach(function (p) {
        var i = -1;
        if (p) for (var k = 0; k < cl.length; k++) if (cl[k] && cl[k].clip === p.clip) { i = k; break; }
        if (i < 0) { if (p) missing.push(p); joinable = false; return; }
        if (!isNum(p.t0) || !isNum(p.t1)) { joinable = false; return; }
        var a = r3(offs[i] + Math.max(0, p.t0)), b = r3(offs[i] + Math.min(p.t1, durOf(cl[i])));
        if (b - a < MIN) { joinable = false; return; }
        var view = p.view || 'all', rate = rateOf(p), last = segs[segs.length - 1];
        if (joinable && last && Math.abs(last.b - a) <= JOIN && last.view === view && last.rate === rate) last.b = b;
        else segs.push({ a: a, b: b, view: view, rate: rate });
        joinable = true;
    });
    return { segs: segs, missing: missing };
}

/* seconds of finished video */
function length(parts) {
    return list(parts).reduce(function (sum, p) { return p && isNum(p.t0) && isNum(p.t1) && p.t1 > p.t0 ? sum + (p.t1 - p.t0) / rateOf(p) : sum; }, 0);
}

/* what is showing at t seconds into the finished edit -> { i, clip, t } (which part, which clip, the time in that
 * clip), or null outside the edit */
function locate(parts, t) {
    if (!isNum(t) || t < 0) return null;
    var ps = list(parts), at = 0;
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p || !isNum(p.t0) || !isNum(p.t1) || p.t1 <= p.t0) continue;
        var len = (p.t1 - p.t0) / rateOf(p);
        if (t < at + len) return { i: i, clip: p.clip, t: r3(p.t0 + (t - at) * rateOf(p)) };
        at += len;
    }
    return null;
}

module.exports = { offsets: offsets, segsToParts: segsToParts, partsToSegs: partsToSegs, length: length, locate: locate };
