'use strict';
/* How loud the music is at each moment of a finished video: up from nothing at the start, level through the
 * middle, down to nothing at the end. When the music is shorter than the video it fades out at its own end and
 * the rest is silent; it is never looped.
 *
 *   gainAt(t, opts)        -> 0..1 at t seconds into the video
 *   envelope(opts, rate)   -> Float32Array of gains, `rate` a second, for the whole video
 *   opts = { dur (the video, s), musicDur (the music, s), volume 0..1, fadeIn s, fadeOut s }
 */

function fin(v) { return typeof v === 'number' && isFinite(v); }

function gainAt(t, opts) {
    var o = opts || {};
    if (!fin(t) || t < 0 || !fin(o.dur)) return 0;
    var end = fin(o.musicDur) ? Math.min(o.dur, o.musicDur) : o.dur;
    if (t >= end) return 0;
    var g = fin(o.volume) ? Math.max(0, Math.min(1, o.volume)) : 1;
    var fi = fin(o.fadeIn) && o.fadeIn > 0 ? o.fadeIn : 0, fo = fin(o.fadeOut) && o.fadeOut > 0 ? o.fadeOut : 0;
    if (fi && t < fi) g *= t / fi;
    if (fo && t > end - fo) g *= (end - t) / fo;
    return g;
}

function envelope(opts, rate) {
    var r = fin(rate) && rate > 0 ? rate : 100, n = Math.max(2, Math.ceil((opts && fin(opts.dur) ? opts.dur : 0) * r));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = gainAt(i / r, opts);
    return out;
}

module.exports = { gainAt: gainAt, envelope: envelope };
