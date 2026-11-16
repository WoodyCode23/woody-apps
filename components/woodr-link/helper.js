'use strict';
/**
 * helper.js - the only thing on the head unit that may steer Tailscale (woodr-link-helper.service, root).
 *
 * Tailscale's own daemon (tailscaled, fetched from pkgs.tailscale.com by fetch-tailscale.sh, BSD-3-Clause) runs
 * beside this as woodr-link.service. It can do far more than a car should: act as an exit node, route a subnet,
 * serve SSH, take the car's DNS. Apps therefore never talk to it. They talk to this helper, which offers four
 * requests and nothing else, and which puts the daemon's settings back to the car policy whenever they differ:
 *
 *     status                         what the daemon says, reduced to what a screen needs
 *     connect                        log in (the daemon gives a link, the app shows it as a QR) or come back up
 *     disconnect                     stay logged in, go off the tailnet
 *     logout                         forget the login
 *
 * The car policy (POLICY below), enforced on every poll:
 *     shields up        nothing on the tailnet can open a connection to the head unit
 *     no exit node      the car's traffic is never sent through another machine, and it never offers to be one
 *     no routes         it advertises none and accepts none
 *     no Tailscale DNS  the head unit's name lookups stay as BMW set them
 *     no Tailscale SSH
 * The daemon runs in userspace-networking mode with no proxy, so the car's own network settings are never
 * touched and no program on the head unit can reach the tailnet through it. Until a later feature opens
 * something on purpose, a connected car is simply present on the owner's tailnet.
 *
 * The socket: /run/woodr-link/link.sock, 0660 root:tm_oap_app (every app has the group), one JSON object per
 * line each way. The helper sends {type:'state',...} on connect, after each request and whenever it changes.
 *
 * Node 8 (the head unit's): no optional chaining, no object spread. Written for this repository from
 * Tailscale's published LocalAPI (ipn/localapi), not from any other car app.
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const TS_SOCK = process.env.WOODR_LINK_TS_SOCK || '/run/woodr-link/tailscaled.sock';
const TS_TCP = process.env.WOODR_LINK_TS_TCP || '';             /* host:port, for tests through a forwarded socket */
const SOCK = process.env.WOODR_LINK_SOCK || '/run/woodr-link/link.sock';
const GROUP = process.env.WOODR_LINK_GROUP || 'tm_oap_app';
const POLL_MS = 2000, IDLE_POLL_MS = 15000;

/** Settings the helper holds the daemon to. Each is [field, wanted value]. */
const POLICY = Object.freeze([
    ['ShieldsUp', true], ['RouteAll', false], ['CorpDNS', false], ['RunSSH', false],
    ['ExitNodeID', ''], ['AdvertiseRoutes', null],
]);

const log = (s) => { try { process.stdout.write('woodr-link: ' + s + '\n'); } catch (e) { /* no stdout */ } };

/* ---------------- Tailscale's LocalAPI ---------------- */

function api(method, name, body) {
    return new Promise((resolve) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const opts = { method: method, path: '/localapi/v0/' + name, headers: { Host: 'local-tailscaled.sock' }, timeout: 8000 };
        if (TS_TCP) { opts.host = TS_TCP.split(':')[0]; opts.port = Number(TS_TCP.split(':')[1]); } else opts.socketPath = TS_SOCK;
        if (data) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = data.length; }
        let done = false;
        const end = (r) => { if (!done) { done = true; resolve(r); } };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain text reply */ }
                end({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, json: json, text: text.slice(0, 200) });
            });
        });
        req.on('timeout', () => { req.abort(); end({ ok: false, code: 0, text: 'timeout' }); });
        req.on('error', (e) => end({ ok: false, code: 0, text: e.code || e.message }));
        if (data) req.write(data);
        req.end();
    });
}

function offPolicy(prefs) {
    if (!prefs) return [];
    return POLICY.filter((p) => {
        const v = prefs[p[0]];
        if (p[0] === 'AdvertiseRoutes') return Array.isArray(v) && v.length > 0;
        if (p[0] === 'ExitNodeID') return !!v || (!!prefs.ExitNodeIP && prefs.ExitNodeIP !== 'invalid IP');
        return v !== p[1];
    }).map((p) => p[0]);
}

function policyPatch(extra) {
    const m = { ExitNodeIP: '', ExitNodeIPSet: true };
    POLICY.forEach((p) => { m[p[0]] = p[1]; m[p[0] + 'Set'] = true; });
    Object.keys(extra || {}).forEach((k) => { m[k] = extra[k]; m[k + 'Set'] = true; });
    return m;
}

/* ---------------- state ---------------- */

const state = { type: 'state', daemon: false, backend: 'unknown', authUrl: '', name: '', tailnet: '', ips: [], online: false,
    health: [], version: '', policy: 'unknown', note: '' };
const clients = new Set();
let lastSent = '';

function publish(force) {
    const line = JSON.stringify(state) + '\n';
    if (!force && line === lastSent) return;
    lastSent = line;
    clients.forEach((c) => { try { c.write(line); } catch (e) { /* gone */ } });
}

async function poll() {
    const st = await api('GET', 'status');
    if (!st.ok || !st.json) {
        state.daemon = false; state.backend = 'unknown'; state.authUrl = ''; state.online = false; state.ips = [];
        state.note = st.code === 0 ? 'Tailscale is not running (' + st.text + ')' : 'Tailscale answered ' + st.code;
        return publish();
    }
    const s = st.json, self = s.Self || {};
    state.daemon = true;
    state.backend = String(s.BackendState || 'unknown');
    state.authUrl = String(s.AuthURL || '');
    state.version = String(s.Version || '').split('-')[0];
    state.name = String(self.HostName || '');
    state.ips = (s.TailscaleIPs || self.TailscaleIPs || []).slice(0, 2);
    state.online = !!self.Online;
    state.tailnet = s.CurrentTailnet && s.CurrentTailnet.Name ? String(s.CurrentTailnet.Name) : '';
    state.health = (s.Health || []).slice(0, 3).map((h) => String(h).slice(0, 160));
    if (state.note.indexOf('Tailscale') === 0) state.note = '';

    const pr = await api('GET', 'prefs');
    if (pr.ok && pr.json) {
        const off = offPolicy(pr.json);
        if (off.length) {
            log('settings off the car policy (' + off.join(', ') + '): putting them back');
            const fix = await api('PATCH', 'prefs', policyPatch());
            state.policy = fix.ok ? 'enforced' : 'failed';
            if (!fix.ok) state.note = 'Could not restore the car policy (' + (fix.text || fix.code) + ')';
        } else state.policy = 'ok';
    } else state.policy = 'unknown';
    publish();
}

/* ---------------- the four requests ---------------- */

const OPS = {
    status: async () => {},
    connect: async () => {
        const fix = await api('PATCH', 'prefs', policyPatch({ WantRunning: true }));
        if (!fix.ok) { state.note = 'Tailscale refused the settings (' + (fix.text || fix.code) + ')'; return; }
        const st = await api('GET', 'status');
        const b = st.json && st.json.BackendState;
        if (b === 'NeedsLogin' || b === 'NoState') {
            const r = await api('POST', 'login-interactive');
            state.note = r.ok ? '' : 'Could not start the login (' + (r.text || r.code) + ')';
        } else state.note = '';
    },
    disconnect: async () => {
        const r = await api('PATCH', 'prefs', policyPatch({ WantRunning: false }));
        state.note = r.ok ? '' : 'Could not disconnect (' + (r.text || r.code) + ')';
    },
    logout: async () => {
        const r = await api('POST', 'logout');
        state.note = r.ok ? '' : 'Could not log out (' + (r.text || r.code) + ')';
    },
};

let chain = Promise.resolve();
function run(op) {
    chain = chain.then(() => OPS[op]()).then(poll).catch((e) => { state.note = String((e && e.message) || e); publish(); });
    return chain;
}

/* ---------------- the socket apps use ---------------- */

function serve() {
    try { fs.mkdirSync(path.dirname(SOCK)); } catch (e) { /* there */ }
    try { fs.unlinkSync(SOCK); } catch (e) { /* none */ }
    const server = net.createServer((c) => {
        clients.add(c);
        c.setEncoding('utf8');
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            if (buf.length > 4096) { c.destroy(); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                let m = null;
                try { m = JSON.parse(line); } catch (e) { /* not JSON */ }
                const op = m && typeof m.op === 'string' ? m.op : '';
                if (!Object.prototype.hasOwnProperty.call(OPS, op)) { try { c.write(JSON.stringify({ type: 'error', error: 'unknown request' }) + '\n'); } catch (e) { /* gone */ } continue; }
                if (op !== 'status') log('request: ' + op);
                run(op).then(() => publish(true));
            }
        });
        const gone = () => clients.delete(c);
        c.on('close', gone); c.on('error', gone);
        try { c.write(JSON.stringify(state) + '\n'); } catch (e) { /* gone */ }
    });
    server.on('error', (e) => { log('socket: ' + e.message); process.exit(1); });
    server.listen(SOCK, () => {
        try { fs.chmodSync(SOCK, 0o660); } catch (e) { log('chmod: ' + e.message); }
        if (GROUP && process.platform !== 'win32') {
            try {
                const line = fs.readFileSync('/etc/group', 'utf8').split('\n').filter((l) => l.split(':')[0] === GROUP)[0];
                if (line) fs.chownSync(SOCK, 0, Number(line.split(':')[2])); else log('group ' + GROUP + ' not found: only root can use the socket');
            } catch (e) { log('chown: ' + e.message); }
        }
        log('listening on ' + SOCK);
    });
}

function loop() {
    chain = chain.then(poll).catch(() => {});
    const t = setTimeout(loop, clients.size ? POLL_MS : IDLE_POLL_MS);
    if (t.unref && process.env.WOODR_LINK_ONCE) t.unref();
}

if (require.main === module) { serve(); loop(); }
module.exports = { POLICY: POLICY, offPolicy: offPolicy, policyPatch: policyPatch, OPS: Object.keys(OPS) };
