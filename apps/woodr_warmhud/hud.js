'use strict';
/**
 * The head-up display side of Warm-Up HUD.
 *
 * One image layer on cluster-render's 'hud' target. The target is an 800x480 scene; only
 * HUD_WINDOW of it is actually visible through the windshield, so the readout is placed inside
 * that. A picture, never a shader: the cluster's renderer runs the HUD's shaders and a heavy one
 * has restarted the cluster on car (see redline/hud.js).
 *
 * Night maps and HUD reflection both want near-black backgrounds - anything not drawn stays
 * transparent glass, so we draw glyphs and a bar, nothing else.
 */
const { Canvas } = require('./kit/canvas');
const { HudClaim } = require('./kit/hud_claim');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported by start() */ }

const SCENE_W = 800, SCENE_H = 480;
/* the part of the scene the driver actually sees - measured on THIS car from Screen Lab photos
 * (top/bottom/left match bimmer-lab's 120,100 485x278; the right edge reaches ~690, not 605) */
const HUD_WINDOW = { x: 120, y: 100, w: 570, h: 278 };
/* BMW's own HUD content, seen in the same photos (scene px, approximate):
 *   every view: speed limit + speed, bottom-left  x 120-340, y 318-378
 *   M view:     rev band across the top           x 120-690, y 105-182
 *               its diagonal down the left        x 120-215, y 105-245
 * SLOT is what is left clear in every view, so placement needs no idea which view is on. */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };
const IW = 400, IH = 120;
const FPS = 5;                       /* warm-up moves slowly; no reason to burn cluster bandwidth */

const COLD = '#ff9d3b', WARM = '#ffd34d', READY = '#2fd27a', DIM = '#8a8a8a', TEXT = '#ffffff';

const num = (v) => typeof v === 'number' && isFinite(v);

/** oil progress for the bar and its colour; also used by the centre screen */
function state(oil, readyAt) {
    if (!num(oil)) return { key: 'none', label: 'OIL --', colour: DIM, frac: 0 };
    if (oil < 50) return { key: 'cold', label: 'COLD', colour: COLD, frac: Math.max(0, (oil + 10) / (readyAt + 10)) };
    if (oil < readyAt) return { key: 'warm', label: 'WARMING', colour: WARM, frac: (oil + 10) / (readyAt + 10) };
    return { key: 'ready', label: 'READY', colour: READY, frac: 1 };
}

/** A safe ceiling while the oil is cold - deliberately conservative, not a BMW figure. */
function revCeiling(oil, readyAt) {
    if (!num(oil) || oil >= readyAt) return null;
    if (oil < 30) return 3000;
    if (oil < 50) return 4000;
    if (oil < 70) return 5000;
    return 6000;
}

const CORNER = { FLH: 'FL', FRH: 'FR', RLH: 'RL', RRH: 'RR' };

/** tyre pressure in the chosen unit */
const { shownUnits, presText } = require('./tyres');
function pres(bar, unit) { return presText(bar, unit); }

/** stage 4 (coldest tyre warming) and the anytime pressure warning */
function drawTyres(cv, ph, d, opts, deg) {
    const ty = d.tyres || {};
    if (ph === 'pressure') {
        const lo = ty.low;
        cv.text('TYRE', 8, 34, 22, DIM, { font: 'bold' });
        cv.text(CORNER[lo.corner] + ' ' + pres(lo.p, opts.pressureUnit), 90, 40, 40, COLD, { font: 'bold' });
        cv.text('LOW', IW - 8, 36, 26, COLD, { font: 'bold', align: 'right' });
        cv.roundRect(8, 58, IW - 16, 12, 6, COLD);
        cv.text('target ' + pres(lo.target, opts.pressureUnit) + ' - check it', 8, 100, 24, WARM);
        return;
    }
    const v = ty.minT, ready = opts.tyreReady;
    const done = num(v) && v >= ready;
    const colour = done ? READY : !num(v) ? DIM : v < ready - 15 ? COLD : WARM;
    const frac = !num(v) ? 0 : Math.max(0, Math.min(1, (v + 10) / (ready + 10)));
    cv.text('TYRES', 8, 34, 22, DIM, { font: 'bold' });
    cv.text(deg(v), 100, 40, 44, colour, { font: 'bold' });
    cv.text(done ? 'READY' : !num(v) ? 'WAITING' : 'COLD', IW - 8, 36, 26, colour, { font: 'bold', align: 'right' });
    cv.roundRect(8, 58, IW - 16, 12, 6, '#2a2a2a');
    if (frac > 0) cv.roundRect(8, 58, Math.max(12, frac * (IW - 16)), 12, 6, colour);
    cv.text(num(v) ? 'coldest ' + CORNER[ty.minCorner] + ' - easy on grip' : 'reading the tyres', 8, 100, 24, num(v) ? WARM : DIM);
    cv.text('OIL+TRANS OK', IW - 8, 100, 22, READY, { align: 'right' });
}

/** one readout: phase is 'oil', 'trans' or 'ready' (both done, counting down to off) */
function draw(cv, ph, d, opts) {
    cv.clear('#000000');                                  /* black reads as clear glass on a HUD */
    const f = opts.tempUnit === 'f';
    const deg = (c) => (num(c) ? Math.round(f ? c * 9 / 5 + 32 : c) + (f ? 'F' : 'C') : '--');
    if (ph === 'tyres' || ph === 'pressure') return drawTyres(cv, ph, d, opts, deg);
    const isOil = ph !== 'trans';
    const v = isOil ? d.oil : d.trans, ready = isOil ? opts.readyAt : opts.transReady;
    const done = ph === 'ready' || (num(v) && v >= ready);
    const colour = done ? READY : !num(v) ? DIM : v < ready - 30 ? COLD : WARM;
    const frac = !num(v) ? 0 : Math.max(0, Math.min(1, (v + 10) / (ready + 10)));

    cv.text(isOil ? 'OIL' : 'TRANS', 8, 34, 22, DIM, { font: 'bold' });
    cv.text(deg(v), isOil ? 70 : 100, 40, 44, colour, { font: 'bold' });
    cv.text(done ? 'READY' : !num(v) ? 'WAITING' : 'WARMING', IW - 8, 36, 26, colour, { font: 'bold', align: 'right' });

    const bx = 8, by = 58, bw = IW - 16, bh = 12;
    cv.roundRect(bx, by, bw, bh, 6, '#2a2a2a');
    if (frac > 0) cv.roundRect(bx, by, Math.max(bh, frac * bw), bh, 6, colour);

    if (ph === 'oil') {
        const ceil = revCeiling(d.oil, opts.readyAt);
        cv.text(ceil !== null ? 'keep under ' + ceil + ' rpm' : 'waiting for the engine', 8, 100, 24, ceil !== null ? WARM : DIM);
        if (num(d.coolant)) cv.text('H2O ' + deg(d.coolant), IW - 8, 100, 22, TEXT, { align: 'right' });
    } else if (ph === 'trans') {
        cv.text(num(d.trans) ? 'easy on hard shifts' : 'reading the gearbox', 8, 100, 24, num(d.trans) ? WARM : DIM);
        cv.text('OIL ' + deg(d.oil) + ' OK', IW - 8, 100, 22, READY, { align: 'right' });
    } else {
        cv.text('full revs available', 8, 100, 24, READY);
    }
}

class WarmHud {
    constructor(ctx, id) {
        this.ctx = ctx; this.log = ctx.log; this.id = id;
        this.cr = null; this.layer = null; this.claim = new HudClaim(id, ctx.log);
        this.readySince = 0; this.lastKey = '';
        /* done = warm-up is over for this drive: the HUD stays off until the oil is properly cold again.
         * firstOil = the first real oil reading, to spot a restart of an already-warm engine. */
        this.done = false; this.firstOil = null;
        /* the driver's double-tap: null = automatic, 'hide' = hidden this drive, 'show' = shown even when warm */
        this.user = null;
        /* latched phases: oilOk/transOk only drop back on a real fall (5 C under ready) */
        this.oilOk = false; this.transOk = false; this.phase = 'oil';
        this.transWaitSince = 0;            /* when the trans phase began without a reading */
        this.firstTrans = null;
        this.tyresOk = false; this.tyreWaitSince = 0; this.firstTyre = null;
    }

    available() { return !!ClusterRender; }

    start() {
        if (!ClusterRender) { this.log.warn('hud: cluster_render_client missing - is cluster-render installed?'); return false; }
        this.cr = new ClusterRender(this.id);
        this.cr.on('layer', (ref, s, why) => this.log.info('hud layer: ' + s + (why ? ' (' + why + ')' : '')));
        this.cr.on('target', (name, s, holder, why, guideDisabled, disabled) => {
            if (name === 'hud' && disabled) this.log.warn('hud: target disabled by the guard - run `cluster-render guard-reset` as root');
        });
        this.cr.on('ready', () => { this.lastKey = ''; });
        this.cr.connect();
        return true;
    }

    /** size and vertical position from settings, kept inside SLOT (clear of BMW's content in every view) */
    _rect() {
        let s = (Number(this.ctx.settings.get('scale')) || 100) / 100;
        s = Math.min(s, SLOT.w / IW, SLOT.h / IH);               /* never larger than the clear slot */
        const w = Math.round(IW * s), h = Math.round(IH * s);
        let y = Number(this.ctx.settings.get('posY'));
        if (!isFinite(y)) y = SLOT.y;
        y = Math.max(SLOT.y, Math.min(y, SLOT.y + SLOT.h - h));
        return { x: SLOT.x, y: y, w: w, h: h };
    }

    off() {
        if (this.layer && this.cr) { this.cr.drop(this.layer); }
        this.layer = null; this.claim.hold(false); this.lastKey = '';
    }

    /** the phase from oil then gearbox temperature: 'oil', 'trans', 'ready' or 'done' */
    _phase(d, o) {
        const now = Date.now(), hideAfter = o.hideAfter;
        if (num(d.oil) && this.firstOil === null) this.firstOil = d.oil;
        if (num(d.trans) && this.firstTrans === null) this.firstTrans = d.trans;
        const tyMin = d.tyres && d.tyres.minT;
        if (num(tyMin) && this.firstTyre === null) this.firstTyre = tyMin;
        if (!o.tyres) this.tyresOk = true;
        else if (num(tyMin)) { if (tyMin >= o.tyreReady) this.tyresOk = true; else if (tyMin < o.tyreReady - 3) this.tyresOk = false; }

        if (num(d.oil)) { if (d.oil >= o.readyAt) this.oilOk = true; else if (d.oil < o.readyAt - 5) this.oilOk = false; }
        if (!o.trans) this.transOk = true;
        else if (num(d.trans)) { if (d.trans >= o.transReady) this.transOk = true; else if (d.trans < o.transReady - 5) this.transOk = false; }

        /* re-arm a finished drive only once the oil is properly cold again */
        if (this.done && num(d.oil) && d.oil < o.readyAt - 20) {
            this.done = false; this.readySince = 0; this.transWaitSince = 0; this.tyreWaitSince = 0;
            this.ctx.log.info('hud: oil cold again, warm-up shown again');
        }
        if (this.done) return 'done';

        /* restart of a warm car: everything already at temperature on the first readings -> never show */
        if (hideAfter > 0 && this.readySince === 0 && num(this.firstOil) && this.firstOil >= o.readyAt &&
            (!o.trans || (num(this.firstTrans) && this.firstTrans >= o.transReady)) &&
            (!o.tyres || (num(this.firstTyre) && this.firstTyre >= o.tyreReady))) {
            this.done = true; this.ctx.log.info('hud: already warm, staying off this drive'); return 'done';
        }

        if (!this.oilOk) { this.transWaitSince = 0; this.readySince = 0; return 'oil'; }

        if (!this.transOk) {
            /* a gearbox that never answers must not hold the HUD up for the whole drive */
            if (!num(d.trans)) {
                if (!this.transWaitSince) this.transWaitSince = now;
                if (now - this.transWaitSince > 60000) {
                    this.transOk = true; this.ctx.log.warn('hud: no gearbox temperature after 60 s, skipping the trans phase');
                } else { this.readySince = 0; return 'trans'; }
            } else { this.transWaitSince = 0; this.readySince = 0; return 'trans'; }
        }

        if (!this.tyresOk) {
            /* TPMS that never reports must not hold the HUD up either */
            if (!num(tyMin)) {
                if (!this.tyreWaitSince) this.tyreWaitSince = now;
                if (now - this.tyreWaitSince > 60000) {
                    this.tyresOk = true; this.ctx.log.warn('hud: no tyre temperature after 60 s, skipping the tyre stage');
                } else { this.readySince = 0; return 'tyres'; }
            } else { this.tyreWaitSince = 0; this.readySince = 0; return 'tyres'; }
        }

        if (!this.readySince) this.readySince = now;
        if (hideAfter > 0 && (now - this.readySince) / 1000 >= hideAfter) {
            this.done = true; this.ctx.log.info('hud: oil, gearbox and tyres warm, hidden for the rest of this drive'); return 'done';
        }
        return 'ready';
    }

    /** double-tap: hide what shows, show what is hidden. Returns the new state. */
    toggle() {
        this.user = this.layer ? 'hide' : 'show';
        this.lastKey = '';
        this.ctx.log.info('hud: double-tap -> ' + this.user);
        return this.user;
    }

    update(d) {
        if (!this.cr) return null;
        const set = this.ctx.settings;
        /* "fully on": the engine running, or ran in the last ENGINE_HOLD_MS (auto start/stop at a light), or
         * the car moving. Ignition alone (engine off) shows nothing. */
        if (typeof d.engineOn === 'boolean') this.engineOn = d.engineOn;      /* callers without it keep the last state */
        const running = this.engineOn === true || (typeof d.speed === 'number' && d.speed > 1);
        const on = set.get('hud') !== false && (set.get('engineOnly') === false || running);
        const o = {
            readyAt: Number(set.get('readyAt')) || 90,
            transReady: Number(set.get('transReady')) || 70,
            trans: set.get('trans') !== false,
            hideAfter: Number(set.get('hideWhenReady')) || 0,
            tyres: set.get('tyres') !== false,
            tyreReady: Number(set.get('tyreReady')) || 25,
            pressureWarn: Number(set.get('pressureWarn')) || 0,
            pressureUnit: null,
            tempUnit: null,
        };
        if (d.units) this.carUnits = d.units;
        const su = shownUnits(set, this.carUnits);
        o.pressureUnit = su.press; o.tempUnit = su.temp;
        let ph = this._phase(d, o);
        /* a low tyre shows whatever the warm-up is doing, and after it is done */
        const low = d.tyres && d.tyres.lowest;
        if (o.pressureWarn > 0 && low && num(low.p) && num(low.target) && low.target - low.p >= o.pressureWarn) {
            d = Object.assign({}, d, { tyres: Object.assign({}, d.tyres, { low: low }) });
            ph = 'pressure';
        }
        this.phase = ph;
        const st = state(d.oil, o.readyAt);

        /* standing app: give way while another app (Redline) holds the HUD */
        try {
            HudClaim.standing(this.id, on);
            if (on && HudClaim.others(this.id).length) { if (this.layer) this.off(); return st; }
        } catch (e) { /* claims live on tmpfs; carry on if unreadable */ }

        /* nothing until the first oil reading; nothing once done */
        /* the driver's double-tap wins over the automatic: hidden, or shown (as 'ready' when the warm-up is done) */
        if (this.user === 'hide' && ph !== 'pressure') { if (this.layer) this.off(); return st; }
        if (this.user === 'show' && set.get('hud') !== false) { if (ph === 'done') ph = 'ready'; }
        else if (!on || ph === 'done' || (!num(d.oil) && ph !== 'pressure')) { if (this.layer) this.off(); return st; }

        const r = this._rect();
        if (!this.layer) {
            this.layer = this.cr.image({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h,
                iw: IW, ih: IH, fps: FPS, sampling: 'bilinear' });
            if (!this.layer) { this.ctx.log.warn('hud: layer refused'); return st; }
            this.claim.hold(true);
        } else {
            this.cr.set(this.layer, r);
        }

        const rd = (v) => (num(v) ? Math.round(v) : 'x');
        const ty = d.tyres || {};
        const key = ph + '|' + rd(d.oil) + '|' + rd(d.trans) + '|' + rd(d.coolant) + '|' + rd(ty.minT) + ty.minCorner +
            '|' + (ty.low ? ty.low.corner + rd(ty.low.p * 10) : '') + '|' + o.tempUnit + o.pressureUnit;
        if (key === this.lastKey) return st;
        this.lastKey = key;

        const cv = new Canvas(IW, IH);
        draw(cv, ph, d, o);
        if (!this.cr.pixels(this.layer, null, Buffer.from(cv.d.buffer || cv.d))) this.ctx.log.warn('hud: pixels refused');
        return st;
    }

    stop() { this.off(); if (this.cr) { try { this.cr.close(); } catch (e) { /* going away anyway */ } } }
}

module.exports = { WarmHud: WarmHud, state: state, revCeiling: revCeiling, HUD_WINDOW: HUD_WINDOW, SLOT: SLOT };
