'use strict';
/**
 * screens.js - the tree and the run's key numbers on the instrument cluster and the head-up display.
 *
 * Two small image layers through cluster-render, one per target, plus a third tiny one on the HUD that is
 * only ever shown or hidden: the shift flash. Pictures, never shaders.
 *
 *   panel (cluster) the middle of the whole instrument cluster, between the dials (draw.js PANEL_STAGE): the
 *                   CLUSTER picture shown larger, and under it a strip that comes up for three seconds as each
 *                   split is passed (green when it beats the best on file). Two small layers, class overlay,
 *                   never exclusive and never the size of the panel: a full-size layer makes the car drop its
 *                   own cluster picture. The car's speed, revs, gear and lamps stay where they are.
 *                   Setting "On the cluster" = whole cluster: a third layer under those two that IS the size
 *                   of the panel down to the gear strip (draw.js backdrop, a small picture shown stretched). The car then takes its
 *                   own dials away for as long as it is up and keeps only the gear, PARK and belt lamps on
 *                   top; it puts its picture back when the layer is dropped. Off unless chosen. With it come
 *                   two small gauges of our own where the dials were: speed on the left, gear and revs on
 *                   the right (draw.js wingSpeed / wingRevs).
 *   hud             HUD box, inside the slot the car's own HUD content leaves clear in every view.
 *                   yield 0: it stays up when one of the car's own list pop-ups opens (the roller press that
 *                   arms the tree can open one).
 *
 * The upload budget is shared between every app that draws there (about 5500 KB/s), so the pictures are small
 * (263 KB and 213 KB a frame) and slow: at most 3 a second on the cluster and 5 on the HUD while a run is
 * timed, and only on a change otherwise (the tree is 5 or 6 frames in all). The shift flash sends no pixels:
 * its layer is one red bar whose visibility is switched.
 *
 *   const r = new Remote(ctx, 'woodr_launch');
 *   r.start();
 *   r.update(state, nowMs);     state as draw.js hud() / cluster() take it, or null to take everything down
 *   r.flash(on);                the shift flash, while a run shows
 *   r.status()                  { available, hud, map } for the log and the centre screen
 *   r.stop();
 */
const D = require('./draw');
const { Canvas } = require('./kit/canvas');
const { HudClaim } = require('./kit/hud_claim');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported by start() */ }

const HUD_MS = 200, MAP_MS = 334;      /* the least time between two pictures of a run */
const POP_MS = 3000;                   /* how long a split's pop-up stays on the cluster */
const BACK_MS = { run: 167, tree: 250, done: 334 };      /* the whole-cluster backdrop: the least time between two pictures */
const WING_MS = 300;                   /* the whole cluster's own gauges: the least time between two pictures of one */
const BACK_RETRY_MS = 5000;            /* after the renderer refused the backdrop, how long before it is asked again */

class Remote {
    constructor(ctx, appId) {
        this.ctx = ctx; this.log = ctx.log; this.id = appId;
        this.cr = null; this.available = false;
        this.t = {
            hud: { name: 'hud', box: D.HUD, draw: D.hud, every: HUD_MS, layer: 0, key: '', at: 0, cv: null, state: '' },
            map: { name: 'map', box: D.CLUSTER, draw: D.cluster, every: MAP_MS, layer: 0, key: '', at: 0, cv: null, state: '' },
        };
        this.flashLayer = 0; this.flashOn = false;
        this.pop = { layer: 0, key: '', until: 0, on: false, cv: null };
        this.back = { layer: 0, cv: null, at: 0, phase: 0, refused: 0 };
        this.wings = [{ at: D.PANEL_WING_L, draw: D.wingSpeed, keyOf: D.wingSpeedKey, layer: 0, key: '', sent: 0, cv: null },
            { at: D.PANEL_WING_R, draw: D.wingRevs, keyOf: D.wingRevsKey, layer: 0, key: '', sent: 0, cv: null }];
        this.claim = new HudClaim(appId, ctx.log);
    }

    start() {
        if (!ClusterRender) { this.log.warn('screens: cluster_render_client missing'); return false; }
        try {
            this.cr = new ClusterRender(this.id);
            this.cr.on('ready', () => { try { this.available = true; this.t.hud.key = ''; this.t.map.key = ''; this.log.info('screens: cluster-render up (targets ' + this.cr.targets + ')'); } catch (e) { this.log.warn('screens ready: ' + e); } });
            this.cr.on('disconnected', () => { this.available = false; });
            this.cr.on('layer', (ref, state, why) => {
                try {
                    const which = ref === this.t.hud.layer ? 'hud' : ref === this.t.map.layer ? 'map' : ref === this.flashLayer ? 'flash' : ref === this.pop.layer ? 'pop-up' : ref === this.back.layer ? 'backdrop' : '';
                    if (!which) return;
                    if (this.t[which]) this.t[which].state = state;
                    this.log.info('screens: ' + which + ' layer ' + state + (why ? ' (' + why + ')' : ''));
                } catch (e) { this.log.warn('screens layer: ' + e); }
            });
            this.cr.on('target', (name, state, holder, why, guideDisabled, disabled) => {
                try { if (disabled) this.log.warn('screens: target ' + name + ' disabled by the mapping guard'); } catch (e) { /* log only */ }
            });
            this.cr.on('refused', (op, ref, why) => { try { this.log.warn('screens: refused ' + op + ': ' + why); } catch (e) { /* log only */ } });
            this.cr.on('error', (e) => { try { this.log.warn('screens: ' + e); } catch (x) { /* log only */ } });
            this.cr.connect();
            return true;
        } catch (e) { this.log.warn('screens start: ' + e); this.cr = null; return false; }
    }

    _wanted(name) {
        const s = this.ctx.settings.get('screens');
        if (s === 'centre') return false;
        return s === name || s === 'all' || s === undefined || (name === 'map' && s === 'cluster');
    }

    _drop(t) {
        if (t.layer && this.cr) { try { this.cr.drop(t.layer); } catch (e) { this.log.warn('screens drop: ' + e); } }
        t.layer = 0; t.key = ''; t.state = '';
        if (t.name === 'map') {
            if (this.pop.layer && this.cr) { try { this.cr.drop(this.pop.layer); } catch (e) { /* going */ } }
            this.pop.layer = 0; this.pop.key = ''; this.pop.on = false;
            this._dropBack();
        }
        if (t.name === 'hud') {
            if (this.flashLayer && this.cr) { try { this.cr.drop(this.flashLayer); } catch (e) { /* going */ } }
            this.flashLayer = 0; this.flashOn = false;
            try { this.claim.hold(false); } catch (e) { /* tmpfs */ }
        }
    }

    _make(t) {
        const b = t.box, hud = t.name === 'hud', at = hud ? b : D.PANEL_MAIN;
        t.layer = this.cr.image({
            target: hud ? 'hud' : 'panel', klass: 'overlay', z: hud ? 6 : 50,
            x: at.x, y: at.y, w: at.w, h: at.h, iw: b.w, ih: b.h,
            fps: hud ? 5 : 3, sampling: 'bilinear', visible: true, opacity: 1,
            yield: hud ? 0 : undefined,
        });
        if (!t.layer) { this.log.warn('screens: ' + t.name + ' layer refused'); return false; }
        if (!t.cv) t.cv = new Canvas(b.w, b.h);
        if (!hud) {
            /* the split pop-up: made with the main picture, hidden until a split is passed */
            const p = D.PANEL_POP;
            this.pop.layer = this.cr.image({ target: 'panel', klass: 'overlay', z: 51, x: p.x, y: p.y, w: p.w, h: p.h, iw: D.POP.w, ih: D.POP.h, fps: 2, sampling: 'bilinear', visible: false });
            this.pop.key = ''; this.pop.on = false;
            if (!this.pop.layer) this.log.warn('screens: pop-up layer refused');
            else if (!this.pop.cv) this.pop.cv = new Canvas(D.POP.w, D.POP.h);
        }
        if (hud) {
            try { this.claim.hold(true); } catch (e) { /* tmpfs */ }
            const f = D.FLASH;
            this.flashLayer = this.cr.image({ target: 'hud', klass: 'overlay', z: 7, yield: 0, x: f.x, y: f.y, w: f.w, h: f.h, iw: 8, ih: 2, fps: 1, sampling: 'nearest', visible: false });
            this.flashOn = false;
            if (this.flashLayer) {
                const bar = new Canvas(8, 2).clear(D.RED);
                this.cr.pixels(this.flashLayer, null, Buffer.from(bar.d.buffer, bar.d.byteOffset, bar.d.length));
            } else this.log.warn('screens: shift flash layer refused');
        }
        return true;
    }

    /** s: what to show (draw.js), or null for nothing. now: ms on any steady clock. */
    update(s, now) {
        if (!this.cr) return;
        ['hud', 'map'].forEach((name) => {
            const t = this.t[name];
            try {
                if (!s || !this._wanted(name) || !this.available) { if (t.layer) this._drop(t); return; }
                if (!t.layer && !this._make(t)) return;
                /* the tree and the result change rarely and must show at once; a run's numbers are paced */
                const L = s.lights || {}, bare = name === 'map' && this._whole();
                const still = (bare ? 'b' : '') + s.phase + '|' + (L.ambers || []).join('') + L.green + L.red + '|' + (s.phase === 'done' ? (s.headline ? s.headline.s : '') + s.at : '');
                if (s.phase === 'run') { if (still === t.key && now - t.at < t.every) return; } else if (still === t.key) return;
                t.key = still; t.at = now;
                t.draw(t.cv, name === 'hud' ? Object.assign({}, s, { shift: s.shift && !!this.flashLayer ? 'under' : s.shift }) : bare ? Object.assign({}, s, { bare: true }) : s);
                if (!this.cr.pixels(t.layer, null, Buffer.from(t.cv.d.buffer, t.cv.d.byteOffset, t.cv.d.length))) this.log.warn('screens: ' + name + ' pixels refused');
            } catch (e) { this.log.warn('screens ' + name + ': ' + e); }
        });
        try { this._pop(s, now); } catch (e) { this.log.warn('screens pop-up: ' + e); }
        try { this._back(s, now); } catch (e) { this.log.warn('screens backdrop: ' + e); }
    }

    _whole() { return this.ctx.settings.get('clusterLook') === 'whole'; }

    _dropBack() {
        const b = this.back;
        if (b.layer && this.cr) { try { this.cr.drop(b.layer); this.log.info('screens: whole-cluster backdrop taken down'); } catch (e) { this.log.warn('screens drop: ' + e); } }
        b.layer = 0; b.at = 0;
        this.wings.forEach((w) => { if (w.layer && this.cr) { try { this.cr.drop(w.layer); } catch (e) { /* going */ } } w.layer = 0; w.key = ''; });
    }

    /* the whole cluster's own gauges, where the car's dials were: up with the backdrop while the tree and the run show */
    _wings(s, now) {
        const on = !!this.back.layer && (s.phase === 'tree' || s.phase === 'run');
        this.wings.forEach((w) => {
            if (!on) { if (w.layer) { try { this.cr.drop(w.layer); } catch (e) { /* going */ } w.layer = 0; w.key = ''; } return; }
            if (!w.layer) {
                w.layer = this.cr.image({ target: 'panel', klass: 'overlay', z: 50, x: w.at.x, y: w.at.y, w: w.at.w, h: w.at.h, iw: D.WING.w, ih: D.WING.h, fps: 4, sampling: 'bilinear', visible: true, opacity: 1 });
                if (!w.layer) return;                  /* the backdrop and the run still show; asked again on the next picture */
                w.key = ''; w.sent = 0;
                if (!w.cv) w.cv = new Canvas(D.WING.w, D.WING.h);
            }
            const key = w.keyOf(s);
            if (key === w.key || now - w.sent < WING_MS) return;
            w.draw(w.cv, s);
            if (this.cr.pixels(w.layer, null, Buffer.from(w.cv.d.buffer, w.cv.d.byteOffset, w.cv.d.length))) { w.key = key; w.sent = now; }
        });
    }

    /* the whole-cluster backdrop: only while the run's own picture is up on the cluster, and only when chosen */
    _back(s, now) {
        const b = this.back;
        if (!s || !this.cr || !this.t.map.layer || !this._whole()) { if (b.layer) this._dropBack(); return; }
        if (!b.layer) {
            if (b.refused && now - b.refused < BACK_RETRY_MS) return;
            const P = D.PANEL_BACK;
            b.layer = this.cr.image({ target: 'panel', klass: 'overlay', z: 49, x: P.x, y: P.y, w: P.w, h: P.h, iw: D.BACK.w, ih: D.BACK.h, fps: 8, sampling: 'bilinear', visible: true, opacity: 1 });
            if (!b.layer) { b.refused = now; this.log.warn('screens: whole-cluster backdrop refused'); return; }
            b.refused = 0; b.at = 0;
            if (!b.cv) b.cv = new Canvas(D.BACK.w, D.BACK.h);
            this.log.info('screens: whole-cluster backdrop up (' + D.BACK.w + 'x' + D.BACK.h + ' shown ' + P.w + 'x' + P.h + ')');
        }
        try { this._wings(s, now); } catch (e) { this.log.warn('screens gauges: ' + e); }
        const every = BACK_MS[s.phase] || BACK_MS.done;
        if (b.at && now - b.at < every) return;
        const dt = b.at ? Math.max(0, Math.min(0.5, (now - b.at) / 1000)) : 0;
        const kmh = typeof s.kmh === 'number' && isFinite(s.kmh) ? Math.max(0, s.kmh) : 0;
        /* rings a second: slow while waiting, with the speed in a run, never so fast that they seem to run backwards */
        const rate = s.phase === 'run' ? Math.min(3, 0.8 + kmh / 50) : s.phase === 'tree' ? 0.5 : 0.25;
        b.phase = (b.phase + dt * rate) % D.RINGS; b.at = now;
        const hot = !!s.red || !!(s.lights && s.lights.red) || (s.phase === 'run' && typeof s.rpm === 'number' && typeof s.shiftRpm === 'number' && s.rpm >= s.shiftRpm);
        D.backdrop(b.cv, { phase: b.phase, hot: hot });
        if (!this.cr.pixels(b.layer, null, Buffer.from(b.cv.d.buffer, b.cv.d.byteOffset, b.cv.d.length))) this.log.warn('screens: backdrop pixels refused');
    }

    /* the split pop-up: up when a new split is passed, down three seconds later or when the run is over */
    _pop(s, now) {
        const p = this.pop;
        if (!p.layer || !this.cr) return;
        const last = s && s.phase === 'run' && s.last && typeof s.last.s === 'number' ? s.last : null;
        const key = last ? last.key + '|' + last.s : '';
        if (key && key !== p.key) {
            p.key = key; p.until = now + POP_MS;
            D.pop(p.cv, { label: last.label, s: last.s, at: s.lastAt || '', best: !!s.lastBest, bare: this._whole() });
            if (!this.cr.pixels(p.layer, null, Buffer.from(p.cv.d.buffer, p.cv.d.byteOffset, p.cv.d.length))) this.log.warn('screens: pop-up pixels refused');
            if (!p.on) { this.cr.set(p.layer, { visible: true }); p.on = true; }
            return;
        }
        if (p.on && (!key || now >= p.until)) { this.cr.set(p.layer, { visible: false }); p.on = false; }
        if (!key) p.key = '';
    }

    flash(on) {
        try {
            if (!this.cr || !this.flashLayer || !!on === this.flashOn) return;
            this.flashOn = !!on;
            this.cr.set(this.flashLayer, { visible: this.flashOn });
        } catch (e) { this.log.warn('screens flash: ' + e); }
    }

    status() { return { available: this.available, hud: this.t.hud.layer ? this.t.hud.state || 'asked' : 'off', map: this.t.map.layer ? this.t.map.state || 'asked' : 'off' }; }

    stop() {
        try { this._drop(this.t.hud); this._drop(this.t.map); } catch (e) { /* going */ }
        if (this.cr) { try { this.cr.removeAllListeners(); this.cr.close(); } catch (e) { /* going */ } this.cr = null; }
    }
}

module.exports = { Remote: Remote };
