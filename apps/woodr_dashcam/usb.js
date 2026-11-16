'use strict';
/**
 * usb.js - a USB stick as the dash cam's storage, the way BMW's Drive Recorder (oap_12231) exports to one.
 *
 * The head unit mounts sticks read-only (vfat, all permission bits open). Writing needs a session:
 *   DeviceManagement "1":  registerHandler({ scheme: 'file', capability: 'FILE_PLAYER' }), then the broadcasts
 *                          deviceConnected { friendlyName, uriList: ['file:/media/<id>'], uniqueID },
 *                          deviceDisconnected { uniqueID }, metadataEvent { uniqueID, deviceMetadata }
 *   USBRWControl "MGU":    accquireRWSession({ deviceID }) -> { USBRWResults: 'OK' }   (BMW's spelling)
 *                          releaseRWSession({ deviceID })
 * While a session is held the stick is writable by every user; it is released when the loop stops, the stick
 * goes, or the app exits, so the stick is read-only (safe to pull) whenever nothing is being written.
 *
 *   const usb = new Usb(ctx); await usb.start();
 *   usb.device                      { id, name, mount } or null
 *   await usb.hold()  / usb.drop()  the write session
 *   usb.copyClip(srcDir, name)      copies a clip folder to <mount>/DriveRecorder/<name>, one at a time
 *   usb.prune(keepBytes)            deletes the oldest clip folders beyond keepBytes
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DM = 'de.bmw.infotainment.devicemanager.devicemanagement.DeviceManagement';
const RW = 'de.bmw.infotainment.usbrwcontrol.USBRWControl';
const FOLDER = 'DriveRecorder';

function mountOf(uriList) {
    const list = Array.isArray(uriList) ? uriList : [uriList];
    for (let i = 0; i < list.length; i++) {
        const m = /(\/media\/[^\s"']+)/.exec(String(list[i] || ''));
        if (m) return m[1].replace(/\/+$/, '');
    }
    return null;
}

class Usb extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx; this.log = ctx.log; this.signals = ctx.signals;
        this.dm = null; this.rw = null; this.handlerId = null;
        this.devices = {};               /* uniqueID -> { id, name, mount } */
        this.held = false; this.error = '';
        this.queue = []; this.copying = null;
        this.copied = 0; this.copiedBytes = 0; this.failed = 0; this.lastCopyMs = null;
    }

    get device() { const k = Object.keys(this.devices)[0]; return k ? this.devices[k] : null; }

    async start() {
        if (this.ready) return true;
        try {
            if (!this.dm) {
                const sub = await this.signals.watch(DM, '1', {}, this.log);
                if (sub.error) throw new Error(sub.error);
                this.dm = sub.proxy;
                await this.signals.on(this.dm, 'deviceConnected', (v) => this._connected(v), this.log);
                await this.signals.on(this.dm, 'deviceDisconnected', (v) => this._gone(v), this.log);
            }
            if (!this.rw) this.rw = await this.signals.proxy(RW, 'MGU');
            /* as BMW's app does: a registered handler is told about the sticks already plugged in */
            const r = await this.signals.call(this.dm, 'registerHandler', { scheme: 'file', capability: 'FILE_PLAYER' }, 8000);
            this.handlerId = r && r.handlerID;
            this.log.info('usb: handler registered ' + JSON.stringify(r));
            this.error = '';
            this.ready = true;
        } catch (e) {
            /* right after a start the device manager may not be up yet ("Service unavailable"): keep trying */
            this.error = String(e && e.message || e);
            this.log.warn('usb: ' + this.error + ' - trying again in 15 s');
            if (!this.retry) this.retry = setTimeout(() => { this.retry = null; this.start(); }, 15000);
            if (this.retry.unref) this.retry.unref();
        }
        return !this.error;
    }

    _connected(v) {
        const mount = mountOf(v && v.uriList);
        if (!mount || !v || typeof v.uniqueID !== 'number') { this.log.info('usb: device without a mount: ' + JSON.stringify(v).slice(0, 200)); return; }
        this.devices[v.uniqueID] = { id: v.uniqueID, name: v.friendlyName || 'USB', mount: mount };
        this.log.info('usb: stick "' + (v.friendlyName || '') + '" id ' + v.uniqueID + ' at ' + mount);
        this.emit('change');
    }

    _gone(v) {
        if (!v || !this.devices[v.uniqueID]) return;
        this.log.info('usb: stick ' + v.uniqueID + ' gone');
        delete this.devices[v.uniqueID];
        this.held = false; this.queue = [];
        this.emit('change');
    }

    /** take the write session (idempotent) */
    async hold() {
        const d = this.device;
        if (!d) throw new Error('no USB stick');
        if (this.held) return d;
        const r = await this.signals.call(this.rw, 'accquireRWSession', { deviceID: d.id }, 120000);
        if (!r || r.USBRWResults !== 'OK') throw new Error('write session refused: ' + JSON.stringify(r));
        this.held = true;
        this.log.info('usb: write session on ' + d.mount);
        try { fs.mkdirSync(path.join(d.mount, FOLDER)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        this.emit('change');
        return d;
    }

    /** give the write session back: the stick is read-only again and safe to pull */
    async drop() {
        const d = this.device;
        if (!this.held || !d) { this.held = false; return; }
        try { await this.signals.call(this.rw, 'releaseRWSession', { deviceID: d.id }, 30000); } catch (e) { this.log.warn('usb: release: ' + e.message); }
        this.held = false;
        this.log.info('usb: write session released');
        this.emit('change');
    }

    /** a small write and read back, to prove the session works */
    async test() {
        const d = await this.hold();
        const f = path.join(d.mount, FOLDER, 'bimmerapps-test.txt'), text = 'Dashcam wrote this at ' + new Date().toISOString() + '\n';
        fs.writeFileSync(f, text);
        const back = fs.readFileSync(f, 'utf8');
        if (back !== text) throw new Error('read back differs');
        return f;
    }

    /* One clip is about 90 MB and a catch-up copies dozens in a row. Streams allocate a new buffer for every
     * chunk, and on the car that grew the process past its memory limit (214 MB) until the app manager stopped
     * it. So: one buffer for the whole life of the app, read and written in turn. */
    async _copyFile(src, dst) {
        if (!this._buf) this._buf = Buffer.allocUnsafe(1048576);
        const buf = this._buf;
        const open = (f, m) => new Promise((res, rej) => fs.open(f, m, (e, fd) => (e ? rej(e) : res(fd))));
        const close = (fd) => new Promise((res) => fs.close(fd, () => res()));
        const rd = (fd) => new Promise((res, rej) => fs.read(fd, buf, 0, buf.length, null, (e, n) => (e ? rej(e) : res(n))));
        const wr = (fd, n) => new Promise((res, rej) => fs.write(fd, buf, 0, n, null, (e) => (e ? rej(e) : res())));
        const a = await open(src, 'r');
        let b = -1, total = 0;
        try {
            b = await open(dst, 'w');
            for (;;) { const n = await rd(a); if (!n) break; await wr(b, n); total += n; }
        } finally { await close(a); if (b >= 0) await close(b); }
        return total;
    }

    /** queue a finished clip folder for copying */
    copyClip(srcDir, name, done) {
        if (this.queue.length > 20) { this.failed++; this.log.warn('usb: copy queue full, clip skipped: ' + name); if (done) done(false); return; }
        this.queue.push({ src: srcDir, name: name, done: done });
        this._pump();
    }

    _pump() {
        if (this.copying || !this.queue.length) return;
        const job = this.queue.shift();
        this.copying = job.name;
        const t0 = Date.now();
        this.emit('change');
        (async () => {
            const d = await this.hold();
            const out = path.join(d.mount, FOLDER, job.name);
            try { fs.mkdirSync(out); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            let bytes = 0;
            const files = fs.readdirSync(job.src);
            for (let i = 0; i < files.length; i++) bytes += await this._copyFile(path.join(job.src, files[i]), path.join(out, files[i]));
            this.copied++; this.copiedBytes += bytes; this.lastCopyMs = Date.now() - t0;
            this.log.info('usb: copied ' + job.name + ' (' + Math.round(bytes / 1048576) + ' MB in ' + (this.lastCopyMs / 1000).toFixed(1) + ' s)');
            if (job.done) { try { job.done(true, bytes); } catch (e) { /* the caller's */ } }
            if (typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* not exposed */ } }
        })().catch((e) => { this.failed++; this.error = String(e && e.message || e); this.log.warn('usb: copy ' + job.name + ': ' + this.error); if (job.done) { try { job.done(false); } catch (e2) { /* the caller's */ } } })
            .then(() => { this.copying = null; this.emit('change'); this._pump(); });
    }

    /** the clip folders on the stick, oldest first, with sizes */
    clips() {
        const d = this.device;
        if (!d) return [];
        const root = path.join(d.mount, FOLDER);
        try {
            return fs.readdirSync(root).filter((n) => /_(Event|Crash)$/.test(n)).map((n) => {
                let bytes = 0, at = 0;
                try { fs.readdirSync(path.join(root, n)).forEach((f) => { const s = fs.statSync(path.join(root, n, f)); bytes += s.size; at = Math.max(at, s.mtime.getTime()); }); } catch (e) { /* half-written */ }
                return { name: n, bytes: bytes, at: at };
            }).sort((a, b) => a.at - b.at);
        } catch (e) { return []; }
    }

    /** delete the oldest clips until what is left is under keepBytes (needs the session) */
    prune(keepBytes) {
        const d = this.device;
        if (!d || !this.held) return 0;
        const list = this.clips();
        let total = list.reduce((s, c) => s + c.bytes, 0), n = 0;
        const marked = this.highlights();
        while (total > keepBytes) {
            /* the oldest clip that is not a highlight; the newest clip always stays */
            let i = -1;
            for (let k = 0; k < list.length - 1; k++) { if (!marked[list[k].name]) { i = k; break; } }
            if (i < 0) break;
            const c = list.splice(i, 1)[0], dir = path.join(d.mount, FOLDER, c.name);
            try { fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f))); fs.rmdirSync(dir); total -= c.bytes; n++; } catch (e) { this.log.warn('usb: prune ' + c.name + ': ' + e.message); break; }
        }
        if (n) this.log.info('usb: removed the ' + n + ' oldest clips');
        return n;
    }

    /** the highlighted clips on the stick: { name: true }, from DriveRecorder/highlights.jsonl */
    highlights() {
        const d = this.device, out = {};
        if (!d) return out;
        try {
            fs.readFileSync(path.join(d.mount, FOLDER, 'highlights.jsonl'), 'utf8').split('\n').forEach((l) => { try { const j = JSON.parse(l); if (j && j.name) out[j.name] = true; } catch (e) { /* a torn line */ } });
        } catch (e) { /* none yet */ }
        return out;
    }

    /** note a copied clip as a highlight on the stick (needs the session: call from a copy's done) */
    markHighlight(name, at) {
        const d = this.device;
        if (!d || this.highlights()[name]) return;
        try { fs.appendFileSync(path.join(d.mount, FOLDER, 'highlights.jsonl'), JSON.stringify({ name: name, at: at || Date.now() }) + '\n'); }
        catch (e) { this.log.warn('usb: highlight note for ' + name + ': ' + e.message); }
    }

    async stop() {
        await this.drop();
        if (this.dm && this.handlerId !== null && this.handlerId !== undefined) {
            try { await this.signals.call(this.dm, 'unregisterHandler', { handlerID: this.handlerId }, 3000); } catch (e) { /* leaving */ }
        }
    }
}

module.exports = { Usb: Usb, FOLDER: FOLDER, mountOf: mountOf };
