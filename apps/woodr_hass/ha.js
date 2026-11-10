'use strict';
/**
 * ha.js - the Home Assistant connection: WebSocket for live state, REST as the fallback.
 *
 *   const ha = new Ha(cfg, log);
 *   ha.on('state', (entityId, st) => ...);     // one entity changed (st = { state, attributes, ... })
 *   ha.on('states', () => ...);                // the whole snapshot arrived (first connect)
 *   ha.on('link', (how, why) => ...);          // 'ws' | 'rest' | 'down', with a reason
 *   ha.on('event', (ev) => ...);               // any non-state_changed event we subscribed to
 *   ha.start();
 *   ha.get('light.porch')                      // last known state object, or null
 *   ha.call('light', 'toggle', { entity_id: 'light.porch' })   -> Promise
 *   ha.stop();
 *
 * Protocol (HA developer docs, /api/websocket):
 *   server -> { type: 'auth_required', ha_version }
 *   client -> { type: 'auth', access_token }
 *   server -> { type: 'auth_ok' } | { type: 'auth_invalid', message }
 *   then every client message carries an increasing id; the server answers
 *   { id, type: 'result', success, result|error } and pushes { id, type: 'event', event }.
 *
 * Reconnect: exponential backoff, and on every (re)connect the state snapshot is fetched again -
 * state_changed events missed while disconnected are simply not knowable, so a resync is the only
 * correct answer. If the WebSocket cannot be had at all, REST polling takes over at a slow rate
 * so the tiles still work (and service calls still go out).
 *
 * Nothing here throws into the event loop: every callback is wrapped. An uncaught error exits the
 * app, and MainApp's CorruptAppsHandler wipes the app's data on its first crash.
 */
const http = require('http');
const https = require('https');
const url = require('url');
const EventEmitter = require('events');
const { WebSock } = require('./ws');

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const PING_MS = 25000;
const PING_GRACE_MS = 10000;
const REST_POLL_MS = 15000;
const CALL_TIMEOUT_MS = 12000;

class Ha extends EventEmitter {
    /** cfg: see config.js (baseUrl, token, entities, verifyTls, ...). */
    constructor(cfg, log) {
        super();
        this.cfg = cfg;
        this.log = log || { info: () => {}, warn: () => {}, error: () => {} };
        this.states = {};            /* entity_id -> state object */
        this.sock = null;
        this.id = 1;
        this.waiting = new Map();    /* message id -> { resolve, reject, timer } */
        this.link = 'down';
        this.linkWhy = 'not started';
        this.tries = 0;
        this.timer = null;
        this.pingTimer = null;
        this.pongBy = 0;
        this.restTimer = null;
        this.stopped = true;
        this.haVersion = '';
        this.subs = {};              /* event_type -> subscription id */
    }

    /* ---------------- lifecycle ---------------- */

    start() {
        this.stopped = false;
        this._openWs();
    }

    stop() {
        this.stopped = true;
        this._clear();
        if (this.sock) { this.sock.removeAllListeners(); this.sock.close(1000, 'app closing'); this.sock = null; }
        this._setLink('down', 'stopped');
    }

    _clear() {
        [this.timer, this.pingTimer, this.restTimer].forEach((t) => { if (t) clearTimeout(t); });
        if (this.restTimer) clearInterval(this.restTimer);
        this.timer = this.pingTimer = this.restTimer = null;
        this.waiting.forEach((w) => { clearTimeout(w.timer); w.reject(new Error('connection went away')); });
        this.waiting.clear();
    }

    _setLink(how, why) {
        if (this.link === how && this.linkWhy === why) return;
        this.link = how;
        this.linkWhy = why || '';
        this._emit('link', how, this.linkWhy);
    }

    _emit() {
        const args = Array.prototype.slice.call(arguments);
        try { this.emit.apply(this, args); } catch (e) { this.log.warn('ha listener: ' + e); }
    }

    ok() { return this.link === 'ws'; }
    get(entityId) { return this.states[entityId] || null; }
    version() { return this.haVersion; }

    /* ---------------- WebSocket ---------------- */

    _wsUrl() {
        const u = url.parse(this.cfg.baseUrl);
        const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = u.port ? ':' + u.port : '';
        return scheme + '//' + u.hostname + port + '/api/websocket';
    }

    _openWs() {
        if (this.stopped || this.sock) return;
        if (!this.cfg.baseUrl || !this.cfg.token) { this._setLink('down', 'ha.json has no baseUrl or token'); return; }
        const sock = new WebSock(this._wsUrl(), {
            timeout: 10000,
            rejectUnauthorized: this.cfg.verifyTls !== false,
            ca: this.cfg.ca || null,
        });
        this.sock = sock;
        sock.on('open', () => this.log.info('ha: socket open, waiting for auth_required'));
        sock.on('message', (data, binary) => { if (!binary) this._wsMessage(data); });
        sock.on('error', (e) => this.log.warn('ha: ' + e.message));
        sock.on('close', (code, why) => {
            if (this.sock !== sock) return;
            this.sock = null;
            this._clear();
            this._setLink('down', 'socket closed (' + code + (why ? ': ' + why : '') + ')');
            this._retry();
            this._startRest();          /* tiles keep working on REST while the socket is away */
        });
        sock.connect();
    }

    _retry() {
        if (this.stopped || this.timer) return;
        const ms = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)];
        this.tries++;
        this.timer = setTimeout(() => { this.timer = null; this._openWs(); }, ms);
    }

    _wsMessage(text) {
        let m = null;
        try { m = JSON.parse(text); } catch (e) { this.log.warn('ha: unparseable message'); return; }
        if (m.type === 'auth_required') {
            this.haVersion = m.ha_version || '';
            this.sock.send(JSON.stringify({ type: 'auth', access_token: this.cfg.token }));
            return;
        }
        if (m.type === 'auth_invalid') {
            /* A bad token never fixes itself: stop retrying the socket and say so on screen. */
            this.log.warn('ha: auth_invalid - the long-lived access token was refused');
            this._setLink('down', 'token refused by Home Assistant');
            this.stopped = true;
            if (this.sock) { this.sock.close(1000, 'auth invalid'); this.sock = null; }
            return;
        }
        if (m.type === 'auth_ok') {
            this.tries = 0;
            this._setLink('ws', 'authenticated' + (this.haVersion ? ' (HA ' + this.haVersion + ')' : ''));
            this._stopRest();
            this._afterAuth();
            return;
        }
        if (m.type === 'result') {
            const w = this.waiting.get(m.id);
            if (!w) return;
            clearTimeout(w.timer);
            this.waiting.delete(m.id);
            if (m.success) w.resolve(m.result);
            else w.reject(new Error((m.error && m.error.message) || 'call failed'));
            return;
        }
        if (m.type === 'event') { this._event(m.event); return; }
        if (m.type === 'pong') { this.pongBy = 0; return; }
    }

    _afterAuth() {
        const types = ['state_changed'].concat(this.cfg.extraEvents || []);
        types.forEach((t) => {
            this._send({ type: 'subscribe_events', event_type: t })
                .then((r) => { this.subs[t] = r; })
                .catch((e) => this.log.warn('ha: subscribe ' + t + ': ' + e.message));
        });
        this._send({ type: 'get_states' }).then((rows) => {
            const next = {};
            (rows || []).forEach((s) => { next[s.entity_id] = s; });
            this.states = next;
            this._emit('states');
        }).catch((e) => this.log.warn('ha: get_states: ' + e.message));
        this._ping();
    }

    _ping() {
        if (this.pingTimer) clearTimeout(this.pingTimer);
        this.pingTimer = setTimeout(() => {
            if (!this.sock || !this.sock.open) return;
            if (this.pongBy && Date.now() > this.pongBy) {
                this.log.warn('ha: no pong, dropping the socket');
                this.sock.close(1001, 'no pong');
                return;
            }
            this.pongBy = Date.now() + PING_GRACE_MS;
            this._send({ type: 'ping' }).then(() => { this.pongBy = 0; }).catch(() => {});
            this._ping();
        }, PING_MS);
        if (this.pingTimer.unref) this.pingTimer.unref();
    }

    _event(ev) {
        if (!ev) return;
        if (ev.event_type === 'state_changed') {
            const d = ev.data || {};
            if (!d.entity_id) return;
            if (d.new_state) this.states[d.entity_id] = d.new_state;
            else delete this.states[d.entity_id];
            this._emit('state', d.entity_id, d.new_state || null);
            return;
        }
        this._emit('event', ev);
    }

    /** A WebSocket command with an id. Resolves with its result. */
    _send(msg) {
        return new Promise((resolve, reject) => {
            if (!this.sock || !this.sock.open) { reject(new Error('not connected')); return; }
            const id = this.id++;
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error('timed out'));
            }, CALL_TIMEOUT_MS);
            if (timer.unref) timer.unref();
            this.waiting.set(id, { resolve: resolve, reject: reject, timer: timer });
            const out = Object.assign({ id: id }, msg);
            if (!this.sock.send(JSON.stringify(out))) {
                clearTimeout(timer);
                this.waiting.delete(id);
                reject(new Error('socket would not take the message'));
            }
        });
    }

    /* ---------------- services ---------------- */

    /**
     * Call a service. Over the socket when it is up, over REST otherwise, so a button still works
     * on a flaky link. data may carry entity_id, brightness, and so on.
     */
    call(domain, service, data) {
        const body = { domain: domain, service: service, service_data: data || {} };
        if (this.sock && this.sock.open && this.link === 'ws') {
            return this._send({ type: 'call_service', domain: domain, service: service, service_data: data || {} })
                .catch((e) => {
                    this.log.warn('ha: call_service over ws failed (' + e.message + '), trying REST');
                    return this.rest('POST', '/api/services/' + domain + '/' + service, body.service_data);
                });
        }
        return this.rest('POST', '/api/services/' + domain + '/' + service, body.service_data);
    }

    /* ---------------- REST ---------------- */

    /**
     * One REST request. path starts with '/'. Resolves with the parsed JSON body (or the raw
     * Buffer when it is not JSON). Rejects on a non-2xx status.
     */
    rest(method, path, body, opts) {
        const o = opts || {};
        return new Promise((resolve, reject) => {
            if (!this.cfg.baseUrl || !this.cfg.token) { reject(new Error('ha.json has no baseUrl or token')); return; }
            const u = url.parse(this.cfg.baseUrl);
            const secure = u.protocol === 'https:';
            const lib = secure ? https : http;
            const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
            const headers = {
                Authorization: 'Bearer ' + this.cfg.token,
                Accept: o.accept || 'application/json',
            };
            if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
            const req = lib.request({
                protocol: u.protocol, hostname: u.hostname, port: u.port || (secure ? 443 : 80),
                method: method, path: path, headers: headers,
                rejectUnauthorized: secure ? this.cfg.verifyTls !== false : undefined,
                ca: secure ? (this.cfg.ca || undefined) : undefined,
            }, (res) => {
                const parts = [];
                let n = 0;
                const cap = o.maxBytes || 4 * 1024 * 1024;
                res.on('data', (d) => {
                    n += d.length;
                    if (n > cap) { req.abort(); reject(new Error('response over ' + cap + ' bytes')); return; }
                    parts.push(d);
                });
                res.on('end', () => {
                    const buf = Buffer.concat(parts);
                    if (!(res.statusCode >= 200 && res.statusCode < 300)) {
                        reject(new Error('HTTP ' + res.statusCode + ' ' + path + ' ' + buf.slice(0, 200).toString('utf8')));
                        return;
                    }
                    if (o.raw) { resolve(buf); return; }
                    try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { resolve(buf); }
                });
            });
            req.setTimeout(o.timeout || CALL_TIMEOUT_MS, () => { req.abort(); reject(new Error('REST timed out')); });
            req.on('error', (e) => reject(e));
            if (payload) req.write(payload);
            req.end();
        });
    }

    /** The REST fallback: a slow poll of /api/states while the socket is away. */
    _startRest() {
        if (this.restTimer || this.stopped) return;
        const poll = () => {
            this.rest('GET', '/api/states').then((rows) => {
                if (this.link === 'ws') return;
                const next = {};
                (rows || []).forEach((s) => { if (s && s.entity_id) next[s.entity_id] = s; });
                this.states = next;
                this._setLink('rest', 'polling /api/states');
                this._emit('states');
            }).catch((e) => this._setLink('down', e.message));
        };
        poll();
        this.restTimer = setInterval(poll, REST_POLL_MS);
        if (this.restTimer.unref) this.restTimer.unref();
    }

    _stopRest() {
        if (!this.restTimer) return;
        clearInterval(this.restTimer);
        this.restTimer = null;
    }
}

module.exports = { Ha };
