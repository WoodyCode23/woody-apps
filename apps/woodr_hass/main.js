'use strict';
/**
 * Home Assistant - HA on the centre screen, the car's state in HA, and the doorbell camera on the
 * instrument cluster.
 *
 *   tiles.js      the entity grid (1600x520)
 *   ha.js         the WebSocket connection, with REST as the fallback and for service calls
 *   ws.js         a Node 8 RFC 6455 client (no npm on the head unit)
 *   config.js     <dataDir>/ha.json: URL, token, tiles - none of which fits app.json settings
 *   push.js       car state out to HA (webhook or helper services)
 *   doorbell.js   the camera overlay on cluster-render's `map` target, and its hand-back
 *
 * Read-only on the car: vehicle signals in, pixels and HTTP out. Nothing is written to any ECU.
 * Never throws out of a callback: an uncaught error exits the app, and MainApp's
 * CorruptAppsHandler wipes an app's data on its first crash and uninstalls it on the second.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Tiles = require('./tiles');
const config = require('./config');
const { Ha } = require('./ha');
const { Push } = require('./push');
const { Doorbell } = require('./doorbell');

const W = 1600, H = 520;
const APP_ID = 'woodr_hass';
const CONFIRM_MS = 4000;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let cfg = config.load(ctx.dataDir, log);
        const car = new Car(ctx, ['speed', 'rpm', 'temps', 'gear', 'condition']);
        const ha = new Ha(cfg, log);
        const push = new Push(ctx, ha, cfg);
        const doorbell = new Doorbell(ctx, ha, cfg, APP_ID);

        let pageIx = 0, sel = 0;
        const busy = {};                  /* entity -> true while a service call is in flight */
        let armed = null;                  /* { entity, until } for a confirm-twice tile */
        let note = '';                     /* the last thing worth telling the driver */
        let noteUntil = 0;

        const say = (text, secs) => { note = text; noteUntil = Date.now() + (secs || 5) * 1000; refresh(); };
        const pages = () => config.pagesFor(cfg, ha.get(cfg.dashboardEntity)).pages;
        const page = () => { const p = pages(); return p.length ? p[Math.min(pageIx, p.length - 1)] : null; };

        /* ---------------- actions ---------------- */

        function activate(tile) {
            if (!tile || tile.tap === 'none') return;
            if (tile.confirm) {
                const now = Date.now();
                if (!armed || armed.entity !== tile.entity || now > armed.until) {
                    armed = { entity: tile.entity, until: now + CONFIRM_MS };
                    say('Press again to confirm ' + tile.name, 4);
                    return;
                }
                armed = null;
            }
            const parts = tile.tap === 'toggle' ? ['homeassistant', 'toggle'] : tile.tap.split('.');
            if (parts.length !== 2) { say('Bad tap action: ' + tile.tap); return; }
            const data = Object.assign({ entity_id: tile.entity }, tile.data || {});
            busy[tile.entity] = true;
            refresh();
            ha.call(parts[0], parts[1], data)
                .then(() => { delete busy[tile.entity]; say(tile.name + ': ' + parts[1]); })
                .catch((e) => { delete busy[tile.entity]; say(tile.name + ' failed: ' + e.message, 8); });
        }

        /* ---------------- the HA connection ---------------- */

        ha.on('link', (how, why) => { log.info('link: ' + how + ' - ' + why); refresh(); });
        ha.on('states', () => refresh());
        ha.on('state', (entity, st) => {
            /* The doorbell trigger: a state_changed into the configured state. */
            const d = cfg.doorbell;
            if (d && d.entity && entity === d.entity && st && String(st.state) === String(d.to)) {
                doorbell.ring(d.label);
            }
            /* Only redraw for something on screen, or the dashboard definition changing. */
            const p = page();
            const mine = p && p.tiles.some((t) => t.entity === entity);
            if (mine || entity === cfg.dashboardEntity) refresh();
        });

        doorbell.onChange = () => refresh();

        /* ---------------- drawing ---------------- */

        function drawHeader(cv, t) {
            const p = pages(), title = page() ? page().title : 'No tiles';
            const link = ha.link === 'ws' ? 'Live' : ha.link === 'rest' ? 'Polling' : 'Offline';
            const colour = ha.link === 'ws' ? '#2fd27a' : ha.link === 'rest' ? '#ffc21a' : t.warn;
            cv.text(title, 24, 76, 30, t.text, { font: 'bold' });
            cv.text(link, W - 24, 76, 24, colour, { align: 'right', font: 'bold' });
            cv.text(ha.linkWhy || '', W - 24, 100, 18, t.dim, { align: 'right' });
            if (p.length > 1) cv.text('Page ' + (pageIx + 1) + ' of ' + p.length, 24, 100, 18, t.dim);
        }

        function drawFooter(cv, t) {
            const y = 470 + G.pageBottom(cv) - G.BOTTOM;
            const db = doorbell.status();
            const ps = push.status();
            let line;
            if (Date.now() < noteUntil && note) line = note;
            else if (cfg.error) line = cfg.error;
            else if (db.shown) line = 'Cluster: ' + db.kind + ' for ' + db.secsLeft + ' s (' + db.why + ')';
            else {
                line = 'Doorbell ' + db.mode + (db.available ? '' : ' - cluster-render down')
                    + (db.decoder ? '' : ' - no JPEG decoder')
                    + '   |   Car state ' + (ps.on ? 'to HA via ' + ps.how + ' (' + ps.sent + ' sent' + (ps.failed ? ', ' + ps.failed + ' failed' : '') + ')' : 'not sent');
            }
            cv.text(line, 24, y, 20, Date.now() < noteUntil || cfg.error ? t.text : t.dim);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawHeader(cv, t);
            const p = page();
            if (!p) {
                G.panel(cv, t, 24, 112, 1552, 332, 'Nothing to show yet');
                cv.text(cfg.error || 'ha.json has no "pages", and no dashboard entity was found.', 56, 210, 26, t.warn);
                cv.text('Copy ha.json to ' + cfg.file, 56, 256, 22, t.dim);
                cv.text('See ha-design/OPEN_QUESTIONS.md for what it needs.', 56, 294, 22, t.dim);
            } else {
                Tiles.draw(cv, t, p, (e) => ha.get(e), (tile) => activate(tile), sel, busy);
            }
            drawFooter(cv, t);
            G.frame(cv, t, ['Home Assistant'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        function refresh() { render().catch((e) => log.warn('render: ' + e)); }

        /* ---------------- buttons ---------------- */

        ui.onClick('BTN_ACTION', () => {
            const p = page();
            if (p && p.tiles[sel]) activate(p.tiles[sel]);
            else if (cfg.doorbell) doorbell.ring(cfg.doorbell.label);     /* nothing to tap: test the overlay */
            return render();
        });
        ui.onClick('BTN_PAGE', () => {
            const p = pages();
            if (p.length > 1) pageIx = (pageIx + 1) % p.length;
            else sel = (sel + 1) % Tiles.PER_PAGE;
            return render();
        });

        settings.onChange((key) => {
            if (key === 'reload' && settings.get('reload') === true) {
                cfg = config.load(ctx.dataDir, log);
                ha.cfg = cfg; push.cfg = cfg; doorbell.cfg = cfg;
                settings.set('reload', false);
                say('ha.json reloaded');
                if (ha.link === 'down' && cfg.baseUrl && cfg.token) { ha.stopped = false; ha.start(); }
                return;
            }
            if (key === 'doorbell' && settings.get('doorbell') === 'off') doorbell.dismiss('turned off');
            refresh();
        });

        /* ---------------- car signals ---------------- */

        car.onSample(() => {
            const d = car.data ? car.data() : car.live;
            push.feed(d);
            doorbell.carState(d);
        });

        /* ---------------- start ---------------- */

        doorbell.start();
        push.start();
        ha.start();

        process.on('exit', () => { doorbell.stop(); push.stop(); ha.stop(); });

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
