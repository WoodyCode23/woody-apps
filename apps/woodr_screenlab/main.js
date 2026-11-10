'use strict';
/**
 * Screen Lab - put a measured grid on the HUD, the cluster or the centre screen, so you can
 * design against real geometry instead of guessing.
 *
 * Centre screen shows the target list your car actually advertises (cluster-render's hello),
 * the probe numbers to copy into your code, and the same pattern scaled down to preview.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Lab = require('./lab');
const { Canvas } = require('./kit/canvas');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported below */ }

const W = 1600, H = 520;
const APP_ID = 'woodr_screenlab';
const ORDER = ['hud', 'map', 'panel', 'screen'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let cr = null, layer = null, layerTarget = '', advertised = '', on = true, lastKey = '';

        if (ClusterRender) {
            cr = new ClusterRender(APP_ID);
            cr.on('ready', () => { advertised = cr.targets || ''; lastKey = ''; log.info('targets: ' + advertised); render().catch(() => {}); });
            cr.on('layer', (ref, s, why) => { log.info('layer ' + s + (why ? ' (' + why + ')' : '')); render().catch(() => {}); });
            cr.on('target', (name, s, holder, why, guideDisabled, disabled) => {
                if (disabled) log.warn(name + ': disabled by the guard - `cluster-render guard-reset` as root');
            });
            cr.connect();
        } else {
            log.warn('cluster_render_client missing - centre screen only');
        }

        /* driving mode: stock HUD views differ by mode, so every pattern carries it */
        let modeRaw = null;
        const modeLabel = () => {
            const m = Lab.driveModeOf(modeRaw);
            return modeRaw === null ? '' : (m ? m.toUpperCase() : 'UNKNOWN') + ' (' + modeRaw + ')';
        };
        ctx.signals.watch('de.bmw.infotainment.drivingexcitement.FES', '1', {
            statusFESVehicleDynamicSwitchHMI: (v) => {
                const raw = v && v.actualValueModeDrivingExperience;
                if (raw !== undefined && String(raw) !== String(modeRaw)) {
                    modeRaw = raw; log.info('driving mode: ' + modeLabel()); render().catch(() => {});
                }
            },
        }, log).then((sub) => { if (sub && sub.error) log.warn('FES: ' + sub.error); }).catch(() => {});

        const opts = () => ({
            modeLabel: modeLabel(),
            pattern: settings.get('pattern') || 'grid',
            grid: Number(settings.get('grid')) || 50,
            safe: settings.get('safe') !== false,
            probe: { x: Number(settings.get('px')) || 0, y: Number(settings.get('py')) || 0,
                     w: Number(settings.get('pw')) || 100, h: Number(settings.get('ph')) || 100 },
        });

        function dropLayer() { if (layer && cr) cr.drop(layer); layer = null; layerTarget = ''; lastKey = ''; }

        /** put the pattern on the chosen cluster-render target; returns the clamped probe */
        function project() {
            const target = settings.get('target') || 'hud';
            if (!cr || target === 'screen' || !on) { dropLayer(); return null; }
            const T = Lab.TARGETS[target];
            if (!T) { dropLayer(); return null; }
            const o = opts();

            if (layerTarget !== target) {
                dropLayer();
                layer = cr.image({ target: target, klass: 'overlay', z: 0, x: 0, y: 0, w: T.w, h: T.h,
                    iw: T.w, ih: T.h, fps: 2, sampling: 'nearest', contend: target === 'map' ? 1 : 0 });
                if (!layer) { log.warn('layer refused for ' + target); return null; }
                layerTarget = target;
            }
            const key = target + '|' + JSON.stringify(o);
            if (key === lastKey) return Lab.clampProbe(o.probe, T.w, T.h);
            lastKey = key;

            const cv = new Canvas(T.w, T.h);
            const probe = Lab.paint(Lab.pen(cv, 0, 0, 1), target, o);
            if (!cr.pixels(layer, null, Buffer.from(cv.d.buffer || cv.d))) log.warn('pixels refused');
            return probe;
        }

        function drawPreview(cv, t) {
            G.panel(cv, t, 24, 44, 900, 468, 'Preview');
            const target = settings.get('target') || 'hud';
            const T = Lab.TARGETS[target];
            if (!T) { cv.text('Centre screen only - nothing projected', 48, 140, 28, t.dim); return null; }
            const maxW = 840, maxH = 320;
            const k = Math.min(maxW / T.w, maxH / T.h);
            const dx = 48, dy = 104;
            cv.fillRect(dx - 2, dy - 2, T.w * k + 4, T.h * k + 4, '#333333');
            const probe = Lab.paint(Lab.pen(cv, dx, dy, k), target, opts());
            cv.text(T.w + ' x ' + T.h + '  shown at ' + Math.round(k * 100) + '%', 48, dy + T.h * k + 36, 22, t.dim);
            return probe;
        }

        function drawNumbers(cv, t, probe) {
            G.panel(cv, t, 944, 44, 632, 468, 'Numbers');
            const target = settings.get('target') || 'hud';
            const T = Lab.TARGETS[target];
            let y = 110;
            const row = (k, v, colour) => { cv.text(k, 968, y, 22, t.dim); cv.text(v, 1240, y, 24, colour || t.text, { font: 'bold' }); y += 44; };

            row('Target', target);
            row('Mode', modeLabel() || 'no signal yet', modeRaw === null ? t.dim : '#ffd34d');
            row('Scene', T ? T.w + ' x ' + T.h : 'centre screen 1600 x 520');
            if (probe) {
                row('Probe x,y', probe.x + ', ' + probe.y, '#ffd34d');
                row('Probe w,h', probe.w + ' x ' + probe.h, '#ffd34d');
            }
            const known = Lab.KNOWN_SAFE[target];
            if (known) row('Known safe', known.x + ',' + known.y + ' ' + known.w + 'x' + known.h, '#2fd27a');
            row('Layer', !cr ? 'no cluster-render' : !on ? 'paused' : layer ? 'up on ' + layerTarget : target === 'screen' ? 'n/a' : 'not up',
                layer && on ? '#2fd27a' : t.dim);

            cv.text('Car advertises:', 968, 430, 20, t.dim);
            cv.text(advertised || '(waiting for cluster-render)', 968, 458, 18, advertised ? t.text : t.dim);
        }

        async function render() {
            const probe = project();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const shownProbe = drawPreview(cv, t) || probe;
            drawNumbers(cv, t, shownProbe);
            G.frame(cv, t, ['Screen Lab'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { on = !on; return render(); });
        ui.onClick('BTN_PAGE', () => {
            const cur = settings.get('target') || 'hud';
            settings.set('target', ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]);
            return render();
        });
        settings.onChange(() => render().catch(() => {}));
        process.on('exit', () => { dropLayer(); if (cr) { try { cr.close(); } catch (e) { /* leaving */ } } });

        ctx.loop('MAIN', 1, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
