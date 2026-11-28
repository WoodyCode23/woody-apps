'use strict';
/**
 * link.js - the app's side of components/woodr-link/helper.js.
 *
 * /run/woodr-link/link.sock, one JSON object per line each way. The helper sends its whole state on connect,
 * after each request and whenever it changes. The requests are all there is: status, connect, disconnect, logout,
 * and asking for SSH on or off. Whether SSH opens is the helper's decision, from the tailnet's own rules; nothing
 * here (or anywhere in the app) can change what Tailscale is allowed to do on the car.
 */
const net = require('net');
const EventEmitter = require('events');

const SOCK = process.env.WOODR_LINK_SOCK || '/run/woodr-link/link.sock';
const EMPTY = Object.freeze({ daemon: false, backend: 'unknown', authUrl: '', name: '', tailnet: '', ips: [], online: false, health: [], version: '', policy: 'unknown', note: '', ssh: 'off', sshWhy: '' });

class Link extends EventEmitter {
    constructor(path) {
        super();
        this.path = path || SOCK;
        this.sock = null; this.buf = ''; this.up = false; this.timer = null; this.closed = false;
        this.state = EMPTY;
        this.why = 'starting';                 /* why there is no helper, when there is none */
    }

    start() {
        if (this.sock || this.closed) return;
        let s;
        try { s = net.connect(this.path); } catch (e) { this.why = e.code || e.message; this._retry(); return; }
        this.sock = s;
        s.setEncoding('utf8');
        s.on('connect', () => { this.up = true; this.why = ''; this.emit('change'); });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { this.why = e.code || e.message; });
        s.on('close', () => {
            this.sock = null; this.buf = '';
            if (this.up) { this.up = false; this.state = EMPTY; this.emit('change'); }
            this._retry();
        });
    }

    _retry() {
        if (this.closed || this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.start(); }, 3000);
        if (this.timer.unref) this.timer.unref();
    }

    _data(d) {
        this.buf += d;
        if (this.buf.length > 65536) { this.buf = ''; return; }
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
            if (!line.trim()) continue;
            let m; try { m = JSON.parse(line); } catch (e) { continue; }
            if (m && m.type === 'state') { this.state = m; this.emit('change'); }
        }
    }

    _send(op) {
        if (!this.sock || !this.up) return false;
        try { this.sock.write(JSON.stringify({ op: op }) + '\n'); return true; } catch (e) { return false; }
    }

    connect() { return this._send('connect'); }
    disconnect() { return this._send('disconnect'); }
    logout() { return this._send('logout'); }
    sshOn() { return this._send('ssh-on'); }
    sshOff() { return this._send('ssh-off'); }

    stop() { this.closed = true; clearTimeout(this.timer); this.timer = null; if (this.sock) { this.sock.destroy(); this.sock = null; } }
}

/**
 * What the screen should say, from the helper's state:
 *   { key, title, line, action }   action = 'connect' | 'disconnect' | null (what the main button does now)
 */
function view(link) {
    const s = link.state;
    if (!link.up) return { key: 'none', title: 'Not installed', line: 'The Link service is not running on this car (' + (link.why || 'no answer') + ').', action: null };
    if (!s.daemon) return { key: 'down', title: 'Starting', line: s.note || 'Waiting for Tailscale to start.', action: null };
    if (s.backend === 'Running') return { key: 'on', title: 'Connected', line: s.tailnet ? 'On ' + s.tailnet : 'On your tailnet', action: 'disconnect' };
    if (s.backend === 'NeedsLogin' && s.authUrl) return { key: 'login', title: 'Log in', line: 'Scan with your phone and approve this car in your own Tailscale account.', action: 'disconnect' };
    if (s.backend === 'NeedsMachineAuth') return { key: 'wait', title: 'Waiting for approval', line: 'Approve this device in the Tailscale admin console.', action: 'disconnect' };
    if (s.backend === 'Starting') return { key: 'wait', title: 'Connecting', line: 'Reaching Tailscale.', action: 'disconnect' };
    if (s.backend === 'NeedsLogin') return { key: 'off', title: 'Not logged in', line: 'Press Connect to get a login code.', action: 'connect' };
    if (s.backend === 'Stopped') return { key: 'off', title: 'Disconnected', line: 'Logged in, off the tailnet.', action: 'connect' };
    return { key: 'off', title: 'Off', line: s.note || 'Press Connect.', action: 'connect' };
}

module.exports = { Link: Link, view: view, SOCK: SOCK };
