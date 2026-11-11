'use strict';
/**
 * Ambient Studio - the ambient light, on top of the car's own.
 *
 *   Colours     tap a preset on the screen; it becomes the car's colour, as BMW's own menu would set it.
 *   Brightness  menu / boost / max (offset 254 is brighter than the menu allows, measured on this car).
 *   Stalk taps  double-tap the high-beam-assistant button: next colour in your list. Four taps: rev-follow
 *               on/off. An even number of taps toggles the assistant back to where it was, so the car's own
 *               function is untouched; single presses are left to the car.
 *   Rev-follow  with the engine running (and, if set, only while Redline is on the HUD): your colour when
 *               cruising, amber from the amber rpm (if on), red from the warning rpm, red at full brightness
 *               from the shift rpm, your light back when you lift. The defaults (5500 / 6300 / 6800) are the
 *               same steps the gear on the head-up display goes through. The light takes a change every 1.5 s, so these are stages, not a needle.
 *
 * Runs in the background (autostart). Never leaves a temporary effect behind: rev-follow and flashes are
 * put back field for field from what the car reported, also when the app stops.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { withAlpha } = require('./kit/canvas');
const { HudClaim } = require('./kit/hud_claim');
const { Light, NAMES, SWATCH } = require('./light');
const { Taps } = require('./taps');
const shared = require('./shared');

const W = 1600, H = 520;
const CYCLES = {
    rgb: [3, 10, 5, 12],
    red: [3],
    all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};
const BRIGHT = { menu: null, boost: 200, max: 254 };
const HYST = 300;                    /* rpm under a stage's start before it is left */
const ENGINE_RPM = 400;
const AMBER = 4;                     /* the car's preset 4, taken to be its orange: not yet looked at in the car */

async function background(bg) {
    const { log, settings } = bg;
    const light = new Light(bg);
    await light.start();
    const car = new Car(bg, ['rpm', 'speed']);
    const st = { stage: 0, home: null, cycleAt: -1, revOn: settings.get('revFollow') === true, lastTap: null, redline: false, garage: 0 };

    /* your colour when the app starts is "home": the double-tap cycle starts and ends there */
    const homeTimer = setInterval(() => { if (st.home === null && light.state.own) st.home = light.state.own; }, 1000);

    function nextColour() {
        const list = CYCLES[settings.get('cycle')] || CYCLES.rgb;
        const ring = [st.home || light.state.own || list[0]].concat(list.filter((n) => n !== st.home));
        st.cycleAt = (st.cycleAt + 1) % ring.length;
        light.preset(ring[st.cycleAt]);
    }

    function applyBrightness() {
        const b = BRIGHT[settings.get('brightness')];
        if (b !== undefined && settings.get('brightness') !== 'menu') light.brightness(b);
    }

    const taps = new Taps(bg, (n) => {
        if (settings.get('taps') !== true) return;
        st.lastTap = { n: n, at: Date.now() };
        if (n === 4) nextColour();                  /* 2 taps belong to Warm-Up HUD (hide / show) */
        else if (n === 6) { st.revOn = !st.revOn; settings.set('revFollow', st.revOn); light.flash(); }
    });
    await taps.start();

    /* Woody HUD's menu: "Ambient: next colour" bumps n in /dev/shm/woody/ambient.json */
    let menuN = (shared.read('ambient.json') || {}).n || 0;
    const menuTimer = setInterval(() => {
        const a = shared.read('ambient.json');
        if (a && a.cmd === 'next' && a.n !== menuN) { menuN = a.n; nextColour(); }
    }, 500);
    if (menuTimer.unref) menuTimer.unref();

    /* rev-follow: stages with hysteresis */
    function revTick() {
        const d = car.data ? car.data() : car.live;
        const rpm = d && typeof d.rpm === 'number' ? d.rpm : null;
        st.redline = HudClaim.others('woodr_ambient').indexOf('redline') >= 0;
        const want = st.revOn && rpm !== null && rpm > ENGINE_RPM && (settings.get('revRedlineOnly') === false || st.redline);
        if (!want) { if (st.stage) { st.stage = 0; st.garage = 0; light.back('rev-follow off'); } return; }
        const warn = Number(settings.get('warnRpm')) || 6300, shift = Number(settings.get('shiftRpm')) || 6800;
        const amber = settings.get('revAmber') === false ? warn : Math.min(warn, Number(settings.get('amberRpm')) || 5500);
        /* where stages 1 (amber), 2 (red) and 3 (red, full brightness) start; with amber off, 1 starts where 2 does and is never shown */
        const starts = [0, amber, warn, shift];
        let s = 0;
        for (let i = 3; i >= 1; i--) if (rpm >= starts[i]) { s = i; break; }
        if (s < st.stage && rpm >= starts[st.stage] - HYST) s = st.stage;
        if (s === st.stage) return;
        st.stage = s;
        if (s === 0) { st.garage = 0; light.back('below ' + amber); }
        else if (s === 1) light.temp(AMBER, null, 'rev-follow: amber from ' + amber);
        else if (s === 2) light.temp(3, null, 'rev-follow: red from ' + warn);
        else light.temp(3, 254, 'rev-follow: shift ' + shift);
    }
    const revTimer = setInterval(revTick, 250);
    if (revTimer.unref) revTimer.unref();
    car.onSample(revTick);

    /* The garage doors, from the Home Assistant app's /dev/shm/woody/garage.json: red while a door is open or
     * moving, green for 10 s after the last one closed, the car's own light whenever there is no fresh news
     * (file older than 40 s, ok:false, the house locked, that app not running). Rev-follow goes first. */
    function garageTick() {
        let want = 0;
        if (settings.get('garage') !== false) {
            const g = shared.read('garage.json', 40000);
            if (g && g.ok === true) {
                if (g.state === 'closed') want = g.since && Date.now() - g.since < 10000 ? 10 : 0;
                else if (g.state === 'open' || g.state === 'opening' || g.state === 'closing') want = 3;
            }
        }
        if (st.stage) return;
        if (want === st.garage) return;
        st.garage = want;
        if (want) light.temp(want, null, 'garage ' + (want === 3 ? 'open' : 'closed'));
        else light.back('garage: nothing to show');
    }
    const garageTimer = setInterval(() => { try { garageTick(); } catch (e) { log.warn('garage: ' + e); } }, 1000);
    if (garageTimer.unref) garageTimer.unref();

    settings.onChange((key) => {
        if (key === 'brightness') { if (settings.get('brightness') === 'menu') light.back('brightness to menu'); else applyBrightness(); }
        if (key === 'revFollow') st.revOn = settings.get('revFollow') === true;
    });
    setTimeout(applyBrightness, 3000);

    process.on('exit', () => { clearInterval(homeTimer); clearInterval(revTimer); clearInterval(garageTimer); taps.stop(); light.stop(); });
    return { light: light, st: st, nextColour: nextColour };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgm = ctx.background || await background(ctx);
        const { light, st } = bgm;

        function chip(cv, t, x, y, w, h, n) {
            const on = light.state.own === n;
            cv.roundRect(x, y, w, h, 12, withAlpha(SWATCH[n], on ? 0.85 : 0.45));
            if (on) cv.strokeRoundRect(x, y, w, h, 12, 3, '#ffffff');
            const ink = [1, 2, 7].indexOf(n) >= 0 ? '#000000' : '#ffffff';     /* dark text only on the whites */
            cv.text(String(n), x + 14, y + 30, 20, ink, { font: 'bold' });
            cv.text(NAMES[n], x + w / 2, y + h - 14, 18, ink, { font: 'bold', align: 'center' });
            if (cv.own) cv.target(x, y, w, h, () => { light.preset(n); return render(); }, 'p' + n, 12);
        }

        function button(cv, t, x, y, w, label, on, key, fn) {
            cv.roundRect(x, y, w, 52, 12, on ? withAlpha('#e1001a', 0.6) : withAlpha(t.text, 0.12));
            cv.text(label, x + w / 2, y + 34, 21, t.text, { font: 'bold', align: 'center' });
            if (cv.own) cv.target(x, y, w, 52, fn, key, 12);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.panel(cv, t, 24, 44, 920, 468, 'Colours');
            for (let n = 1; n <= 12; n++) {
                const k = n - 1, x = 48 + (k % 4) * 220, y = 100 + Math.floor(k / 4) * 96;
                chip(cv, t, x, y, 204, 84, n);
            }
            cv.text(light.error ? 'Ambient light: ' + light.error : 'Tap a colour: it becomes the car\'s own colour, like the BMW menu.', 48, 492, 18, light.error ? t.warn : t.dim);

            G.panel(cv, t, 964, 44, 612, 468, 'Brightness and effects');
            const b = settings.get('brightness') || 'menu';
            [['menu', 'Menu'], ['boost', 'Boost'], ['max', 'Max']].forEach(([k, label], i) =>
                button(cv, t, 988 + i * 192, 100, 180, label, b === k, 'b' + k, () => { settings.set('brightness', k); return render(); }));
            button(cv, t, 988, 172, 276, 'Rev-follow: ' + (st.revOn ? 'ON' : 'off'), st.revOn, 'rev', () => { settings.set('revFollow', !st.revOn); st.revOn = !st.revOn; return render(); });
            button(cv, t, 1276, 172, 276, 'Flash', false, 'flash', () => { light.flash(); return render(); });
            button(cv, t, 988, 244, 564, 'Next colour (same as 4 taps)', false, 'next', () => { bgm.nextColour(); return render(); });

            let y = 336;
            const line = (k, v, c) => { cv.text(k, 988, y, 19, t.dim); cv.text(v, 1552, y, 19, c || t.text, { align: 'right' }); y += 30; };
            line('Stalk button', settings.get('taps') === false ? 'off' : '4 taps next colour, 6 taps rev-follow');
            line('Rev-follow', st.revOn ? ['cruising', 'amber', 'red (warning)', 'red + max (shift)'][st.stage] + (settings.get('revRedlineOnly') === false ? '' : st.redline ? ' · Redline on' : ' · waits for Redline') : 'off');
            line('Amber / red / shift', (settings.get('revAmber') === false ? 'off' : (settings.get('amberRpm') || 5500)) + ' / ' + (settings.get('warnRpm') || 6300) + ' / ' + (settings.get('shiftRpm') || 6800) + ' rpm');
            if (st.lastTap && Date.now() - st.lastTap.at < 8000) line('Last taps', st.lastTap.n + ' taps', '#2fd27a');
            if (st.garage) line('Garage', st.garage === 3 ? 'a door is open: red' : 'closed: green', st.garage === 3 ? '#ff3b30' : '#2fd27a');
            line('Writes', String(light.writes) + (light.inEffect ? ' · effect on' : ''));

            G.frame(cv, t, ['Ambient Studio'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { bgm.nextColour(); return render(); });
        ctx.onScroll((dy) => { bgm.nextColour(); render().catch(() => {}); return true; });
        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 1, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
