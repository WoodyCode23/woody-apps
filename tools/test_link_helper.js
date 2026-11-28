'use strict';
/**
 * test_link_helper.js - drive components/woodr-link/helper.js through its socket and print what it says.
 *
 *   node tools/test_link_helper.js <socket> status|connect|disconnect|logout|ssh-on|ssh-off [waitSeconds]
 *
 * Also checks the helper's policy functions when run with no arguments (no daemon needed).
 */
const net = require('net');
const assert = require('assert');

if (process.argv.length < 4) {
    const h = require('../components/woodr-link/helper');
    assert.deepStrictEqual(h.OPS.sort(), ['connect', 'disconnect', 'logout', 'ssh-off', 'ssh-on', 'status']);
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
    /* shields: up unless SSH is open; while it is open, shields down is the policy and shields up is off it */
    assert.deepStrictEqual(h.offPolicy(Object.assign({}, good, { ShieldsUp: false }), false), []);
    assert.deepStrictEqual(h.offPolicy(good, false), ['ShieldsUp']);
    assert.strictEqual(h.policyPatch(null, false).ShieldsUp, false);
    assert.strictEqual(h.policyPatch(null, false).RunSSH, false, 'never Tailscale SSH: the head unit\'s own sshd and keys');
    assert.strictEqual(h.policyPatch(null).ShieldsUp, true);
    /* SSH opens only for rules that let nothing but port 22 reach the car; anything unreadable or wider keeps it shut */
    const port = (a, b, ip) => ({ IP: ip || '100.100.1.2', Ports: { First: a, Last: b } });
    assert.deepStrictEqual(h.sshOnly([{ SrcIPs: ['100.64.0.5'], DstPorts: [port(22, 22)] }]), []);
    assert.deepStrictEqual(h.sshOnly([{ SrcIPs: ['*'], DstPorts: [port(22, 22), port(22, 22, 'fd7a::1')] }, { SrcIPs: ['x'], CapGrant: [{}] }]), []);
    assert.strictEqual(h.sshOnly([{ SrcIPs: ['*'], DstPorts: [port(0, 65535, '*')] }]).length, 1, 'Tailscale\'s default allow-all keeps it shut');
    assert.ok(/every port/.test(h.sshOnly([{ SrcIPs: ['*'], DstPorts: [port(0, 65535, '*')] }])[0]));
    assert.strictEqual(h.sshOnly([{ DstPorts: [port(22, 22)] }, { DstPorts: [port(8080, 8080)] }]).length, 1);
    assert.strictEqual(h.sshOnly([{ DstPorts: [port(20, 25)] }]).length, 1);
    assert.strictEqual(h.sshOnly([]).length, 1, 'no openings at all: nothing to open SSH for');
    assert.strictEqual(h.sshOnly([{ CapGrant: [{}] }]).length, 1);
    assert.strictEqual(h.sshOnly(null).length, 1, 'rules that cannot be read keep it shut');
    assert.strictEqual(h.sshOnly({}).length, 1);
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
