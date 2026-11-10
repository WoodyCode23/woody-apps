'use strict';
/**
 * Warm-Up HUD - oil warm-up state on the head-up display.
 *
 * The centre screen shows the same information plus whether the HUD layer is actually up;
 * hud.js owns the HUD itself. Read-only: signals in, pixels out, nothing written to the car.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { WarmHud, state, revCeiling } = require('./hud');
const GearboxTemp = require('./gearbox');

const W = 1600, H = 520;
const APP_ID = 'woodr_warmhud';

async function background(bg) {
    const gearbox = new GearboxTemp(bg);
    const car = new Car(bg, ['temps', 'rpm', 'speed'], gearbox.handlers());
    const hud = new WarmHud(bg, APP_ID);
    hud.start();

    /* The gearbox temperature is a diagnostic read (UDS 22 to the EGS, through the kit's read-only link:
     * anything but reads throws before it leaves the head unit). Poll it ONLY while the engine runs and
     * the warm-up isn't finished: flashing and coding (E-Sys, bootmod3) happen with the engine off, and
     * nothing of ours should be on the bus then. */
    let rpmSeen = 0;
    const wantGearbox = () => {
        const running = typeof car.live.rpm === 'number' && car.live.rpm > 400;
        if (running) rpmSeen = Date.now();
        const engineOn = Date.now() - rpmSeen < 5000;
        return engineOn && bg.settings.get('trans') !== false && !hud.done;
    };
    let polling = false;
    const tick = () => {
        try {
            const want = wantGearbox();
            if (want && !polling) { gearbox.start(); polling = true; bg.log.info('gearbox: polling (engine running)'); }
            else if (!want && polling) { gearbox.stop(); polling = false; bg.log.info('gearbox: stopped'); }
            hud.update(Object.assign({}, car.live, { trans: gearbox.value() }));
        } catch (e) { bg.log.warn('hud tick: ' + e); }
    };
    const timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref();
    car.onSample(tick);
    bg.settings.onChange(tick);
    process.on('exit', () => { clearInterval(timer); gearbox.stop(); hud.stop(); });
    tick();
    return { car: car, hud: hud, gearbox: gearbox };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const bgm = ctx.background || await background(ctx);
        const car = bgm.car, hud = bgm.hud, gearbox = bgm.gearbox;
        const hudOk = hud.available();
        let lastSt = null;

        const num = (v) => (typeof v === 'number' && isFinite(v));
        const readyAt = () => Number(settings.get('readyAt')) || 90;
        const unitF = () => settings.get('tempUnit') === 'f';
        const shown = (c) => (!num(c) ? '--' : Math.round(unitF() ? c * 9 / 5 + 32 : c) + String.fromCharCode(176) + (unitF() ? 'F' : 'C'));


        function drawState(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'Warm-up');
            const d = car.live;
            const st = state(d.oil, readyAt());
            cv.text(st.label === 'OIL --' ? 'No data' : st.label, 48, 136, 48, st.colour, { font: 'bold' });

            cv.text('Oil', 48, 220, 26, t.dim);
            cv.text(shown(d.oil), 260, 220, 42, num(d.oil) ? t.text : t.dim, { font: 'bold' });
            cv.text('Coolant', 48, 270, 26, t.dim);
            cv.text(shown(d.coolant), 260, 270, 42, num(d.coolant) ? t.text : t.dim, { font: 'bold' });
            const tr = gearbox.value();
            cv.text('Gearbox', 48, 320, 26, t.dim);
            cv.text(settings.get('trans') === false ? 'off' : shown(tr) + (num(tr) && gearbox.source ? '  (' + gearbox.source + ')' : ''),
                260, 320, 34, num(tr) ? t.text : t.dim, { font: 'bold' });

            const bx = 48, by = 350, bw = 680, bh = 18;
            cv.roundRect(bx, by, bw, bh, 9, '#2a2a2a');
            if (st.frac > 0) cv.roundRect(bx, by, Math.max(bh, Math.min(1, st.frac) * bw), bh, 9, st.colour);

            const ceil = revCeiling(d.oil, readyAt());
            cv.text(ceil === null ? (st.key === 'ready' ? 'Full revs available' : 'Waiting for the engine')
                : 'Keep under ' + ceil + ' rpm', 48, 410, 24, ceil === null && st.key === 'ready' ? st.colour : t.dim);
        }

        function drawHudPanel(cv, t) {
            G.panel(cv, t, 804, 44, 772, 468, 'Head-up display');
            const on = settings.get('hud') !== false;
            let line, colour;
            if (!hudOk) { line = 'cluster-render not available'; colour = t.warn; }
            else if (!on) { line = 'Turned off in settings'; colour = t.dim; }
            else if (hud.layer) { line = 'Showing on the HUD'; colour = '#2fd27a'; }
            else if (hud.done) { line = 'Done for this drive - oil and gearbox warm'; colour = '#2fd27a'; }
            else if (hud.layer && hud.phase === 'trans') { line = 'Showing gearbox warm-up'; colour = '#2fd27a'; }
            else if (!(typeof car.live.oil === 'number')) { line = 'Waiting for the oil reading'; colour = t.dim; }
            else { line = 'Waiting for the HUD'; colour = t.dim; }
            cv.text(line, 828, 136, 34, colour, { font: 'bold' });

            cv.text('The readout sits in the part of the HUD scene you can', 828, 210, 22, t.dim);
            cv.text('actually see. Black areas read as clear glass.', 828, 242, 22, t.dim);

            let x = 828;
            x += G.button(cv, t, x, 300, 0, 52, on ? 'HUD on' : 'HUD off', () => { settings.set('hud', !on); return render(); },
                { primary: on, key: 'hud' }) + 16;
            G.button(cv, t, x, 300, 0, 52, 'Settings', () => ui.screen('SETTINGS'), { key: 'settings' });

            cv.text('Rev ceilings while cold are conservative guidance,', 828, 400, 20, t.dim);
            cv.text('not a BMW specification.', 828, 428, 20, t.dim);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawState(cv, t);
            drawHudPanel(cv, t);
            G.frame(cv, t, ['Warm-Up HUD'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { settings.set('hud', settings.get('hud') === false); return render(); });
        settings.onChange(() => { lastSt = hud.update(car.live); return render().catch(() => {}); });
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
