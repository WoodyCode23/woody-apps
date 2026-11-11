'use strict';
/**
 * Dev HUD - progress bars and the numbers that matter while working on the car, on the head-up display.
 *
 * Shown while something is happening (a Store install, a bar pushed from the laptop), or always if set;
 * never while the car moves. Sources, all read-only:
 *   mgu-updater's socket (status only), the car's battery-charge broadcast, the uplink lease file,
 *   and <dataDir>/feed.json, which the laptop writes with tools/hud-push.sh.
 * No diagnostic requests: safe to leave running during E-Sys or bootmod3 sessions.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { UpdaterClient } = require('./updater_client');
const { DevHud, rows, draw, IW, IH } = require('./devhud');

const W = 1600, H = 520;
const APP_ID = 'woodr_devhud', VERSION = '0.1.4';
const LEASE = '/run/mgu-uplink/lease.json';
const FEED_FRESH_MS = 60000;
const MOVING_KMH = 5;

async function background(bg) {
    const { log, settings } = bg;
    const st = { updater: null, battery: null, net: null, feed: [], speed: null };
    const hud = new DevHud(bg, APP_ID);
    hud.start();

    const car = new Car(bg, ['speed']);
    bg.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
        statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (typeof c === 'number' && c >= 0 && c <= 100) st.battery = c; },
    }, log, { pollMs: 30000 }).then((s) => log.info('battery ' + (s.error ? 'error: ' + s.error : 'subscribed')));

    const up = new UpdaterClient({ hello: { id: APP_ID, version: VERSION } });
    up.on('state', (s) => { st.updater = s; });      /* drawn by the 1 s tick, not on every push */
    up.on('down', () => { st.updater = null; });
    up.connect();
    /* the updater's pushes can be sparse: ask while a job runs, so the bar moves */
    const poll = setInterval(() => { if (st.updater && st.updater.busy) up._write({ op: 'status' }); }, 3000);
    if (poll.unref) poll.unref();

    const readLease = () => {
        try { const l = JSON.parse(fs.readFileSync(LEASE, 'utf8')); st.net = l.interface ? l.interface + ' ' + (l.ip || '') : null; } catch (e) { st.net = null; }
    };
    const feedFile = path.join(bg.dataDir, 'feed.json');
    const readFeed = () => {
        try {
            const age = Date.now() - fs.statSync(feedFile).mtime.getTime();
            if (age > FEED_FRESH_MS) { st.feed = []; return; }
            const f = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
            st.feed = Array.isArray(f.items) ? f.items.slice(0, 3) : [];
        } catch (e) { st.feed = []; }
    };

    let shown = null;
    function tick() {
        try {
            readLease(); readFeed();
            const d = car.data ? car.data() : car.live;
            st.speed = d && typeof d.speed === 'number' ? d.speed : null;
            const r = rows(st);
            const on = settings.get('hud') !== false;
            const moving = typeof st.speed === 'number' && st.speed > MOVING_KMH;
            const want = on && !moving && (r.active || settings.get('mode') === 'always');
            shown = want ? r.rows : null;
            hud.show(shown);
        } catch (e) { log.warn('tick: ' + e); }
    }
    const timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref();
    settings.onChange(tick);
    process.on('exit', () => { clearInterval(timer); up.close(); hud.stop(); });
    tick();
    return { st: st, rows: () => rows(st), shown: () => shown, feedFile: feedFile };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgm = ctx.background || await background(ctx);

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const r = bgm.rows(), shown = bgm.shown();
            G.panel(cv, t, 24, 44, 820, 468, 'On the HUD now');
            /* the same picture the HUD gets, drawn on a black "windshield" */
            cv.roundRect(48, 110, IW + 32, IH + 32, 12, '#000000');
            draw(cv, r.rows, 64, 126);
            const lines = r.rows.map((x) => x.label + ':  ' + x.text + (x.frac !== null && x.frac !== undefined ? '  (' + Math.round(x.frac * 100) + '%)' : ''));
            lines.forEach((l, i) => cv.text(l, 64, 330 + i * 34, 24, t.text));
            cv.text(shown ? 'Showing on the HUD' : settings.get('hud') === false ? 'HUD off in settings' : r.active ? 'Hidden: car moving' : 'Hidden: nothing happening (mode: when busy)',
                64, 460, 22, shown ? '#2fd27a' : t.dim);

            G.panel(cv, t, 864, 44, 712, 468, 'Push a bar from the laptop');
            [
                'bash ~/mgu-dev/tools/hud-push.sh "E-Sys" 40',
                'bash ~/mgu-dev/tools/hud-push.sh "Build" 3 5 "step 3 of 5"',
                'bash ~/mgu-dev/tools/hud-push.sh clear',
                '',
                'A pushed bar stays up for 60 s after the last push.',
                'It writes ' + path.basename(bgm.feedFile) + ' in this app\'s data folder.',
                'Battery: the car\'s own charge signal, no requests.',
                'Hidden above ' + MOVING_KMH + ' km/h.',
            ].forEach((l, i) => cv.text(l, 888, 120 + i * 40, i < 3 ? 20 : 20, i < 3 ? t.text : t.dim));
            G.frame(cv, t, ['Dev HUD'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { settings.set('mode', settings.get('mode') === 'always' ? 'busy' : 'always'); return render(); });
        ctx.loop('MAIN', 1, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
