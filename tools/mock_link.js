'use strict';
/**
 * mock_link.js - stands in for components/woodr-link/helper.js so Woody Link can be previewed on a PC.
 *
 *   node tools/mock_link.js <socket or pipe> [off|login|on|down]
 *
 * Serves one fixed state in the helper's format; connect / disconnect move between off, login and on.
 */
const net = require('net');

const sock = process.argv[2], start = process.argv[3] || 'off';
const BASE = { type: 'state', daemon: true, authUrl: '', name: '', tailnet: '', ips: [], online: false, health: [], version: '1.104.6', policy: 'ok', note: '' };
const STATES = {
    down: Object.assign({}, BASE, { daemon: false, backend: 'unknown', version: '', policy: 'unknown', note: 'Tailscale is not running (ENOENT)' }),
    off: Object.assign({}, BASE, { backend: 'NeedsLogin', health: ['Tailscale is stopped.'] }),
    login: Object.assign({}, BASE, { backend: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/0123456789abcdef' }),
    on: Object.assign({}, BASE, { backend: 'Running', name: 'm3', tailnet: 'example.ts.net', ips: ['100.64.0.7'], online: true }),
};
let cur = STATES[start] ? start : 'off';
const clients = new Set();
const tell = () => clients.forEach((c) => c.write(JSON.stringify(STATES[cur]) + '\n'));

net.createServer((c) => {
    clients.add(c);
    c.setEncoding('utf8');
    c.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => {
        let m = {}; try { m = JSON.parse(l); } catch (e) { /* ignore */ }
        if (m.op === 'connect') cur = cur === 'off' ? 'login' : 'on';
        else if (m.op === 'disconnect' || m.op === 'logout') cur = 'off';
        tell();
    }));
    c.on('close', () => clients.delete(c)); c.on('error', () => clients.delete(c));
    c.write(JSON.stringify(STATES[cur]) + '\n');
}).listen(sock, () => console.log('mock link on ' + sock + ' (' + cur + ')'));
