'use strict';
/**
 * Ambient Lab - run one ambient-light test at a time and see what the car does.
 *
 * Left: the car's own report of the ambient light, every field, live (read-only).
 * Right: the selected test, whether writes are allowed, and what happened last time.
 *
 * Safety: nothing is written unless "Allow test writes" is on. Writes are paced 1.5 s apart.
 * Every test (except "Restore") puts back the state captured just before it, after the
 * restore delay, and again when the app closes.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Lab = require('./lab');
const fs = require('fs');
const path = require('path');

/* what you saw, one tap: general tests, and colours for the preset tour */
const SAW = [['changed', 'Changed colour'], ['brighter', 'Brighter'], ['dimmer', 'Dimmer'], ['part', 'Part of cabin'], ['off', 'Went off'], ['nothing', 'Nothing']];
const COLOURS = [['red', 'Red', '#e1001a'], ['orange', 'Orange', '#ff7a1a'], ['yellow', 'Yellow', '#ffd21a'], ['green', 'Green', '#2fd27a'],
    ['teal', 'Teal', '#1ad2c8'], ['blue', 'Blue', '#2a6cff'], ['purple', 'Purple', '#9a4dff'], ['pink', 'Pink', '#ff4dc4'],
    ['white', 'White', '#f0f0f0'], ['other', 'Other', '#777777']];
const isPreset = (t) => /^Preset \d+$/.test(t.name);

const W = 1600, H = 520;
const LIGHT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let proxy = null, linkError = null;
        const st = { slot: null, own: null, raw: {}, seen: 0, changedAt: 0 };
        /* your answers, kept across restarts: test name -> answer */
        const resultsFile = path.join(ctx.dataDir, 'results.json');
        let answers = {};
        try { answers = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) || {}; } catch (e) { answers = {}; }
        function answer(t, key) {
            answers[t.name] = key;
            try { fs.writeFileSync(resultsFile, JSON.stringify(answers, null, 1)); } catch (e) { log.warn('results: ' + e); }
            log.info('result ' + t.name + ' = ' + key);
            last = null;
            idx = Math.min(Lab.TESTS.length - 1, idx + 1);          /* on to the next test */
            return render();
        }
        let idx = 1, last = null, before = null, restoreTimer = null, restoreAt = 0, lastWrite = 0, busy = false;

        const sub = await ctx.signals.watch(LIGHT, '1', {
            statusAmbientLightInteriorColour: (v) => {
                st.raw = v || {}; st.seen++; st.changedAt = Date.now();
                const n = Lab.slotOf(v && v.statusMenuAmbientePanoramicRoofInteriorLighting);
                if (n !== null) { st.slot = n; if (!before) st.own = n; }   /* own = what you chose, not what a test set */
                render().catch(() => {});
            },
        }, log);
        proxy = sub && sub.proxy;
        if (sub && sub.error) { linkError = sub.error; log.warn('ambient light: ' + sub.error); }

        const allowed = () => settings.get('allowWrites') === true;

        function send(req, why) {
            if (!proxy) return Promise.reject(new Error('the ambient light does not answer'));
            const wait = lastWrite + Lab.MIN_GAP_MS - Date.now();
            const go = () => { lastWrite = Date.now(); log.info('ambient lab: ' + why + ' -> ' + JSON.stringify(req)); return ctx.signals.set(proxy, 'ambientLightInteriorColour', req); };
            return wait > 0 ? new Promise((res) => setTimeout(res, wait)).then(go) : Promise.resolve().then(go);
        }

        function restoreNow(reason) {
            clearTimeout(restoreTimer); restoreTimer = null; restoreAt = 0;
            if (!before) return Promise.resolve();
            const req = Lab.restoreFrom(before); before = null;
            return send(req, 'restore (' + reason + ')').catch((e) => log.warn('restore failed: ' + e));
        }

        async function run() {
            const t = Lab.TESTS[idx];
            if (!allowed()) { last = { name: t.name, ok: false, text: 'Writes are off. Turn on "Allow test writes" in Settings.' }; return render(); }
            if (busy) return;
            busy = true;
            try {
                if (t.restore) { await restoreNow('by hand'); if (!before) await send(t.req(st), t.name); }
                else {
                    if (!before) before = { slot: st.own || st.slot, raw: Object.assign({}, st.raw) };
                    const seenBefore = st.seen, rawBefore = JSON.stringify(st.raw);
                    await send(t.req(st), t.name);
                    last = { name: t.name, ok: true, text: 'Sent. Watching the car\'s report...', at: Date.now(), seenBefore: seenBefore, rawBefore: rawBefore };
                    const secs = Number(settings.get('restoreAfter')) || 10;
                    clearTimeout(restoreTimer);
                    restoreAt = Date.now() + secs * 1000;
                    restoreTimer = setTimeout(() => restoreNow('timer').then(() => render().catch(() => {})), secs * 1000);
                }
            } catch (e) {
                last = { name: t.name, ok: false, text: 'Refused: ' + (e && e.message || e) };
            } finally { busy = false; }
            return render();
        }

        /* did the car's report change after the last send? */
        function verdict() {
            if (!last || !last.at) return null;
            if (Date.now() - last.at < 1500) return 'waiting for the car...';
            return JSON.stringify(st.raw) !== last.rawBefore ? 'the car\'s report CHANGED - look at the cabin' : 'the car\'s report did not change';
        }

        function drawStatus(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'What the car reports');
            if (!proxy) { cv.text(linkError ? 'No link: ' + linkError : 'Waiting for the ambient light...', 48, 130, 24, t.warn); return; }
            const keys = Object.keys(st.raw);
            if (!keys.length) { cv.text('No report yet', 48, 130, 24, t.dim); return; }
            let y = 112;
            keys.slice(0, 11).forEach((k) => {
                const short = k.replace(/^status/, '').replace(/AmbientePanoramicRoofInteriorLighting/, '…').replace(/InteriorLighting/, '…');
                cv.text(short, 48, y, 18, t.dim);
                cv.text(String(st.raw[k]), 470, y, 20, t.text, { font: 'bold' });
                y += 34;
            });
            cv.text('Your colour: ' + (st.own || '?') + '   now: ' + (st.slot || '?') + '   reports: ' + st.seen, 48, 480, 18, t.dim);
        }

        function drawTest(cv, t) {
            G.panel(cv, t, 804, 44, 772, 468, 'Test ' + (idx + 1) + ' of ' + Lab.TESTS.length);
            const test = Lab.TESTS[idx];
            cv.text(test.name, 828, 130, 34, t.text, { font: 'bold' });
            cv.text(test.note, 828, 172, 20, t.dim);
            cv.text(allowed() ? 'Writes ALLOWED' : 'Writes off (Settings)', 828, 236, 26, allowed() ? '#ffd34d' : t.dim, { font: 'bold' });
            const given = answers[test.name];
            if (given) cv.text('Your answer: ' + given, 1552, 236, 22, '#2fd27a', { font: 'bold', align: 'right' });
            if (last && last.ok && last.name === test.name && last.at) {
                /* what did you see? one tap records it and moves on */
                const opts = isPreset(test) ? COLOURS : SAW;
                const per = isPreset(test) ? 5 : 3, bw = isPreset(test) ? 136 : 236, bh = 52, gap = 10;
                cv.text('What did you see?', 1552, 290, 22, t.text, { font: 'bold', align: 'right' });
                opts.forEach((o, k) => {
                    const x = 828 + (k % per) * (bw + gap), y = 306 + Math.floor(k / per) * (bh + gap);
                    cv.roundRect(x, y, bw, bh, 10, o[2] ? withAlpha(o[2], 0.55) : withAlpha(t.text, 0.14));
                    cv.text(o[1], x + bw / 2, y + 34, 21, t.text, { font: 'bold', align: 'center' });
                    if (cv.own) cv.target(x, y, bw, bh, () => answer(test, o[0]), 'ans' + k, 10);
                });
            } else if (last) {
                cv.text('Last: ' + last.name, 828, 296, 22, t.text);
                cv.text(last.text, 828, 330, 20, last.ok ? t.dim : t.warn);
                const v = verdict(); if (v) cv.text(v, 828, 364, 22, /CHANGED/.test(v) ? '#2fd27a' : t.dim, { font: 'bold' });
            }
            if (restoreAt) cv.text('Restoring your colour in ' + Math.max(0, Math.ceil((restoreAt - Date.now()) / 1000)) + ' s', 828, 268, 20, '#ffd34d');
            /* on-screen controls: some HMI layouts show no page buttons. Touch these, or turn the controller. */
            const btn = (x, w, label, col, key, fn) => {
                cv.roundRect(x, 450, w, 52, 12, col);
                cv.text(label, x + w / 2, 484, 24, t.text, { font: 'bold', align: 'center' });
                if (cv.own) cv.target(x, 450, w, 52, fn, key, 12);
            };
            btn(828, 130, '<  Prev', withAlpha(t.text, 0.12), 'prev', () => { step(-1); return render(); });
            btn(970, 300, 'RUN TEST', withAlpha('#2fd27a', allowed() ? 0.35 : 0.12), 'run', () => run());
            btn(1282, 130, 'Next  >', withAlpha(t.text, 0.12), 'next', () => { step(1); return render(); });
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawStatus(cv, t);
            drawTest(cv, t);
            G.frame(cv, t, ['Ambient Lab'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => run());
        function step(d) { idx = (idx + d + Lab.TESTS.length) % Lab.TESTS.length; }
        ui.onClick('BTN_PAGE', () => { step(1); return render(); });
        ui.onClick('BTN_PREV', () => { step(-1); return render(); });
        ctx.onScroll((dy) => { step(dy > 0 ? 1 : -1); render().catch(() => {}); return true; });
        settings.onChange(() => render().catch(() => {}));
        process.on('exit', () => { if (before && proxy) { try { ctx.signals.set(proxy, 'ambientLightInteriorColour', Lab.restoreFrom(before)); } catch (e) { /* leaving */ } } });

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
