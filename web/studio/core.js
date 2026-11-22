/* Dashcam Studio, shared core. Packed by tools/build_studio_web.js from components/studio-core: change it there. */
(function (root) {
'use strict';
var defs = {}, made = {};
function need(name) {
    name = name.replace(/\.js$/, '');
    if (made[name]) return made[name].exports;
    if (!defs[name]) throw new Error('studio core: no part called ' + name);
    var m = made[name] = { exports: {} };
    defs[name](m, m.exports, need);
    return m.exports;
}

/* ---- audio.js ---- */
defs['./audio'] = function (module, exports, require) {
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
};

/* ---- beats.js ---- */
defs['./beats'] = function (module, exports, require) {
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
};

/* ---- clipname.js ---- */
defs['./clipname'] = function (module, exports, require) {
/* One name per clip, wherever it is: its start time, "YYYY-MM-DD HH.MM.SS", local to the car.
 *
 * The PC library and a stick import call a clip "2026-11-14 18.41.07.mp4"; the car keeps it in a folder called
 * "14.11.2026_18_41_07_Event". Both come out as "2026-11-14 18.41.07", which is what a recipe's parts carry, so an
 * edit made in one place finds its clips in another. */

var PC = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)\.(\d\d)(\.[A-Za-z0-9]{1,5})?$/;
var CAR = /^(\d\d)\.(\d\d)\.(\d{4})_(\d\d)_(\d\d)_(\d\d)(_[A-Za-z]{1,20})?$/;
var NAME = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)\.(\d\d)$/;

function valid(y, mo, d, h, mi, s) { return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59 && y >= 2000; }

/* a file name, a folder name or a path to either -> the clip's name, or null */
function fromAny(name) {
    if (typeof name !== 'string' || !name || name.length > 1024) return null;
    var last = name.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    var m = PC.exec(last), y, mo, d;
    if (m) { y = m[1]; mo = m[2]; d = m[3]; } else {
        m = CAR.exec(last);
        if (!m) return null;
        d = m[1]; mo = m[2]; y = m[3];
    }
    if (!valid(+y, +mo, +d, +m[4], +m[5], +m[6])) return null;
    return y + '-' + mo + '-' + d + ' ' + m[4] + '.' + m[5] + '.' + m[6];
}

/* milliseconds, reading the name as if it were UTC: only for ordering and for gaps between clips, which are the
 * same whatever the car's time zone was */
function toDate(clip) {
    var m = typeof clip === 'string' ? NAME.exec(clip) : null;
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/* the names are written biggest unit first, so they sort as text */
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

module.exports = { fromAny: fromAny, toDate: toDate, compare: compare };
};

/* ---- compose.js ---- */
defs['./compose'] = function (module, exports, require) {
/* Templates for a finished social clip: what each frame of the video shows, decided here so that every editor
 * (the web app, the PC Studio, the car) makes the same clip from the same choices.
 *
 * MOMENT: one piece of a drive, up to fifteen seconds, with a slow push-in, a title early and a caption late.
 *
 *   moment(piece, opts) -> plan
 *     piece = { t0, t1 (seconds, the piece's start and end), view, rate }
 *     opts  = { title, caption, look, shape: 'vertical' | 'square' | 'wide', maxDur }
 *     plan  = { kind: 'moment', w, h, fps, dur, frames, piece, zoom: { from, to }, texts: [{ text, role, in, out }], look }
 * LAUNCH: one run from the Launch app's data log. The lights counting down, the launch itself in slow motion, the
 * run with its figures, a hold on the finish, and a timeslip card with the run's own numbers.
 *
 *   launch(run, opts) -> plan         run = runlog.parse(...).run
 *     opts = { title, look, shape, lead (seconds of clip there are before the car first moved) }
 *     plan = { kind: 'launch', w, h, fps, dur, frames, parts: [{ part, at, d, a, rate }], green, fin, rows, look, title }
 *       part: 'tree' | 'slow' | 'run' | 'hold' | 'card'; at/d: where it sits in the clip (s); a: the second of the
 *       run (after first movement) it starts on; rate: run seconds per clip second (0 holds still)
 *       rows: the timeslip, [{ label, value }], figures as the log gave them
 *   For a launch plan, frameAt -> { part, src (seconds after first movement), view: 'front', zoom,
 *       tree: { amber: 0 to 3, green } or null, card: 0 to 1 (how far the timeslip has come in), texts }
 *     The lamps are a picture of a countdown, half a second apart: the log holds when the light went green, not
 *     how the tree was set.
 *
 * MONTAGE: up to eight pieces of a drive, a couple of seconds of each, cut on the beat of the music when there is
 * one, with a flash at each cut and the title over the start.
 *
 *   montage(pieces, opts) -> plan
 *     pieces = [{ t0, t1, view, rate }] in the order to show them
 *     opts   = { title, look, shape, beat: { period, first } from beats.detect or null, maxDur }
 *     plan   = { kind: 'montage', w, h, fps, dur, frames, parts: [{ k, at, d, a, rate, view }], onBeat, look, title }
 *       k: which piece; at/d: where the part sits in the clip (s); a: the second of the drive it starts on (the
 *       middle of its piece is what is shown). With a beat every cut falls on one; without, parts are even.
 *   For a montage plan, frameAt -> { part (its number), src, view, zoom, flash: 0 to 1 (white, fading, after a cut), texts }
 *
 *   frameAt(plan, i) -> { src (the second of the piece's source frame i shows), view, zoom, texts: [{ text, role, alpha }] }
 *   fitText(measure, text, maxW, size, minSize) -> { lines, size }
 *     measure(text, size) -> width. Shrinks first, then wraps to two lines at most, the second cut with "…".
 */
var FPS = 30;
var SHAPES = { vertical: [1080, 1920], square: [1080, 1080], wide: [1920, 1080] };
var FADE = 0.3;                 /* seconds a text takes to come and to go */

function fin(v) { return typeof v === 'number' && isFinite(v); }
function clean(s, max) { return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

function moment(piece, opts) {
    var p = piece || {}, o = opts || {};
    var shape = Object.prototype.hasOwnProperty.call(SHAPES, o.shape) ? SHAPES[o.shape] : SHAPES.vertical;
    var rate = fin(p.rate) && p.rate > 0 ? p.rate : 1;
    var t0 = fin(p.t0) ? p.t0 : 0, t1 = fin(p.t1) && p.t1 > t0 ? p.t1 : t0;
    var max = fin(o.maxDur) && o.maxDur > 0 ? o.maxDur : 15;
    var dur = Math.min(max, (t1 - t0) / rate);
    var texts = [], title = clean(o.title, 60), caption = clean(o.caption, 60);
    if (title && dur > 0.6) texts.push({ text: title, role: 'title', in: Math.min(0.3, dur / 4), out: Math.min(3.3, dur - 0.1) });
    if (caption && dur > 0.6) texts.push({ text: caption, role: 'caption', in: Math.max(0, dur - 3.5), out: dur - 0.3 });
    return {
        kind: 'moment', w: shape[0], h: shape[1], fps: FPS, dur: dur, frames: Math.round(dur * FPS),
        piece: { t0: t0, t1: t1, view: typeof p.view === 'string' ? p.view : 'all', rate: rate },
        zoom: { from: 1, to: 1.12 }, texts: texts, look: typeof o.look === 'string' ? o.look : 'clean',
    };
}

function frameAt(plan, i) {
    if (plan.kind === 'launch') return launchFrame(plan, i);
    if (plan.kind === 'montage') return montageFrame(plan, i);
    var n = plan.frames, k = Math.max(0, Math.min(n - 1, fin(i) ? i : 0)), tau = k / plan.fps;
    var u = n > 1 ? k / (n - 1) : 0, ease = u * u * (3 - 2 * u);
    var texts = [];
    plan.texts.forEach(function (t) {
        if (tau < t.in || tau > t.out) return;
        var a = Math.min(1, (tau - t.in) / FADE, (t.out - tau) / FADE);
        if (a > 0) texts.push({ text: t.text, role: t.role, alpha: a });
    });
    return { src: plan.piece.t0 + tau * plan.piece.rate, view: plan.piece.view, zoom: plan.zoom.from + (plan.zoom.to - plan.zoom.from) * ease, texts: texts };
}

var SLOW_FROM = -0.3, SLOW_TO = 1.2, SLOW_RATE = 0.4, RUN_MAX = 12, HOLD = 1.2, CARD = 3.5, TREE_MAX = 3, LAMP_GAP = 0.5;
function f2(v) { return v.toFixed(2); }

function launch(run, opts) {
    var o = opts || {}, shape = Object.prototype.hasOwnProperty.call(SHAPES, o.shape) ? SHAPES[o.shape] : SHAPES.vertical;
    var plan = { kind: 'launch', w: shape[0], h: shape[1], fps: FPS, dur: 0, frames: 0, parts: [], green: null, fin: 0, rows: [], look: typeof o.look === 'string' ? o.look : 'clean', title: clean(o.title, 60) };
    if (!run || !fin(run.end) || run.end <= 0 || !Array.isArray(run.splits)) return plan;
    var splits = run.splits.filter(function (x) { return x && fin(x.s) && x.s > 0 && x.s <= run.end && typeof x.label === 'string'; }).slice(0, 13);
    var last = splits.length ? splits[splits.length - 1].s : run.end;
    var end = Math.min(run.end, last + 0.4);            /* a moment past the last split, so its figure is seen landing */
    var lead = fin(o.lead) && o.lead > 0 ? o.lead : 0, at = 0;
    var add = function (part, d, a, rate) { if (d > 0.001) { plan.parts.push({ part: part, at: at, d: d, a: a, rate: rate }); at += d; } };
    var slow0 = Math.max(-lead, SLOW_FROM), slow1 = Math.min(end, SLOW_TO);
    add('tree', Math.min(TREE_MAX, lead) + slow0, -Math.min(TREE_MAX, lead), 1);
    add('slow', (slow1 - slow0) / SLOW_RATE, slow0, SLOW_RATE);
    var rest = end - slow1, rate = Math.max(1, rest / RUN_MAX);     /* a long run is hurried to fit, never cut */
    add('run', rest / rate, slow1, rate);
    add('hold', HOLD, end, 0);
    add('card', CARD, end, 0);
    plan.dur = at; plan.frames = Math.round(at * FPS); plan.fin = end;
    plan.green = fin(run.green) ? run.green : null;
    if (run.red === true) plan.rows.push({ label: 'RED LIGHT', value: '' });
    else if (plan.green !== null && plan.green <= 0) plan.rows.push({ label: 'REACTION', value: (-plan.green).toFixed(3) });
    splits.slice(0, 8).forEach(function (x) { plan.rows.push({ label: clean(x.label, 16), value: f2(x.s) }); });
    if (fin(run.peakG)) plan.rows.push({ label: 'PEAK', value: f2(run.peakG) + ' G' });
    if (fin(run.launchRpm)) plan.rows.push({ label: 'LAUNCH', value: String(Math.round(run.launchRpm / 10) * 10) + ' RPM' });
    return plan;
}

function launchFrame(plan, i) {
    var n = plan.frames, k = Math.max(0, Math.min(n - 1, fin(i) ? i : 0)), tau = k / plan.fps;
    var p = plan.parts[0] || { part: 'card', at: 0, d: 0, a: 0, rate: 0 };
    for (var j = 0; j < plan.parts.length; j++) if (tau >= plan.parts[j].at) p = plan.parts[j];
    var src = p.a + (tau - p.at) * p.rate, tree = null, texts = [];
    if (plan.green !== null && (p.part === 'tree' || p.part === 'slow' || p.part === 'run')) {
        var tb = src - plan.green;                      /* seconds since the green */
        if (tb < 1.5) tree = { amber: tb >= 0 ? 0 : tb >= -LAMP_GAP ? 3 : tb >= -2 * LAMP_GAP ? 2 : tb >= -3 * LAMP_GAP ? 1 : 0, green: tb >= 0 };
    }
    if (plan.title && p.part === 'tree') { var a = Math.min(1, tau / FADE, (p.d - tau) / FADE); if (a > 0) texts.push({ text: plan.title, role: 'title', alpha: a }); }
    return { part: p.part, src: src, view: 'front', zoom: p.part === 'slow' ? 1.06 : 1, tree: tree, card: p.part === 'card' ? Math.min(1, (tau - p.at) / 0.4) : 0, texts: texts };
}

var MONTAGE_PIECES = 8, PART_S = 2.5, PART_MIN = 1.2, FLASH_S = 0.12, MONTAGE_MAX = 60;

function montage(pieces, opts) {
    var o = opts || {}, shape = Object.prototype.hasOwnProperty.call(SHAPES, o.shape) ? SHAPES[o.shape] : SHAPES.vertical;
    var plan = { kind: 'montage', w: shape[0], h: shape[1], fps: FPS, dur: 0, frames: 0, parts: [], onBeat: false, look: typeof o.look === 'string' ? o.look : 'clean', title: clean(o.title, 60) };
    if (!Array.isArray(pieces)) return plan;
    var max = fin(o.maxDur) && o.maxDur > 0 ? Math.min(o.maxDur, MONTAGE_MAX) : MONTAGE_MAX;
    var b = o.beat, period = b && fin(b.period) && b.period >= 0.25 && b.period <= 1.2 ? b.period : 0;
    var first = period && fin(b.first) && b.first >= 0 ? b.first % period : 0;
    /* beats in a part: as near two and a half seconds as the beat allows, never under PART_MIN */
    var per = period ? Math.max(1, Math.round(PART_S / period)) : 0;
    if (period && per * period < PART_MIN) per++;
    var at = 0;
    pieces.slice(0, MONTAGE_PIECES).forEach(function (p, k) {
        if (!p || !fin(p.t0) || !fin(p.t1) || p.t1 <= p.t0) return;
        var rate = fin(p.rate) && p.rate > 0 ? p.rate : 1, avail = (p.t1 - p.t0) / rate, d;
        if (period) {
            /* the first part also runs up to the first beat, so that every cut after it is on one */
            var want = per * period + (plan.parts.length ? 0 : first), lead = plan.parts.length ? 0 : first;
            d = want <= avail ? want : lead + Math.floor((avail - lead) / period + 1e-9) * period;
            if (d - lead < period - 1e-9) return;                 /* not one whole beat of it: left out */
        } else {
            d = Math.min(PART_S, avail);
            if (d < 0.5) return;
        }
        if (at + d > max + 1e-9) return;
        plan.parts.push({ k: k, at: at, d: d, a: p.t0 + ((p.t1 - p.t0) - d * rate) / 2, rate: rate, view: typeof p.view === 'string' ? p.view : 'all' });
        at += d;
    });
    plan.dur = at; plan.frames = Math.round(at * FPS); plan.onBeat = !!period && plan.parts.length > 0;
    return plan;
}

function montageFrame(plan, i) {
    var n = plan.frames, k = Math.max(0, Math.min(n - 1, fin(i) ? i : 0)), tau = k / plan.fps;
    var idx = 0;
    for (var j = 0; j < plan.parts.length; j++) if (tau >= plan.parts[j].at - 1e-9) idx = j;
    var p = plan.parts[idx] || { at: 0, d: 1, a: 0, rate: 1, view: 'all' }, local = Math.max(0, tau - p.at), texts = [];
    if (plan.title) { var a = Math.min(1, (tau - 0.2) / FADE, (Math.min(3, plan.dur - 0.2) - tau) / FADE); if (a > 0) texts.push({ text: plan.title, role: 'title', alpha: a }); }
    return { part: idx, src: p.a + local * p.rate, view: p.view, zoom: 1 + 0.05 * Math.min(1, local / p.d),
        flash: idx > 0 && local < FLASH_S ? 1 - local / FLASH_S : 0, texts: texts };
}

function fitText(measure, text, maxW, size, minSize) {
    text = String(text == null ? '' : text);
    var s = size;
    while (s > minSize && measure(text, s) > maxW) s -= 2;
    if (s < minSize) s = minSize;
    if (measure(text, s) <= maxW) return { lines: [text], size: s };
    var words = text.split(' '), first = '', k = 0;
    while (k < words.length && measure(first ? first + ' ' + words[k] : words[k], s) <= maxW) { first = first ? first + ' ' + words[k] : words[k]; k++; }
    if (!first) {                                   /* one word wider than the line: cut it */
        first = text;
        while (first.length > 1 && measure(first + '…', s) > maxW) first = first.slice(0, -1);
        return { lines: [first + '…'], size: s };
    }
    var second = words.slice(k).join(' ');
    if (measure(second, s) > maxW) {
        while (second.length > 1 && measure(second + '…', s) > maxW) second = second.slice(0, -1);
        second = second.replace(/\s+$/, '') + '…';
    }
    return { lines: second ? [first, second] : [first], size: s };
}

module.exports = { launch: launch, moment: moment, montage: montage, frameAt: frameAt, fitText: fitText, SHAPES: SHAPES, FPS: FPS };
};

/* ---- geometry.js ---- */
defs['./geometry'] = function (module, exports, require) {
/* Where the picture goes. A clip is one picture with the four cameras in a 2 x 2 grid; an edit shows the whole
 * grid or one camera, in one of five output shapes, either filling the frame (edges cropped) or whole with bars.
 * Every editor and every exporter takes its rectangles from here, so a preview and the finished video agree. */

var FORMATS = { original: [1280, 960], wide: [1920, 1080], vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080] };
var VIEWS = { all: null, front: [0, 0], rear: [1, 0], left: [0, 1], right: [1, 1] };      /* column, row in the grid */

function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
function size(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : 0; }

/* the camera's rectangle inside a clip picture of w x h */
function crop(view, w, h) {
    var W = size(w), H = size(h), at = own(VIEWS, view) ? VIEWS[view] : null;
    if (!at) return { x: 0, y: 0, w: W, h: H };
    var hw = Math.floor(W / 2), hh = Math.floor(H / 2);
    return { x: at[0] * hw, y: at[1] * hh, w: hw, h: hh };
}

/* A source picture of sw x sh into the output shape. -> the part of the source to take (sx, sy, sw, sh, measured
 * inside that source picture) and where it lands (dx, dy, dw, dh) in an output of W x H. With fill the source is
 * cropped about its middle to the output's proportions; without, it is shown whole and centred. */
function fit(sw, sh, format, fill) {
    var f = own(FORMATS, format) ? FORMATS[format] : FORMATS.original, W = f[0], H = f[1];
    var w = size(sw), h = size(sh);
    if (!w || !h) return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: W, dh: H, W: W, H: H };
    if (fill) {
        var cw = w, ch = h;
        if (w * H > h * W) cw = Math.round(h * W / H); else ch = Math.round(w * H / W);
        return { sx: Math.round((w - cw) / 2), sy: Math.round((h - ch) / 2), sw: cw, sh: ch, dx: 0, dy: 0, dw: W, dh: H, W: W, H: H };
    }
    var k = Math.min(W / w, H / h), dw = Math.round(w * k), dh = Math.round(h * k);
    return { sx: 0, sy: 0, sw: w, sh: h, dx: Math.round((W - dw) / 2), dy: Math.round((H - dh) / 2), dw: dw, dh: dh, W: W, H: H };
}

module.exports = { FORMATS: FORMATS, VIEWS: VIEWS, crop: crop, fit: fit };
};

/* ---- index.js ---- */
defs['./index'] = function (module, exports, require) {
/* The Studio's shared core in one require. See README.md. */
module.exports = {
    recipe: require('./recipe'),
    clipname: require('./clipname'),
    timeline: require('./timeline'),
    speedtrack: require('./speedtrack'),
    geometry: require('./geometry'),
    library: require('./library'),
    tsmp4: require('./tsmp4'),
    runlog: require('./runlog'),
    audio: require('./audio'),
    beats: require('./beats'),
    compose: require('./compose'),
    looks: require('./looks'),
};
};

/* ---- library.js ---- */
defs['./library'] = function (module, exports, require) {
/* What is in a folder of clips. An editor that has no library program behind it (the phone and web app, the car)
 * is handed a list of file names: this sorts them into clips, each with its video, its data file and its picture,
 * and the saved edits beside them, and groups the clips into drives.
 *
 * It knows both layouts: the PC library and a stick import ("2026-11-14 18.41.07.mp4" with .json and .jpg beside
 * it) and the car's own (a folder "14.11.2026_18_41_07_Event" holding the video and a Metadata.json). Names only:
 * no file is opened here. */

var clipname = require('./clipname');
var runlog = require('./runlog');

var MAX_FILES = 50000;
var GAP_S = 180;              /* a longer pause than this between two clips starts a new drive (as in the PC Studio) */
var VIDEO = /\.(mp4|m4v|mov|ts)$/i, RECIPE = /\.edit\.json$/i, JSON_FILE = /\.json$/i, PICTURE = /\.jpe?g$/i;

function pieces(name) { return name.replace(/[\\/]+$/, '').split(/[\\/]/); }

/* names: file names or paths, as the place lists them -> { clips: [{ clip, video, meta, picture, ts }], recipes:
 * [index], runs: [index] (Launch data logs), other: count }. video, meta and picture are indexes into names (-1 when there is none); ts says the
 * video is the car's transport stream, which a browser cannot play as it is. Clips are in time order; a clip with
 * no video is left out. */
function sort(names) {
    var list = Array.isArray(names) ? names : [], by = {}, recipes = [], runs = [], other = 0;
    var n = Math.min(list.length, MAX_FILES);
    for (var i = 0; i < n; i++) {
        var name = list[i];
        if (typeof name !== 'string' || !name || name.length > 1024) { other++; continue; }
        var parts = pieces(name), base = parts[parts.length - 1];
        if (RECIPE.test(base)) { recipes.push(i); continue; }
        if (runlog.isRunFile(base)) { runs.push(i); continue; }       /* a Launch run's data log, for the overlay */
        var kind = VIDEO.test(base) ? 'video' : JSON_FILE.test(base) ? 'meta' : PICTURE.test(base) ? 'picture' : '';
        var clip = kind ? clipname.fromAny(base) || (parts.length > 1 ? clipname.fromAny(parts[parts.length - 2]) : null) : null;
        if (!clip) { other++; continue; }
        var c = by[clip] || (by[clip] = { clip: clip, video: -1, meta: -1, picture: -1, ts: false });
        if (kind === 'video') {
            /* a clip present twice (the car's .ts and the PC's .mp4): the one a browser plays as it is wins */
            var ts = /\.ts$/i.test(base);
            if (c.video < 0 || (c.ts && !ts)) { c.video = i; c.ts = ts; }
        } else if (c[kind] < 0) c[kind] = i;
    }
    var clips = Object.keys(by).sort().map(function (k) { return by[k]; }).filter(function (c) { return c.video >= 0; });
    return { clips: clips, recipes: recipes, runs: runs, other: other + Math.max(0, list.length - n) };
}

/* clips: [{ clip, dur }] in any order -> drives, newest first: [{ id (its first clip), clips: [...] in order }].
 * A clip whose length is not known yet counts as 40 s, the car's usual clip. */
function drives(clips, gapS) {
    var gap = (typeof gapS === 'number' && gapS >= 0 ? gapS : GAP_S) * 1000;
    var list = (Array.isArray(clips) ? clips : []).filter(function (c) { return c && !isNaN(clipname.toDate(c.clip)); })
        .slice().sort(function (a, b) { return clipname.compare(a.clip, b.clip); });
    var out = [], cur = null, end = 0;
    list.forEach(function (c) {
        var at = clipname.toDate(c.clip), dur = typeof c.dur === 'number' && isFinite(c.dur) && c.dur > 0 ? c.dur : 40;
        if (!cur || at - end > gap) { cur = { id: c.clip, clips: [] }; out.push(cur); }
        cur.clips.push(c);
        end = Math.max(end, at + dur * 1000);
    });
    return out.reverse();
}

module.exports = { sort: sort, drives: drives, GAP_S: GAP_S };
};

/* ---- looks.js ---- */
defs['./looks'] = function (module, exports, require) {
/* The looks a finished clip can have: a few settings of brightness, contrast, colour and warmth, given as the
 * `filter` value a canvas (or CSS) takes. Dash cam pictures are flat and a little grey; these lift them.
 *
 *   LOOKS                    { clean, night, warm, punchy }
 *   filter(name, adjust) -> 'brightness(1.05) contrast(1.18) saturate(1.3)'
 *     adjust = { brightness, contrast, saturate } multiplies the look's own (each 0.5 to 1.5); unknown names are clean
 */
var LOOKS = {
    clean: { brightness: 1, contrast: 1.04, saturate: 1.08, warmth: 0 },
    night: { brightness: 1.14, contrast: 1.1, saturate: 0.92, warmth: 0 },
    warm: { brightness: 1.03, contrast: 1.06, saturate: 1.15, warmth: 0.14 },
    punchy: { brightness: 1.05, contrast: 1.18, saturate: 1.3, warmth: 0 },
};

function mult(v) { return typeof v === 'number' && isFinite(v) ? Math.max(0.5, Math.min(1.5, v)) : 1; }
function r2(v) { return Math.round(v * 100) / 100; }

function filter(name, adjust) {
    var l = typeof name === 'string' && Object.prototype.hasOwnProperty.call(LOOKS, name) ? LOOKS[name] : LOOKS.clean, a = adjust || {};
    var out = 'brightness(' + r2(l.brightness * mult(a.brightness)) + ') contrast(' + r2(l.contrast * mult(a.contrast)) + ') saturate(' + r2(l.saturate * mult(a.saturate)) + ')';
    return l.warmth > 0 ? out + ' sepia(' + r2(l.warmth) + ')' : out;
}

module.exports = { LOOKS: LOOKS, filter: filter };
};

/* ---- recipe.js ---- */
defs['./recipe'] = function (module, exports, require) {
/* The Studio's edit, version 1: a small recipe saved beside the clips as <name>.edit.json.
 *
 * It says which clips, where each cut starts and ends, which camera and which shape. It never holds a VIN, a
 * position, a file path or a person's name: check() copies the known keys and nothing else, on the way in and on
 * the way out, so whatever a file carries, those cannot ride along.
 *
 * Runs on the car (Node 8), in a browser and under the tests: no built-in modules, and nothing here throws on bad
 * input. The same rules are in the PC Studio's recipe.py; both are held to fixtures/recipes.json. */

var VERSION = 1;
var MAX_BYTES = 262144;       /* a recipe is a few kB; anything near this is not one */
var MAX_PARTS = 500;
var VIEWS = ['all', 'front', 'rear', 'left', 'right'];
var FORMATS = { original: [1280, 960], wide: [1920, 1080], vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080] };
var PLACES = ['car', 'phone', 'web', 'pc'];
var UNITS = ['mph', 'kmh'];
var ID = /^[a-z0-9]{4,12}$/;
var WHEN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
var LIMIT = 1e9;              /* no time, rate or length in a recipe is anywhere near this; past it, it is not a number to us */
var CLIP = /^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d$/;
var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
var MIN_PART = 0.05;          /* seconds; shorter than this is a slip of the hand, not a cut */

function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function isNum(n) { return typeof n === 'number' && isFinite(n) && Math.abs(n) <= LIMIT; }

/* a recipe's name: no control characters, no slashes (so it is never a path), at most 80 units and never cut
 * through the middle of a character (recipe.py cuts it the same way) */
function cleanName(name) {
    if (typeof name !== 'string') return 'Edit';
    var s = name.replace(/[\u0000-\u001f\\\/]/g, '').slice(0, 80).replace(/[\ud800-\udbff]$/, '');
    s = s.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '').replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
    return s || 'Edit';
}
function oneOf(list, v, dflt) { return typeof v === 'string' && list.indexOf(v) >= 0 ? v : dflt; }
function r3(x) { return Math.floor(x * 1000 + 0.5) / 1000; }

function checkPart(p, i, errors) {
    if (!isObj(p)) { errors.push('part ' + i + ' is not an object'); return null; }
    if (typeof p.clip !== 'string' || !CLIP.test(p.clip)) { errors.push('part ' + i + ' does not name a clip'); return null; }
    if (!isNum(p.t0) || !isNum(p.t1)) { errors.push('part ' + i + ' has no times'); return null; }
    var t0 = r3(Math.max(0, p.t0)), t1 = r3(p.t1);
    if (t1 - t0 < MIN_PART) { errors.push('part ' + i + ' is empty'); return null; }
    var rate = isNum(p.rate) && p.rate !== 0 ? Math.min(8, Math.max(0.1, p.rate)) : 1;
    return { clip: p.clip, t0: t0, t1: t1, view: oneOf(VIEWS, p.view, 'all'), rate: rate };
}

/* -> { ok, recipe, errors }. recipe is a clean copy (known keys only, values in range) or null. A part that cannot
 * be used is left out and named in errors; the recipe is still ok. */
function check(obj) {
    var errors = [];
    if (!isObj(obj)) return { ok: false, recipe: null, errors: ['not a recipe'] };
    if (obj.v !== VERSION) errors.push('not version ' + VERSION);
    if (typeof obj.id !== 'string' || !ID.test(obj.id)) errors.push('bad id');
    if (typeof obj.created !== 'string' || !WHEN.test(obj.created)) errors.push('bad created time');
    if (typeof obj.updated !== 'string' || !WHEN.test(obj.updated)) errors.push('bad updated time');
    if (!Array.isArray(obj.parts)) errors.push('parts is not a list');
    else if (obj.parts.length > MAX_PARTS) errors.push('more than ' + MAX_PARTS + ' parts');
    if (errors.length) return { ok: false, recipe: null, errors: errors };

    var speed = isObj(obj.speed) ? obj.speed : {};
    var parts = [];
    for (var i = 0; i < obj.parts.length; i++) {
        var p = checkPart(obj.parts[i], i, errors);
        if (p) parts.push(p);
    }
    return { ok: true, errors: errors, recipe: {
        v: VERSION,
        id: obj.id,
        name: cleanName(obj.name),
        created: obj.created,
        updated: obj.updated,
        by: oneOf(PLACES, obj.by, 'pc'),
        format: typeof obj.format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, obj.format) ? obj.format : 'original',
        fill: !!obj.fill,
        speed: { show: !!speed.show, unit: oneOf(UNITS, speed.unit, 'mph') },
        parts: parts,
    } };
}

function parse(text) {
    if (typeof text !== 'string') return { ok: false, recipe: null, errors: ['not text'] };
    if (text.length > MAX_BYTES) return { ok: false, recipe: null, errors: ['too large to be a recipe'] };
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, recipe: null, errors: ['not JSON'] }; }
    return check(obj);
}

/* '' for something that is not a recipe, so nothing invalid is ever written */
function stringify(recipe) {
    var r = check(recipe);
    return r.ok ? JSON.stringify(r.recipe, null, 1) : '';
}

function newId(rand) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', id = '';
    for (var i = 0; i < 6; i++) id += abc.charAt(Math.min(abc.length - 1, Math.max(0, Math.floor((rand ? rand() : Math.random()) * abc.length))));
    return id;
}

function create(opts, nowIso, rand) {
    var o = isObj(opts) ? opts : {};
    return check({ v: VERSION, id: newId(rand), name: o.name, created: nowIso, updated: nowIso, by: o.by, format: o.format, fill: o.fill, speed: o.speed, parts: [] }).recipe;
}

function touch(recipe, by, nowIso) {
    var r = check(recipe).recipe;
    if (!r) return null;
    r.by = oneOf(PLACES, by, r.by);
    r.updated = nowIso;
    return check(r).recipe;
}

/* a name that is safe as a file name everywhere the clips go: a stick (FAT), Windows, the car, a phone */
function safeName(name) {
    var s = typeof name === 'string' ? name : '';
    s = s.replace(/[^A-Za-z0-9 .()_-]/g, '').replace(/^[ .]+/, '').slice(0, 80).replace(/[ .]+$/, '');
    if (!s) return 'Edit';
    return RESERVED.test(s) ? s + '_' : s;
}
function fileName(recipe) { return safeName(recipe && recipe.name) + '.edit.json'; }
function conflictName(recipe) { return safeName(recipe && recipe.name) + '.conflict.edit.json'; }

/* a recipe's updated time in a form that sorts as text: one clock writes 19:00:00Z, another 19:00:00.900Z */
function whenKey(r) {
    var u = r && typeof r.updated === 'string' && WHEN.test(r.updated) ? r.updated : '';
    if (!u) return '';
    return u.slice(0, 19) + '.' + (u.length > 20 ? u.slice(20, -1) : '') + '000'.slice(u.length > 20 ? u.length - 21 : 0);
}

/* Two copies of one edit (the same id) saved in two places: the later one is kept, the other is handed back to be
 * saved beside it, never dropped. other is null when they say the same thing. */
function resolve(a, b) {
    if (stringify(a) === stringify(b)) return { keep: a, other: null };
    return whenKey(b) > whenKey(a) ? { keep: b, other: a } : { keep: a, other: b };
}

module.exports = {
    VERSION: VERSION, MAX_BYTES: MAX_BYTES, MAX_PARTS: MAX_PARTS, VIEWS: VIEWS, FORMATS: FORMATS,
    check: check, parse: parse, stringify: stringify, create: create, touch: touch,
    safeName: safeName, fileName: fileName, conflictName: conflictName, resolve: resolve,
};
};

/* ---- runlog.js ---- */
defs['./runlog'] = function (module, exports, require) {
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
};

/* ---- speedtrack.js ---- */
defs['./speedtrack'] = function (module, exports, require) {
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
};

/* ---- timeline.js ---- */
defs['./timeline'] = function (module, exports, require) {
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
};

/* ---- tsmp4.js ---- */
defs['./tsmp4'] = function (module, exports, require) {
/* The car's clips are MPEG transport streams (.ts) holding one H.264 picture stream and no sound. A browser does
 * not play those. This rewraps one as an ordinary .mp4, in memory, without touching the pictures: the same bytes
 * of video in a different container, so it is fast and loses nothing. (The PC Studio does the same with a video
 * tool when it imports.)
 *
 *   var r = tsmp4.rewrap(bytes);          bytes: a Uint8Array of the whole .ts file
 *   r -> { ok: true, mp4: Uint8Array, frames, dur (seconds), w, h, codec: 'avc1.42c028' }
 *     or { ok: false, error: 'why' }
 *
 * What it handles is what the car writes: one video stream, H.264, pictures in the order they are shown. A stream
 * with reordered pictures still comes out playable in order of decoding, with the shown times kept as offsets.
 * Sound, a second video stream and encrypted streams are not handled; they give ok: false or are left out.
 * Never throws. No built-in modules: runs on the car's Node 8 and in a browser alike. */

var PACKET = 188, SYNC = 0x47, CLOCK = 90000;
var MAX_FRAMES = 200000;      /* three hours at 15 a second; past that this is not one of the car's clips */

/* ---------------------------------------------------------------- reading the transport stream */

function findStart(b) {
    for (var i = 0; i < Math.min(b.length - 2 * PACKET, 4 * PACKET); i++) if (b[i] === SYNC && b[i + PACKET] === SYNC && b[i + 2 * PACKET] === SYNC) return i;
    return -1;
}

/* the payload of one packet -> [start, end) inside b, or null when it has none */
function payloadOf(b, p) {
    var afc = (b[p + 3] >> 4) & 3, at = p + 4;
    if (afc === 0 || afc === 2) return null;
    if (afc === 3) at += 1 + b[p + 4];
    return at < p + PACKET ? [at, p + PACKET] : null;
}

/* the first H.264 stream's packet id, from the programme tables; -1 when they do not name one */
function videoPid(b, start) {
    var pmt = -1, limit = Math.min(b.length - PACKET + 1, start + 20000 * PACKET);
    for (var p = start; p < limit; p += PACKET) {
        if (b[p] !== SYNC || !(b[p + 1] & 0x40)) continue;
        var pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2], pl = payloadOf(b, p);
        if (!pl) continue;
        var s = pl[0] + 1 + b[pl[0]];                       /* past the pointer field */
        if (s + 12 > pl[1]) continue;
        var len = ((b[s + 1] & 0x0f) << 8) | b[s + 2], end = Math.min(pl[1], s + 3 + len - 4), i;
        if (pid === 0 && b[s] === 0x00 && pmt < 0) {
            for (i = s + 8; i + 4 <= end; i += 4) if (((b[i] << 8) | b[i + 1]) !== 0) { pmt = ((b[i + 2] & 0x1f) << 8) | b[i + 3]; break; }
        } else if (pid === pmt && b[s] === 0x02) {
            i = s + 12 + (((b[s + 10] & 0x0f) << 8) | b[s + 11]);
            while (i + 5 <= end) {
                if (b[i] === 0x1b) return ((b[i + 1] & 0x1f) << 8) | b[i + 2];
                i += 5 + (((b[i + 3] & 0x0f) << 8) | b[i + 4]);
            }
            return -1;
        }
    }
    return -1;
}

/* a 33-bit time stamp from five bytes of a packet header, in 90 kHz ticks */
function stamp(b, i) {
    return (b[i] & 0x0e) * 536870912 + (((b[i + 1] << 8) | b[i + 2]) >> 1) * 32768 + (((b[i + 3] << 8) | b[i + 4]) >> 1);
}

/* the stream's pictures: [{ pts, dts, chunks: [[start, end)...] }] with chunks pointing into b */
function pictures(b, start, pid) {
    var out = [], cur = null;
    for (var p = start; p + PACKET <= b.length; p += PACKET) {
        if (b[p] !== SYNC) {                                 /* lost the rhythm: find it again */
            var again = -1;
            for (var q = p + 1; q + PACKET < b.length && q < p + 4 * PACKET; q++) if (b[q] === SYNC && b[q + PACKET] === SYNC) { again = q; break; }
            if (again < 0) break;
            p = again - PACKET;
            continue;
        }
        if ((((b[p + 1] & 0x1f) << 8) | b[p + 2]) !== pid) continue;
        if (b[p + 3] & 0xc0) return null;                    /* scrambled */
        var pl = payloadOf(b, p);
        if (!pl) continue;
        var at = pl[0];
        if (b[p + 1] & 0x40) {                               /* a new picture starts in this packet */
            if (at + 9 > pl[1] || b[at] !== 0 || b[at + 1] !== 0 || b[at + 2] !== 1) { cur = null; continue; }
            var flags = b[at + 7], hlen = b[at + 8], pts = -1, dts = -1;
            if ((flags & 0x80) && at + 14 <= pl[1]) pts = stamp(b, at + 9);
            if ((flags & 0x40) && at + 19 <= pl[1]) dts = stamp(b, at + 14);
            cur = { pts: pts, dts: dts < 0 ? pts : dts, chunks: [] };
            out.push(cur);
            if (out.length > MAX_FRAMES) return null;
            at += 9 + hlen;
        }
        if (cur && at < pl[1]) cur.chunks.push([at, pl[1]]);
    }
    return out;
}

/* ---------------------------------------------------------------- reading the H.264 inside */

function join(b, chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i][1] - chunks[i][0];
    var out = new Uint8Array(n), at = 0;
    for (i = 0; i < chunks.length; i++) { out.set(b.subarray(chunks[i][0], chunks[i][1]), at); at += chunks[i][1] - chunks[i][0]; }
    return out;
}

/* the units of one picture (split at the 00 00 01 marks) -> [[start, end)...] inside d */
function units(d) {
    var out = [], from = -1, n = d.length;
    for (var i = 0; i + 2 < n; i++) {
        if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 1) continue;
        if (from >= 0) { var e = i; while (e > from && d[e - 1] === 0) e--; if (e > from) out.push([from, e]); }
        from = i + 3;
        i += 2;
    }
    if (from >= 0 && from < n) { var end = n; while (end > from && d[end - 1] === 0) end--; if (end > from) out.push([from, end]); }
    return out;
}

function Bits(d) { this.d = d; this.at = 0; }
Bits.prototype.bit = function () { var v = this.at < this.d.length * 8 ? (this.d[this.at >> 3] >> (7 - (this.at & 7))) & 1 : 0; this.at++; return v; };
Bits.prototype.bits = function (n) { var v = 0; for (var i = 0; i < n; i++) v = v * 2 + this.bit(); return v; };
Bits.prototype.ue = function () { var z = 0; while (z < 32 && this.bit() === 0) z++; return z >= 32 ? 0 : Math.pow(2, z) - 1 + this.bits(z); };
Bits.prototype.se = function () { var v = this.ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };

/* the picture's size, from the stream's parameter set */
function sizeOf(sps) {
    var raw = [], i;
    for (i = 0; i < sps.length; i++) { if (i >= 2 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue; raw.push(sps[i]); }
    var r = new Bits(raw);
    r.bits(8);
    var profile = r.bits(8), chroma = 1;
    r.bits(16); r.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
        chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue(); r.ue(); r.bit();
        if (r.bit()) {
            for (i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (!r.bit()) continue;
                var last = 8, next = 8, size = i < 6 ? 16 : 64;
                for (var j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
            }
        }
    }
    r.ue();
    var poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.bit(); r.se(); r.se(); var n = r.ue(); for (i = 0; i < n && i < 256; i++) r.se(); }
    r.ue(); r.bit();
    var wMbs = r.ue() + 1, hUnits = r.ue() + 1, frameOnly = r.bit();
    if (!frameOnly) r.bit();
    r.bit();
    var cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    var ux = chroma === 0 || chroma === 3 ? 1 : 2, uy = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
    return { w: wMbs * 16 - ux * (cl + cr), h: (2 - frameOnly) * hUnits * 16 - uy * (ct + cb) };
}

/* ---------------------------------------------------------------- writing the .mp4 */

function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >> 8) & 255, n & 255]; }
function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
function chars(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 255); return a; }

/* a box: its size, its four-letter type, then its parts (arrays of bytes or Uint8Arrays) */
function box(type) {
    var parts = Array.prototype.slice.call(arguments, 1), n = 8, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), at = 8;
    out.set(u32(n), 0); out.set(chars(type), 4);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
}
var MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

function moov(o, mdatAt) {
    var n = o.sizes.length, i;
    /* durations, run-length coded */
    var runs = [];
    for (i = 0; i < n; i++) { if (runs.length && runs[runs.length - 1][1] === o.durs[i]) runs[runs.length - 1][0]++; else runs.push([1, o.durs[i]]); }
    var stts = [].concat(u32(0), u32(runs.length));
    runs.forEach(function (r) { stts = stts.concat(u32(r[0]), u32(r[1])); });
    var stsz = new Uint8Array(12 + 4 * n);
    stsz.set(u32(n), 8);
    for (i = 0; i < n; i++) stsz.set(u32(o.sizes[i]), 12 + 4 * i);
    var stss = new Uint8Array(8 + 4 * o.keys.length);
    stss.set(u32(o.keys.length), 4);
    for (i = 0; i < o.keys.length; i++) stss.set(u32(o.keys[i] + 1), 8 + 4 * i);
    var tables = [box('stts', stts)];
    if (o.shifts) {                                           /* shown later than decoded: reordered pictures */
        var ctts = new Uint8Array(8 + 8 * n);
        ctts.set(u32(n), 4);
        for (i = 0; i < n; i++) { ctts.set(u32(1), 8 + 8 * i); ctts.set(u32(o.shifts[i]), 12 + 8 * i); }
        tables.push(box('ctts', ctts));
    }
    if (o.keys.length && o.keys.length < n) tables.push(box('stss', stss));
    tables.push(box('stsc', [].concat(u32(0), u32(1), u32(1), u32(n), u32(1))), box('stsz', stsz), box('stco', [].concat(u32(0), u32(1), u32(mdatAt))));

    var avcC = box('avcC', [1, o.sps[1], o.sps[2], o.sps[3], 0xff, 0xe1].concat(u16(o.sps.length)), o.sps, [1].concat(u16(o.pps.length)), o.pps);
    var avc1 = box('avc1', [].concat(zeros(6), u16(1), zeros(16), u16(o.w), u16(o.h), u32(0x480000), u32(0x480000), zeros(4), u16(1), zeros(32), u16(0x18), [255, 255]), avcC);
    var stbl = box.apply(null, ['stbl', box('stsd', [].concat(u32(0), u32(1)), avc1)].concat(tables));
    var minf = box('minf', box('vmhd', [].concat(u32(1), zeros(8))), box('dinf', box('dref', [].concat(u32(0), u32(1)), box('url ', u32(1)))), stbl);
    var mdia = box('mdia', box('mdhd', [].concat(u32(0), u32(0), u32(0), u32(CLOCK), u32(o.total), [0x55, 0xc4, 0, 0])),
        box('hdlr', [].concat(u32(0), u32(0), chars('vide'), zeros(12), chars('Video'), [0])), minf);
    var tkhd = box('tkhd', [].concat(u32(7), u32(0), u32(0), u32(1), u32(0), u32(o.total), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(o.w * 65536), u32(o.h * 65536)));
    var mvhd = box('mvhd', [].concat(u32(0), u32(0), u32(0), u32(CLOCK), u32(o.total), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)));
    return box('moov', mvhd, box('trak', tkhd, mdia));
}

function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

function work(b) {
    if (!b || typeof b.length !== 'number' || typeof b.subarray !== 'function') return { ok: false, error: 'not a file' };
    var start = findStart(b);
    if (start < 0) return { ok: false, error: 'not a transport stream' };
    var pid = videoPid(b, start);
    if (pid < 0) return { ok: false, error: 'no H.264 video in it' };
    var pics = pictures(b, start, pid);
    if (!pics) return { ok: false, error: 'the stream is scrambled or far too long' };

    var sps = null, pps = null, samples = [], total = 0, i, j;
    for (i = 0; i < pics.length; i++) {
        var d = join(b, pics[i].chunks), list = units(d), keep = [], size = 0, key = false;
        for (j = 0; j < list.length; j++) {
            var type = d[list[j][0]] & 0x1f;
            if (type === 7) { if (!sps) sps = d.slice ? d.slice(list[j][0], list[j][1]) : new Uint8Array(d.subarray(list[j][0], list[j][1])); continue; }
            if (type === 8) { if (!pps) pps = d.slice ? d.slice(list[j][0], list[j][1]) : new Uint8Array(d.subarray(list[j][0], list[j][1])); continue; }
            if (type === 9 || type === 12 || type === 0 || type > 23) continue;      /* delimiters, filler, and what is not H.264's own */
            if (type === 5) key = true;
            if (type === 1 || type === 5 || keep.length || type === 6) { keep.push(list[j]); size += 4 + list[j][1] - list[j][0]; }
        }
        if (!keep.some(function (u) { var t = d[u[0]] & 0x1f; return t === 1 || t === 5; })) continue;      /* no picture in it */
        if (!sps || !pps || (!samples.length && !key)) continue;          /* nothing can be shown before the first whole picture */
        samples.push({ d: d, units: keep, size: size, key: key, pts: pics[i].pts, dts: pics[i].dts });
        total += size;
    }
    if (!samples.length) return { ok: false, error: 'no pictures found' };
    if (sps.length < 4) return { ok: false, error: 'the stream describes itself badly' };
    var dim = sizeOf(sps);
    if (!(dim.w >= 16 && dim.w <= 8192 && dim.h >= 16 && dim.h <= 8192)) return { ok: false, error: 'the picture size makes no sense' };

    /* how long each picture stays up: the gap to the next one, and for the last, the usual gap */
    var n = samples.length, durs = [], sum = 0, usual = 6000, shifts = null;
    for (i = 0; i < n - 1; i++) {
        var gap = samples[i + 1].dts - samples[i].dts;
        if (samples[i].dts < 0 || samples[i + 1].dts < 0 || gap <= 0 || gap > CLOCK * 10) gap = usual; else usual = gap;
        durs.push(gap); sum += gap;
    }
    durs.push(usual); sum += usual;
    for (i = 0; i < n; i++) if (samples[i].pts >= 0 && samples[i].dts >= 0 && samples[i].pts !== samples[i].dts) { shifts = []; break; }
    if (shifts) for (i = 0; i < n; i++) shifts.push(Math.max(0, Math.min(CLOCK * 10, samples[i].pts - samples[i].dts)));

    var o = { sps: sps, pps: pps, w: dim.w, h: dim.h, total: sum, durs: durs, shifts: shifts,
        sizes: samples.map(function (s) { return s.size; }), keys: [] };
    for (i = 0; i < n; i++) if (samples[i].key) o.keys.push(i);
    var ftyp = box('ftyp', chars('isom'), u32(0x200), chars('isomiso2avc1mp41'));
    var head = moov(o, 0), mdatAt = ftyp.length + head.length + 8;
    if (mdatAt + total > 0xfffffff0) return { ok: false, error: 'too large to rewrap in one piece' };
    head = moov(o, mdatAt);
    var out = new Uint8Array(mdatAt + total), at = mdatAt;
    out.set(ftyp, 0); out.set(head, ftyp.length);
    out.set(u32(total + 8), ftyp.length + head.length); out.set(chars('mdat'), ftyp.length + head.length + 4);
    for (i = 0; i < n; i++) {
        for (j = 0; j < samples[i].units.length; j++) {
            var u = samples[i].units[j], len = u[1] - u[0];
            out.set(u32(len), at); out.set(samples[i].d.subarray(u[0], u[1]), at + 4);
            at += 4 + len;
        }
        samples[i].d = null;
    }
    return { ok: true, mp4: out, frames: n, dur: sum / CLOCK, w: dim.w, h: dim.h, codec: 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]) };
}

function rewrap(bytes) {
    try { return work(bytes); } catch (e) { return { ok: false, error: 'could not be read (' + (e && e.message ? e.message : e) + ')' }; }
}

module.exports = { rewrap: rewrap };
};

root.StudioCore = need('./index');
})(typeof self !== 'undefined' ? self : this);
