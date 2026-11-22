'use strict';
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
