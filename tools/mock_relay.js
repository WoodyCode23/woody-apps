'use strict';
/**
 * mock_relay.js - a stand-in for Car Relay on the PC, to work on woodr_hass with no car and no house.
 *
 *   node tools/mock_relay.js [port=8791] [a .jpg for the camera]
 *   relay.json: { "base": "http://127.0.0.1:8791/api/car_relay/v1" }   and CAR_RELAY_DEV=1 for the app
 *
 * Steer it from another terminal:
 *   curl "http://127.0.0.1:8791/_ctl?pairing=open"          open the pairing window
 *   curl "http://127.0.0.1:8791/_ctl?approve=1"             approve the code on screen (pair or unlock)
 *   curl "http://127.0.0.1:8791/_ctl?phone=1"  (or 0)       a phone is / is not in the car
 *   curl "http://127.0.0.1:8791/_ctl?big_garage=opening"    set a tile's state
 *   curl "http://127.0.0.1:8791/_ctl?bell=1"                ring the doorbell
 *   curl "http://127.0.0.1:8791/_ctl?unpair=1"
 * Same paths, status codes and bodies as custom_components/car_relay (contract v1). No real doors.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');

const PORT = Number(process.argv[2]) || 8791;
const BASE = '/api/car_relay/v1';
const JPEG = process.argv[3] && fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3]) : null;
const st = {
    pairingOpen: false, pend: null, token: null, phone: false, hard: false, scan: null, seq: 1, events: [], nonces: {},
    tiles: [
        { id: 'big_garage', name: 'Big Garage', kind: 'cover', state: 'closed', actions: ['open', 'close'] },
        { id: 'small_garage', name: 'Small Garage', kind: 'cover', state: 'closed', actions: ['open', 'close'] },
        { id: 'front_door', name: 'Front Door', kind: 'lock', state: 'locked', actions: ['lock'] },
        { id: 'printer', name: '3D Printer', kind: 'camera', state: 'idle', actions: [], camera: 'front_door', info: '62% \u00b7 1 h 20 min left \u00b7 layer 95/117' },
    ],
};
let waiters = [];
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const qr = (c) => 'homeassistant://fire_event/car_relay_scan?c=' + c;
const bump = () => { st.seq++; waiters.forEach((w) => w()); waiters = []; };
const session = () => (st.hard ? { unlocked: false, reason: 'scan-required' }
    : st.phone ? { unlocked: true, reason: 'ok' } : { unlocked: false, reason: 'no-phone' });
const snap = (since) => {
    const s = session();
    return {
        seq: st.seq, session: s,
        tiles: s.unlocked ? st.tiles.map((t) => Object.assign({ ok: t.state !== 'unavailable', unit: '' }, t)) : [],
        events: s.unlocked ? st.events.filter((e) => e.seq > since) : [],
    };
};
const NEED = { open: 'closed', close: 'open' };

http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(400, { error: 'bad-json' }); }
        const p = u.pathname, q = u.searchParams;
        if (p === '/_ctl') {
            if (q.get('pairing')) st.pairingOpen = q.get('pairing') === 'open';
            if (q.get('approve')) {
                if (st.pend) { st.pend.token = 'dev1.' + crypto.randomBytes(16).toString('hex'); st.token = st.pend.token; st.pairingOpen = false; }
                else if (st.scan) { st.hard = false; st.phone = true; st.scan = null; }
            }
            if (q.get('phone')) st.phone = q.get('phone') === '1';
            if (q.get('unpair')) st.token = null;
            if (q.get('bell')) { st.seq++; st.events.push({ type: 'doorbell', label: 'Front door', camera: 'front_door', seq: st.seq, at: Math.floor(Date.now() / 1000) }); }
            st.tiles.forEach((t) => { if (q.get(t.id)) t.state = q.get(t.id); });
            bump();
            return send(200, { session: session(), tiles: st.tiles.map((t) => t.id + '=' + t.state), paired: !!st.token });
        }
        if (p === BASE + '/pair') {
            if (!st.pairingOpen) return send(403, { error: 'pairing-closed' });
            const c = code();
            st.pend = { id: crypto.randomBytes(8).toString('hex'), token: null };
            console.log('pair code ' + c);
            return send(200, { pair_id: st.pend.id, code: c, qr: qr(c), expires_in: 300 });
        }
        if (p === BASE + '/pair/status') {
            if (!st.pend || body.pair_id !== st.pend.id) return send(200, { status: 'unknown' });
            if (!st.pend.token) return send(200, { status: 'pending' });
            const t = st.pend.token;
            st.pend = null;
            return send(200, { status: 'approved', token: t });
        }
        if (!st.token || req.headers['x-car-token'] !== st.token) return send(401, { error: 'bad-token' });
        if (p === BASE + '/poll') {
            const since = Number(q.get('since')) || 0, wait = Math.min(25, Number(q.get('wait')) || 0);
            if (!wait || st.seq !== since) return send(200, snap(since));
            let done = false;
            const go = () => { if (done) return; done = true; clearTimeout(timer); send(200, snap(since)); };
            const timer = setTimeout(go, wait * 1000);
            waiters.push(go);
            return undefined;
        }
        if (p === BASE + '/scan') { const c = code(); st.scan = c; console.log('scan code ' + c); return send(200, { code: c, qr: qr(c), expires_in: 180 }); }
        if (p === BASE + '/lock') {
            if (body.reason === 'button') st.hard = true; else st.phone = false;
            bump();
            return send(200, { ok: true, session: session() });
        }
        if (p === BASE + '/car') { console.log('car ' + raw); return send(200, { ok: true }); }
        if (p === BASE + '/action') {
            if (!session().unlocked) return send(403, { error: 'locked' });
            const t = st.tiles.find((x) => x.id === body.tile);
            if (!t || t.actions.indexOf(body.action) < 0) return send(404, { error: 'no-such-action' });
            if (!body.nonce) return send(400, { error: 'nonce-required' });
            if (st.nonces[body.nonce]) return send(200, { ok: true, duplicate: true });
            st.nonces[body.nonce] = 1;
            const need = NEED[body.action];
            if (need && t.state !== need) return send(409, { error: 'wrong-state', state: t.state, need: need });
            console.log('ACTION ' + t.id + ' ' + body.action);
            if (t.kind === 'cover') {
                t.state = body.action === 'open' ? 'opening' : 'closing';
                setTimeout(() => { t.state = body.action === 'open' ? 'open' : 'closed'; bump(); }, 6000);
            } else if (t.kind === 'lock') t.state = 'locked';
            bump();
            return send(200, { ok: true });
        }
        if (p.indexOf(BASE + '/camera/') === 0) {
            if (!session().unlocked) return send(403, { error: 'locked' });
            if (p === BASE + '/camera/front_door/stream') {      /* the still, four times a second, for 20 s */
                if (!JPEG) return send(404, { error: 'no-such-camera' });
                res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=frame', 'Cache-Control': 'no-store' });
                const part = () => { res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + JPEG.length + '\r\n\r\n'); res.write(JPEG); res.write('\r\n'); };
                const iv = setInterval(part, 250);
                const stop = () => { clearInterval(iv); try { res.end(); } catch (e) { /* closed */ } };
                setTimeout(stop, 20000);
                res.on('close', stop);
                return undefined;
            }
            if (p !== BASE + '/camera/front_door') return send(404, { error: 'no-such-camera' });
            if (!JPEG) return send(502, { error: 'camera-failed' });
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
            return res.end(JPEG);
        }
        return send(404, { error: 'not-found' });
    });
}).listen(PORT, '127.0.0.1', () => console.log('mock relay on http://127.0.0.1:' + PORT + BASE));
