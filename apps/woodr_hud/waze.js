'use strict';
/**
 * waze.js - where the Waze map sits on the HUD, and its size, through waze-on-cluster's control socket
 * (/dev/shm/waze-on-cluster/ctl.sock, root:tm_oap_a 0660: every OAP app may use it).
 *
 *   {"cmd":"status"}  -> {"ev":"status", ..., "hud":1, "hud_state":"showing", "hud_width_pct":0, "hud_x":0, "hud_y":0}
 *   {"cmd":"hud","hud_width_pct":"45"}  resizes the running map (20-100; 0 = the standard fitted box)
 *
 * The map's box on the HUD scene (800x480): width = pct% of 800 (0 = 56.5 %, the tool's standard box: 452 px,
 * measured on this car 2026-11-10 as "quad 452x200 at 173,140"), height from the 1088x480 picture's shape,
 * centred, then moved by hud_x / hud_y.
 */
const net = require('net');

const SOCK = '/dev/shm/waze-on-cluster/ctl.sock';
const SCENE_W = 800, SCENE_H = 480, PIC_W = 1088, PIC_H = 480, STD_PCT = 56.5;

function boxOf(st) {
    const pct = st && st.hud_width_pct > 0 ? st.hud_width_pct : STD_PCT;
    let w = Math.round(SCENE_W * pct / 100), h = Math.round(w * PIC_H / PIC_W);
    if (h > SCENE_H) { h = SCENE_H; w = Math.round(h * PIC_W / PIC_H); }
    const x = Math.round((SCENE_W - w) / 2 + ((st && st.hud_x) || 0)), y = Math.round((SCENE_H - h) / 2 + ((st && st.hud_y) || 0));
    return { x: x, y: y, w: w, h: h };
}

/** one request, the first status line back (or null) */
function ask(msg, timeoutMs) {
    return new Promise((resolve) => {
        let buf = '', done = false;
        const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) { /* closed */ } resolve(v); };
        const s = net.connect(SOCK);
        s.setEncoding('utf8');
        /* the service sends its status by itself on connect; only real commands are written ("status" is not one:
         * it logged "unknown or malformed command status" at every poll) */
        s.on('connect', () => { if (msg && msg.cmd && msg.cmd !== 'status') s.write(JSON.stringify(msg) + '\n'); });
        s.on('data', (d) => {
            buf += d;
            buf.split('\n').forEach((line) => {
                if (line.indexOf('"ev":"status"') < 0) return;
                try { finish(JSON.parse(line)); } catch (e) { /* a partial line */ }
            });
        });
        s.on('error', () => finish(null));
        setTimeout(() => finish(null), timeoutMs || 2500);
    });
}

class Waze {
    constructor(log) { this.log = log; this.st = null; this.at = 0; }
    /** refresh the status (call every few seconds) */
    poll() { return ask({ cmd: 'status' }).then((st) => { if (st) { this.st = st; this.at = Date.now(); } return st; }); }
    /** the map is on the HUD now: its box, else null */
    hudBox() {
        const s = this.st;
        if (!s || Date.now() - this.at > 45000 || Number(s.hud) !== 1 || s.hud_state !== 'showing') return null;
        return boxOf(s);
    }
    setSize(pct) { this.log.info('waze: hud width ' + pct + '%'); return ask({ cmd: 'hud', hud_width_pct: String(pct) }).then(() => this.poll()); }
}

module.exports = { Waze: Waze, boxOf: boxOf };
