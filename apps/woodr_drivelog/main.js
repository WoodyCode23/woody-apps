'use strict';
/**
 * Drive Log - a second-by-second record of the drive, to line up with the dash cam's clips.
 *
 * Read-only: broadcast signals in, two files out, in this app's data folder (pulled by the laptop afterwards):
 *   drive-<start>.csv   one line a second (UTC time, speed, rpm, gear, selector, vehicle condition, oil, coolant,
 *                       g long / lat, pedal %, tyre pressures bar and temperatures C, samples a second of speed and rpm)
 *   fast-<start>.csv    every speed and rpm sample with its millisecond, while the car accelerates hard
 *                       (pedal over 60 % or more than 0.25 g), for timing a pull; capped at FAST_MAX bytes
 * Old files are deleted so the folder stays under KEEP_BYTES (apps have a small disk quota).
 * No diagnostic requests: safe next to anything.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Tyres } = require('./tyres');

const W = 1600, H = 520;
const KEEP_BYTES = 9 * 1048576, FAST_MAX = 3 * 1048576;
const PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
const pad = (n) => (n < 10 ? '0' : '') + n;
const num = (v) => typeof v === 'number' && isFinite(v);
const f1 = (v, d) => (num(v) ? v.toFixed(d === undefined ? 1 : d) : '');

async function background(bg) {
    const { log, settings } = bg;
    const st = { speedN: 0, rpmN: 0, speedHz: 0, rpmHz: 0, pedal: null, lines: 0, fastBytes: 0, file: '', lastSpeedAt: 0, conditions: {} };
    const now = new Date();
    const stamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + '-' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds());
    const slow = path.join(bg.dataDir, 'drive-' + stamp + '.csv'), fast = path.join(bg.dataDir, 'fast-' + stamp + '.csv');
    st.file = path.basename(slow);

    /* make room first: oldest logs go */
    try {
        const files = fs.readdirSync(bg.dataDir).filter((f) => /^(drive|fast)-.*\.csv$/.test(f)).map((f) => ({ f: f, s: fs.statSync(path.join(bg.dataDir, f)) })).sort((a, b) => a.s.mtime - b.s.mtime);
        let total = files.reduce((n, x) => n + x.s.size, 0);
        while (files.length && total > KEEP_BYTES) { const x = files.shift(); fs.unlinkSync(path.join(bg.dataDir, x.f)); total -= x.s.size; }
    } catch (e) { log.warn('cleanup: ' + e); }

    const append = (file, text) => { try { fs.appendFileSync(file, text); return true; } catch (e) { if (!st.writeError) { st.writeError = String(e.message || e); log.warn('write: ' + st.writeError); } return false; } };
    append(slow, 'utc,speed_kmh,rpm,gear,stage,condition,oil_c,coolant_c,g_long,g_lat,pedal_pct,p_fl,p_fr,p_rl,p_rr,t_fl,t_fr,t_rl,t_rr,speed_hz,rpm_hz\n');
    append(fast, 'ms,kind,value\n');

    let hard = false;
    const fastLine = (kind, v) => {
        if (!hard || st.fastBytes > FAST_MAX) return;
        const line = Date.now() + ',' + kind + ',' + v + '\n';
        if (append(fast, line)) st.fastBytes += line.length;
    };

    /* count raw samples as they arrive (the rate an app really gets), next to the kit's scaled values */
    const car = new Car(bg, ['rpm', 'speed', 'accel', 'temps', 'gear', 'condition'], {
        'de.bmw.infotainment.vehicle.Vehicle2': { statusCarSpeed2: (v) => { st.speedN++; st.lastSpeedAt = Date.now(); const raw = v && v.speedVehicleCentreOfGravity; if (num(raw)) fastLine('speed', (raw * 0.015625).toFixed(3)); } },
        'de.bmw.infotainment.vehicle.CDS': { statusEngineSpeed2: (v) => { st.rpmN++; const raw = v && v.actualValueRPMEngineCrankshaft; if (num(raw)) fastLine('rpm', (raw * 0.25).toFixed(0)); } },
    });
    bg.signals.watch(PEDAL, '1', {
        AngleAcceleratorPedal: (v) => { const raw = v && v.actualValueAngleAcceleratorPedal; if (num(raw)) st.pedal = raw * 0.025; },
    }, log).then((s) => { if (s && s.error) log.warn('pedal: ' + s.error); });
    const tyres = new Tyres(bg);
    tyres.start().catch((e) => log.warn('tpms: ' + e));

    let lastCondition;
    const timer = setInterval(() => {
        try {
            const d = (car.data ? car.data() : car.live) || {};
            st.speedHz = st.speedN; st.rpmHz = st.rpmN; st.speedN = 0; st.rpmN = 0;
            hard = (num(st.pedal) && st.pedal > 60) || (num(d.gLong) && Math.abs(d.gLong) > 0.25);
            if (d.condition !== lastCondition) { log.info('vehicle condition ' + lastCondition + ' -> ' + d.condition + ' (rpm ' + f1(d.rpm, 0) + ', speed ' + f1(d.speed) + ')'); lastCondition = d.condition; st.conditions[String(d.condition)] = (st.conditions[String(d.condition)] || 0) + 1; }
            if (d.demo) return;                       /* never log the kit's demo drive */
            const ty = tyres.snapshot(), c = {};
            (ty.corners || []).forEach((x) => { c[x.c] = x; });
            const p = (k) => f1(c[k] && c[k].p, 2), t = (k) => f1(c[k] && c[k].t, 0);
            const line = [new Date().toISOString(), f1(d.speed, 2), f1(d.rpm, 0), num(d.gear) ? d.gear : '', d.stage || '', num(d.condition) ? d.condition : '',
                f1(d.oil, 0), f1(d.coolant, 0), f1(d.gLong, 3), f1(d.gLat, 3), f1(st.pedal, 1),
                p('FLH'), p('FRH'), p('RLH'), p('RRH'), t('FLH'), t('FRH'), t('RLH'), t('RRH'), st.speedHz, st.rpmHz].join(',') + '\n';
            if (append(slow, line)) st.lines++;
        } catch (e) { log.warn('tick: ' + e); }
    }, 1000);
    process.on('exit', () => clearInterval(timer));
    log.info('drive log: ' + slow);
    return { st: st, car: car, slow: slow };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui } = ctx;
        const bgm = ctx.background || await background(ctx);
        async function render() {
            const t = ctx.theme(), st = bgm.st;
            const cv = ctx.canvas(W, H).clear(t.bg);
            const d = (bgm.car.data ? bgm.car.data() : bgm.car.live) || {};
            G.panel(cv, t, 24, 44, 1552, 468, 'Drive Log');
            const kv = (k, v, y, c) => { cv.text(k, 56, y, 22, t.dim); cv.text(v, 420, y, 22, c || t.text, { font: 'bold' }); };
            kv('Logging to', st.file, 112);
            kv('Lines written', String(st.lines) + (st.writeError ? '   write error: ' + st.writeError : ''), 150, st.writeError ? t.warn : '#2fd27a');
            kv('Speed samples', st.speedHz + ' a second', 188);
            kv('Engine speed samples', st.rpmHz + ' a second', 226);
            kv('Now', f1(d.speed) + ' km/h   ' + f1(d.rpm, 0) + ' rpm   gear ' + (num(d.gear) ? d.gear : '-') + ' ' + (d.stage || '') + '   condition ' + (num(d.condition) ? d.condition : '-'), 264);
            kv('Pedal / g', f1(st.pedal) + ' %   ' + f1(d.gLong, 2) + ' g', 302);
            kv('Hard-acceleration log', Math.round(st.fastBytes / 1024) + ' KB', 340);
            cv.text('Read-only. The laptop pulls the files after the drive.', 56, 480, 18, t.dim);
            G.frame(cv, t, ['Drive Log'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 1, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
