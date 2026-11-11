'use strict';
/**
 * devhud.js - what Dev HUD shows, and the head-up display layer it shows it on.
 *
 * Rows, most important first, at most ROWS of them:
 *   Store       the updater's current job: component, phase, progress bar
 *   feed items  bars pushed from the laptop into <dataDir>/feed.json (tools/hud-push.sh)
 *   Battery     the car's own state of charge (CDS statusBattery2: a broadcast, no request to any unit)
 *   Network     online on which interface, or offline
 *
 * One image layer on cluster-render's 'hud' target, inside SLOT: the part of the HUD that is clear of
 * BMW's own content in every view (measured on this car with Screen Lab). A picture, never a shader.
 */
const { Canvas, withAlpha } = require('./kit/canvas');
const { Progress } = require('./progress');
const progress = new Progress();
const { HudClaim } = require('./kit/hud_claim');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported by start() */ }

const SLOT = { x: 220, y: 185, w: 470, h: 133 };
const IW = 470, IH = 133;
const FPS = 2;
const MIN_GAP_MS = 500;
const ROWS = 3, ROW_H = 42;
const GREEN = '#2fd27a', AMBER = '#ffd34d', ORANGE = '#ff9d3b', RED = '#ff5a4d', DIM = '#9a9a9a', TEXT = '#ffffff';

const num = (v) => typeof v === 'number' && isFinite(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The rows to show now, from everything known. active = something is happening (a job or a fresh feed). */
function rows(s) {
    const out = [];
    let active = false;
    const up = s.updater;
    if (!(up && up.busy)) progress.of(null);
    if (up && up.busy) {
        active = true;
        const b = up.busy, pr = progress.of(b);
        const name = String(b.id || '?').replace(/^woodr_|^robertn_/, '');
        out.push({ label: 'Store', text: name.slice(0, 9) + ' ' + Math.round(pr.frac * 100) + '%', frac: pr.frac, colour: AMBER });
    } else if (up && up.catalog && up.catalog.checking) {
        active = true;
        out.push({ label: 'Store', text: 'checking sources', frac: null, colour: AMBER });
    }
    (s.feed || []).forEach((f) => {
        if (!f || typeof f !== 'object') return;
        active = true;
        const max = num(f.max) && f.max > 0 ? f.max : 100;
        const frac = num(f.value) ? clamp01(f.value / max) : null;
        const text = typeof f.text === 'string' && f.text ? f.text : num(f.value) ? Math.round(f.value) + (max === 100 ? '%' : ' / ' + max) : '';
        out.push({ label: String(f.label || 'Laptop').slice(0, 10), text: text, frac: frac, colour: f.colour === 'red' ? RED : f.colour === 'green' ? GREEN : '#58b4ff' });
    });
    if (num(s.battery)) {
        const c = s.battery;
        out.push({ label: 'Battery', text: Math.round(c) + '%', frac: clamp01(c / 100), colour: c >= 70 ? GREEN : c >= 50 ? AMBER : RED });
    }
    out.push({ label: 'Net', text: s.net || 'offline', frac: null, colour: s.net ? GREEN : ORANGE });
    return { rows: out.slice(0, ROWS), active: active };
}

function draw(cv, list, ox, oy) {
    const X = ox || 0, Y = oy || 0;
    list.forEach((r, i) => {
        const y = Y + 4 + i * ROW_H;
        cv.text(r.label, X + 4, y + 28, 22, DIM, { font: 'bold' });
        if (r.frac !== null && r.frac !== undefined) {
            cv.roundRect(X + 118, y + 10, 200, 20, 6, withAlpha('#ffffff', 0.18));
            if (r.frac > 0) cv.roundRect(X + 118, y + 10, Math.max(12, Math.round(200 * r.frac)), 20, 6, r.colour);
            cv.text(r.text.slice(0, 14), X + 466, y + 28, 22, TEXT, { align: 'right' });
        } else {
            cv.text(r.text.slice(0, 30), X + 118, y + 28, 22, r.colour);
        }
    });
}

class DevHud {
    constructor(ctx, id) {
        this.ctx = ctx; this.id = id; this.log = ctx.log;
        this.cr = null; this.layer = null; this.lastKey = '';
        this.claim = new HudClaim(id, ctx.log);
    }

    start() {
        if (!ClusterRender) { this.log.warn('hud: cluster_render_client missing - is cluster-render installed?'); return false; }
        this.cr = new ClusterRender(this.id);
        this.cr.on('layer', (ref, st, why) => this.log.info('hud layer: ' + st + (why ? ' (' + why + ')' : '')));
        this.cr.on('target', (name, st, holder, why, guideDisabled, disabled) => {
            if (name === 'hud' && disabled) this.log.warn('hud: target disabled by the guard - run `cluster-render guard-reset` as root');
        });
        this.cr.on('ready', () => { this.lastKey = ''; });
        this.cr.connect();
        return true;
    }

    off() {
        if (this.layer && this.cr) this.cr.drop(this.layer);
        this.layer = null; this.claim.hold(false); this.lastKey = '';
    }

    /** show(list) puts these rows up; show(null) takes the layer down. */
    show(list) {
        if (!this.cr) return;
        if (!list || !list.length) { if (this.layer) this.off(); return; }
        if (!this.layer) {
            this.layer = this.cr.image({ target: 'hud', klass: 'overlay', z: 1, x: SLOT.x, y: SLOT.y, w: SLOT.w, h: SLOT.h,
                iw: IW, ih: IH, fps: FPS, sampling: 'bilinear' });
            if (!this.layer) { this.log.warn('hud: layer refused'); return; }
            this.claim.hold(true);            /* standing apps (Warm-Up HUD) give way while this is up */
        }
        const key = JSON.stringify(list.map((r) => [r.label, r.text, r.frac === null || r.frac === undefined ? -1 : Math.round(r.frac * 100), r.colour]));
        if (key === this.lastKey) return;
        /* at most MIN_GAP_MS between uploads: the updater pushes its state many times a second during a download,
         * and every push used to become a frame (4930 frames / 592 MB a minute on the car, starving the cluster's
         * upload budget). A skipped change is drawn by the next 1 s tick. */
        const now = Date.now();
        if (now - (this.lastPushAt || 0) < MIN_GAP_MS) return;
        this.lastPushAt = now;
        this.lastKey = key;
        const cv = new Canvas(IW, IH);
        draw(cv, list);
        if (!this.cr.pixels(this.layer, null, Buffer.from(cv.d.buffer || cv.d))) this.log.warn('hud: pixels refused');
    }

    stop() { this.off(); if (this.cr) { try { this.cr.close(); } catch (e) { /* going away anyway */ } } }
}

module.exports = { DevHud: DevHud, rows: rows, draw: draw, IW: IW, IH: IH, SLOT: SLOT };
