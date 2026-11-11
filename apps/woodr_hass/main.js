'use strict';
/**
 * Home Assistant - the house on the centre screen, through Car Relay.
 *
 *   relay.js      the connection: pairing, the long poll, actions, the camera
 *   doorbell.js   the front door camera on the instrument cluster when the bell rings
 *   qrcode.js     the pairing / unlock code as a QR (qrcode-generator, MIT)
 *   shared.js     /dev/shm/woody/garage.json for Ambient Studio (green closed, red open)
 *
 * What the screen shows follows the relay:
 *   not set up        relay.json is missing from the app's data folder
 *   not paired        a Pair button, then a QR and a code to approve from an allowed phone
 *   locked, no phone  the logo, nothing else: the house is not shown to whoever sits in the car
 *   locked, scan      a QR and a code (after the Lock button, or in the set hours)
 *   unlocked          the tiles. Doors and locks take two presses.
 *
 * The car holds no Home Assistant token and cannot unlock a door: the relay has no such action.
 * Read-only on the car: vehicle signals in, pixels and HTTPS out. Nothing is written to any ECU.
 * Never throws out of a callback: an uncaught error exits the app, and MainApp's
 * CorruptAppsHandler wipes an app's data on its first crash and uninstalls it on the second.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { withAlpha } = require('./kit/canvas');
const qrcode = require('./qrcode');
const shared = require('./shared');
const { Relay } = require('./relay');
const { Doorbell } = require('./doorbell');

const W = 1600, H = 520;
const APP_ID = 'woodr_hass';
const CONFIRM_MS = 4000;
const TWICE = ['cover', 'lock'];                 /* kinds that take two presses */
const GREEN = '#2fd27a', RED = '#ff3b30', AMBER = '#ffc21a';
const ENGINE_RPM = 400, MOVING_KMH = 2;

/** The one action a tile offers in its current state, or null. */
function offer(tile) {
    const has = (a) => tile.actions.indexOf(a) >= 0;
    if (!tile.ok) return null;
    if (tile.kind === 'cover') {
        if (tile.state === 'closed' && has('open')) return { action: 'open', label: 'Open' };
        if (tile.state === 'open' && has('close')) return { action: 'close', label: 'Close' };
        return null;                             /* moving: wait for it */
    }
    if (tile.kind === 'lock') return tile.state === 'unlocked' && has('lock') ? { action: 'lock', label: 'Lock' } : null;
    if (tile.kind === 'light' || tile.kind === 'switch') {
        if (tile.state === 'on' && has('off')) return { action: 'off', label: 'Turn off' };
        if (tile.state !== 'on' && has('on')) return { action: 'on', label: 'Turn on' };
        return null;
    }
    if (tile.kind === 'camera') return { action: 'view', label: 'View' };      /* shown by the car itself, nothing sent */
    if (tile.kind === 'scene' && has('activate')) return { action: 'activate', label: 'Activate' };
    if (tile.kind === 'script' && has('run')) return { action: 'run', label: 'Run' };
    return null;
}

function stateColour(tile, t) {
    if (!tile.ok) return t.warn;
    if (tile.state === 'closed' || tile.state === 'locked') return GREEN;
    if (tile.state === 'open' || tile.state === 'unlocked') return RED;
    if (tile.state === 'opening' || tile.state === 'closing' || tile.state === 'locking') return AMBER;
    return t.text;
}

function stateText(tile) {
    if (tile.kind === 'camera') return tile.ok ? 'Camera' : 'Offline';
    const v = String(tile.state == null ? '' : tile.state);
    if (!v) return '--';
    const n = Number(v);
    if (isFinite(n) && v.trim() !== '') return (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + (tile.unit ? ' ' + tile.unit : '');
    return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
}

/** What an action's refusal means, in the driver's words. */
function refusal(r, tile) {
    if (r.error === 'wrong-state') return tile.name + ' is ' + (r.state || 'busy') + ' now, nothing sent';
    if (r.error === 'locked') return 'Locked';
    if (r.error === 'action-failed') return tile.name + ': Home Assistant could not do it';
    return tile.name + ' failed: ' + r.error;
}

/* ---------------- QR ---------------- */

const qrCache = { text: '', n: 0, rows: [] };
/** rows of [start, length] dark runs per module row, cached per text */
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
    for (let r = 0; r < q.n; r++) {
        q.rows[r].forEach((run) => cv.fillRect(ox + (quiet + run[0]) * m, oy + (quiet + r) * m, run[1] * m, m, '#000000'));
    }
    return true;
}

/** The lock screen's mark: a W in a ring. */
function drawLogo(cv, t, cx, cy, s) {
    cv.arc(cx, cy, s * 0.92, s, 0, 360,withAlpha(t.accent, 0.9));
    const p = [[-0.52, -0.36], [-0.27, 0.40], [0, -0.16], [0.27, 0.40], [0.52, -0.36]].map((q) => [cx + q[0] * s, cy + q[1] * s]);
    cv.polyline(p, Math.max(6, s * 0.11), t.text);
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['speed', 'rpm', 'temps', 'gear', 'condition']);
        const relay = new Relay(ctx.dataDir, log);
        const doorbell = new Doorbell(ctx, relay, APP_ID);

        let sel = 0;
        const busy = {};                  /* tile id -> true while an action is in flight */
        let armed = null;                  /* { id, action, until } waiting for the second press */
        let note = '', noteUntil = 0;

        const say = (text, secs) => { note = text; noteUntil = Date.now() + (secs || 5) * 1000; refresh(); };
        const unlocked = () => relay.state === 'paired' && relay.fresh() && relay.session.unlocked;

        /* ---------------- actions ---------------- */

        function press(tile) {
            if (!tile || busy[tile.id]) return;
            if (!unlocked()) { say('Not connected: nothing sent', 6); return; }
            const o = offer(tile);
            if (!o) { say(tile.name + ' is ' + stateText(tile).toLowerCase() + ': nothing to do', 4); return; }
            if (o.action === 'view') {      /* a camera tile: the doorbell's overlay, for longer; a second press closes it */
                const cam = tile.camera || tile.id;
                if (doorbell.status().shown && doorbell.camera === cam) { doorbell.dismiss('closed from the tile'); say(tile.name + ': closed', 3); return; }
                doorbell.ring(tile.name, cam, 60);
                say(doorbell.status().shown ? tile.name + ': showing for a minute, press again to close' : tile.name + ': the picture only shows while parked', 5);
                return;
            }
            if (TWICE.indexOf(tile.kind) >= 0) {
                const now = Date.now();
                if (!armed || armed.id !== tile.id || armed.action !== o.action || now > armed.until) {
                    armed = { id: tile.id, action: o.action, until: now + CONFIRM_MS };
                    say('Press again to ' + o.label.toLowerCase() + ' ' + tile.name, 4);
                    return;
                }
                armed = null;
            }
            busy[tile.id] = true;
            noteUntil = 0;
            refresh();
            relay.action(tile.id, o.action).then((r) => {
                delete busy[tile.id];
                say(r.ok ? tile.name + ': ' + o.label.toLowerCase() + ' sent' : refusal(r, tile), r.ok ? 4 : 8);
            }).catch((e) => { delete busy[tile.id]; say(tile.name + ' failed: ' + e.message, 8); });
        }

        function lockNow() {
            if (relay.state !== 'paired') return;
            armed = null;
            relay.lock('button').then((ok) => say(ok ? 'Locked. Scan the code to unlock.' : 'Could not reach Home Assistant to lock', 6));
        }

        /* ---------------- the garage, for Ambient Studio ---------------- */

        const garage = { state: null, since: 0, told: false };
        /**
         * garage.json = { ok, state, since }: state is the worst of the garage doors
         * (opening / closing / open, else closed), since = when it last changed (0 = not seen
         * changing). ok:false and a file left to go stale both mean "no information", and
         * Ambient Studio then shows the car's normal light.
         */
        function tellGarage() {
            let state = null;
            if (unlocked()) {
                const doors = relay.tiles.filter((x) => x.kind === 'cover');
                if (doors.length && doors.every((d) => d.ok)) {
                    const any = (s) => doors.some((d) => d.state === s);
                    state = any('opening') ? 'opening' : any('closing') ? 'closing' : any('open') ? 'open'
                        : doors.every((d) => d.state === 'closed') ? 'closed' : null;
                }
            }
            if (state === null) {
                if (garage.told) { shared.write('garage.json', { ok: false }); garage.told = false; }
                garage.state = null;
                return;
            }
            if (state !== garage.state) { garage.since = garage.state === null ? 0 : Date.now(); garage.state = state; }
            shared.write('garage.json', { ok: true, state: state, since: garage.since });
            garage.told = true;
        }

        /* ---------------- car state to the relay ---------------- */

        const push = { at: 0, key: '', sent: 0, failed: 0, condition: undefined };
        function pushCar() {
            const d = car.data ? car.data() : car.live;
            if (!d || d.demo) return;
            if (d.condition !== push.condition) { log.info('vehicle condition ' + push.condition + ' -> ' + d.condition); push.condition = d.condition; }
            if (settings.get('pushCar') === false || relay.state !== 'paired' || !relay.online) return;
            const num = (v, r) => (typeof v === 'number' && isFinite(v) ? Math.round(v * r) / r : undefined);
            const body = {
                speed_kmh: num(d.speed, 10), rpm: num(d.rpm, 1), coolant_c: num(d.coolant, 1), oil_c: num(d.oil, 1),
                gear: num(d.gear, 1), stage: d.stage || undefined, condition: num(d.condition, 1),
                moving: typeof d.speed === 'number' ? d.speed > MOVING_KMH : undefined,
                engine: typeof d.rpm === 'number' ? d.rpm > ENGINE_RPM : undefined,
            };
            const every = Math.max(10, Number(settings.get('pushEvery')) || 30) * 1000;
            const now = Date.now(), key = JSON.stringify(body);
            if (now - push.at < every) return;
            if (key === push.key && now - push.at < 300000) return;        /* a parked car says it once */
            push.at = now; push.key = key;
            relay.car(body).then((ok) => { if (ok) push.sent++; else push.failed++; });
        }

        /* ---------------- the relay ---------------- */

        relay.on('change', () => {
            if (!unlocked()) armed = null;
            if (relay.state === 'paired' && relay.online && !relay.session.unlocked
                && String(relay.session.reason).indexOf('scan-required') === 0) relay.scanCode();
            tellGarage();
            refresh();
        });
        relay.on('event', (e) => {
            if (e.type !== 'doorbell') return;
            log.info('doorbell event: ' + e.label);
            say((e.label || 'Front door') + ': doorbell', 10);
            doorbell.ring(e.label, e.camera);
        });
        doorbell.onChange = () => refresh();

        /* ---------------- drawing ---------------- */

        function button(cv, t, x, y, w, h, label, colour, key, fn) {
            cv.roundRect(x, y, w, h, 12, withAlpha(colour, 0.28));
            cv.strokeRoundRect(x, y, w, h, 12, 2, colour);
            cv.text(label, x + w / 2, y + h / 2 + 10, 28, t.text, { font: 'bold', align: 'center' });
            cv.target(x, y, w, h, fn, key, 12);
        }

        function drawCode(cv, t, title, code, qr, until, hint) {
            drawQr(cv, qr, 120, 96, 380);
            cv.text(title, 580, 150, 34, t.text, { font: 'bold' });
            cv.text(code, 580, 250, 84, t.text, { font: 'bold' });
            const left = Math.max(0, Math.round((until - Date.now()) / 1000));
            cv.text('Point your iPhone camera at the code.', 580, 316, 24, t.dim);
            cv.text(hint, 580, 352, 24, t.dim);
            cv.text('New code in ' + left + ' s', 580, 420, 22, left < 30 ? t.warn : t.dim);
        }

        function drawLocked(cv, t, line) {
            drawLogo(cv, t, W / 2, 250, 130);
            if (line && settings.get('hints') !== false) cv.text(line, W / 2, 452, 22, t.dim, { align: 'center' });
        }

        function drawTiles(cv, t) {
            const tiles = relay.tiles.slice(0, 8);
            if (!tiles.length) { cv.text('The relay has no tiles configured.', W / 2, 270, 26, t.dim, { align: 'center' }); return; }
            if (sel >= tiles.length) sel = 0;
            const cols = Math.max(3, Math.min(4, tiles.length)), rows = Math.ceil(tiles.length / cols);
            const gap = 16, x0 = 24, y0 = 104, gw = 1552, gh = 344;
            const cw = (gw - gap * (cols - 1)) / cols, ch = (gh - gap * (rows - 1)) / rows;
            tiles.forEach((tile, i) => {
                const x = x0 + (i % cols) * (cw + gap), y = y0 + Math.floor(i / cols) * (ch + gap);
                const colour = stateColour(tile, t), o = offer(tile);
                const isArmed = armed && armed.id === tile.id && Date.now() < armed.until;
                cv.roundRect(x, y, cw, ch, 14, withAlpha(t.text, 0.07));
                cv.strokeRoundRect(x, y, cw, ch, 14, i === sel ? 3 : 2, i === sel ? t.text : withAlpha(colour, 0.55));
                cv.text(tile.name, x + 22, y + 44, 28, t.text, { font: 'bold' });
                cv.text(stateText(tile), x + 22, y + (rows > 1 ? 92 : 124), rows > 1 ? 36 : 56, colour, { font: 'bold' });
                const bh = rows > 1 ? 50 : 76, by = y + ch - bh - 18;
                if (busy[tile.id]) cv.text('Sending...', x + 22, by + bh / 2 + 8, 24, t.dim);
                else if (o) {
                    const twice = TWICE.indexOf(tile.kind) >= 0;
                    button(cv, t, x + 18, by, cw - 36, bh, isArmed ? 'Press again: ' + o.label : o.label,
                        isArmed ? AMBER : t.accent, 'tile-' + i, () => { sel = i; press(tile); });
                    if (twice && !isArmed && rows === 1) cv.text('press twice', x + cw / 2, by - 12, 18, t.dim, { align: 'center' });
                }
            });
        }

        function drawFooter(cv, t, text, colour) {
            const y = 492 + G.pageBottom(cv) - G.BOTTOM;
            cv.text(text, 24, y, 20, colour || t.dim);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const noted = Date.now() < noteUntil && note;
            const s = relay.session || {};
            if (relay.state === 'unconfigured') {
                drawLocked(cv, t, relay.error || 'Not set up yet: relay.json is missing from this app\'s data folder.');
            } else if (relay.state === 'unpaired') {
                drawLogo(cv, t, 400, 270, 120);
                cv.text('This car is not paired', 640, 190, 36, t.text, { font: 'bold' });
                cv.text('Open a pairing window in Home Assistant, then press Pair.', 640, 236, 24, t.dim);
                button(cv, t, 640, 280, 360, 84, 'Pair', t.accent, 'pair', () => { relay.pair(); });
                if (relay.error) cv.text(relay.error, 640, 412, 22, t.warn);
            } else if (relay.state === 'pairing' && relay.pairing) {
                drawCode(cv, t, 'Pair this car', relay.pairing.code, relay.pairing.qr, relay.pairing.until,
                    'Or in Home Assistant: Approve a car code, and type it in.');
            } else if (!relay.fresh()) {
                drawLocked(cv, t, relay.lastOk ? 'No connection to the house' : 'Connecting...');
            } else if (!s.unlocked) {
                if (String(s.reason).indexOf('scan-required') === 0 && relay.scan && Date.now() < relay.scan.until) {
                    drawCode(cv, t, 'Locked', relay.scan.code, relay.scan.qr, relay.scan.until,
                        'Or in Home Assistant: Approve a car code, and type it in.');
                } else drawLocked(cv, t, String(s.reason).indexOf('scan-required') === 0 ? 'Locked' : '');
            } else {
                cv.text('Home', 24, 80, 30, t.text, { font: 'bold' });
                cv.text('Live', W - 24, 80, 24, GREEN, { align: 'right', font: 'bold' });
                drawTiles(cv, t);
                const db = doorbell.status();
                drawFooter(cv, t, noted ? note : db.shown ? 'Front door camera on the cluster for ' + db.secsLeft + ' s' : '', noted ? t.text : t.dim);
            }
            if (noted && !(relay.fresh() && s.unlocked)) drawFooter(cv, t, note, t.text);
            G.frame(cv, t, ['Home Assistant'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        function refresh() { render().catch((e) => log.warn('render: ' + e)); }

        /* ---------------- buttons ---------------- */

        ui.onClick('BTN_ACTION', () => {
            if (relay.state === 'unpaired') relay.pair();
            else if (unlocked()) press(relay.tiles[sel]);
            return render();
        });
        ui.onClick('BTN_PAGE', () => {
            const n = Math.min(8, relay.tiles.length);
            if (unlocked() && n) { sel = (sel + 1) % n; armed = null; }
            return render();
        });
        ui.onClick('BTN_LOCK', () => { lockNow(); return render(); });

        settings.onChange((key) => {
            if (key === 'reload' && settings.get('reload') === true) {
                settings.set('reload', false);
                relay.stop();
                relay.start();
                say('relay.json read again');
                return;
            }
            if (key === 'doorbell' && settings.get('doorbell') === 'off') doorbell.dismiss('turned off');
            if (key === 'testBell' && settings.get('testBell') === true) {
                settings.set('testBell', false);
                doorbell.ring('Front door (test)', 'front_door');
            }
            refresh();
        });

        /* ---------------- car signals ---------------- */

        car.onSample(() => { doorbell.carState(car.data ? car.data() : car.live); });
        const second = setInterval(() => {
            try {
                pushCar();
                tellGarage();
                if (relay.state === 'paired' && relay.online && relay.session && !relay.session.unlocked
                    && String(relay.session.reason).indexOf('scan-required') === 0) relay.scanCode();
            } catch (e) { log.warn('tick: ' + e); }
        }, 1000);
        if (second.unref) second.unref();

        /* ---------------- start ---------------- */

        doorbell.start();
        relay.start();

        process.on('exit', () => {
            clearInterval(second);
            if (garage.told) shared.write('garage.json', { ok: false });
            doorbell.stop();
            relay.stop();
        });

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
