'use strict';
/**
 * setup.js - telling the car where the house is, without a shell on the head unit.
 *
 * Every Home Assistant has its own address, and the car has to know it before it can even ask to pair. Settings
 * on the car only offer switches, choices and numbers, so there are two ways in:
 *
 *   1. From the phone (the usual way). While the set-up screen is open, the car listens on its own network for one
 *      page. The screen shows a QR with that page's address and a one-time code in it. The phone opens it, the owner
 *      pastes the house's address and presses Save. The phone has to be on the same network as the car, which it is
 *      when the car uses the phone's hotspot.
 *   2. On the screen (when 1 cannot work: the head unit would not let the app listen, or the phone is not on the
 *      car's network). A keyboard drawn on the screen, worked by touch or the controller. Slow, but once only.
 *
 * Either way the result is the same file the hand-written set-up used: <dataDir>/relay.json { base, name }.
 *
 * It listens on one network only, the one the QR names (a phone hotspot first, else Wi-Fi; never a VPN).
 * The page only answers with the right code, only while the screen is open, at most ten minutes, and closes for
 * good after five wrong tries. It takes one small form and nothing else: no file, no command, no redirect. It is
 * plain HTTP on the car's own network; what goes over it is the house's address, which is not a secret (the relay
 * still needs a pairing approved from an allowed phone before it shows anything).
 *
 *   const s = new Setup(dataDir, log);
 *   s.on('saved', (cfg) => ...)    relay.json was written
 *   s.on('change', () => ...)      redraw
 *   s.start() -> Promise<boolean>   listening (false: use the keyboard)
 *   s.links()                      [{ url, iface }] one per network the car is on, best first
 *   s.stop()
 *   normalise(text) -> { ok, base } | { ok: false, why }
 *   save(dataDir, base, name)      write relay.json (whole, 0600)
 *
 * No kit imports (tools/test_hass_setup.js runs it under plain Node). Nothing here throws out of a callback.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');

const PORTS = [8791, 8792, 0];
const OPEN_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_BODY = 2048;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const API = '/api/car_relay/v1';

function code(n) {
    const b = crypto.randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
    return s;
}

/**
 * What the owner typed or pasted, as the relay's base address. Takes a bare host ("abc.ui.nabu.casa"), a Home
 * Assistant address ("https://ha.example.com:8123/"), or the relay's own ("https://.../api/car_relay/v1").
 */
function normalise(text, allowHttp) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, why: 'Nothing was entered' };
    if (s.length > 200) return { ok: false, why: 'That is too long for an address' };
    if (/\s/.test(s)) return { ok: false, why: 'An address has no spaces' };
    if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new (require('url').URL)(s); } catch (e) { return { ok: false, why: 'That does not look like an address' }; }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return { ok: false, why: 'The address has to start with https://' };
    if (!u.hostname || u.hostname.indexOf('.') < 0 && u.hostname !== 'localhost') return { ok: false, why: 'That does not look like an address' };
    if (u.username || u.password) return { ok: false, why: 'Leave the user name and password out of the address' };
    if (u.search || u.hash) return { ok: false, why: 'Leave anything after ? or # out of the address' };
    let p = u.pathname.replace(/\/+$/, '');
    const at = p.indexOf(API);
    p = at >= 0 ? p.slice(0, at) : p;
    return { ok: true, base: u.protocol + '//' + u.host + p + API };
}

function save(dataDir, base, name) {
    const file = path.join(dataDir, 'relay.json'), tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ base: base, name: String(name || 'Car').slice(0, 40) }) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* best effort */ }
    fs.renameSync(tmp, file);
    return { base: base, name: String(name || 'Car').slice(0, 40) };
}

/** The car's own addresses on its networks, best guess first: a phone hotspot or a home Wi-Fi, never loopback or link-local. */
function addresses(ifaces) {
    const out = [];
    const all = ifaces || os.networkInterfaces();
    Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
        const v4 = a && (a.family === 'IPv4' || a.family === 4);
        if (!v4 || a.internal || /^127\.|^169\.254\./.test(a.address)) return;
        const rank = /^172\.20\.10\./.test(a.address) ? 0 : /^192\.168\./.test(a.address) ? 1 : /^10\./.test(a.address) ? 2 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) ? 9 : 3;
        out.push({ address: a.address, iface: name, rank: rank });
    }));
    return out.sort((x, y) => x.rank - y.rank);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(body) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'">' +
        '<title>Car set-up</title><style>body{margin:0;padding:24px;background:#0b0b0e;color:#f2f2f4;font:17px/1.45 system-ui,sans-serif}' +
        'h1{font-size:22px;margin:0 0 12px}p{color:#c9cad0}input{width:100%;box-sizing:border-box;padding:14px;font-size:17px;border-radius:10px;border:1px solid #444;background:#16161b;color:#fff}' +
        'button{margin-top:14px;width:100%;padding:14px;font-size:18px;font-weight:700;border:0;border-radius:10px;background:#ff1f3d;color:#fff}.e{color:#ff6b6b}</style></head><body>' + body + '</body></html>';
}
function form(err, value) {
    return page('<h1>Tell the car where your house is</h1>' +
        '<p>Paste your Home Assistant address, the one your phone uses away from home. In Home Assistant it is under Settings, System, Network: the Internet address (with Home Assistant Cloud, the ui.nabu.casa one).</p>' +
        (err ? '<p class="e">' + esc(err) + '</p>' : '') +
        '<form method="post"><input name="base" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://example.ui.nabu.casa" value="' + esc(value || '') + '" required>' +
        '<input name="name" maxlength="40" placeholder="Name for this car (optional)" style="margin-top:12px">' +
        '<button type="submit">Save to the car</button></form>');
}

class Setup extends EventEmitter {
    constructor(dataDir, log, opts) {
        super();
        this.dataDir = dataDir; this.log = log || { info() {}, warn() {} };
        this.opts = opts || {};
        this.server = null; this.port = 0; this.code = ''; this.until = 0; this.tries = 0;
        this.state = 'off';          /* off | starting | open | closed (tries used up) | failed (no listening) | saved */
        this.why = ''; this.timer = null;
    }

    start() {
        this.stop();
        this.code = code(8); this.tries = 0; this.why = ''; this.state = 'starting';
        this.until = Date.now() + (this.opts.openMs || OPEN_MS);
        const ports = this.opts.ports || PORTS;
        /* one network only: the car's best address that is not a VPN (a phone hotspot, else Wi-Fi), never all of them */
        const best = addresses(this.opts.ifaces).filter((a) => a.rank < 9)[0];
        this.host = this.opts.host || (best && best.address) || '';
        this.hostShown = (best && best.address) || '';
        if (!this.host) { this.state = 'failed'; this.why = 'no network'; this.log.warn('setup: the car is on no network a phone can reach: the on-screen keyboard it is'); this.emit('change'); return Promise.resolve(false); }
        const tryPort = (i) => new Promise((resolve) => {
            if (i >= ports.length) { resolve(false); return; }
            const srv = http.createServer((req, res) => { try { this._serve(req, res); } catch (e) { try { res.statusCode = 500; res.end(); } catch (x) { /* gone */ } } });
            srv.on('error', (e) => {
                try { srv.close(); } catch (x) { /* not open */ }
                this.why = e.code || e.message;
                tryPort(i + 1).then(resolve);
            });
            srv.listen(ports[i], this.host, () => { this.server = srv; this.port = srv.address().port; resolve(true); });
        });
        return tryPort(0).then((ok) => {
            if (!ok) { this.state = 'failed'; this.log.warn('setup: cannot listen (' + this.why + '): the on-screen keyboard it is'); this.emit('change'); return false; }
            if (this.state !== 'starting') { this.stop(); return false; }     /* stopped while starting */
            this.state = 'open';
            this.timer = setInterval(() => { try { if (Date.now() > this.until) { this.log.info('setup: page closed (time)'); this.stop(); this.emit('change'); } } catch (e) { /* log only */ } }, 5000);
            if (this.timer.unref) this.timer.unref();
            this.log.info('setup: page open on port ' + this.port + ' for ' + Math.round((this.until - Date.now()) / 60000) + ' min');
            this.emit('change');
            return true;
        });
    }

    links() {
        if (this.state !== 'open') return [];
        return this.hostShown ? [{ url: 'http://' + this.hostShown + ':' + this.port + '/s/' + this.code }] : [];
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.server) { try { this.server.close(); } catch (e) { /* closed */ } this.server = null; }
        if (this.state === 'open' || this.state === 'starting') this.state = 'off';
    }

    _serve(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        const url = String(req.url || '').split('?')[0];
        const send = (status, html) => { res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); };
        if (this.state !== 'open' || Date.now() > this.until) { send(410, page('<h1>This set-up page has closed</h1><p>Open the set-up screen on the car again.</p>')); return; }
        if (url !== '/s/' + this.code) {
            this.tries++;
            if (this.tries >= MAX_TRIES) { this.log.warn('setup: closed after ' + this.tries + ' wrong tries'); this.stop(); this.state = 'closed'; this.emit('change'); }
            send(404, page('<h1>Not found</h1>'));
            return;
        }
        if (req.method === 'GET') { send(200, form('', '')); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const parts = []; let size = 0, done = false;
        req.on('data', (b) => { try { size += b.length; if (size > MAX_BODY && !done) { done = true; send(413, page('<h1>Too long</h1>')); req.destroy(); } else parts.push(b); } catch (e) { /* gone */ } });
        req.on('end', () => {
            try {
                if (done) return;
                const q = require('querystring').parse(Buffer.concat(parts).toString('utf8'));
                const n = normalise(q.base, this.opts.allowHttp);
                if (!n.ok) { send(400, form(n.why, q.base)); return; }
                const cfg = save(this.dataDir, n.base, q.name);
                this.state = 'saved';
                send(200, page('<h1>Saved</h1><p>The car now knows where your house is. Look at its screen: the next step is pairing, which you approve from Home Assistant.</p>'));
                this.log.info('setup: relay.json written from the phone');
                setImmediate(() => { this.stop(); this.state = 'saved'; this.emit('saved', cfg); this.emit('change'); });
            } catch (e) { send(500, page('<h1>The car could not save it</h1><p>' + esc(e.message) + '</p>')); }
        });
    }
}

/* ---- the on-screen keyboard's model: what the keys are and what a press does. Drawing is main.js's. */
const KEYS = ['abcdefghij', 'klmnopqrst', 'uvwxyz0123', '456789.-:/'];
const WORDS = [['https://', 'https://'], ['.ui.nabu.casa', '.ui.nabu.casa'], [':8123', ':8123']];
function press(text, key) {
    text = String(text || '');
    if (key === 'del') return text.slice(0, -1);
    if (key === 'clear') return '';
    if (typeof key === 'string' && text.length + key.length <= 200) return text + key;
    return text;
}

module.exports = { Setup: Setup, normalise: normalise, save: save, addresses: addresses, KEYS: KEYS, WORDS: WORDS, press: press, OPEN_MS: OPEN_MS, MAX_TRIES: MAX_TRIES };
