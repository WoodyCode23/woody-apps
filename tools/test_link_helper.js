'use strict';
/**
 * test_link_helper.js - drive components/woodr-link/helper.js through its socket and print what it says.
 *
 *   node tools/test_link_helper.js <socket> status|connect|disconnect|logout [waitSeconds]
 *
 * Also checks the helper's policy functions when run with no arguments (no daemon needed).
 */
const net = require('net');
const assert = require('assert');

if (process.argv.length < 4) {
    const h = require('../components/woodr-link/helper');
    assert.deepStrictEqual(h.OPS.sort(), ['connect', 'disconnect', 'logout', 'status']);
    const good = { ShieldsUp: true, RouteAll: false, CorpDNS: false, RunSSH: false, ExitNodeID: '', ExitNodeIP: '', AdvertiseRoutes: null };
    assert.deepStrictEqual(h.offPolicy(good), []);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { ShieldsUp: false })), ['ShieldsUp']);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { RunSSH: true, CorpDNS: true })), ['CorpDNS', 'RunSSH']);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { ExitNodeID: 'n123' })), ['ExitNodeID']);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { ExitNodeIP: '100.64.0.1' })), ['ExitNodeID']);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { AdvertiseRoutes: ['10.0.0.0/8'] })), ['AdvertiseRoutes']);
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { AdvertiseRoutes: [] })), []);
    const p = h.policyPatch({ WantRunning: true });
    assert.strictEqual(p.ShieldsUp, true); assert.strictEqual(p.ShieldsUpSet, true);
    assert.strictEqual(p.WantRunning, true); assert.strictEqual(p.WantRunningSet, true);
    assert.strictEqual(p.ExitNodeIPSet, true); assert.strictEqual(p.RunSSH, false);
    console.log('helper policy: ok');
    process.exit(0);
}

const sock = process.argv[2], op = process.argv[3], wait = Number(process.argv[4] || 6) * 1000;
const c = net.connect(sock);
c.setEncoding('utf8');
c.on('connect', () => c.write(JSON.stringify({ op: op }) + '\n'));
c.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => {
    const m = JSON.parse(l);
    if (m.authUrl) m.authUrl = m.authUrl.replace(/\/a\/.*/, '/a/<hidden>');
    console.log(JSON.stringify(m));
}));
c.on('error', (e) => { console.log('socket error: ' + e.message); process.exit(1); });
setTimeout(() => process.exit(0), wait);
