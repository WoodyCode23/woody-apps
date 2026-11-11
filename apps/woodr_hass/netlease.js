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
 * Network access itself is gated per uid (/var/opt/mgu-uplink/uids.d). An app's uid lands there
 * when its package.json says "mguInternet": true - app.json "internet": true, via build.py.
 */
const fs = require('fs');
const dns = require('dns');

const LEASE = process.env.MGU_UPLINK_LEASE || '/run/mgu-uplink/lease.json';

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
    const servers = leaseServers();
    if (!servers) return dns.lookup(hostname, { family: 4 }, (err, addr) => done(err, addr));
    const r = new dns.Resolver();
    r.setServers(servers);
    r.resolve4(hostname, (err, addrs) => {
        if (err || !addrs || !addrs.length) return done(err || new Error('no address for ' + hostname + ' via the uplink lease'));
        done(null, addrs[0]);
    });
}

/** what the uplink is using now, for the status screen ("wlan0 192.168.1.40", or null) */
function current() {
    try { const l = JSON.parse(fs.readFileSync(LEASE, 'utf8')); return l.interface + ' ' + l.ip; } catch (e) { return null; }
}

module.exports = { lookup: lookup, leaseServers: leaseServers, current: current };
