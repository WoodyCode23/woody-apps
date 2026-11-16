'use strict';
/**
 * Link - the car on your own Tailscale network, locked down.
 *
 *   link.js     the connection to the helper service (components/woodr-link), and what the screen says
 *   qrcode.js   the login link as a QR (qrcode-generator, MIT)
 *
 * The app only asks: status, connect, disconnect, log out. The helper service holds Tailscale to the car
 * policy (shields up, no exit node, no routes, no Tailscale DNS, no SSH), and the app has no way to change it.
 * You log in yourself, on your phone, in your own Tailscale account: the app never sees a password or a key.
 *
 * Nothing is read from or written to the car: no signals, no control units.
 * Never throws out of a callback: an uncaught error exits the app, and MainApp wipes its data.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const qrcode = require('./qrcode');
const { Link, view } = require('./link');

const W = 1600, H = 520;
const GREEN = '#2fd27a', AMBER = '#ffc21a';
const CONFIRM_MS = 4000;

const qrCache = { text: '', n: 0, rows: [] };
function qrRuns(text) {
    if (qrCache.text === text) return qrCache;
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), rows = [];
    for (let y = 0; y < n; y++) {
        const runs = [];
        let x = 0;
        while (x < n) {
            if (!q.isDark(y, x)) { x++; continue; }
            let e = x;
            while (e < n && q.isDark(y, e)) e++;
            runs.push([x, e - x]);
            x = e;
        }
        rows.push(runs);
    }
    qrCache.text = text; qrCache.n = n; qrCache.rows = rows;
    return qrCache;
}

function drawQr(cv, text, x, y, size) {
    let q;
    try { q = qrRuns(text); } catch (e) { return false; }
    const quiet = 4, m = Math.floor(size / (q.n + quiet * 2)), side = m * (q.n + quiet * 2);
    const ox = x + Math.floor((size - side) / 2), oy = y + Math.floor((size - side) / 2);
    cv.fillRect(ox, oy, side, side, '#ffffff');
    for (let r = 0; r < q.n; r++) q.rows[r].forEach((run) => cv.fillRect(ox + (quiet + run[0]) * m, oy + (quiet + r) * m, run[1] * m, m, '#000000'));
    return true;
}

/** The mark: two nodes joined by a line, inside the brand's corner brackets. */
function drawMark(cv, t, cx, cy, s, colour) {
    const b = s * 0.34, e = s;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((q) => {
        cv.line(cx + q[0] * e, cy + q[1] * e, cx + q[0] * (e - b), cy + q[1] * e, 6, t.text);
        cv.line(cx + q[0] * e, cy + q[1] * e, cx + q[0] * e, cy + q[1] * (e - b), 6, t.text);
    });
    cv.line(cx - s * 0.42, cy, cx + s * 0.42, cy, 8, colour);
    cv.arc(cx - s * 0.5, cy, s * 0.1, s * 0.2, 0, 360, t.text);
    cv.arc(cx + s * 0.5, cy, s * 0.1, s * 0.2, 0, 360, colour);
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const link = new Link();
        let armed = 0;                         /* log out takes two presses: the time the first one runs out */
        let note = '', noteUntil = 0;
        const say = (text, secs) => { note = text; noteUntil = Date.now() + (secs || 5) * 1000; refresh(); };

        function button(cv, t, x, y, w, h, label, colour, key, fn) {
            cv.roundRect(x, y, w, h, 12, withAlpha(colour, 0.28));
            cv.strokeRoundRect(x, y, w, h, 12, 2, colour);
            cv.text(label, x + w / 2, y + h / 2 + 10, 28, t.text, { font: 'bold', align: 'center' });
            cv.target(x, y, w, h, fn, key, 12);
        }

        function act() {
            const v = view(link);
            if (!v.action) { say(v.line, 6); return; }
            const sent = v.action === 'connect' ? link.connect() : link.disconnect();
            say(sent ? (v.action === 'connect' ? 'Connecting...' : 'Disconnecting...') : 'The service did not answer', 4);
        }

        function logout() {
            const s = link.state;
            if (!link.up || !s.daemon) { say('The service is not running', 4); return; }
            const now = Date.now();
            if (now > armed) { armed = now + CONFIRM_MS; say('Press again to log this car out of Tailscale', 4); return; }
            armed = 0;
            say(link.logout() ? 'Logged out' : 'The service did not answer', 5);
        }

        function rule(cv, t, x, y, label, value, colour) {
            cv.text(label, x, y, 20, t.dim);
            cv.text(value, x, y + 34, 28, colour || t.text, { font: 'bold' });
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const s = link.state, v = view(link);
            const colour = v.key === 'on' ? GREEN : v.key === 'login' || v.key === 'wait' ? AMBER : v.key === 'none' || v.key === 'down' ? t.warn : t.dim;

            if (v.key === 'login') {
                drawQr(cv, s.authUrl, 100, 92, 380);
                cv.text('Log in to Tailscale', 560, 150, 36, t.text, { font: 'bold' });
                cv.text('Point your phone camera at the code and approve', 560, 204, 24, t.dim);
                cv.text('this car in your own Tailscale account.', 560, 238, 24, t.dim);
                cv.text('The car never sees your password.', 560, 290, 24, t.dim);
                button(cv, t, 560, 340, 320, 76, 'Cancel', t.accent, 'act', act);
            } else {
                drawMark(cv, t, 250, 262, 120, colour);
                cv.text(v.title, 470, 160, 52, colour === t.dim ? t.text : colour, { font: 'bold' });
                cv.text(v.line, 470, 206, 24, t.dim);
                if (v.key === 'on') {
                    rule(cv, t, 470, 258, 'THIS CAR', s.name || '--');
                    rule(cv, t, 800, 258, 'ADDRESS', s.ips[0] || '--');
                    rule(cv, t, 1130, 258, 'REACHABLE', s.online ? 'Yes' : 'Not yet', s.online ? GREEN : AMBER);
                }
                if (v.action) button(cv, t, 470, 350, 320, 76, v.action === 'connect' ? 'Connect' : 'Disconnect', v.action === 'connect' ? t.accent : t.dim, 'act', act);
                if (s.daemon && s.backend !== 'NeedsLogin') button(cv, t, 820, 350, 320, 76, Date.now() < armed ? 'Press again' : 'Log out', Date.now() < armed ? AMBER : t.dim, 'logout', logout);
            }

            /* the policy line: what this car will and will not do on the tailnet, and whether the helper confirms it */
            if (link.up && s.daemon && settings.get('hints') !== false) {
                const ok = s.policy === 'ok' || s.policy === 'enforced';
                cv.text(ok ? 'Locked down: shields up, no exit node, no routes, no SSH' : 'Policy not confirmed: ' + s.policy, W - 24, 80, 20, ok ? t.dim : t.warn, { align: 'right' });
            }
            const y = 492 + G.pageBottom(cv) - G.BOTTOM;
            const noted = Date.now() < noteUntil && note;
            const foot = noted ? note : s.note ? s.note : (v.key !== 'on' && s.health && s.health[0] && v.key !== 'off') ? s.health[0] : s.version ? 'Tailscale ' + s.version : '';
            cv.text(String(foot).slice(0, 110), 24, y, 20, noted ? t.text : t.dim);
            G.frame(cv, t, ['Link'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        function refresh() { render().catch((e) => log.warn('render: ' + e)); }

        ui.onClick('BTN_ACTION', () => { act(); return render(); });
        ui.onClick('BTN_LOGOUT', () => { logout(); return render(); });
        settings.onChange(() => refresh());
        link.on('change', () => refresh());
        link.start();
        process.on('exit', () => link.stop());

        ctx.loop('MAIN', 1, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
