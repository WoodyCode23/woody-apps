'use strict';
/**
 * Name lookup through mgu-uplink's current lease.
 *
 * The head unit's resolver (/etc/resolv.conf -> 127.0.0.1, BMW's dnsmasq) does not answer for
 * public names, so getaddrinfo fails with ENOTFOUND. mgu-updater resolves through the DNS servers
 * of the uplink's lease instead (/run/mgu-uplink/lease.json); this does the same.
 *
 * The lease is read on every lookup, not once: it changes when the car moves from home Wi-Fi to
 * a phone hotspot or USB tethering, and a cached server list would then point at a network the
 * car is no longer on.
 *
 * A lookup from the car fails or hangs now and then (a 38 s timeout was measured), so each server gets
 * LOOKUP_MS, the next server is tried, and the last address that worked is reused: at once while it is
 * REUSE_MS young, and for KEEP_MS when no server answers.
 *
 * Network access itself is gated per uid (/var/opt/mgu-uplink/uids.d). An app's uid lands there
 * when its package.json says "mguInternet": true - app.json "internet": true, via build.py.
 */
const fs = require('fs');
const dns = require('dns');

const LEASE = process.env.MGU_UPLINK_LEASE || '/run/mgu-uplink/lease.json';

const LOOKUP_MS = 3000, REUSE_MS = 2 * 60000, KEEP_MS = 15 * 60000;
const known = {};                     /* hostname -> { addr, at } */

/** one server, one question, an answer or an error within LOOKUP_MS */
function ask(server, hostname, cb) {
    let done = false, r = null, t = null;
    const fin = (err, addrs) => { if (done) return; done = true; if (t) clearTimeout(t); cb(err, addrs); };
    t = setTimeout(() => { fin(new Error('name lookup timed out')); try { if (r) r.cancel(); } catch (e) { /* gone */ } }, LOOKUP_MS);
    try { r = new dns.Resolver(); r.setServers([server]); r.resolve4(hostname, fin); } catch (e) { fin(e); }
}

function leaseServers() {
    try {
        const l = JSON.parse(fs.readFileSync(LEASE, 'utf8'));
        return Array.isArray(l.dns) && l.dns.length ? l.dns : null;
    } catch (e) { return null; }
}

/** a net/tls `lookup` option. Falls back to the system resolver off the car (preview, desktop). */
function lookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    /* newer Node asks for every address ({ all: true }) and expects a list; Node 8 on the car never does */
    const done = (err, addr) => (err ? cb(err) : options && options.all ? cb(null, [{ address: addr, family: 4 }]) : cb(null, addr, 4));
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return process.nextTick(done, null, hostname);
    const had = known[hostname];
    if (had && Date.now() - had.at < REUSE_MS) return process.nextTick(done, null, had.addr);
    const servers = leaseServers();
    if (!servers) return dns.lookup(hostname, { family: 4 }, (err, addr) => done(err, addr));
    let i = 0;
    const next = (lastErr) => {
        if (i >= servers.length) {
            const old = known[hostname];
            if (old && Date.now() - old.at < KEEP_MS) return done(null, old.addr);
            return done(lastErr || new Error('no address via the uplink lease'));
        }
        ask(servers[i++], hostname, (err, addrs) => {
            if (err || !addrs || !addrs.length) return next(err || new Error('no address via the uplink lease'));
            known[hostname] = { addr: addrs[0], at: Date.now() };
            done(null, addrs[0]);
        });
    };
    next(null);
}

/** what the uplink is using now, for the status screen ("wlan0 192.168.1.40", or null) */
function current() {
    try { const l = JSON.parse(fs.readFileSync(LEASE, 'utf8')); return l.interface + ' ' + l.ip; } catch (e) { return null; }
}

module.exports = { lookup: lookup, leaseServers: leaseServers, current: current };
