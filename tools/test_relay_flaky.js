'use strict';
/* A relay that drops polls on purpose, to check the car side rides through it. Node 8 syntax only.
 * npx -y node@8.16.2 tools/test_relay_flaky.js apps/woodr_hass   (takes about 30 s) */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.CAR_RELAY_DEV = '1';
const app = path.resolve(process.argv[2] || "apps/woodr_hass");
const Relay = require(path.join(app, 'relay.js')).Relay;
const netlease = require(path.join(app, 'netlease.js'));

let mode = 'ok', polls = 0, sockets = 0, seq = 1;
const srv = http.createServer((req, res) => {
    if (req.url.indexOf('/api/car_relay/v1/poll') !== 0) { res.writeHead(404); return res.end(); }
    polls++;
    if (mode === 'drop-one') { mode = 'ok'; return req.socket.destroy(); }
    if (mode === 'down') return req.socket.destroy();
    const wait = /wait=0/.test(req.url) ? 0 : 400;
    setTimeout(() => {
        const body = JSON.stringify({ seq: seq, session: { unlocked: true, reason: 'ok' }, tiles: [{ id: 'g', kind: 'cover', state: 'closed', ok: true }], events: [] });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    }, wait);
});
srv.on('connection', () => { sockets++; });

const lines = [];
const log = { info: (m) => lines.push('info ' + m), warn: (m) => lines.push('warn ' + m) };
const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

srv.listen(0, '127.0.0.1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaytest-'));
    fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ base: 'http://127.0.0.1:' + srv.address().port + '/api/car_relay/v1' }));
    fs.writeFileSync(path.join(dir, 'relay-token.json'), JSON.stringify({ token: 'dev.secret' }));
    const r = new Relay(dir, log);
    let changes = 0;
    r.on('change', () => { changes++; });
    r.start();
    sleep(1500).then(() => {
        ok('online and fresh after the first polls', r.online && r.fresh() && r.session.unlocked);
        ok('polls share one kept-alive connection', polls >= 3 && sockets === 1);
        ok('the start line does not name the host', lines[0] === 'info relay: paired');
        ok('the session reason is logged once', lines.filter((l) => l === 'info relay: session unlocked').length === 1);
        mode = 'drop-one';
        return sleep(1500);
    }).then(() => {
        ok('one dropped poll: still online, fresh, unlocked', r.online && r.fresh() && r.session.unlocked);
        ok('one dropped poll is logged as a retry, not offline', lines.some((l) => /a poll failed/.test(l)) && !lines.some((l) => /offline/.test(l)));
        ok('polling went on after the drop', r.fails === 0);
        mode = 'down';
        return sleep(9500);       /* 0.3 + 2 + 5 s of retries: three failures */
    }).then(() => {
        ok('link down: offline after three failed polls', !r.online && lines.some((l) => /offline \(.*3 polls failed\)/.test(l)));
        ok('link down: the last state stays on screen while fresh', r.fresh() && r.session.unlocked && r.tiles.length === 1);
        ok('no log line or error text holds the address', !lines.some((l) => /127\.0\.0\.1/.test(l)) && !/127\.0\.0\.1/.test(r.error));
        mode = 'ok';
        return sleep(11000);      /* the next retry is at most 10 s away */
    }).then(() => {
        ok('link back: online again and says for how long it was down', r.online && lines.some((l) => /online after \d+ s/.test(l)));
        /* staleness, with the clock moved instead of waiting 90 s */
        r.lastOk = Date.now() - 91000;
        ok('a state older than FRESH_MS is not fresh', !r.fresh());
        r.stop();
        /* name lookup: a literal address, then the cache and the fall-back with servers that never answer */
        return new Promise((res) => netlease.lookup('10.1.2.3', {}, (e, a) => { ok('lookup: a literal address passes through', !e && a === '10.1.2.3'); res(); }));
    }).then(() => {
        const lease = path.join(os.tmpdir(), 'lease-' + process.pid + '.json');
        fs.writeFileSync(lease, JSON.stringify({ dns: ['192.0.2.1', '192.0.2.2'], interface: 'wlan0', ip: '10.0.0.2' }));
        process.env.MGU_UPLINK_LEASE = lease;
        delete require.cache[require.resolve(path.join(app, 'netlease.js'))];
        const nl = require(path.join(app, 'netlease.js'));
        const t0 = Date.now();
        return new Promise((res) => nl.lookup('example.invalid', {}, (e, a) => {
            const took = Date.now() - t0;
            ok('lookup: two dead servers give an error in about 6 s, not 38 (' + took + ' ms)', !!e && !a && took > 5000 && took < 8000);
            ok('lookup: the error does not hold the name', !/example\.invalid/.test(String(e && e.message)));
            res();
        }));
    }).then(() => {
        srv.close();
        console.log(lines.join('\n'));
        console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'all ok');
        process.exit(fails.length ? 1 : 0);
    }).catch((e) => { console.error(e); process.exit(2); });
});
