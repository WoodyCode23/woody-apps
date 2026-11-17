'use strict';
/**
 * recorder.js - BMW's drive-recorder video buffer, driven the way BMW's own Drive Recorder app (oap_12231 7.74.0)
 * drives it, read from its code:
 *
 *   ICAM2Proxy (extends CameraProxy), instance "1":
 *     clientAttach({ type: 'CLIENT_INDIRECT' }) -> { cookie }          once per app life; clientDetach at the end
 *     changeState({ cookie, desiredState: { application, mode: 'MODE_MOSAIK', perspective } })
 *        application DR_STANDBY (50) while buffering, DR_ACTIVE (51) to store; perspective ALL = 7
 *     currentState  { application, mode, perspective }
 *   VideoBuffer, instance "VideoBuffer":
 *     startRecording()                    BMW's app does this itself while driving with its recorder on
 *     storeVideo({ baseFilename, secondsIntoPast, secondsIntoFuture })
 *        baseFilename = <dir> + "dd.mm.yyyy_HH_MM_ss_Event": BMW's app lists such folders, exports them to USB
 *        and keeps its newest N (its setting), so clips named like that get its viewer and its clean-up
 *     currentStatus  IDLE / ERROR / RECORDING / STORING ; currentConfiguration { maxDuration ms, maxBitrate }
 *
 * After a store the buffer goes IDLE and BMW's app starts it again (activation sequence), so back-to-back clips
 * may have a gap: this module times every state change so the loop can be tuned to the car.
 *
 * BMW's app is started by hand (appStartType "manually"), so after a head-unit start nothing starts the buffer
 * until someone opens it. wake() is its activation sequence, read from its code (7.87.0): attach, cameras to
 * DR_STANDBY, startRecording. Like BMW's it runs only with the engine running, and only when the buffer has
 * stayed IDLE far longer than BMW's app would leave it.
 */
const EventEmitter = require('events');

const VB = 'de.bmw.infotainment.video.videobuffer.VideoBuffer';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const RPM_INVALID = 65535, RPM_FACTOR = 0.25, RPM_RUNNING = 400;
const ICAM = 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy';
const STATUS = { 0: 'IDLE', 1: 'ERROR', 2: 'RECORDING', 3: 'STORING' };
const APPS = { 0: 'OFF', 1: 'TOPREARVIEW', 2: 'SIDEVIEW', 3: 'RFK', 20: 'OFFROAD', 50: 'DR_STANDBY', 51: 'DR_ACTIVE', 52: 'DR_CRASH', 60: 'REMOTE360', 255: 'SIGNAL_UNFILLED' };
const ALL_CAMERAS = 7;
const DIR = '/mnt/share/ent/driverecorder/';        /* BMW's own path on this hardware (generation < 22) */

const name = (v, map) => (typeof v === 'number' ? map[v] || String(v) : String(v));
const pad = (n) => (n < 10 ? '0' : '') + n;

function bmwName(d) {
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + '_' + pad(d.getHours()) + '_' + pad(d.getMinutes()) + '_' + pad(d.getSeconds()) + '_Event';
}

class Recorder extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx; this.log = ctx.log; this.signals = ctx.signals;
        this.vb = null; this.icam = null; this.cookie = -1; this.error = null;
        this.status = 'unknown'; this.config = null; this.icamState = null;
        this.since = Date.now();
        this.timeline = [];                /* { at, what } newest last, the last 60 */
        this.saves = 0; this.lastSaveAt = 0; this.lastStoreMs = null; this.lastGapMs = null;
        this._storingFrom = 0; this._idleFrom = 0;
        this.rpm = null; this.wakes = 0; this.lastWakeAt = 0; this._waking = false;
    }

    _mark(what) {
        this.timeline.push({ at: Date.now(), what: what });
        if (this.timeline.length > 60) this.timeline.shift();
        this.log.info('dashcam: ' + what);
        this.emit('change');
    }

    async start() {
        const a = await this.signals.watch(VB, 'VideoBuffer', {
            currentStatus: (v) => this._status(name(v, STATUS)),
            currentConfiguration: (v) => { this.config = v; this.emit('change'); },
        }, this.log);
        this.vb = a && a.proxy;
        if (a && a.error) this.error = 'video buffer: ' + a.error;
        const b = await this.signals.watch(ICAM, '1', {
            currentState: (v) => {
                this.icamState = v ? { application: name(v.application, APPS), mode: v.mode, perspective: v.perspective } : null;
                this.emit('change');
            },
        }, this.log);
        this.icam = b && b.proxy;
        if (b && b.error) this.error = (this.error ? this.error + '; ' : '') + 'camera proxy: ' + b.error;
        /* engine speed, only to know the engine runs before waking the buffer; without it the buffer is never woken */
        try {
            await this.signals.watch(CDS, '1', {
                statusEngineSpeed2: (v) => { const raw = v && v.actualValueRPMEngineCrankshaft; this.rpm = typeof raw === 'number' && raw !== RPM_INVALID ? raw * RPM_FACTOR : null; },
            }, this.log);
        } catch (e) { /* optional */ }
        return !!this.vb;
    }

    _status(s) {
        if (s === this.status) return;
        const now = Date.now(), was = this.status;
        if (s === 'STORING') this._storingFrom = now;
        if (was === 'STORING' && this._storingFrom) this.lastStoreMs = now - this._storingFrom;
        if (s === 'IDLE') this._idleFrom = now;
        /* a store of ours just ended: the clip's folder is complete */
        if (was === 'STORING' && s !== 'ERROR' && this.lastBase) { const b = this.lastBase; this.lastBase = null; setTimeout(() => this.emit('stored', b), 1500); }
        /* the real gap: from the store's end (IDLE) to the buffer recording again */
        if (s === 'RECORDING' && this._idleFrom) { this.lastGapMs = now - this._idleFrom; this._idleFrom = 0; }
        if (s === 'RECORDING') this.wakes = 0;
        this.status = s; this.since = now;
        this._mark(was + ' -> ' + s + (s === 'RECORDING' && this.lastGapMs !== null ? ' (not buffering for ' + (this.lastGapMs / 1000).toFixed(1) + ' s)' : '')
            + (was === 'STORING' && this.lastStoreMs !== null ? ' (store took ' + (this.lastStoreMs / 1000).toFixed(1) + ' s)' : ''));
    }

    async _attach() {
        if (this.cookie !== -1 || !this.icam) return;
        const r = await this.signals.call(this.icam, 'clientAttach', { type: 'CLIENT_INDIRECT' }, 5000);
        this.cookie = r && typeof r.cookie === 'number' ? r.cookie : -1;
        this._mark('camera client attached, cookie ' + this.cookie);
    }

    /**
     * Keep `past` seconds before and `future` after now. active: switch the cameras to DR_ACTIVE first, as BMW's app
     * does before every store (false = the buffer alone, to learn whether that is enough).
     */
    async save(past, future, opts) {
        const o = opts || {};
        if (!this.vb) throw new Error('no video buffer');
        if (this.status !== 'RECORDING') throw new Error('the buffer is ' + this.status + ': it records while driving with BMW\'s Drive Recorder switched on');
        if (o.active !== false && this.icam) {
            await this._attach();
            if (this.cookie !== -1) {
                const persp = this.icamState && typeof this.icamState.perspective === 'number' ? this.icamState.perspective : ALL_CAMERAS;
                await this.signals.call(this.icam, 'changeState', { cookie: this.cookie, desiredState: { application: 'DR_ACTIVE', mode: 'MODE_MOSAIK', perspective: persp } }, 5000);
            }
        }
        const base = DIR + bmwName(new Date());
        await this.signals.call(this.vb, 'storeVideo', { baseFilename: base, secondsIntoPast: past, secondsIntoFuture: future }, 10000);
        this.saves++; this.lastSaveAt = Date.now(); this.lastBase = base;
        this._mark('store ' + past + '+' + future + ' s -> ' + base + (o.active === false ? ' (buffer only)' : ''));
        return base;
    }

    /** true when the buffer may be woken: engine running, buffer IDLE for `idleMs`, cameras known, not tried lately */
    canWake(idleMs) {
        const now = Date.now();
        return !!this.vb && !!this.icam && !this._waking && this.status === 'IDLE' && now - this.since >= idleMs
            && typeof this.rpm === 'number' && this.rpm >= RPM_RUNNING
            && now - this.lastWakeAt >= 15000 && this.wakes < 10
            && !(this.icamState && this.icamState.application === 'SIGNAL_UNFILLED');
    }

    /** BMW's activation sequence: attach, cameras to DR_STANDBY, start the buffer. One try; the caller paces it. */
    async wake() {
        if (this._waking) return false;
        this._waking = true; this.lastWakeAt = Date.now(); this.wakes++;
        try {
            await this._attach();
            if (this.cookie === -1) throw new Error('no camera client');
            const persp = this.icamState && typeof this.icamState.perspective === 'number' ? this.icamState.perspective : ALL_CAMERAS;
            if (!(this.icamState && this.icamState.application === 'DR_STANDBY')) {
                await this.signals.call(this.icam, 'changeState', { cookie: this.cookie, desiredState: { application: 'DR_STANDBY', mode: 'MODE_MOSAIK', perspective: persp } }, 5000);
            }
            if (this.status === 'IDLE') await this.signals.call(this.vb, 'startRecording', {}, 5000);
            this.selfWoke = true;
            this._mark('buffer woken (try ' + this.wakes + ')');
            return true;
        } catch (e) {
            this.log.warn('dashcam: wake failed: ' + String(e && e.message || e));
            return false;
        } finally { this._waking = false; }
    }

    async stop() {
        if (this.cookie !== -1 && this.icam) {
            try { await this.signals.call(this.icam, 'clientDetach', { cookie: this.cookie }, 3000); } catch (e) { /* leaving */ }
            this.cookie = -1;
        }
    }
}

module.exports = { Recorder: Recorder, DIR: DIR, bmwName: bmwName, STATUS: STATUS };
