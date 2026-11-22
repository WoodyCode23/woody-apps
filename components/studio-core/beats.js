'use strict';
/* The beat of a piece of music, found from its samples, so a montage can cut on it.
 *
 * Plain and small on purpose: how loud the music is every hundredth of a second, how sharply that rises (a drum
 * hit rises sharply), which spacing between 60 and 180 beats a minute those rises repeat at, and where the first
 * one falls. Music with no clear pulse (a held note, speech, silence) gives no beat, and the montage then cuts at
 * even lengths instead.
 *
 *   detect(samples, rate) -> { bpm, period (s), first (s of the first beat), strength 0..1 } or null
 *     samples: one channel as numbers between -1 and 1 (a Float32Array, or anything with a length and indexes)
 *   grid(beat, dur) -> the beats from the first up to dur, in seconds
 */
var FPS = 100;                       /* loudness is measured this many times a second */
var MIN_BPM = 60, MAX_BPM = 180;
var MAX_SECONDS = 600;               /* the first ten minutes are plenty to find a beat in */
var MIN_STRENGTH = 0.12;
var MIN_RISE = 0.06;                 /* the least jump in loudness, as a share of the loudest moment, that counts as a hit */

function detect(samples, rate) {
    if (!samples || typeof samples.length !== 'number' || typeof rate !== 'number' || !isFinite(rate) || rate < 4000 || rate > 400000) return null;
    var hop = Math.round(rate / FPS), n = Math.min(Math.floor(samples.length / hop), MAX_SECONDS * FPS);
    if (n < FPS * 4) return null;                       /* under four seconds: nothing to go on */
    var env = new Float32Array(n), i, j, peak = 0;
    for (i = 0; i < n; i++) {
        var sum = 0, at = i * hop;
        for (j = 0; j < hop; j++) { var v = +samples[at + j]; if (v === v) sum += v * v; }
        env[i] = Math.sqrt(sum / hop);
        if (env[i] > peak) peak = env[i];
    }
    if (!(peak > 1e-4)) return null;                    /* silence */
    /* how sharply the loudness rises, frame to frame */
    var rise = new Float32Array(n), total = 0;
    /* a steady tone still ripples a few hundredths from one measure to the next: that is not a beat, so a rise
     * counts only from MIN_RISE of the loudest moment up */
    for (i = 1; i < n; i++) { var d = (env[i] - env[i - 1]) / peak; if (d >= MIN_RISE) { rise[i] = d; total += d * d; } }
    if (!(total > 1e-6)) return null;                   /* a held note, a hum */
    /* the spacing the rises repeat at */
    var lo = Math.round(FPS * 60 / MAX_BPM), hi = Math.round(FPS * 60 / MIN_BPM), best = 0, bestLag = 0;
    var score = function (lag) { var s = 0; for (var k = lag; k < n; k++) s += rise[k] * rise[k - lag]; return s / (n - lag); };
    for (var lag = lo; lag <= hi; lag++) { var sc = score(lag); if (sc > best) { best = sc; bestLag = lag; } }
    var strength = best / (total / n);
    if (!bestLag || !(strength >= MIN_STRENGTH)) return null;
    /* twice as fast, if that fits nearly as well: a beat is more use to cut on than every other beat */
    var half = Math.round(bestLag / 2);
    if (half >= lo && score(half) >= best * 0.8) bestLag = half;
    /* where the first beat falls: the offset whose every bestLag-th frame holds the most rise */
    var bestOff = 0, bestSum = -1;
    for (var off = 0; off < bestLag; off++) {
        var s2 = 0;
        for (var k2 = off; k2 < n; k2 += bestLag) s2 += rise[k2] + (k2 + 1 < n ? rise[k2 + 1] * 0.5 : 0) + (k2 > 0 ? rise[k2 - 1] * 0.5 : 0);
        if (s2 > bestSum) { bestSum = s2; bestOff = off; }
    }
    var period = bestLag / FPS;
    return { bpm: Math.round(600 / period) / 10, period: period, first: bestOff / FPS, strength: Math.min(1, strength) };
}

function grid(beat, dur) {
    var out = [];
    if (!beat || !(beat.period > 0.2) || !(dur > 0) || !(beat.first >= 0)) return out;
    for (var t = beat.first; t <= dur && out.length < 5000; t += beat.period) out.push(Math.round(t * 1000) / 1000);
    return out;
}

module.exports = { detect: detect, grid: grid, FPS: FPS };
