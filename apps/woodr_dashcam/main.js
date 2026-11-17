'use strict';
/**
 * Dashcam - BMW's drive recorder as a loop dash cam, and a lab to tune it.
 *
 * LAB   The video buffer's state live, every state change timed (how long a store takes, how long the buffer is
 *       not recording afterwards), the clips on the car, and test saves: 10+10 s with the cameras switched to
 *       DR_ACTIVE first (as BMW's app does) or the buffer alone.
 * LOOP  While the buffer records (driving, BMW's Drive Recorder on), save past+future seconds every past+future
 *       seconds, named like BMW's own event clips, so BMW's app lists them, exports them to USB and keeps its newest N.
 *
 * KEEP  The stock app keeps only its newest 10 clips. The clip keeper (a small root service, components/
 *       woodr-dashkeep) keeps every finished clip on the car up to a size cap (about 8 GB an hour), without
 *       copying. This app tells it the cap, shows what it holds, moves the kept clips to a USB stick when one is
 *       in, and can clear them. Without the keeper installed nothing is kept beyond the stock app's 10.
 *
 * HIGHLIGHT  "Highlight this clip" (the button here, the HUD menu through /dev/shm/woody/dashcam.highlight.json, or
 *       Launch at every real launch through dashcam.highlight.launch.json)
 *       marks the clip that holds this moment and the one after it. A highlight is never removed to make room,
 *       on the car or on the stick; it goes from the car once it is on a stick (listed there in highlights.jsonl).
 *
 * Every command goes to BMW's camera / video services (the same calls BMW's Drive Recorder makes); none to a
 * control unit. Off until "Allow camera commands" is on in the settings.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Recorder } = require('./recorder');
const shared = require('./shared');
const { Usb } = require('./usb');
const runlogs = require('./runlogs');

const W = 1600, H = 520;
const CLIPS = '/var/opt/hdshare/ent/driverecorder';      /* the same folder, as this unit mounts it */
const KEPT = '/var/opt/hdshare/ent/woody-dashcam';                   /* the clip keeper's folder: the same clips, kept longer */
const CLIP_BYTES_PER_MIN = 136 * 1048576;                /* measured: 91 MB for a 40 s clip */

function clips(dir) {
    dir = dir || CLIPS;
    try {
        return fs.readdirSync(dir).filter((d) => /_(Event|Crash)$/.test(d)).map((d) => {
            let bytes = 0, n = 0;
            try { fs.readdirSync(path.join(dir, d)).forEach((f) => { n++; try { bytes += fs.statSync(path.join(dir, d, f)).size; } catch (e) { /* gone */ } }); } catch (e) { /* unreadable */ }
            return { name: d, bytes: bytes, files: n, dir: path.join(dir, d) };
        }).sort((a, b) => (a.name < b.name ? 1 : -1));
    } catch (e) { return []; }
}

async function background(bg) {
    const { log, settings } = bg;
    const rec = new Recorder(bg);
    await rec.start();
    /* the loop switch is read from the settings every time: one source, whoever changed it (button or settings page) */
    const st = { get loop() { return settings.get('loop') === true; }, lastError: '', next: 0 };

    const allowed = () => settings.get('allow') === true;
    async function save(past, future, active) {
        if (!allowed()) { st.lastError = 'Camera commands are off (Settings)'; return; }
        /* one save at a time, and none right after another (the status takes a moment to say STORING) */
        if (st.saving || Date.now() - rec.lastSaveAt < 3000) return;
        st.saving = true;
        /* tell BMW's Drive Recorder (patched, when it is) that this save is ours: no "recording" pop-up for it.
         * The file's age is what counts (under 90 s), so a stopped app never keeps the pop-up away. */
        if (settings.get('quiet') !== false) shared.write('dashcam.quiet', { past: past, future: future });
        try { await rec.save(past, future, { active: active }); st.lastError = ''; }
        catch (e) { st.lastError = String(e && e.message || e); log.warn('save: ' + st.lastError); }
        finally { st.saving = false; }
    }

    /* the loop: one clip of (past + future) s every (past + future) s while the buffer records */
    const loopTimer = setInterval(() => {
        if (!st.loop || !allowed() || rec.status !== 'RECORDING') return;
        const past = Number(settings.get('past')) || 20, future = Number(settings.get('future')) || 20;
        /* Save as soon as the buffer holds `past` seconds since it last (re)started: the clip then begins where
         * the previous one ended, and the only time lost is the buffer's own restart (0.2-0.4 s measured). */
        if (Date.now() - rec.since >= past * 1000 - (Number(settings.get('overlap')) || 0) * 1000) save(past, future, settings.get('active') !== false);
    }, 200);
    if (loopTimer.unref) loopTimer.unref();

    /* after a head-unit start BMW's recorder app is not running and the buffer stays IDLE: wake it ourselves, only
     * with the loop on, camera commands allowed and the engine running, after 20 s of IDLE (BMW's app needs about 1 s) */
    const wakeTimer = setInterval(() => {
        if (!st.loop || !allowed() || settings.get('wake') === false) return;
        /* once this app has woken it, BMW's app is not there to do it after each store: do not wait 20 s every time */
        if (rec.canWake(rec.selfWoke ? 2500 : 20000)) rec.wake().catch(() => {});
    }, 500);
    if (wakeTimer.unref) wakeTimer.unref();

    /* ---- clips kept on the car: what the keeper is asked for, and what it reports ---- */
    /* ---- highlights: clip names kept in this app's data folder (small), pinned at the keeper ---- */
    const HL_FILE = path.join(bg.dataDir, 'highlights.json');
    const hl = { list: [], next: 0, lastAt: 0, seenReq: 0 };
    try { const j = JSON.parse(fs.readFileSync(HL_FILE, 'utf8')); if (Array.isArray(j)) hl.list = j.filter((x) => x && typeof x.name === 'string').slice(-40); } catch (e) { /* none yet */ }
    const hlSave = () => { try { fs.writeFileSync(HL_FILE, JSON.stringify(hl.list)); } catch (e) { log.warn('highlights: ' + e.message); } };
    const hlHas = (name) => hl.list.some((x) => x.name === name);
    function hlAdd(name, at) { if (!name || hlHas(name)) return; hl.list.push({ name: name, at: at }); hl.list = hl.list.slice(-40); hlSave(); keep.send(); log.info('highlight: ' + name); }
    /** mark this moment: the clip that holds it (the one being stored, or stored in the last seconds) and the next one */
    function highlight(from) {
        const now = Date.now();
        if (now - hl.lastAt < 3000) return 'Already marked';
        hl.lastAt = now;
        /* the clip being stored now holds this moment; so does one that finished in the last few seconds */
        const last = rec.lastBase ? path.basename(rec.lastBase) : (hl.prev && now - hl.prevAt < 6000 ? hl.prev : '');
        if (last) hlAdd(last, now);
        hl.next = now;                                    /* the next clip stored is marked too */
        if (!st.loop || rec.status === 'IDLE' || rec.status === 'ERROR') {
            /* no loop running: save one clip now if the buffer records, else say why nothing new will come */
            if (rec.status === 'RECORDING' && allowed()) save(Number(settings.get('past')) || 20, Number(settings.get('future')) || 20, settings.get('active') !== false);
            else if (!last) { hl.next = 0; st.hlNote = 'Nothing to highlight: the recorder is not running'; st.hlNoteAt = now; shared.write('dashcam.highlighted.json', { from: from || 'app', count: hl.list.length, ok: false, note: 'the recorder is not running' }); return st.hlNote; }
        }
        st.hlNote = 'Highlight marked'; st.hlNoteAt = now;
        shared.write('dashcam.highlighted.json', { from: from || 'app', count: hl.list.length, ok: true });
        log.info('highlight asked (' + (from || 'app') + ')');
        return st.hlNote;
    }
    rec.on('stored', (base) => { hl.prev = path.basename(base); hl.prevAt = Date.now(); if (hl.next && Date.now() - hl.next < 180000 && !hlHas(hl.prev)) { hlAdd(hl.prev, hl.next); hl.next = 0; } else if (hl.next && hlHas(hl.prev)) { /* the clip that was being stored when it was asked: the next one is still to come */ } else hl.next = 0; });
    /* the HUD menu's request: a small file any app may write; it only ever marks a clip, at most one every 3 s */
    const hlTimer = setInterval(() => {
        try {
            const st2 = fs.statSync(path.join(shared.DIR, 'dashcam.highlight.json')), at = st2.mtime.getTime();
            if (at > hl.seenReq) { const first = hl.seenReq === 0; hl.seenReq = at; if (!first && Date.now() - at < 10000) highlight('hud'); else if (first && Date.now() - at < 3000) highlight('hud'); }
        } catch (e) { if (!hl.seenReq) hl.seenReq = 1; }
        /* Launch's request, in a file of its own: each app runs as its own user and cannot replace another's file */
        try {
            const at = fs.statSync(path.join(shared.DIR, 'dashcam.highlight.launch.json')).mtime.getTime();
            if (at > (hl.seenLaunch || 0)) { const first = !hl.seenLaunch; hl.seenLaunch = at; if (Date.now() - at < (first ? 3000 : 10000)) highlight('launch'); }
        } catch (e) { if (!hl.seenLaunch) hl.seenLaunch = 1; }
    }, 500);
    if (hlTimer.unref) hlTimer.unref();

    const keep = {
        drops: [], clear: 0, armedAt: 0, note: '',
        drop(name) { if (this.drops.indexOf(name) < 0) { this.drops.push(name); this.send(); } },
        report() { return shared.read('dashcam.kept.json', 60000); },
        send() {
            /* a dropped name is asked for until the keeper has let go of it */
            this.drops = this.drops.filter((n) => fs.existsSync(path.join(KEPT, n))).slice(-300);
            shared.write('dashcam.keep.json', { on: settings.get('keep') !== false, capGb: Number(settings.get('keepGb')) || 10, clear: this.clear, drop: this.drops, pin: hl.list.map((x) => x.name) });
        },
        /* clearing takes two presses within 15 s */
        pressClear() {
            if (Date.now() - this.armedAt > 15000) { this.armedAt = Date.now(); this.note = 'Press again to delete the clips kept on the car'; this.noteAt = Date.now(); return false; }
            this.armedAt = 0; this.clear = Date.now(); this.note = 'Clearing the clips kept on the car'; this.noteAt = Date.now(); log.info('keep: clear asked'); this.send(); return true;
        },
    };
    const moveOn = () => settings.get('usbMove') !== false;
    /* a highlight that reached the stick: noted there (while the session is held), and off this app's list once the car's copy goes */
    function onStick(name) { const h = hl.list.filter((x) => x.name === name)[0]; if (!h) return; if (usb.held) usb.markHighlight(name, h.at); if (moveOn() && usb.highlights()[name]) { hl.list = hl.list.filter((x) => x.name !== name); hlSave(); } }
    const keepTimer = setInterval(() => {
        try {
            if (settings.get('clearKept') === true) { settings.set('clearKept', false); keep.pressClear(); }
            if (keep.armedAt && Date.now() - keep.armedAt > 15000) keep.armedAt = 0;
            keep.send();
        } catch (e) { log.warn('keep: ' + e); }
    }, 5000);
    if (keepTimer.unref) keepTimer.unref();
    keep.send();

    /* ---- the USB stick: every finished clip is copied to it, the oldest make room ---- */
    const usb = new Usb(bg);
    let usbStarted = false;
    const usbOn = () => allowed() && settings.get('usb') === true;
    const ensureUsb = () => { if (!usbStarted) { usbStarted = true; usb.start().catch((e) => log.warn('usb start: ' + e)); } };
    rec.on('stored', (base) => {
        if (!usbOn() || !usb.device) return;
        const name = path.basename(base);
        usb.copyClip(path.join(CLIPS, name), name, (ok) => { if (ok) onStick(name); });
    });
    /* catch up: clips still on the car that the stick does not have (saved while the stick was not ready, or
     * before the copying was switched on). Never the clip being written now. */
    let caughtUpAt = 0;
    function catchUp() {
        if (!usb.device || usb.copying || usb.queue.length || Date.now() - caughtUpAt < 30000) return;
        caughtUpAt = Date.now();
        const have = {};
        usb.clips().forEach((c) => { have[c.name] = true; });
        const busy = rec.lastBase ? path.basename(rec.lastBase) : '';
        /* the keeper's copy of a clip first (it stays when the stock app drops its own), then the stock folder's */
        const seen = {}, todo = [];
        clips(KEPT).concat(clips()).forEach((c) => { if (!seen[c.name]) { seen[c.name] = true; todo.push(c); } });
        todo.filter((c) => c.name !== busy && c.files >= 3).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((c) => {
            const kept = c.dir.indexOf(KEPT) === 0;
            if (have[c.name]) { onStick(c.name); if (kept && moveOn()) keep.drop(c.name); return; }       /* on the stick already */
            if (usb.queue.length >= 12) return;                                          /* the rest at the next pass */
            usb.copyClip(c.dir, c.name, (ok) => { if (ok) onStick(c.name); if (ok && kept && moveOn()) keep.drop(c.name); });
        });
        /* Launch's run logs, beside the clips: small, so they go at once, under the same write session */
        try {
            const dest = path.join(usb.device.mount, runlogs.FOLDER);
            let there = [];
            try { there = fs.readdirSync(dest); } catch (e) { /* no folder yet */ }
            const src = path.join(shared.DIR, 'launch.runs'), names = runlogs.pending(src, there);
            if (names.length) {
                usb.hold().then(() => {
                    const r = runlogs.copyTo(src, dest, names);
                    log.info('usb: ' + r.copied + ' run log' + (r.copied === 1 ? '' : 's') + ' from Launch copied' + (r.failed ? ', ' + r.failed + ' failed: ' + r.why : ''));
                }).catch((e) => log.warn('usb: run logs: ' + (e && e.message || e)));
            }
        } catch (e) { log.warn('usb: run logs: ' + e); }
    }
    let idleSince = 0;
    const usbTimer = setInterval(() => {
        if (usbOn()) { ensureUsb(); try { catchUp(); } catch (e) { log.warn('catch up: ' + e); } }
        if (!usb.held || usb.copying || usb.queue.length) { idleSince = 0; return; }
        /* make room, then give the session back once nothing has been written for a while (the stick is then
         * read-only and safe to pull): at once when the copying is switched off, after 60 s when the buffer rests */
        try { usb.prune((Number(settings.get('usbKeepGb')) || 50) * 1073741824); } catch (e) { log.warn('prune: ' + e); }
        const resting = rec.status !== 'RECORDING' && rec.status !== 'STORING';
        if (!usbOn()) { usb.drop(); return; }
        if (resting || !st.loop) { if (!idleSince) idleSince = Date.now(); if (Date.now() - idleSince > 60000) { idleSince = 0; usb.drop(); } } else idleSince = 0;
    }, 5000);
    if (usbTimer.unref) usbTimer.unref();
    async function usbTest() {
        if (!allowed()) { st.lastError = 'Camera commands are off (Settings)'; return; }
        ensureUsb();
        /* the first press also starts the search for the stick: give it a moment to be found */
        for (let i = 0; i < 20 && !usb.device; i++) await new Promise((res) => setTimeout(res, 250));
        try { const f = await usb.test(); st.lastError = ''; st.usbNote = 'wrote ' + f; log.info('usb test: wrote ' + f); }
        catch (e) { st.usbNote = 'test failed: ' + String(e && e.message || e); log.warn('usb test: ' + st.usbNote); }
    }

    process.on('exit', () => { clearInterval(loopTimer); clearInterval(usbTimer); clearInterval(keepTimer); clearInterval(hlTimer); rec.stop(); usb.stop(); });
    return { rec: rec, st: st, save: save, allowed: allowed, usb: usb, usbTest: usbTest, keep: keep, highlight: highlight, hl: hl };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgm = ctx.background || await background(ctx);
        const { rec, st, usb } = bgm;
        rec.on('change', () => render().catch(() => {}));
        usb.on('change', () => render().catch(() => {}));

        function button(cv, t, x, y, w, label, on, key, fn) {
            cv.roundRect(x, y, w, 52, 12, on ? withAlpha('#e1001a', 0.6) : withAlpha(t.text, 0.12));
            cv.text(label, x + w / 2, y + 34, 20, t.text, { font: 'bold', align: 'center' });
            if (cv.own) cv.target(x, y, w, 52, fn, key, 12);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            /* left: the buffer, live */
            G.panel(cv, t, 24, 44, 760, 468, 'Video buffer');
            const col = rec.status === 'RECORDING' ? '#2fd27a' : rec.status === 'STORING' ? '#ffd34d' : rec.status === 'ERROR' ? t.warn : t.dim;
            cv.text(rec.status, 48, 132, 36, col, { font: 'bold' });
            cv.text('for ' + Math.round((Date.now() - rec.since) / 1000) + ' s', 48, 162, 20, t.dim);
            const kv = (k, v, y) => { cv.text(k, 360, y, 19, t.dim); cv.text(v, 760, y, 19, t.text, { align: 'right' }); };
            kv('Buffer', rec.config ? (rec.config.maxDuration / 1000) + ' s at ' + rec.config.maxBitrate + ' kbit/s' : '?', 100);
            kv('Cameras', rec.icamState ? rec.icamState.application + ' / persp ' + rec.icamState.perspective : '?', 128);
            kv('Last store took', rec.lastStoreMs !== null ? (rec.lastStoreMs / 1000).toFixed(1) + ' s' : '-', 156);
            kv('Not buffering after', rec.lastGapMs !== null ? (rec.lastGapMs / 1000).toFixed(1) + ' s' : '-', 184);
            if (rec.error) cv.text(rec.error.slice(0, 70), 48, 210, 18, t.warn);
            cv.text('What happened', 48, 246, 19, t.dim);
            rec.timeline.slice(-7).reverse().forEach((e, i) => {
                const d = new Date(e.at), ts = d.toTimeString().slice(0, 8);
                cv.text(ts + '  ' + e.what.slice(0, 64), 48, 276 + i * 30, 18, i === 0 ? t.text : t.dim);
            });

            /* right: actions and clips */
            G.panel(cv, t, 804, 44, 772, 468, 'Dashcam');
            const ok = bgm.allowed();
            const hlFresh = st.hlNote && Date.now() - (st.hlNoteAt || 0) < 6000;
            button(cv, t, 828, 96, 360, hlFresh ? st.hlNote.slice(0, 26) : 'Highlight this clip' + (bgm.hl.list.length ? '  (' + bgm.hl.list.length + ')' : ''), hlFresh, 'highlight', () => { bgm.highlight('app'); return render(); });
            button(cv, t, 1200, 96, 352, 'Save 10+10 s (test)', false, 'saveA', () => { bgm.save(10, 10, true); return render(); });
            button(cv, t, 828, 160, 724, 'Loop: ' + (st.loop ? 'ON  (' + ((Number(settings.get('past')) || 20) + (Number(settings.get('future')) || 20)) + ' s clips)' : 'off'), st.loop, 'loop',
                () => { const on = !st.loop; settings.set('loop', on); ctx.log.info('loop ' + (on ? 'ON' : 'off')); return render(); });
            /* the USB stick */
            const d = usb.device, usbSet = settings.get('usb') === true;
            button(cv, t, 828, 224, 360, 'Copy to USB: ' + (usbSet ? 'ON' : 'off'), usbSet, 'usb', () => { settings.set('usb', !usbSet); return render(); });
            button(cv, t, 1200, 224, 352, 'Test USB write', false, 'usbtest', () => { bgm.usbTest().then(() => render()); return render(); });
            const keepSet = settings.get('keep') !== false, kr = bgm.keep.report();
            button(cv, t, 828, 288, 360, 'Keep on the car: ' + (keepSet ? 'ON (' + (Number(settings.get('keepGb')) || 10) + ' GB)' : 'off'), keepSet, 'keep', () => { settings.set('keep', !keepSet); return render(); });
            button(cv, t, 1200, 288, 352, bgm.keep.armedAt ? 'Press again to clear' : 'Clear kept clips', !!bgm.keep.armedAt, 'clearkept', () => { bgm.keep.pressClear(); return render(); });
            const onStick = d ? usb.clips() : [];
            const stickBytes = onStick.reduce((s, c) => s + c.bytes, 0);
            const usbLine = !usbSet && !d ? 'USB: switch "Copy to USB" on to look for a stick'
                : !d ? 'USB: no stick seen' + (usb.error ? ' (' + usb.error.slice(0, 40) + ')' : ' (replug it if it is in)')
                    : 'USB "' + d.name + '": ' + onStick.length + ' clips, ' + (stickBytes / 1073741824).toFixed(1) + ' GB' + (usb.held ? '  ·  WRITING, do not pull' : '  ·  safe to pull');
            cv.text(usbLine, 828, 368, 19, d ? (usb.held ? '#ffd34d' : '#2fd27a') : t.dim, { font: 'bold' });
            const copyLine = usb.copying ? 'copying ' + usb.copying + (usb.queue.length ? '  (+' + usb.queue.length + ' waiting)' : '')
                : usb.copied ? 'copied ' + usb.copied + ' clips' + (usb.lastCopyMs ? ', last in ' + (usb.lastCopyMs / 1000).toFixed(1) + ' s' : '') + (usb.failed ? ', ' + usb.failed + ' failed' : '') : (st.usbNote || '');
            if (copyLine) cv.text(copyLine.slice(0, 74), 828, 394, 18, t.dim);
            cv.text(ok ? 'Camera commands ALLOWED' : 'Camera commands off: turn on "Allow camera commands" in Settings', 828, 420, 18, ok ? '#ffd34d' : t.dim, { font: 'bold' });
            if (st.lastError) cv.text(st.lastError.slice(0, 72), 828, 444, 18, t.warn);
            const list = clips();
            const total = list.reduce((s, c) => s + c.bytes, 0);
            cv.text('Stock recorder: ' + list.length + ' clips (' + Math.round(total / 1048576) + ' MB)   ·   saves this drive: ' + rec.saves, 828, 468, 18, t.dim);
            const keptLine = !kr ? 'Kept on the car: the clip keeper is not running (only the stock 10 clips stay)'
                : !kr.on ? 'Kept on the car: off  (' + kr.count + ' clips still held)'
                    : 'Kept on the car: ' + kr.count + ' clips' + (kr.pinned ? ' (' + kr.pinned + ' highlights)' : '') + ', ' + (kr.bytes / 1073741824).toFixed(1) + ' of ' + kr.capGb + ' GB, about ' + Math.round(kr.bytes / CLIP_BYTES_PER_MIN) + ' min' + (kr.note ? '  (' + kr.note.slice(0, 30) + ')' : '');
            const fresh = bgm.keep.note && Date.now() - (bgm.keep.noteAt || 0) < 15000;
            cv.text((fresh ? bgm.keep.note : keptLine).slice(0, 78), 828, 494, 18, fresh ? '#ffd34d' : kr && kr.on ? '#2fd27a' : t.dim, { font: 'bold' });
            G.frame(cv, t, ['Dashcam'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => { bgm.highlight('app'); return render(); });
        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 1, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
