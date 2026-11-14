'use strict';
/**
 * HUD - a menu on the head-up display worked from the steering wheel, a rev bar across the top of the
 * display, and the song CarPlay is playing as one line above it.
 *
 * MENU   The wheel's menu button opens it and the right roller moves through it: a roller of five rows with the
 *        chosen one large (menu.js). The menu button again acts on the chosen row and the menu STAYS OPEN: a
 *        switch flips, a choice steps to its next option, an action runs, and a line says what happened.
 *        It closes after 10 s without a touch or from its Close row, and opens again on the row used last.
 *        Rows: this app's own switches, a few quick actions, then every other running app's switches and
 *        choices (kit/hudlink.js; settings only, the app that owns one applies it). The car opens its own
 *        list with the same button whatever an app does, so the roller's press is left alone: it would
 *        pick in the car's list.
 * REVS   With the engine running: a row of segments that fills with the revs, white, then yellow, then red,
 *        and blinks from the shift rpm. It is redrawn only when the number of lit segments changes; the blink
 *        only toggles the layer's visibility, so no pixels go up for it. Setting "Shift display": the older
 *        coloured frame round the Waze map is still there as a choice.
 * SONG   The title and artist from CarPlay (song.js), on the top line. No CarPlay, no line.
 *
 * Read-only on the car: signals in, pixels out, two small files in /dev/shm/woody for the other Woody apps.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Canvas, withAlpha } = require('./kit/canvas');
const { Wheel } = require('./wheel');
const { Waze } = require('./waze');
const { Song } = require('./song');
const { drawBar, drawSong, PLACES, SEGS, RPM_FULL, WHITE, ACCENT } = require('./strip');
const shared = require('./shared');
const hudlink = require('./kit/hudlink');
const menu = require('./menu');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported at start */ }

const W = 1600, H = 520;
const APP_ID = 'woodr_hud';
const IDLE_MS = 10000;                 /* the menu closes this long after the last button or roll */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };            /* clear of BMW's HUD content in every view (Screen Lab) */
const MENU = menu.MENU;
const COLOURS = { green: '#2fd27a', yellow: '#ffd34d', red: '#ff2a2a' };
const FRAME = 7, PAD = 6;
/* widths that stay inside the HUD's visible 570 px (Screen Lab): 280 / 400 / 544 px */
const SIZES = [['small', 35], ['medium', 50], ['large', 68]];

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
    const st = { menuOpen: false, at: 0, sel: '', say: '', sayUntil: 0, pending: null, openedAt: 0, warmup: 'auto', shiftOn: settings.get('shift') !== false, stage: '', box: null, lastPick: '' };
    const cr = ClusterRender ? new ClusterRender(APP_ID) : null;
    if (cr) {
        cr.on('layer', (ref, s, why) => log.info('hud layer ' + ref + ': ' + s + (why ? ' (' + why + ')' : '')));
        cr.connect();
    } else log.warn('cluster_render_client missing');
    let menuLayer = 0, frameLayer = 0, frameKey = '', frameVisible = false;
    let barLayer = 0, barGeom = '', barKey = '', barVisible = false, songLayer = 0, songKey = '', songGeom = '';
    const song = new Song(bg, () => { songKey = ''; });
    song.start().catch((e) => log.info('song: ' + e));

    shared.write('hud.json', { warmup: 'auto' });

    /* ---------- the menu ---------- */
    let sizeIx = 1;
    const syncSize = () => { const pct = waze.st && waze.st.hud_width_pct; const i = SIZES.findIndex((z) => z[1] === pct); if (i >= 0) sizeIx = i; };
    const sizeAt = () => sizeIx;
    const idOf = (it) => (it.app || '') + '|' + it.key;

    /** every row: this app's switches and choices, the quick actions, every other running app's, then Close */
    function items() {
        const list = [];
        const row = (g, app) => (x) => list.push({ g: g, app: app, key: x.key, label: x.label, kind: x.type, value: x.value, options: x.options });
        /* first, so it is one press away when the menu opens fresh: keep the clip the dash cam is recording now */
        list.push({ g: 'Dashcam', app: null, key: 'highlight', kind: 'action', label: 'Highlight this clip', value: 'Mark' });
        hudlink.offered(bg.spec && bg.spec.settings, settings).forEach(row('HUD', null));
        list.push({ g: 'Quick', app: null, key: 'warmup', kind: 'action', label: 'Warm-Up', value: st.warmup === 'hide' ? 'Hidden' : 'Shown' });
        list.push({ g: 'Quick', app: null, key: 'waze', kind: 'action', label: 'Waze map', value: SIZES[sizeAt()][0] });
        list.push({ g: 'Quick', app: null, key: 'ambient', kind: 'action', label: 'Ambient colour', value: 'Next' });
        list.push({ g: 'Quick', app: null, key: 'test', kind: 'action', label: 'Test the rev bar', value: 'Run' });
        try { hudlink.apps(APP_ID).forEach((a) => a.items.forEach(row(a.title, a.id))); } catch (e) { log.warn('menu: apps: ' + e); }
        list.push({ g: 'Menu', app: null, key: 'close', kind: 'close', label: 'Close', value: '' });
        /* a change asked of another app shows at once, until that app has had time to answer with its own value */
        const p = st.pending;
        if (p && Date.now() < p.until) list.forEach((it) => { if (idOf(it) === p.id) it.value = p.value; });
        /* the chosen row follows its item when apps come and go */
        const at = st.sel ? list.findIndex((it) => idOf(it) === st.sel) : -1;
        st.at = at >= 0 ? at : Math.max(0, Math.min(st.at, list.length - 1));
        st.sel = idOf(list[st.at]);
        return list;
    }

    let menuKey = '';
    function showMenu(force) {
        if (!cr) return;
        const list = items();
        const idle = Math.max(0, 1 - (Date.now() - (st.touched || 0)) / IDLE_MS);
        const say = Date.now() < st.sayUntil ? st.say : '';
        /* redrawn only when something on it changed; the idle bar moves in ten steps */
        const key = st.at + '|' + say + '|' + Math.ceil(idle * 10) + '|' + list.map((it) => it.label + '=' + it.value).join(';');
        if (!menuLayer) {
            /* yield 0: the menu stays on the HUD when BMW's own list pop-up opens with the same button (cluster-render
             * then leaves the HUD to us and BMW's list shows on the cluster instead; seen on the car 2026-11-11:
             * without it the layer went "waiting: a stock pop-up shows in its place") */
            menuLayer = cr.image({ target: 'hud', klass: 'alert', z: 9, yield: 0, x: MENU.x, y: MENU.y, w: MENU.w, h: MENU.h, iw: MENU.w, ih: MENU.h, fps: 4, sampling: 'bilinear' });
            if (!menuLayer) { log.warn('menu layer refused'); return; }
            menuKey = '';
        }
        if (!force && key === menuKey) return;
        menuKey = key;
        const cv = new Canvas(MENU.w, MENU.h);
        menu.draw(cv, list, st.at, say, idle);
        cr.pixels(menuLayer, null, Buffer.from(cv.d.buffer || cv.d));
    }
    function closeMenu() { st.menuOpen = false; st.pending = null; if (menuLayer && cr) { cr.drop(menuLayer); menuLayer = 0; } }
    const say = (text) => { st.say = String(text); st.sayUntil = Date.now() + 3500; };

    /**
     * Ask Dashcam to mark the clip it is storing now (its contract: touch dashcam.highlight.json; it answers in
     * dashcam.highlighted.json { count, at } within about half a second). No answer in 2 s: it is not running.
     */
    function highlight() {
        const before = shared.read('dashcam.highlighted.json');
        const was = before && before.at;
        if (!shared.write('dashcam.highlight.json', { from: 'hud' })) { say('Highlight: could not be sent'); return; }
        say('Highlight: asking Dashcam');
        let done = false;
        const check = (last) => () => {
            try {
                if (done) return;
                const now = shared.read('dashcam.highlighted.json');
                if (now && now.at && now.at !== was) { done = true; say('Highlight marked' + (typeof now.count === 'number' ? ' (' + now.count + ' this drive)' : '')); log.info('menu: highlight marked'); }
                else if (last) { done = true; say('Dashcam is not running'); log.info('menu: highlight not answered'); }
                else return;
                if (st.menuOpen) showMenu(true);
            } catch (e) { log.warn('highlight: ' + e); }
        };
        [700, 1300].forEach((ms) => setTimeout(check(false), ms));
        setTimeout(check(true), 2000);
    }

    function pick(key) {
        st.lastPick = key;
        log.info('menu: ' + key);
        if (key === 'highlight') { highlight(); return; }
        if (key === 'warmup') { st.warmup = st.warmup === 'hide' ? 'show' : 'hide'; shared.write('hud.json', { warmup: st.warmup }); say('Warm-Up: ' + (st.warmup === 'hide' ? 'hidden for this drive' : 'shown')); }
        else if (key === 'shift') { st.shiftOn = !st.shiftOn; settings.set('shift', st.shiftOn); }
        else if (key === 'waze') { sizeIx = (sizeIx + 1) % SIZES.length; waze.setSize(SIZES[sizeIx][1]).catch(() => {}); say('Waze map: ' + SIZES[sizeIx][0]); }
        else if (key === 'test') { st.testUntil = Date.now() + 6500; say('Rev bar test running'); }
        else if (key === 'ambient') { const a = shared.read('ambient.json') || {}; shared.write('ambient.json', { cmd: 'next', n: (a.n || 0) + 1 }); say('Ambient: next colour'); }
    }

    /** One press on a row. The menu stays open (only Close closes it). */
    function act(it) {
        if (!it) return;
        if (it.kind === 'close') { closeMenu(); log.info('menu: closed (Close)'); return; }
        if (it.kind === 'action') { pick(it.key); return; }
        const to = hudlink.next(it);
        st.lastPick = (it.app ? it.app + ' ' : '') + it.key;
        log.info('menu: ' + st.lastPick + ' -> ' + to);
        if (it.app) {
            /* another app's setting: asked for, and that app applies it; shown at once, then as the app reports it */
            if (!hudlink.request(it.app, it.key, to)) { say(it.label + ': could not be sent'); return; }
            st.pending = { id: idOf(it), value: to, until: Date.now() + 1500 };
        } else {
            settings.set(it.key, to);
            st.shiftOn = settings.get('shift') !== false;
        }
        say(it.label + ': ' + menu.valueText(it, to));
    }

    /* the wheel: the menu button opens the menu and then acts on the chosen row; the right roller moves through it.
     * The roller's press is not used: the car's own list is open under ours and that press would pick in it. */
    const wheel = new Wheel(bg, {
        onMenu: () => {
            if (settings.get('menu') === false) return;
            st.touched = Date.now();
            if (!st.menuOpen) { st.menuOpen = true; st.say = ''; showMenu(true); log.info('menu: open'); return; }
            act(items()[st.at]);
            if (st.menuOpen) showMenu(true);
        },
        onRoll: (d) => {
            if (!st.menuOpen) return;
            const list = items(), n = list.length;
            /* on the car rolling the roller DOWN reports 127 - n (d < 0), and down must go to the next item */
            st.at = ((st.at + (d < 0 ? 1 : -1)) % n + n) % n;
            st.sel = idOf(list[st.at]);
            st.touched = Date.now();
            showMenu(true);
        },
    });
    await wheel.start();
    const menuTimer = setInterval(() => {
        try {
            if (!st.menuOpen) return;
            if (Date.now() - (st.touched || 0) > IDLE_MS) { closeMenu(); log.info('menu: closed (idle)'); return; }
            showMenu(false);      /* the idle bar, the say line running out, another app's new value */
        } catch (e) { log.warn('menu: ' + e); }
    }, 400);

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

    /* ---------- rev bar and song line ---------- */
    const place = () => PLACES[settings.get('place') === 'slot' ? 'slot' : 'top'];
    function colourAt(rpm) {
        const y = Number(settings.get('yellowRpm')) || 5500, r = Number(settings.get('redRpm')) || 6300;
        return rpm >= r ? ACCENT : rpm >= y ? COLOURS.yellow : WHITE;
    }
    function hideBar() { if (barLayer && cr) { cr.drop(barLayer); } barLayer = 0; barKey = ''; barGeom = ''; barVisible = false; }
    function showBar(rpm, blink) {
        const g = place().bar, geom = JSON.stringify(g);
        if (geom !== barGeom) { hideBar(); barGeom = geom; }
        if (!barLayer) {
            barLayer = cr.image({ target: 'hud', klass: 'overlay', z: 7, x: g.x, y: g.y, w: g.w, h: g.h, iw: g.w, ih: g.h, fps: 8, sampling: 'nearest' });
            if (!barLayer) { log.warn('rev bar layer refused'); barGeom = ''; return; }
            barVisible = true;
        }
        const filled = Math.max(0, Math.min(SEGS, Math.round(rpm / RPM_FULL * SEGS)));
        const key = filled + '|' + (settings.get('yellowRpm') || '') + '|' + (settings.get('redRpm') || '');
        if (key !== barKey) {
            const cv = new Canvas(g.w, g.h);
            drawBar(cv, g.w, g.h, filled, colourAt);
            cr.pixels(barLayer, null, Buffer.from(cv.d.buffer || cv.d));
            barKey = key;
        }
        const want = blink ? !barVisible : true;
        if (want !== barVisible) { cr.set(barLayer, { visible: want }); barVisible = want; }
    }
    function hideSong() { if (songLayer && cr) { cr.drop(songLayer); } songLayer = 0; songKey = ''; }
    function showSong() {
        const now = settings.get('song') !== false ? song.now : null;
        if (!now) { hideSong(); return; }
        const p = song.progress();
        const g = place().song, key = JSON.stringify(g) + now.title + '|' + now.artist + '|' + (p ? Math.ceil(p.left) : '');
        if (key === songKey && songLayer) return;
        const geom = JSON.stringify(g);
        if (songLayer && geom !== songGeom) hideSong();      /* moved: a new layer; otherwise the same one is drawn on again */
        if (!songLayer) {
            songLayer = cr.image({ target: 'hud', klass: 'overlay', z: 6, x: g.x, y: g.y, w: g.w, h: g.h, iw: g.w, ih: g.h, fps: 2, sampling: 'nearest' });
            if (!songLayer) { log.warn('song layer refused'); return; }
            songGeom = geom;
        }
        const cv = new Canvas(g.w, g.h);
        drawSong(cv, g.w, g.h, { title: now.title, artist: now.artist, left: p ? p.left : null, frac: p ? p.frac : null });
        cr.pixels(songLayer, null, Buffer.from(cv.d.buffer || cv.d));
        songKey = key;
    }

    let flashOn = false;
    const shiftTimer = setInterval(() => {
        try {
            if (!cr) return;
            const d = car.data ? car.data() : car.live;
            st.shiftOn = settings.get('shift') !== false;      /* also when another screen or the menu changed it */
            const rpm = d && typeof d.rpm === 'number' ? d.rpm : null;
            /* the test: green, yellow, red, flash, 1.5 s each, engine or not */
            const testLeft = (st.testUntil || 0) - Date.now();
            const stage = testLeft > 0 ? ['flash', 'red', 'yellow', 'green', 'green'][Math.floor(testLeft / 1500)] || 'green'
                : st.shiftOn && rpm !== null && rpm > 400 ? stageOf(rpm) : '';
            if (stage !== st.stage) log.info('shift: ' + (stage || 'off') + (rpm !== null ? ' at ' + Math.round(rpm) + ' rpm' : '') + (testLeft > 0 ? ' (test)' : ''));
            st.stage = stage;
            const running = testLeft > 0 || (rpm !== null && rpm > 400);
            showSong();              /* the song line is up whenever CarPlay names a track, engine or not (its switch is in the settings) */
            if (settings.get('style') !== 'frame') {
                /* the rev bar: shown whenever the engine runs, whatever the stage; the old frame stays away */
                hideFrame();
                if (!running || (!st.shiftOn && testLeft <= 0)) { hideBar(); return; }
                const shown = testLeft > 0 ? [7000, 6500, 5800, 4500, 3000][Math.floor(testLeft / 1500)] || 3000 : rpm;
                showBar(shown, stage === 'flash');
                return;
            }
            hideBar();
            if (!stage) { hideFrame(); return; }
            placeFrame(st.box, COLOURS[stage === 'flash' ? 'red' : stage]);
            if (stage === 'flash') { flashOn = !flashOn; cr.set(frameLayer, { visible: flashOn }); frameVisible = flashOn; }
            else if (!frameVisible) { cr.set(frameLayer, { visible: true }); frameVisible = true; }
        } catch (e) { log.warn('shift: ' + e); }
    }, 120);

    const wazeTimer = setInterval(() => { waze.poll().then(() => { st.box = waze.hudBox(); syncSize(); }).catch(() => {}); }, 15000);
    waze.poll().then(() => { st.box = waze.hudBox(); }).catch(() => {});

    process.on('exit', () => { [menuTimer, shiftTimer, wazeTimer].forEach(clearInterval); closeMenu(); hideFrame(); hideBar(); hideSong(); if (cr) { try { cr.close(); } catch (e) { /* going */ } } });
    return { st: st, items: items, waze: waze, pick: pick, act: act, song: song };
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
            ['Press the menu button on the wheel (three lines, right side) to open the menu.',
                'Roll the right roller to move. Press the menu button again to change the chosen row:',
                'the menu stays open. Pick Close, or wait 10 s, to leave.', '', 'The first rows (tap one to change it here):']
                .forEach((l, i) => cv.text(l, 48, 112 + i * 32, 20, i < 3 ? t.text : t.dim));
            bgm.items().slice(0, 5).forEach((it, i) => {
                const y = 300 + i * 40;
                cv.roundRect(48, y - 28, 700, 34, 8, withAlpha(t.text, 0.08));
                cv.text(it.g + ': ' + it.label, 64, y - 4, 20, t.text);
                cv.text(menu.valueText(it), 732, y - 4, 20, t.dim, { align: 'right' });
                if (cv.own) cv.target(48, y - 28, 700, 34, () => { bgm.act(it); return render(); }, 'i' + i, 8);
            });
            G.panel(cv, t, 804, 44, 772, 468, 'Revs and song');
            const box = bgm.waze.hudBox();
            const line = (k, v, y, c) => { cv.text(k, 828, y, 20, t.dim); cv.text(v, 1552, y, 20, c || t.text, { align: 'right' }); };
            line('Revs on the display', bgm.st.shiftOn ? 'on' : 'off', 112, bgm.st.shiftOn ? '#2fd27a' : t.dim);
            line('Shown as', settings.get('style') === 'frame' ? (box ? 'frame round the Waze map' : 'slim bar (Waze map not on the HUD)') : 'rev bar, ' + (settings.get('place') === 'slot' ? 'in the clear slot' : 'top of the display'), 146);
            line('Green / yellow / red', (settings.get('greenRpm') || 4000) + ' / ' + (settings.get('yellowRpm') || 5500) + ' / ' + (settings.get('redRpm') || 6300) + ' rpm', 180);
            line('Flash from', (settings.get('shiftRpm') || 6800) + ' rpm', 214);
            line('Now', bgm.st.stage || 'idle', 248, bgm.st.stage ? COLOURS[bgm.st.stage === 'flash' ? 'red' : bgm.st.stage] : t.dim);
            line('Warm-Up HUD', bgm.st.warmup, 282);
            line('Last pick', bgm.st.lastPick || '-', 316);
            const sn = bgm.song.now;
            line('Song', settings.get('song') === false ? 'off' : sn ? (sn.title + (sn.artist ? ', ' + sn.artist : '')).slice(0, 44) : bgm.song.error ? 'not available' : 'nothing playing', 350);
            G.frame(cv, t, ['HUD'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }
        ui.onClick('BTN_ACTION', () => { bgm.pick('shift'); return render(); });
        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 2, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
