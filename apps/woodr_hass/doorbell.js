'use strict';
/**
 * doorbell.js - the front doorbell on the instrument cluster, and the slot handed straight back.
 *
 * The shape of the problem, and why it is not the fight it looks like:
 *
 *   - cluster-render composites layers from SEVERAL clients onto one target, ordered by `class`
 *     (ambient < content < overlay < alert) and then `z`. Waze on the cluster
 *     (robertn_waze_cluster) holds `map` with its own layer; this app adding an `alert`-class
 *     layer to the same target does NOT take the target away from it. There is no slot to seize
 *     and nothing to give back but our own layer.
 *   - The take-over race (`contend: 1`, documented as lost 10 times in 33 attempts) is about
 *     taking the `map` mapping from the STOCK HMI. While Waze already holds the mapping, the
 *     target is ours too and no contention is needed: `contend: 0` is enough and is the default
 *     here. `contend: 1` is only offered as a setting for when Waze is not running and the user
 *     wants the doorbell to pull the slot off BMW's own cluster content anyway.
 *   - So the hand-back is simply cr.drop(layer): Waze's layer still wants the target, the target
 *     is never released, and BMW's content comes back on its own once no layer wants it.
 *
 * Geometry: `map` is 1088x480 on iDrive 7. The gap between the G80's speed readouts has NOT been
 * measured on this car - GAP below is a placeholder. Measure it with woodr_screenlab (grid on the
 * `map` target, photograph, read the numbers off) and put the result in ha.json.
 *
 * Safety: a moving picture in the driver's primary field of view is a genuine distraction, and in
 * many places a video visible to the driver while the car is in motion is also not legal. The
 * default is therefore 'parked': the picture is shown only when the car is stationary (speed
 * under STOPPED_KMH and, when the signal is there, the selector in P or N). While moving, the
 * 'banner' mode draws a small static text strip instead - no image, no motion. 'always' exists
 * because this is the owner's car and the owner's call, but it is not the default.
 *
 *   const db = new Doorbell(ctx, ha, cfg, APP_ID);
 *   db.start();
 *   db.ring();                      // the doorbell fired (from a state_changed, or the button)
 *   db.dismiss('button');           // take it down now
 *   db.carState({ speed, stage });  // the safety gate's inputs, from kit/car.js
 *   db.status()                     // { shown, mode, why, frames, target }
 *   db.stop();
 */
const { ClusterClaim } = require('./cluster_claim');
const { Stream, snapshot } = require('./mjpeg');
const jpeg = require('./jpeg');
const { Canvas } = require('./kit/canvas');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported at start */ }

const TARGET = 'map';
const SCENE_W = 1088, SCENE_H = 480;
/* PLACEHOLDER - the gap between the speed readouts, to be measured with woodr_screenlab. */
const GAP = { x: 394, y: 128, w: 300, h: 204 };
const BANNER = { x: 344, y: 196, w: 400, h: 64 };
const STOPPED_KMH = 2;
const MAX_SECS = 60;             /* no episode outlives this, whatever else fails */
const WATCHDOG_MS = 1000;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = (x) => typeof x === 'number' && isFinite(x);

class Doorbell {
    constructor(ctx, ha, cfg, appId) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.settings = ctx.settings;
        this.ha = ha;
        this.cfg = cfg;
        this.appId = appId;
        this.cr = null;
        this.layer = 0;
        this.kind = '';              /* '' | 'image' | 'banner' */
        this.until = 0;
        this.ringAt = 0;
        this.stream = null;
        this.frames = 0;
        this.lastPush = 0;
        this.car = { speed: null, stage: undefined, condition: undefined };
        this.claim = new ClusterClaim(TARGET, appId, this.log);
        this.watchdog = null;
        this.targetState = '';
        this.why = 'idle';
        this.pixbuf = null;
        this.available = false;
        this.onChange = null;        /* set by main.js to refresh the centre screen */
    }

    /* ---------------- lifecycle ---------------- */

    start() {
        if (!ClusterRender) { this.why = 'cluster_render_client.js missing from the app'; return false; }
        this.cr = new ClusterRender(this.appId);
        this.cr.on('ready', () => { this.available = true; this.log.info('doorbell: cluster-render up (targets ' + this.cr.targets + ')'); this._changed(); });
        this.cr.on('disconnected', () => { this.available = false; this.layer = 0; this.kind = ''; this.log.warn('doorbell: cluster-render went away'); this._changed(); });
        this.cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== TARGET) return;
            this.targetState = state + (holder ? ' (' + holder + ')' : '');
            if (disabled) this.log.warn('doorbell: map disabled by the mapping guard - run `cluster-render guard-reset` as root');
            this._changed();
        });
        this.cr.on('layer', (ref, state, reason) => {
            if (ref !== this.layer) return;
            this.log.info('doorbell: layer ' + state + (reason ? ' (' + reason + ')' : ''));
            this._changed();
        });
        this.cr.on('refused', (op, ref, reason) => this.log.warn('doorbell: refused ' + op + ': ' + reason));
        this.cr.on('budget', (cap, max, why) => this.log.info('doorbell: upload budget ' + cap + '/' + max + ' KB/s (' + why + ')'));
        this.cr.connect();
        /* The watchdog is the guarantee. It runs off its own timer, not off HA, not off the
         * render loop and not off the camera stream, so the overlay comes down on time even if
         * every other part of the app has wedged. */
        this.watchdog = setInterval(() => this._tick(), WATCHDOG_MS);
        if (this.watchdog.unref) this.watchdog.unref();
        return true;
    }

    stop() {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        this._down('app stopping');
        if (this.cr) { this.cr.removeAllListeners(); try { this.cr.close(); } catch (e) { /* leaving */ } this.cr = null; }
    }

    status() {
        return {
            shown: !!this.layer, kind: this.kind, mode: this._mode(), why: this.why,
            frames: this.frames, target: this.targetState, available: this.available,
            secsLeft: this.layer ? Math.max(0, Math.round((this.until - Date.now()) / 1000)) : 0,
            others: ClusterClaim.others(TARGET, this.appId),
            decoder: jpeg.available(),
        };
    }

    /* ---------------- the safety gate ---------------- */

    carState(d) {
        if (!d) return;
        this.car = { speed: d.speed, stage: d.stage, condition: d.condition };
        /* A car that starts moving while the picture is up loses the picture at once. */
        if (this.kind === 'image' && !this._stationary()) this._show('banner', 'car started moving');
    }

    _mode() { return this.settings.get('doorbell') || 'parked'; }

    _stationary() {
        const s = this.car.speed;
        /* No speed signal at all is treated as "moving": the gate must fail safe. */
        if (!isNum(s)) return false;
        if (s > STOPPED_KMH) return false;
        if (this.car.stage === 'D' || this.car.stage === 'R') return false;
        return true;
    }

    /** What may be drawn right now: 'image', 'banner' or '' (nothing). */
    _allowed() {
        const mode = this._mode();
        if (mode === 'off') return '';
        if (mode === 'always') return 'image';
        if (this._stationary()) return 'image';
        return mode === 'banner' ? 'banner' : '';
    }

    /* ---------------- the episode ---------------- */

    /** The doorbell rang. */
    ring(label) {
        const secs = clamp(Number(this.settings.get('doorbellSecs')) || 20, 5, MAX_SECS);
        this.ringAt = Date.now();
        this.until = this.ringAt + secs * 1000;
        this.label = label || (this.cfg.doorbell && this.cfg.doorbell.label) || 'Front door';
        this.frames = 0;
        const want = this._allowed();
        if (!want) { this.why = 'suppressed: ' + (this._mode() === 'off' ? 'turned off' : 'car is moving'); this._changed(); return; }
        this.log.info('doorbell: ring - showing ' + want + ' on ' + TARGET + ' for ' + secs + ' s');
        this._show(want, 'doorbell rang');
    }

    dismiss(why) { this._down(why || 'dismissed'); }

    _tick() {
        if (!this.layer) return;
        if (Date.now() >= this.until) { this._down('timed out'); return; }
        const want = this._allowed();
        if (want !== this.kind) {
            if (!want) this._down('no longer allowed');
            else this._show(want, 'gate changed');
            return;
        }
        if (this.kind === 'image' && !this.stream) this._poll();
    }

    /* ---------------- layers ---------------- */

    _contend() { return this.settings.get('contend') === true ? 1 : 0; }

    _show(kind, why) {
        if (!this.cr || !this.available) { this.why = 'cluster-render not available'; this._changed(); return; }
        if (this.kind === kind && this.layer) return;
        this._dropLayer();
        const box = kind === 'image' ? GAP : BANNER;
        /* class 'alert' sits above Waze's own layer; a modest z so a real warning overlay from
         * another app can still be put over this one. exclusive stays 0: hiding every layer below
         * would blank the cluster, which is exactly what must not happen. */
        this.layer = this.cr.image({
            target: TARGET, klass: 'alert', z: 100,
            x: box.x, y: box.y, w: box.w, h: box.h, iw: box.w, ih: box.h,
            fps: kind === 'image' ? clamp(Number(this.settings.get('doorbellFps')) || 3, 1, 8) : 1,
            sampling: 'bilinear', visible: true, opacity: 1,
            contend: this._contend(), guide_hold: 1,
        });
        if (!this.layer) { this.why = 'layer refused'; this.log.warn('doorbell: image layer refused'); this._changed(); return; }
        this.kind = kind;
        this.why = why;
        this.claim.hold(true, 'doorbell/' + kind);
        this.pixbuf = Buffer.alloc(box.w * box.h * 4);
        this._paintChrome();
        if (kind === 'image') this._openCamera();
        this._changed();
    }

    _down(why) {
        if (!this.layer && !this.stream) { this.why = why; return; }
        this.log.info('doorbell: down (' + why + ') after ' + this.frames + ' frame(s)');
        this._closeCamera();
        this._dropLayer();
        this.claim.hold(false);
        this.why = why;
        this._changed();
    }

    _dropLayer() {
        if (this.layer && this.cr) { try { this.cr.drop(this.layer); } catch (e) { this.log.warn('doorbell: drop: ' + e); } }
        this.layer = 0;
        this.kind = '';
        this.pixbuf = null;
    }

    /** The first thing on screen: a framed box with the label, so something shows before a frame. */
    _paintChrome(note) {
        if (!this.layer) return;
        const box = this.kind === 'image' ? GAP : BANNER;
        const cv = new Canvas(box.w, box.h);
        cv.clear([0, 0, 0, 0]);
        cv.roundRect(0, 0, box.w, box.h, 10, '#0b0b0bdd');
        cv.strokeRoundRect(0, 0, box.w, box.h, 10, 2, '#ffc21a');
        cv.text(this.label || 'Front door', box.w / 2, this.kind === 'banner' ? 42 : 34, 26, '#ffffff', { align: 'center', font: 'bold' });
        const sub = note || (this.kind === 'banner' ? 'camera hidden while moving' : jpeg.available() ? 'connecting to the camera' : 'no JPEG decoder on the car');
        cv.text(sub, box.w / 2, this.kind === 'banner' ? 48 + 24 : box.h - 16, 18, '#bbbbbb', { align: 'center' });
        this._push(cv.d);
    }

    _push(u8) {
        if (!this.layer || !this.cr) return;
        const buf = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.length);
        if (!this.cr.pixels(this.layer, null, buf)) this.log.warn('doorbell: pixels refused');
    }

    /* ---------------- camera ---------------- */

    _camera() { return this.cfg.doorbell && this.cfg.doorbell.camera; }

    _openCamera() {
        const cam = this._camera();
        if (!cam) { this._paintChrome('ha.json has no doorbell camera'); return; }
        if (!jpeg.available()) { this._paintChrome('vendor jpeg_decoder.js to see pixels'); this._poll(); return; }
        /* The MJPEG stream is one request for the whole episode: far cheaper than a snapshot
         * request per frame, and HA's camera_proxy_stream already paces it. */
        const s = new Stream(this.cfg, cam);
        s.on('frame', (jpg) => this._frame(jpg));
        s.on('error', (e) => { this.log.warn('doorbell: stream: ' + e.message); this._closeCamera(); this._poll(); });
        s.on('end', () => { this._closeCamera(); });
        s.start();
        this.stream = s;
    }

    _closeCamera() {
        if (this.stream) { this.stream.removeAllListeners(); this.stream.stop(); this.stream = null; }
    }

    /** Snapshot fallback, used when the stream will not open: one still per second. */
    _poll() {
        const cam = this._camera();
        if (!cam || !this.layer || this.kind !== 'image') return;
        const now = Date.now();
        if (now - this.lastPush < 1000) return;
        this.lastPush = now;
        snapshot(this.ha, cam).then((jpg) => this._frame(jpg)).catch((e) => {
            this.log.warn('doorbell: snapshot: ' + e.message);
            this._paintChrome('camera unreachable');
        });
    }

    _frame(jpg) {
        if (!this.layer || this.kind !== 'image') return;
        const img = jpeg.decode(jpg);
        if (!img) { this._paintChrome('frame could not be decoded'); return; }
        const box = GAP;
        jpeg.fit(img.rgba, img.w, img.h, box.w, box.h, this.pixbuf);
        this.frames++;
        this._push(this.pixbuf);
        this.lastPush = Date.now();
    }

    _changed() { if (this.onChange) { try { this.onChange(); } catch (e) { /* the screen's problem */ } } }
}

module.exports = { Doorbell, GAP, BANNER, TARGET, SCENE_W, SCENE_H, STOPPED_KMH };
