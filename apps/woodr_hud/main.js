'use strict';
/**
 * Woody HUD - a menu on the head-up display, worked by the left stalk's high-beam-assistant button, and shift
 * lights drawn as a border round the Waze map.
 *
 * MENU   Double-tap the button: the menu opens on the HUD and its highlight walks the items by itself
 *        (STEP_MS each). Double-tap again: the highlighted item happens. No pick within a full round: it closes.
 *        Only even tap counts are used, so the assistant always ends where it was (the car's function is
 *        untouched); other counts are left to other apps (Ambient Studio: 4 / 6).
 * SHIFT  With the engine running: a frame round the Waze map's box on the HUD (from waze-on-cluster's status)
 *        green / yellow / red by rpm, flashing from the shift rpm; without the Waze map, a slim bar in the
 *        clear slot instead. The frame's picture changes only with the stage; the flash only toggles the
 *        layer's visibility, so no pixels go up for it.
 *
 * Read-only on the car: signals in, pixels out, two small files in /dev/shm/woody for the other Woody apps.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Canvas, withAlpha } = require('./kit/canvas');
const { Wheel } = require('./wheel');
const { Waze } = require('./waze');
const shared = require('./shared');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported at start */ }

const W = 1600, H = 520;
const APP_ID = 'woodr_hud';
const IDLE_MS = 10000;                 /* the menu closes this long after the last button or roll */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };            /* clear of BMW's HUD content in every view (Screen Lab) */
const MENU = { x: 260, y: 150, w: 390, h: 190 };
const COLOURS = { green: '#2fd27a', yellow: '#ffd34d', red: '#ff2a2a' };
const FRAME = 7, PAD = 6;
/* widths that stay inside the HUD's visible 570 px (Screen Lab): 280 / 400 / 544 px */
const SIZES = [['small', 35], ['medium', 50], ['large', 68]];

function drawMenu(cv, items, at) {
    const rowH = Math.floor((MENU.h - 16) / items.length);
    items.forEach((it, i) => {
        const y = 8 + i * rowH, on = i === at;
        if (on) cv.roundRect(6, y, MENU.w - 12, rowH - 4, 10, '#e1001a');
        cv.text(it.label, 22, y + rowH / 2 + 8, 22, on ? '#ffffff' : '#bdbdbd', { font: on ? 'bold' : undefined });
    });
}

function drawFrame(cv, w, h, colour) {
    cv.fillRect(0, 0, w, FRAME, colour);
    cv.fillRect(0, h - FRAME, w, FRAME, colour);
    cv.fillRect(0, 0, FRAME, h, colour);
    cv.fillRect(w - FRAME, 0, FRAME, h, colour);
}

async function background(bg) {
    const { log, settings } = bg;
    const car = new Car(bg, ['rpm']);
    const waze = new Waze(log);
    const st = { menuOpen: false, at: 0, openedAt: 0, warmup: 'auto', shiftOn: settings.get('shift') !== false, stage: '', box: null, lastPick: '' };
    const cr = ClusterRender ? new ClusterRender(APP_ID) : null;
    if (cr) {
        cr.on('layer', (ref, s, why) => log.info('hud layer ' + ref + ': ' + s + (why ? ' (' + why + ')' : '')));
        cr.connect();
    } else log.warn('cluster_render_client missing');
    let menuLayer = 0, frameLayer = 0, frameKey = '', frameVisible = false;

    shared.write('hud.json', { warmup: 'auto' });

    /* ---------- the menu ---------- */
    const items = () => [
        { key: 'warmup', label: 'Warm-Up: ' + (st.warmup === 'hide' ? 'show again' : 'hide this drive') },
        { key: 'shift', label: 'Shift lights: ' + (st.shiftOn ? 'off' : 'on') },
        { key: 'waze', label: 'Waze map: ' + SIZES[sizeAt()][0] + '  >  ' + SIZES[(sizeAt() + 1) % SIZES.length][0] },
        { key: 'test', label: 'Test shift lights' },
        { key: 'ambient', label: 'Ambient: next colour' },
        { key: 'close', label: 'Close' },
    ];
    let sizeIx = 1;
    const syncSize = () => { const pct = waze.st && waze.st.hud_width_pct; const i = SIZES.findIndex((z) => z[1] === pct); if (i >= 0) sizeIx = i; };
    const sizeAt = () => sizeIx;

    function showMenu() {
        if (!cr) return;
        const list = items();
        if (!menuLayer) {
            /* yield 0: the menu stays on the HUD when BMW's own list pop-up opens with the same button (cluster-render
             * then leaves the HUD to us and BMW's list shows on the cluster instead; seen on the car 2026-11-11:
             * without it the layer went "waiting: a stock pop-up shows in its place") */
            menuLayer = cr.image({ target: 'hud', klass: 'alert', z: 9, yield: 0, x: MENU.x, y: MENU.y, w: MENU.w, h: MENU.h, iw: MENU.w, ih: MENU.h, fps: 4, sampling: 'bilinear' });
            if (!menuLayer) { log.warn('menu layer refused'); return; }
        }
        const cv = new Canvas(MENU.w, MENU.h);
        drawMenu(cv, list, st.at);
        cr.pixels(menuLayer, null, Buffer.from(cv.d.buffer || cv.d));
    }
    function closeMenu() { st.menuOpen = false; if (menuLayer && cr) { cr.drop(menuLayer); menuLayer = 0; } }

    function pick(key) {
        st.lastPick = key;
        log.info('menu: ' + key);
        if (key === 'warmup') { st.warmup = st.warmup === 'hide' ? 'show' : 'hide'; shared.write('hud.json', { warmup: st.warmup }); }
        else if (key === 'shift') { st.shiftOn = !st.shiftOn; settings.set('shift', st.shiftOn); }
        else if (key === 'waze') { sizeIx = (sizeIx + 1) % SIZES.length; waze.setSize(SIZES[sizeIx][1]).catch(() => {}); }
        else if (key === 'test') { st.testUntil = Date.now() + 6500; }
        else if (key === 'ambient') { const a = shared.read('ambient.json') || {}; shared.write('ambient.json', { cmd: 'next', n: (a.n || 0) + 1 }); }
    }

    /* the wheel: the menu button opens (BMW's list opens with it) and picks; the right roller moves the highlight */
    const wheel = new Wheel(bg, {
        onMenu: () => {
            if (settings.get('menu') === false) return;
            if (!st.menuOpen) { st.menuOpen = true; st.at = 0; st.touched = Date.now(); showMenu(); log.info('menu: open'); return; }
            const it = items()[st.at];
            closeMenu();
            if (it && it.key !== 'close') pick(it.key);
        },
        onRoll: (d) => {
            if (!st.menuOpen) return;
            const n = items().length;
            st.at = ((st.at + (d > 0 ? 1 : -1)) % n + n) % n;
            st.touched = Date.now();
            showMenu();
        },
    });
    await wheel.start();

    const menuTimer = setInterval(() => {
        if (st.menuOpen && Date.now() - (st.touched || 0) > IDLE_MS) { closeMenu(); log.info('menu: closed (idle)'); }
    }, 500);

    /* ---------- shift lights ---------- */
    function stageOf(rpm) {
        const g = Number(settings.get('greenRpm')) || 4000, y = Number(settings.get('yellowRpm')) || 5500,
            r = Number(settings.get('redRpm')) || 6300, s = Number(settings.get('shiftRpm')) || 6800;
        if (rpm >= s) return 'flash';
        if (rpm >= r) return 'red';
        if (rpm >= y) return 'yellow';
        if (rpm >= g) return 'green';
        return '';
    }

    function placeFrame(box, colour) {
        /* round the Waze map when it is on the HUD, else a slim bar along the top of the clear slot */
        const r = box ? { x: box.x - PAD - FRAME, y: box.y - PAD - FRAME, w: box.w + 2 * (PAD + FRAME), h: box.h + 2 * (PAD + FRAME) }
            : { x: SLOT.x, y: SLOT.y - 14, w: SLOT.w, h: 12 };
        const key = JSON.stringify(r) + colour;
        if (key === frameKey && frameLayer) return;
        if (frameLayer && cr) { cr.drop(frameLayer); frameLayer = 0; }
        const iw = Math.max(2 * FRAME + 2, Math.round(r.w / 2)), ih = Math.max(2 * FRAME + 2, Math.round(r.h / 2));
        frameLayer = cr.image({ target: 'hud', klass: 'overlay', z: 7, x: r.x, y: r.y, w: r.w, h: r.h, iw: iw, ih: ih, fps: 2, sampling: 'bilinear' });
        if (!frameLayer) { log.warn('frame layer refused'); return; }
        const cv = new Canvas(iw, ih);
        if (box) drawFrame(cv, iw, ih, colour); else cv.roundRect(0, 0, iw, ih, 3, colour);
        cr.pixels(frameLayer, null, Buffer.from(cv.d.buffer || cv.d));
        frameKey = key; frameVisible = true;
    }
    function hideFrame() { if (frameLayer && cr) { cr.drop(frameLayer); frameLayer = 0; frameKey = ''; } }

    let flashOn = false;
    const shiftTimer = setInterval(() => {
        try {
            if (!cr) return;
            const d = car.data ? car.data() : car.live;
            const rpm = d && typeof d.rpm === 'number' ? d.rpm : null;
            /* the test: green, yellow, red, flash, 1.5 s each, engine or not */
            const testLeft = (st.testUntil || 0) - Date.now();
            const stage = testLeft > 0 ? ['flash', 'red', 'yellow', 'green', 'green'][Math.floor(testLeft / 1500)] || 'green'
                : st.shiftOn && rpm !== null && rpm > 400 ? stageOf(rpm) : '';
            if (stage !== st.stage) log.info('shift: ' + (stage || 'off') + (rpm !== null ? ' at ' + Math.round(rpm) + ' rpm' : '') + (testLeft > 0 ? ' (test)' : ''));
            st.stage = stage;
            if (!stage) { hideFrame(); return; }
            placeFrame(st.box, COLOURS[stage === 'flash' ? 'red' : stage]);
            if (stage === 'flash') { flashOn = !flashOn; cr.set(frameLayer, { visible: flashOn }); frameVisible = flashOn; }
            else if (!frameVisible) { cr.set(frameLayer, { visible: true }); frameVisible = true; }
        } catch (e) { log.warn('shift: ' + e); }
    }, 120);

    const wazeTimer = setInterval(() => { waze.poll().then(() => { st.box = waze.hudBox(); syncSize(); }).catch(() => {}); }, 4000);
    waze.poll().then(() => { st.box = waze.hudBox(); }).catch(() => {});

    process.on('exit', () => { [menuTimer, shiftTimer, wazeTimer].forEach(clearInterval); closeMenu(); hideFrame(); if (cr) { try { cr.close(); } catch (e) { /* going */ } } });
    return { st: st, items: items, waze: waze, pick: pick };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgm = ctx.background || await background(ctx);
        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.panel(cv, t, 24, 44, 760, 468, 'HUD menu');
            ['Press the menu button on the wheel (three lines, right side):', 'our menu opens on the HUD over BMW\'s list.',
                'Roll the right roller to move, press the menu button again to pick.', '', 'It closes by itself after 10 s.']
                .forEach((l, i) => cv.text(l, 48, 112 + i * 34, 21, i < 3 ? t.text : t.dim));
            bgm.items().forEach((it, i) => {
                const y = 300 + i * 40;
                cv.roundRect(48, y - 28, 600, 34, 8, withAlpha(t.text, 0.08));
                cv.text(it.label, 64, y - 4, 20, t.text);
                if (cv.own) cv.target(48, y - 28, 600, 34, () => { bgm.pick(it.key); return render(); }, 'i' + i, 8);
            });
            G.panel(cv, t, 804, 44, 772, 468, 'Shift lights');
            const box = bgm.waze.hudBox();
            const line = (k, v, y, c) => { cv.text(k, 828, y, 20, t.dim); cv.text(v, 1552, y, 20, c || t.text, { align: 'right' }); };
            line('Shift lights', bgm.st.shiftOn ? 'on' : 'off', 112, bgm.st.shiftOn ? '#2fd27a' : t.dim);
            line('Where', box ? 'round the Waze map (' + box.w + 'x' + box.h + ' at ' + box.x + ',' + box.y + ')' : 'slim bar (Waze map not on the HUD)', 146);
            line('Green / yellow / red', (settings.get('greenRpm') || 4000) + ' / ' + (settings.get('yellowRpm') || 5500) + ' / ' + (settings.get('redRpm') || 6300) + ' rpm', 180);
            line('Flash from', (settings.get('shiftRpm') || 6800) + ' rpm', 214);
            line('Now', bgm.st.stage || 'idle', 248, bgm.st.stage ? COLOURS[bgm.st.stage === 'flash' ? 'red' : bgm.st.stage] : t.dim);
            line('Warm-Up HUD', bgm.st.warmup, 282);
            line('Last pick', bgm.st.lastPick || '-', 316);
            G.frame(cv, t, ['Woody HUD'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }
        ui.onClick('BTN_ACTION', () => { bgm.pick('shift'); return render(); });
        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 2, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
