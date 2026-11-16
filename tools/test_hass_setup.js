'use strict';
/* node tools/test_hass_setup.js
 * The Home Assistant app's set-up (apps/woodr_hass/setup.js): what an entered address becomes, that the phone page
 * saves only with the right code and closes after five wrong tries or its time, that the file is written whole,
 * and the keyboard's keys. Runs a real server on this machine's loopback. It cannot show the car letting the app
 * listen: that is the car's to answer. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const S = require(path.join(__dirname, '..', 'apps', 'woodr_hass', 'setup.js'));

let failed = 0, n = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

check('an address becomes the relay\'s base, whatever form it was pasted in', () => {
    const base = (t) => S.normalise(t).base;
    assert.strictEqual(base('abc123.ui.nabu.casa'), 'https://abc123.ui.nabu.casa/api/car_relay/v1');
    assert.strictEqual(base('  https://abc123.ui.nabu.casa/  '), 'https://abc123.ui.nabu.casa/api/car_relay/v1');
    assert.strictEqual(base('https://ha.example.com:8123'), 'https://ha.example.com:8123/api/car_relay/v1');
    assert.strictEqual(base('https://ha.example.com/api/car_relay/v1/'), 'https://ha.example.com/api/car_relay/v1');
    assert.strictEqual(base('https://ha.example.com/ha/api/car_relay/v1'), 'https://ha.example.com/ha/api/car_relay/v1');
    assert.strictEqual(base('HTTPS://HA.Example.COM'), 'https://ha.example.com/api/car_relay/v1');
});
check('what is not an address is refused with a reason a person understands', () => {
    const why = (t) => { const r = S.normalise(t); assert.strictEqual(r.ok, false, t); return r.why; };
    assert(/Nothing/.test(why('   ')) && /Nothing/.test(why(null)));
    assert(/https/.test(why('http://ha.example.com')), 'plain http is refused');
    assert(/spaces/.test(why('ha example.com')));
    assert(/user name/.test(why('https://me:pw@ha.example.com')));
    assert(/after \?/.test(why('https://ha.example.com/?token=x')));
    assert(/look like/.test(why('https://nodots')));
    assert(/long/.test(why('a'.repeat(201))));
    assert.strictEqual(S.normalise('http://192.168.1.5:8123', true).ok, true, 'plain http only when the developer setting allows it');
});
check('the file is written whole, readable only by the app', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hass-setup-'));
    S.save(dir, 'https://h.example.com/api/car_relay/v1', '<M3>' + 'x'.repeat(60));
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
    assert.deepStrictEqual(j, { base: 'https://h.example.com/api/car_relay/v1', name: ('<M3>' + 'x'.repeat(60)).slice(0, 40) });
    assert.deepStrictEqual(fs.readdirSync(dir), ['relay.json'], 'no temporary file left');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'relay.json')).mode & 0o777, 0o600);
});
check('the car\'s addresses: hotspot and home Wi-Fi first, never loopback, link-local or the VPN first', () => {
    const got = S.addresses({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '169.254.10.2' }],
        tailscale0: [{ family: 'IPv4', address: '100.101.1.2' }], wlan0: [{ family: 'IPv4', address: '172.20.10.4' }, { family: 'IPv6', address: 'fe80::1' }], wlan1: [{ family: 4, address: '192.168.68.40' }] });
    assert.deepStrictEqual(got.map((a) => a.address), ['172.20.10.4', '192.168.68.40', '100.101.1.2']);
});
check('the keyboard: keys, words, delete, clear, and a length it will not pass', () => {
    assert.strictEqual(S.KEYS.join('').length, 40);
    assert(S.KEYS.join('').indexOf('.') >= 0 && S.KEYS.join('').indexOf(':') >= 0 && S.KEYS.join('').indexOf('/') >= 0);
    let t = S.press('', 'https://'); t = S.press(t, 'a'); t = S.press(t, '.ui.nabu.casa');
    assert.strictEqual(t, 'https://a.ui.nabu.casa');
    assert.strictEqual(S.press(t, 'del'), 'https://a.ui.nabu.cas'); assert.strictEqual(S.press(t, 'clear'), '');
    assert.strictEqual(S.press('x'.repeat(199), 'ab'), 'x'.repeat(199), 'no further than 200');
    assert.strictEqual(S.normalise(t).ok, true);
});

/* ---- the phone page, on loopback */
function req(port, method, p, body) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
            const parts = []; res.on('data', (b) => parts.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8'), headers: res.headers }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}
function setup(extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hass-setup-'));
    const s = new S.Setup(dir, null, Object.assign({ host: '127.0.0.1', ports: [0], ifaces: { wlan0: [{ family: 'IPv4', address: '172.20.10.4' }] } }, extra || {}));
    return { s: s, dir: dir };
}
check('the phone page: the form with the right code, saved, and then closed', () => {
    const { s, dir } = setup();
    let saved = null;
    s.on('saved', (c) => { saved = c; });
    return s.start().then((ok) => {
        assert(ok && s.state === 'open');
        const link = s.links()[0].url;
        assert(new RegExp('^http://172\\.20\\.10\\.4:' + s.port + '/s/[A-Z2-9]{8}$').test(link), link);
        const p = '/s/' + s.code;
        return req(s.port, 'GET', p).then((r) => {
            assert.strictEqual(r.status, 200);
            assert(/Save to the car/.test(r.body) && /default-src 'none'/.test(r.body) && r.headers['cache-control'] === 'no-store');
            return req(s.port, 'POST', p, 'base=' + encodeURIComponent('http://nope.example.com') + '&name=M3');
        }).then((r) => {
            assert.strictEqual(r.status, 400); assert(/https/.test(r.body)); assert(!fs.existsSync(path.join(dir, 'relay.json')), 'nothing saved on a refusal');
            assert(/value="http:\/\/nope\.example\.com"/.test(r.body), 'what they typed is given back to fix');
            return req(s.port, 'POST', p, 'base=' + encodeURIComponent('abc.ui.nabu.casa') + '&name=' + encodeURIComponent('M3 <b>'));
        }).then((r) => {
            assert.strictEqual(r.status, 200); assert(/Saved/.test(r.body));
            return new Promise((res) => setTimeout(res, 30));
        }).then(() => {
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8')), { base: 'https://abc.ui.nabu.casa/api/car_relay/v1', name: 'M3 <b>' });
            assert(saved && saved.base === 'https://abc.ui.nabu.casa/api/car_relay/v1');
            assert.strictEqual(s.state, 'saved'); assert.strictEqual(s.server, null, 'no longer listening');
            assert.deepStrictEqual(s.links(), []);
        });
    });
});
check('a page that echoes what was typed never lets it become markup', () => {
    const { s } = setup();
    return s.start().then(() => req(s.port, 'POST', '/s/' + s.code, 'base=' + encodeURIComponent('"><script>x</script>'))).then((r) => {
        assert.strictEqual(r.status, 400); assert(r.body.indexOf('<script>x') < 0 && r.body.indexOf('&lt;script&gt;') >= 0); s.stop();
    });
});
check('wrong codes: five and the page is gone for good', () => {
    const { s, dir } = setup();
    return s.start().then(() => {
        const port = s.port;
        let chain = Promise.resolve();
        for (let i = 0; i < S.MAX_TRIES; i++) chain = chain.then(() => req(port, 'GET', '/s/WRONG' + i)).then((r) => assert.strictEqual(r.status, 404));
        return chain.then(() => {
            assert.strictEqual(s.state, 'closed'); assert.strictEqual(s.server, null);
            return req(port, 'GET', '/s/' + s.code).then(() => assert(false, 'still answering'), () => true);
        }).then(() => assert(!fs.existsSync(path.join(dir, 'relay.json'))));
    });
});
check('a body far too long is refused, and only GET and POST are answered', () => {
    const { s } = setup();
    return s.start().then(() => req(s.port, 'POST', '/s/' + s.code, 'base=' + 'a'.repeat(5000))).then((r) => {
        assert.strictEqual(r.status, 413);
        return req(s.port, 'PUT', '/s/' + s.code);
    }).then((r) => { assert.strictEqual(r.status, 405); s.stop(); });
});
check('after its time the page answers that it has closed', () => {
    const { s } = setup({ openMs: 1 });
    return s.start().then(() => new Promise((res) => setTimeout(res, 20))).then(() => req(s.port, 'GET', '/s/' + s.code)).then((r) => {
        assert.strictEqual(r.status, 410); s.stop();
    });
});
check('when the car will not let the app listen, it says so and the keyboard takes over', () => {
    const blocker = http.createServer(() => {});
    return new Promise((res) => blocker.listen(0, '127.0.0.1', res)).then(() => {
        const taken = blocker.address().port;
        const { s } = setup({ ports: [taken] });
        let told = 0; s.on('change', () => { told++; });
        return s.start().then((ok) => {
            assert.strictEqual(ok, false); assert.strictEqual(s.state, 'failed'); assert.strictEqual(s.why, 'EADDRINUSE'); assert(told >= 1);
            assert.deepStrictEqual(s.links(), []);
            blocker.close();
        });
    });
});
check('the app uses it, and every handler in setup.js keeps its errors to itself', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'apps', 'woodr_hass', 'main.js'), 'utf8');
    assert(/require\('\.\/setup'\)/.test(main) && /setup\.start\(\)/.test(main) && /S\.KEYS/.test(main), 'main.js wires the set-up');
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps', 'woodr_hass', 'setup.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/\?\.|\?\?|\.\.\.[a-zA-Z_[{]|catch\s*\{/.test(src), 'Node 8 syntax');
    assert(!/child_process|exec\(|eval\(/.test(src));
});

(function next() {
    const item = queue.shift();
    if (!item) { console.log(failed ? 'FAILED: ' + failed + ' of ' + n : 'hass setup: all ' + n + ' ok'); process.exit(failed ? 1 : 0); }
    n++;
    let p;
    try { p = Promise.resolve(item[1]()); } catch (e) { p = Promise.reject(e); }
    p.then(() => console.log('ok   ' + item[0]), (e) => { failed++; console.log('FAIL ' + item[0] + '\n     ' + (e && e.message)); }).then(next);
})();
