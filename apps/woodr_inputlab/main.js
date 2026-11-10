'use strict';
/**
 * Input Lab - which buttons, stalks and gestures does the head unit see?
 *
 * Subscribes to every input interface found on this car (SteeringWheelPushButton, body.Light for the left
 * stalk, FrontCCU, CenterStack, MyCarButton, GestureRecognition) and shows each change as it arrives, with
 * enum values decoded from the interface definitions. Press a button, see its name and value: that is what
 * an app can react to.
 *
 * Listens only. No setter, method or request is ever called; the interfaces' request fields
 * (requestSteerWheelFunctions and the like) are not even subscribed.
 * Every change is also written to the app log (journalctl), so a session can be read back from the PC.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const W = 1600, H = 520;
const MAX_ROWS = 11;
const ROTARY = /Rotary|Steps|Encoder/;

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const spec = require('./inputs');
        const events = [];                 /* newest first: { at, iface, field, text } */
        const counts = {};                 /* iface.field -> changes seen */
        const last = {};                   /* iface.field -> last text, to drop repeats */
        const status = {};                 /* short iface -> 'live' | 'waiting' | error */

        const short = (iface) => iface.split('.').pop();

        /* enum number -> name, from the interface's own definition */
        const enums = {};
        function learnEnums(iface) {
            let cfg = null;
            try { cfg = signals.loadConfig(iface); } catch (e) { return; }
            const walk = (o) => {
                if (!o || typeof o !== 'object') return;
                if (o.n && o.t === 'Enum' && o.e) {
                    const m = {}; Object.keys(o.e).forEach((k) => { m[o.e[k]] = k; });
                    enums[iface + '/' + o.n] = m;
                }
                Object.keys(o).forEach((k) => walk(o[k]));
            };
            walk(cfg);
        }
        function describe(iface, v) {
            if (v === null || v === undefined) return String(v);
            if (typeof v !== 'object') return String(v);
            return Object.keys(v).map((k) => {
                const x = v[k], m = enums[iface + '/' + k];
                const shown = m && m[x] !== undefined ? m[x] : (typeof x === 'object' ? JSON.stringify(x) : String(x));
                return k + '=' + shown;
            }).join('  ');
        }

        function seen(iface, field, v) {
            const key = short(iface) + '.' + field, text = describe(iface, v);
            if (last[key] === text) return;
            last[key] = text;
            counts[key] = (counts[key] || 0) + 1;
            if (ROTARY.test(field) && settings.get('showRotary') === false) return;
            events.unshift({ at: new Date(), iface: short(iface), field: field, text: text });
            if (events.length > 60) events.length = 60;
            log.info('input ' + key + ' ' + text);
            render().catch(() => {});
        }

        Object.keys(spec).forEach((iface) => {
            const def = spec[iface] || {};
            const fields = def.fields || [];
            const broadcasts = def.broadcasts || [];
            learnEnums(iface);
            status[short(iface)] = 'waiting';
            const handlers = {};
            fields.forEach((f) => { handlers[f] = (v) => seen(iface, f, v); });
            signals.watch(iface, '1', handlers, log).then((sub) => {
                status[short(iface)] = sub.error ? 'error: ' + String(sub.error).slice(0, 60) : sub.available ? 'live' : 'subscribed';
                if (sub.proxy) broadcasts.forEach((b) => signals.on(sub.proxy, b, (v) => seen(iface, b + ' (event)', v), log).catch((e) => log.warn(b + ': ' + e)));
                log.info(iface + ': ' + status[short(iface)]);
                render().catch(() => {});
            }).catch((e) => { status[short(iface)] = 'error: ' + e; });
        });

        function pad(n) { return (n < 10 ? '0' : '') + n; }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            /* left: the live list */
            G.panel(cv, t, 24, 44, 1060, 468, 'Press something');
            if (!events.length) cv.text('Nothing yet: press a steering-wheel button, the stalk button, or swipe a gesture.', 48, 130, 22, t.dim);
            events.slice(0, MAX_ROWS).forEach((e, i) => {
                const y = 120 + i * 36;
                if (i === 0) cv.roundRect(36, y - 26, 1036, 34, 8, withAlpha(t.accent, 0.18));
                const ts = pad(e.at.getHours()) + ':' + pad(e.at.getMinutes()) + ':' + pad(e.at.getSeconds());
                cv.text(ts, 48, y, 18, t.dim);
                cv.text(e.iface + '.' + e.field, 140, y, 20, i === 0 ? t.text : t.dim, { font: i === 0 ? 'bold' : undefined });
                cv.text(e.text.slice(0, 70), 560, y, 20, i === 0 ? t.accent : t.text);
            });
            /* right: which interfaces answer, and what has moved */
            G.panel(cv, t, 1104, 44, 472, 468, 'Interfaces');
            let y = 120;
            Object.keys(status).forEach((k) => {
                const s = status[k], ok = s === 'live' || s === 'subscribed';
                cv.text(k, 1128, y, 20, t.text);
                cv.text(s.slice(0, 22), 1552, y, 18, ok ? '#2fd27a' : s === 'waiting' ? t.dim : t.warn, { align: 'right' });
                y += 30;
            });
            y += 14;
            cv.text('Changes seen', 1128, y, 18, t.dim); y += 28;
            Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 6).forEach((k) => {
                cv.text(k.slice(0, 34), 1128, y, 17, t.text);
                cv.text(String(counts[k]), 1552, y, 17, t.accent, { align: 'right' });
                y += 24;
            });
            G.frame(cv, t, ['Input Lab'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { events.length = 0; Object.keys(counts).forEach((k) => delete counts[k]); return render(); });
        ctx.loop('MAIN', 1, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
