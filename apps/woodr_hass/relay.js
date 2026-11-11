'use strict';
/**
 * relay.js - the car's side of Car Relay (the Home Assistant custom component `car_relay`).
 *
 * The car holds no Home Assistant token. It holds a device token that only the relay understands,
 * which reaches a fixed list of tiles and cameras and only while an allowed phone is in the car.
 *
 *   <dataDir>/relay.json         { "base": "https://<host>/api/car_relay/v1", "name": "M3" }
 *                                put there by hand; never in the repo
 *   <dataDir>/relay-token.json   { "token": "<dev>.<secret>" }   written once, at pairing (0600)
 *
 * States: 'unconfigured' (no relay.json) -> 'unpaired' -> 'pairing' (a code is on the screen)
 *         -> 'paired' (long-polling).
 *
 *   const r = new Relay(dataDir, log);
 *   r.on('change', () => redraw);            anything a screen shows changed
 *   r.on('event', (e) => ...);               { type: 'doorbell', label, camera }
 *   r.start();
 *   r.pair()                                 ask for a pairing code (needs an open pairing window)
 *   r.scanCode()                             a fresh unlock code for the lock screen
 *   r.action(tile, action) -> Promise<{ ok } | { error }>
 *   r.lock('button')  r.car(body)  r.camera(name) -> Promise<Buffer>
 *   r.fresh()                                was the house state confirmed within FRESH_MS?
 *
 * Nothing here throws out of a callback (an uncaught error exits the app).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const EventEmitter = require('events');
const netlease = require('./netlease');

const WAIT_S = 20;                    /* long-poll hold; the socket timeout sits above it */
const POLL_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 10000;
const FRESH_MS = 40000;
const BACKOFF_MS = [2000, 5000, 10000, 30000];
const MAX_REPLY = 2 * 1024 * 1024;    /* a 640 px camera JPEG is ~20-60 KB */

function writeWhole(file, text, mode) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, file);
}

class Relay extends EventEmitter {
    constructor(dataDir, log) {
        super();
        this.log = log;
        this.cfgFile = path.join(dataDir, 'relay.json');
        this.tokenFile = path.join(dataDir, 'relay-token.json');
        this.base = null;
        this.name = 'M3';
        this.token = null;
        this.state = 'unconfigured';
        this.error = '';              /* why the last thing did not work, for the screen */
        this.online = false;
        this.lastOk = 0;
        this.seq = 0;
        this.first = true;            /* the first snapshot's events are history, not news */
        this.session = { unlocked: false, reason: 'offline' };
        this.tiles = [];
        this.pairing = null;          /* { pair_id, code, qr, until } */
        this.scan = null;             /* { code, qr, until } */
        this.scanBusy = false;
        this.stopped = true;
        this.timer = null;
        this.fails = 0;
        this.req = null;
    }

    /* ---------------- configuration ---------------- */

    load() {
        this.base = null;
        try {
            const j = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8'));
            const u = new URL(String(j.base));
            /* plain http only for the mock relay on the PC (tools/mock_relay.js); never on the car */
            if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.CAR_RELAY_DEV === '1')) throw new Error('"base" must be https');
            this.base = u;
            if (j.name) this.name = String(j.name).slice(0, 32);
        } catch (e) {
            this.error = e.code === 'ENOENT' ? '' : 'relay.json: ' + e.message;
        }
        this.token = null;
        try {
            const t = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).token;
            if (typeof t === 'string' && t.indexOf('.') > 0) this.token = t;
        } catch (e) { /* not paired yet */ }
        this.state = !this.base ? 'unconfigured' : this.token ? 'paired' : 'unpaired';
    }

    start() {
        this.stopped = false;
        this.load();
        this.log.info('relay: ' + this.state + (this.base ? ' (' + this.base.host + ')' : ''));
        if (this.state === 'paired') this._pollSoon(0);
        this._changed();
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.req) { try { this.req.abort(); } catch (e) { /* leaving */ } }
    }

    fresh() { return this.state === 'paired' && this.online && Date.now() - this.lastOk < FRESH_MS; }

    /* ---------------- one request ---------------- */

    /** Resolves { status, json, body } for any HTTP answer; rejects only when no answer came. */
    _http(method, p, body, timeoutMs, track) {
        return new Promise((resolve, reject) => {
            if (!this.base) return reject(new Error('no relay.json'));
            const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const headers = { Accept: 'application/json' };
            if (this.token) headers['X-Car-Token'] = this.token;
            if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
            let done = false;
            const finish = (err, out) => { if (done) return; done = true; if (track) this.req = null; if (err) reject(err); else resolve(out); };
            let req;
            try {
                const plain = this.base.protocol === 'http:';
                req = (plain ? http : https).request({
                    method: method, host: this.base.hostname, port: this.base.port || (plain ? 80 : 443),
                    path: this.base.pathname.replace(/\/$/, '') + p, headers: headers,
                    lookup: netlease.lookup, agent: false,
                }, (res) => {
                    const chunks = [];
                    let size = 0;
                    res.on('data', (c) => { size += c.length; if (size > MAX_REPLY) { req.abort(); finish(new Error('reply too large')); } else chunks.push(c); });
                    res.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        let json = null;
                        if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; } }
                        finish(null, { status: res.statusCode, json: json, body: buf, type: res.headers['content-type'] || '' });
                    });
                    res.on('error', (e) => finish(e));
                });
            } catch (e) { return finish(e); }
            if (track) this.req = req;
            req.setTimeout(timeoutMs || CALL_TIMEOUT_MS, () => { req.abort(); finish(new Error('timed out')); });
            req.on('error', (e) => finish(e));
            req.end(data || undefined);
        });
    }

    /* ---------------- pairing ---------------- */

    /** Ask the relay for a pairing code. The window must have been opened in Home Assistant. */
    pair() {
        if (this.state !== 'unpaired' && this.state !== 'pairing') return Promise.resolve(false);
        this.error = '';
        return this._http('POST', '/pair', { name: this.name }).then((r) => {
            if (r.status !== 200 || !r.json || !r.json.pair_id) {
                const why = (r.json && r.json.error) || ('HTTP ' + r.status);
                this.error = why === 'pairing-closed' ? 'Pairing is closed. Open a pairing window in Home Assistant first.'
                    : why === 'device-limit' ? 'A car is already paired. Unpair it in Home Assistant first.'
                    : why === 'busy' ? 'Too many pairing attempts. Wait a few minutes.' : 'Pairing refused: ' + why;
                this.state = 'unpaired';
                this._changed();
                return false;
            }
            this.pairing = { pair_id: r.json.pair_id, code: r.json.code, qr: r.json.qr, until: Date.now() + (r.json.expires_in || 300) * 1000 };
            this.state = 'pairing';
            this.log.info('relay: pairing code on screen');
            this._changed();
            this._pairWait();
            return true;
        }).catch((e) => { this.error = 'No connection: ' + e.message; this._changed(); return false; });
    }

    _pairWait() {
        if (this.stopped || this.state !== 'pairing' || !this.pairing) return;
        if (Date.now() > this.pairing.until) {
            this.pairing = null; this.state = 'unpaired'; this.error = 'The code ran out. Press Pair for a new one.';
            return this._changed();
        }
        const again = () => { this.timer = setTimeout(() => this._pairWait(), 2000); };
        this._http('POST', '/pair/status', { pair_id: this.pairing.pair_id }).then((r) => {
            const s = r.json && r.json.status;
            if (s === 'approved' && r.json.token) {
                try { writeWhole(this.tokenFile, JSON.stringify({ token: r.json.token, at: Date.now() }), 0o600); }
                catch (e) { this.log.warn('relay: token not saved: ' + e.message); }
                this.token = r.json.token;
                this.pairing = null;
                this.state = 'paired';
                this.error = '';
                this.log.info('relay: paired');
                this._changed();
                return this._pollSoon(0);
            }
            if (s === 'unknown') { this.pairing = null; this.state = 'unpaired'; this.error = 'The code ran out. Press Pair for a new one.'; return this._changed(); }
            again();
        }).catch(() => again());
    }

    /* ---------------- the long poll ---------------- */

    _pollSoon(ms) {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this._poll(); }, ms);
    }

    _poll() {
        if (this.stopped || this.state !== 'paired') return;
        const wait = this.first ? 0 : WAIT_S;
        this._http('GET', '/poll?since=' + this.seq + '&wait=' + wait, undefined, POLL_TIMEOUT_MS, true).then((r) => {
            if (r.status === 401 && r.json && r.json.error === 'bad-token') return this._revoked();
            if (r.status !== 200 || !r.json || !r.json.session) throw new Error('HTTP ' + r.status);
            const j = r.json, was = this.seq;
            this.fails = 0;
            this.online = true;
            this.lastOk = Date.now();
            this.error = '';
            this.seq = Number(j.seq) || 0;
            this.session = j.session;
            this.tiles = Array.isArray(j.tiles) ? j.tiles : [];
            if (j.session.unlocked) this.scan = null;
            const news = this.first ? [] : (j.events || []).filter((e) => e && e.seq > was);
            this.first = false;
            this._changed();
            news.forEach((e) => { try { this.emit('event', e); } catch (err) { this.log.warn('relay event: ' + err); } });
            this._pollSoon(50);
        }).catch((e) => {
            if (this.stopped) return;
            const was = this.online;
            this.online = false;
            this.error = e.message;
            if (was) this.log.warn('relay: offline (' + e.message + ')');
            this._changed();
            this._pollSoon(BACKOFF_MS[Math.min(this.fails++, BACKOFF_MS.length - 1)]);
        });
    }

    /** The relay no longer knows this token (unpaired in Home Assistant). Keep the file, renamed. */
    _revoked() {
        this.log.warn('relay: the token was refused; this car is no longer paired');
        try { fs.renameSync(this.tokenFile, this.tokenFile + '.refused'); } catch (e) { /* nothing to move */ }
        this.token = null;
        this.state = 'unpaired';
        this.online = false;
        this.session = { unlocked: false, reason: 'offline' };
        this.tiles = [];
        this.first = true;
        this.seq = 0;
        this.error = 'This car was unpaired in Home Assistant.';
        this._changed();
    }

    /* ---------------- while paired ---------------- */

    /** A code for the lock screen. Keeps the one on screen until it is nearly out. */
    scanCode() {
        if (this.state !== 'paired' || this.scanBusy) return;
        if (this.scan && Date.now() < this.scan.until - 15000) return;
        this.scanBusy = true;
        this._http('POST', '/scan', {}).then((r) => {
            this.scanBusy = false;
            if (r.status === 200 && r.json && r.json.code) {
                this.scan = { code: r.json.code, qr: r.json.qr, until: Date.now() + (r.json.expires_in || 180) * 1000 };
                this._changed();
            }
        }).catch(() => { this.scanBusy = false; });
    }

    /**
     * One tile action. The nonce makes a retry safe: the relay runs a nonce once, so the single
     * retry after a lost answer can never open a door twice.
     */
    action(tile, action) {
        const body = { tile: tile, action: action, nonce: crypto.randomBytes(12).toString('hex') };
        const once = () => this._http('POST', '/action', body);
        const read = (r) => (r.status === 200 && r.json && r.json.ok) ? { ok: true }
            : { error: (r.json && r.json.error) || ('HTTP ' + r.status), state: r.json && r.json.state };
        return once().then(read, () => once().then(read, (e) => ({ error: 'no connection (' + e.message + ')' })));
    }

    lock(reason) {
        return this._http('POST', '/lock', { reason: reason }).then((r) => {
            if (r.json && r.json.session) { this.session = r.json.session; this.tiles = []; this._changed(); }
            return r.status === 200;
        }).catch(() => false);
    }

    car(body) { return this._http('POST', '/car', body).then((r) => r.status === 200).catch(() => false); }

    camera(name) {
        return this._http('GET', '/camera/' + encodeURIComponent(name), undefined, 12000).then((r) => {
            if (r.status !== 200 || !/^image\//.test(r.type)) throw new Error((r.json && r.json.error) || ('HTTP ' + r.status));
            return r.body;
        });
    }

    _changed() { try { this.emit('change'); } catch (e) { this.log.warn('relay change: ' + e); } }
}

module.exports = { Relay, FRESH_MS };
