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
 *   ha.setWanted(['light.porch', ...])         // the only entities followed (subscribe_entities / per-entity REST)
 *   ha.get('light.porch')                      // last known state object, or null
 *   ha.fresh('cover.garage')                   // the same, but null unless the link is live: use it to ACT or to show
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
const lease = require('./netlease');

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
        this.wanted = [];            /* entity ids followed */
        this.entSub = null;          /* subscribe_entities message id */
        this.entFirst = false;
        this.lastPollOk = 0;         /* REST: when every wanted entity was last read */
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
        this.waiting.forEach((w) => { clearTimeout(w.timer); w.reject(new Error('connection went away - it may still have happened')); });
        this.entSub = null;
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
    /** Known AND current: the socket is up (live subscription) or the REST poll just succeeded. */
    fresh(entityId) {
        const live = this.link === 'ws' || (this.link === 'rest' && Date.now() - this.lastPollOk < REST_POLL_MS * 2 + 5000);
        return live ? this.get(entityId) : null;
    }

    /** Follow only these entities. Resubscribes when the list changes (a new dashboard definition). */
    setWanted(list) {
        const next = (list || []).filter((e) => typeof e === 'string' && e.indexOf('.') > 0).sort();
        if (next.join(',') === this.wanted.join(',')) return;
        this.wanted = next;
        if (this.link === 'ws') this._subscribeEntities();
    }
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
        if (!m || typeof m !== 'object') return;
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
        if (m.type === 'result' || m.type === 'pong') {
            const w = this.waiting.get(m.id);
            if (!w) return;
            clearTimeout(w.timer);
            this.waiting.delete(m.id);
            if (m.type === 'pong' || m.success) w.resolve(m.result);
            else w.reject(new Error((m.error && m.error.message) || 'call failed'));
            return;
        }
        if (m.type === 'event') {
            if (this.entSub !== null && m.id === this.entSub) this._entities(m.event);
            else this._event(m.event);
            return;
        }
    }

    _afterAuth() {
        /* Never all of state_changed: a house has hundreds of entities and this may be a phone hotspot. */
        (this.cfg.extraEvents || []).filter((t) => t !== 'state_changed').forEach((t) => {
            this._send({ type: 'subscribe_events', event_type: t })
                .then((r) => { this.subs[t] = r; })
                .catch((e) => this.log.warn('ha: subscribe ' + t + ': ' + e.message));
        });
        this.entSub = null;
        this._subscribeEntities();
        this._ping();
    }

    /**
     * subscribe_entities (HA 2021.4+): the first event carries every wanted entity ('a'), later ones
     * only what changed ('c': '+' added/changed keys, '-' removed attribute keys) or went away ('r').
     */
    _subscribeEntities() {
        if (this.entSub !== null) {
            const old = this.entSub;
            this.entSub = null;
            this._send({ type: 'unsubscribe_events', subscription: old }).catch(() => {});
        }
        if (!this.wanted.length) { this.states = {}; this._emit('states'); return; }
        const id = this.id;            /* the id _send gives this message; the subscription's events carry it */
        this.entFirst = true;
        this.entSub = id;
        this._send({ type: 'subscribe_entities', entity_ids: this.wanted.slice() })
            .catch((e) => { if (this.entSub === id) this.entSub = null; this.log.warn('ha: subscribe_entities: ' + e.message); });
    }

    _entities(ev) {
        if (!ev) return;
        const first = this.entFirst;
        this.entFirst = false;
        const changed = [];
        const at = (x) => (typeof x === 'number' ? new Date(x * 1000).toISOString() : undefined);
        if (first) this.states = {};
        Object.keys(ev.a || {}).forEach((id) => {
            const c = ev.a[id] || {};
            this.states[id] = { entity_id: id, state: c.s, attributes: c.a || {}, last_changed: at(c.lc), last_updated: at(c.lu || c.lc) };
            changed.push(id);
        });
        Object.keys(ev.c || {}).forEach((id) => {
            const prev = this.states[id] || { entity_id: id, state: undefined, attributes: {} };
            const d = ev.c[id] || {}, plus = d['+'] || {}, minus = d['-'] || {};
            const st = { entity_id: id, state: prev.state, attributes: Object.assign({}, prev.attributes), last_changed: prev.last_changed, last_updated: prev.last_updated };
            if (plus.s !== undefined) st.state = plus.s;
            if (plus.a) Object.assign(st.attributes, plus.a);
            (minus.a || []).forEach((k) => { delete st.attributes[k]; });
            if (plus.lc !== undefined) st.last_changed = at(plus.lc);
            if (plus.lu !== undefined || plus.lc !== undefined) st.last_updated = at(plus.lu || plus.lc);
            this.states[id] = st;
            changed.push(id);
        });
        (ev.r || []).forEach((id) => { delete this.states[id]; changed.push(id); });
        /* the first event is a snapshot, not a change: no 'state' events (the doorbell must not ring on connect) */
        if (first) { this._emit('states'); return; }
        changed.forEach((id) => this._emit('state', id, this.states[id] || null));
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
            const notSent = (why) => { const e = new Error(why); e.notSent = true; return e; };
            if (!this.sock || !this.sock.open) { reject(notSent('not connected')); return; }
            const id = this.id++;
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error('no answer in ' + Math.round(CALL_TIMEOUT_MS / 1000) + ' s - it may still have happened'));
            }, CALL_TIMEOUT_MS);
            if (timer.unref) timer.unref();
            this.waiting.set(id, { resolve: resolve, reject: reject, timer: timer });
            const out = Object.assign({ id: id }, msg);
            if (!this.sock.send(JSON.stringify(out))) {
                clearTimeout(timer);
                this.waiting.delete(id);
                reject(notSent('socket would not take the message'));
            }
        });
    }

    /* ---------------- services ---------------- */

    /**
     * Call a service. Over the socket when it is up, over REST otherwise, so a button still works
     * on a flaky link; never both for one press. data may carry entity_id, brightness, and so on.
     */
    call(domain, service, data) {
        const body = { domain: domain, service: service, service_data: data || {} };
        if (this.sock && this.sock.open && this.link === 'ws') {
            return this._send({ type: 'call_service', domain: domain, service: service, service_data: data || {} })
                .catch((e) => {
                    /* Resend only what never left. A late or lost answer may mean it DID happen, and a
                     * second open/close/toggle would undo or repeat it. */
                    if (!e.notSent) throw e;
                    this.log.warn('ha: call_service not sent over ws (' + e.message + '), sending over REST');
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
                lookup: lease.lookup,
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
        /* only the wanted entities, one small request each (never the whole /api/states dump) */
        const poll = () => {
            const ids = this.wanted.slice();
            if (!ids.length) return;
            Promise.all(ids.map((id) => this.rest('GET', '/api/states/' + encodeURIComponent(id), null, { maxBytes: 256 * 1024 })
                .then((st) => ({ id: id, s: st }))
                .catch((e) => (/^HTTP 404/.test(e.message) ? { id: id, s: null } : Promise.reject(e)))))
                .then((rows) => {
                    if (this.link === 'ws') return;
                    const before = this.states;
                    const next = {};
                    rows.forEach((x) => { if (x.s && x.s.entity_id) next[x.id] = x.s; });
                    this.states = next;
                    const first = this.link !== 'rest';
                    this.lastPollOk = Date.now();
                    this._setLink('rest', 'polling ' + ids.length + ' entities');
                    if (first) { this._emit('states'); return; }
                    rows.forEach((x) => {
                        const a = before[x.id], b = next[x.id];
                        if ((a && a.state) !== (b && b.state) || (a && a.last_updated) !== (b && b.last_updated)) this._emit('state', x.id, b || null);
                    });
                })
                .catch((e) => this._setLink('down', e.message));
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
