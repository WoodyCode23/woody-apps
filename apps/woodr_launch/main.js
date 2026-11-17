'use strict';
/**
 * Launch - a drag-strip style launch timer: staging, a countdown tree, the run, and a timeslip.
 *
 * STAGING   Shows when the car is ready to stage: stopped, in drive, engine running. The Arm / Reset button
 *           (or a press of the steering wheel's right roller, while this screen is open) arms the tree.
 * TREE      After a random 1.0 to 2.5 s: three ambers 0.5 s apart and then green (sportsman), or all three
 *           ambers together and green 0.4 s later (pro). Moving before green is a red light.
 * RUN       The clock starts when the car first moves (or after the first foot with rollout on). Distance is
 *           speed added up over time; every split is stamped at the moment it is passed, found between
 *           samples (timing.js). The run ends when the car stops, 2 s after the driver lifts past 60 ft, or
 *           after 60 s.
 * TIMESLIP  Reaction, 60 ft, 330 ft, 1/8 mile, 1000 ft, 1/4 mile, 1/2 mile, 1 mile, 0-30, 0-60, 0-100 and
 *           60-130 mph, 0-100 and 100-200 km/h, peak speed and revs. A split never reached shows a dash.
 * HISTORY   Every finished run is one line in runs.jsonl in this app's data folder, the last 50 kept, with
 *           the best of each split marked. No place is read or recorded.
 *
 * The tree and the run's key numbers also show on the instrument cluster and the head-up display
 * (screens.js), inside the areas measured as visible on this car.
 *
 * Read-only: speed, engine speed, gear, acceleration, torque and one wheel button in, pixels and small files out. It arms,
 * changes and triggers nothing on the car: not launch control, not traction settings, nothing.
 *
 * Timing is from the car's speed signal (about 48 to 70 samples a second), not from GPS or a beam.
 * Every timer, signal and button handler below catches its own errors: an uncaught one would end the app.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const T = require('./timing');
const D = require('./draw');
const H = require('./history');
const { DemoCar } = require('./demo');
const { Wheel } = require('./wheel');
const { Remote } = require('./screens');
const RL = require('./runlog');
const shared = require('./shared');

const APP_ID = 'woodr_launch';
const SPEED_IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
const TICK_MS = 20;
const ENGINE_RPM = 400;              /* above this the engine counts as running */
const RESULT_ON_GLASS_MS = 10000;    /* the result stays on the cluster and HUD this long after a run */
const HINT_MS = 4000;

const num = (v) => typeof v === 'number' && isFinite(v);
const pad = (n) => (n < 10 ? '0' : '') + n;

/* a steady clock in ms: the wall clock can jump when the head unit sets its time */
const CLOCK0 = process.hrtime();
function now() { const d = process.hrtime(CLOCK0); return d[0] * 1000 + d[1] / 1e6; }

function whenText(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** A finished demo run made at once, for the demo history: the simulated car against the real timer. */
function demoRun(power, grip, tree, rollout, reaction, at) {
    const car = new DemoCar(), tm = new T.LaunchTimer({ rollout: rollout });
    car.power = power; car.grip = grip;
    let t = 0;
    tm.sample(t, 0);
    const sched = T.treeSchedule(tree, 1500);
    tm.arm(t, sched);
    car.go(t + sched.green, reaction);
    for (let i = 0; i < 4000 && tm.state !== 'done'; i++) {
        t += 16;
        const s = car.step(t);
        tm.sample(t, T.kmhFromRaw(s.raw));
        tm.rpm(s.rpm);
        tm.tick(t);
    }
    return tm.result ? H.record(tm.result, { at: at, demo: true }) : null;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const timer = new T.LaunchTimer({ rollout: settings.get('rollout') === true });
        const sim = new DemoCar();
        const hist = new H.History(path.join(ctx.dataDir, 'runs.jsonl'));
        /* what the car did during each run, sample by sample (runlog.js) */
        const runlog = new RL.RunLog(path.join(ctx.dataDir, 'runs'));
        try { hist.load(); log.info('launch: ' + hist.runs.length + ' saved run(s)'); } catch (e) { log.warn('history: ' + e); }
        const remote = new Remote(ctx, APP_ID);
        /* the newest run logs where Dashcam can take them to its USB stick, beside the clips (its runlogs.js) */
        const shareRuns = () => {
            if (settings.get('usbRuns') === false) return;
            shared.write('launch.runs.json', { dir: 'launch.runs' });          /* also makes the shared folder */
            const n = runlog.publish(path.join(shared.DIR, 'launch.runs'), RL.SHARE);
            if (n < 0) log.warn('launch: run logs not shared: ' + runlog.error);
        };
        try { shareRuns(); } catch (e) { log.warn('launch: share runs: ' + e); }

        /* what the car last said, and what the app is showing */
        const st = {
            kmh: null, speedN: 0, speedHz: 0, rpm: null, gear: undefined, stage: undefined,
            page: 'main', histPage: 0, hint: '', hintUntil: 0,
            result: null, marks: {}, saved: true, doneAt: 0, greenLogged: false, movedLogged: false,
            first: [], demoRuns: null, wasDemo: false, lastState: 'idle',
        };

        /* ---------- the car ---------- */
        function onSpeed(v) {
            try {
                const kmh = T.kmhFromRaw(v && v.speedVehicleCentreOfGravity);
                if (kmh === null) return;
                const t = now();
                st.speedN++;
                if (car.demoActive) return;
                st.kmh = kmh;
                /* the first samples of a launch, kept for the log: they show how the signal leaves zero */
                if (timer.state === 'armed' && kmh > 0 && st.first.length === 0) st.first.push([0, kmh, t]);
                else if (st.first.length > 0 && st.first.length < 10) st.first.push([Math.round(t - st.first[0][2]), kmh]);
                timer.sample(t, kmh);
                const live = car.live || {};
                runlog.sample(t, { kmh: kmh, rpm: live.rpm, gear: num(live.gear) ? live.gear : car.guessed, gLong: live.gLong, gLat: live.gLat, torque: live.torque });
            } catch (e) { log.warn('speed: ' + e); }
        }
        const extra = {};
        extra[SPEED_IFACE] = { statusCarSpeed2: onSpeed };
        const car = new Car(ctx, ['rpm', 'gear', 'accel', 'torque'], extra);
        car.onSample((d) => { try { if (!d.demo) timer.rpm(d.rpm); } catch (e) { log.warn('rpm: ' + e); } });

        const wheel = new Wheel(ctx, () => {
            try {
                if (settings.get('wheelArm') === false || !ui.isVisible('MAIN') || settings.get('noticeSeen') !== true || st.page !== 'main') return;
                log.info('launch: wheel roller pressed');
                if (timer.state === 'idle') arm('wheel');
                else if (timer.state === 'armed') cancel('wheel');
                else if (timer.state === 'done' && timer.stopped()) newRun();
            } catch (e) { log.warn('wheel: ' + e); }
        });
        let wheelOk = false;
        wheel.start().then((ok) => { wheelOk = ok; }).catch((e) => log.warn('wheel start: ' + e));
        try { remote.start(); } catch (e) { log.warn('screens: ' + e); }

        /* ---------- readiness ---------- */
        function ready() {
            const stopped = num(st.kmh) ? st.kmh < T.MOVE_KMH : null;
            const engine = num(st.rpm) ? st.rpm > ENGINE_RPM : null;
            const g = st.gear, s = st.stage;
            let gear = 'unknown', gearText = '';
            if (s === 'P' || s === 'R' || s === 'N') { gear = 'no'; gearText = s; }
            else if (s === 'D' || (num(g) && g >= 1)) { gear = 'ok'; gearText = 'D' + (num(g) && g >= 1 ? g : ''); }
            else if (g === 0 || g === -1) { gear = 'no'; gearText = g === 0 ? 'N' : 'R'; }
            return { stopped: stopped, engine: engine, gear: gear, gearText: gearText, kmh: st.kmh, rpm: st.rpm, all: stopped === true && engine === true && gear !== 'no' };
        }
        function hint(text) { st.hint = text; st.hintUntil = now() + HINT_MS; }

        /* ---------- the buttons ---------- */
        function arm(by) {
            const rd = ready();
            if (!rd.all) {
                hint(rd.stopped !== true ? 'NOT ARMED: THE CAR IS NOT STOPPED' : rd.engine !== true ? 'NOT ARMED: THE ENGINE IS NOT RUNNING' : 'NOT ARMED: SELECT DRIVE');
                log.info('launch: arm refused (' + st.hint + ')');
                return;
            }
            const t = now();
            timer.setRollout(settings.get('rollout') === true);
            const sched = T.treeSchedule(settings.get('tree') === 'pro' ? 'pro' : 'sportsman', T.preStageDelay(Math.random()), Number(settings.get('treeGap')) || 1000);
            if (!timer.arm(t, sched)) { hint('NOT ARMED: NO SPEED FROM THE CAR YET'); return; }
            st.result = null; st.first = []; st.greenLogged = false; st.movedLogged = false; st.hint = '';
            /* the bests this run is measured against on the cluster's pop-ups: real runs only, same rollout */
            try { st.bests = car.demoActive ? {} : H.bests(hist.runs, timer.rollout); } catch (e) { st.bests = {}; }
            if (car.demoActive) sim.go(t + sched.green, Math.random()); else runlog.arm(t);
            log.info('launch: armed by ' + by + ' (' + sched.type + ' tree, pre-stage ' + sched.preMs + ' ms, rollout ' + (timer.rollout ? 'on' : 'off') +
                ', speed samples ' + st.speedHz + '/s' + (car.demoActive ? ', DEMO' : '') + ')');
        }
        function cancel(by) {
            timer.cancel(); sim.cancel(); runlog.cancel();
            hint('CANCELLED');
            log.info('launch: cancelled by ' + by);
        }
        function newRun() { timer.reset(); st.result = null; st.hint = ''; }

        /* Arming from the head-up display's menu (HUD's quick action "Launch"): a small file HUD touches, read here.
         * It does what the Arm / Reset button does, whichever screen is showing. Launch says what state it is in
         * through launch.state.json, so HUD can show the row only while Launch runs and say what came of the press. */
        const remoteArm = { seen: 0, checked: 0, told: 0 };
        function tell(t) {
            if (t - remoteArm.told < 1000) return;
            remoteArm.told = t;
            shared.write('launch.state.json', { state: timer.state, ready: ready().all, hint: st.hint || '' });
        }
        function remoteAsked(t) {
            if (t - remoteArm.checked < 200) return;
            remoteArm.checked = t;
            let at = 0;
            try { at = fs.statSync(path.join(shared.DIR, 'launch.arm.json')).mtime.getTime(); } catch (e) { if (!remoteArm.seen) remoteArm.seen = 1; return; }
            if (at <= remoteArm.seen) return;
            const first = remoteArm.seen === 0;
            remoteArm.seen = at;
            if (first || Date.now() - at > 5000) return;                 /* an old press, from before this app started or long ago */
            if (settings.get('noticeSeen') !== true) { hint('OPEN LAUNCH ON THE CENTRE SCREEN ONCE FIRST'); return; }
            log.info('launch: asked from the head-up display menu');
            st.page = 'main';
            if (timer.state === 'idle') arm('hud');
            else if (timer.state === 'armed') cancel('hud');
            else if (timer.state === 'done' && timer.stopped()) { newRun(); arm('hud'); }
            remoteArm.told = 0;
        }

        function action() {
            if (settings.get('noticeSeen') !== true) { settings.set('noticeSeen', true); log.info('launch: first-run notice accepted'); return; }
            if (st.page === 'history') {
                const n = Math.max(1, Math.ceil(shownRuns().length / D.HIST_ROWS));
                st.histPage = (st.histPage + 1) % n;
                return;
            }
            if (timer.state === 'idle') arm('button');
            else if (timer.state === 'armed') cancel('button');
            else if (timer.state === 'done') newRun();
            /* during a run the button does nothing: the run ends by itself */
        }
        ui.onClick('BTN_ACTION', () => { try { action(); } catch (e) { log.warn('action: ' + e); } return render().catch(() => {}); });
        ui.onClick('BTN_PAGE', () => {
            try { if (settings.get('noticeSeen') === true) { st.page = st.page === 'history' ? 'main' : 'history'; st.histPage = 0; } } catch (e) { log.warn('page: ' + e); }
            return render().catch(() => {});
        });

        /* ---------- runs ---------- */
        const plain = (r) => Object.assign({}, r, { demo: undefined });
        /* the runs the history page lists, newest first: the saved ones, or in demo mode only made-up ones */
        function shownRuns() {
            if (!car.demoActive) return hist.runs.slice().reverse();
            if (!st.demoRuns) {
                const day = 86400000, t0 = Date.now();
                st.demoRuns = [demoRun(310000, 9.5, 'sportsman', false, 0.9, new Date(t0 - 2 * day).toISOString()),
                    demoRun(290000, 9.0, 'pro', false, 0.2, new Date(t0 - day).toISOString())].filter(Boolean);
            }
            return st.demoRuns.slice().reverse();
        }
        /* a demo run is compared with the other demo runs only, a real one with the real ones only */
        function marksFor(rec, list) { return rec.demo ? H.marks(plain(rec), list.map(plain)) : H.marks(rec, list); }

        function finish() {
            const res = timer.result, demo = car.demoActive;
            const rec = H.record(res, {
                at: new Date().toISOString(), unit: settings.get('speedUnit') === 'kmh' ? 'kmh' : 'mph',
                shiftRpm: Number(settings.get('shiftRpm')) || null, tempC: null, demo: demo,
            });
            st.saved = true;
            /* the data log of a real run: beside the timeslip, and its summary on it */
            let logged = null;
            try {
                if (demo || res.aborted) runlog.cancel();
                else {
                    logged = runlog.finish({ at: new Date(Date.now() - Math.max(0, now() - timer.tGreen)).toISOString(), greenMs: timer.tGreen, moveMs: timer.tMove, rollout: !!timer.rollout, red: !!res.red, et: rec.et, end: res.end });
                    if (logged) { shareRuns(); rec.log = logged.file; rec.sum = logged.summary; log.info('launch: data log ' + logged.file + ' ' + JSON.stringify(logged.summary)); }
                    else log.warn('launch: no data log' + (runlog.error ? ': ' + runlog.error : ''));
                }
            } catch (e) { log.warn('launch: data log: ' + e); }
            if (!res.aborted) {
                if (demo) { shownRuns(); st.demoRuns.push(rec); if (st.demoRuns.length > H.KEEP) st.demoRuns.shift(); }
                else {
                    st.saved = hist.add(rec);
                    if (st.saved) log.info('launch: saved run ' + hist.runs.length + ' of at most ' + H.KEEP);
                    else log.warn('launch: history write failed: ' + hist.error);
                }
            }
            st.result = Object.assign({}, rec, { aborted: res.aborted, when: whenText(rec.at).slice(6), logLine: logged ? RL.line(logged.summary, rec.unit) : '' });
            st.marks = res.aborted ? {} : marksFor(rec, demo ? st.demoRuns : hist.runs);
            st.doneAt = now();
            const hd = T.headline(res);
            log.info('launch: run ended (' + res.end + (res.aborted ? ', no split reached' : '') + ')' + (hd ? ' ' + hd.label + ' ' + hd.s.toFixed(3) + ' s' : '') +
                ', reaction ' + res.rt.toFixed(3) + ' s' + (res.red ? ' RED LIGHT' : '') + (res.bumps ? ', ' + res.bumps + ' bump(s) before green ignored' : '') + ', peak ' + res.peakKmh.toFixed(1) + ' km/h, ' + res.samples + ' samples at ' +
                res.hz.toFixed(1) + '/s, longest gap ' + res.maxGapMs + ' ms, bad samples ' + res.glitches + (demo ? ', DEMO' : ''));
            log.info('launch: splits ' + JSON.stringify(rec.et));
            if (st.first.length) log.info('launch: first speeds [ms after the first, km/h] ' + JSON.stringify(st.first.map((x) => [x[0], Math.round(x[1] * 1000) / 1000])));
        }

        /* ---------- the tick: the demo car, the clock's checks, the small screens ---------- */
        let rateAt = now();
        function tick() {
            const t = now();
            const demo = car.demoActive;
            if (demo !== st.wasDemo) {
                st.wasDemo = demo;
                timer.reset(); sim.reset(); st.result = null; st.kmh = null; st.rpm = null; st.page = 'main';
                log.info('launch: ' + (demo ? 'demo car' : 'live car'));
            }
            if (demo) {
                const s = sim.step(t);
                st.kmh = T.kmhFromRaw(s.raw); st.rpm = s.rpm; st.gear = s.gear; st.stage = s.stage;
                timer.sample(t, st.kmh);
                timer.rpm(s.rpm);
            } else {
                const live = car.live || {};
                st.rpm = num(live.rpm) ? live.rpm : null;
                st.gear = num(live.gear) ? live.gear : car.guessed;
                st.stage = live.stage;
            }
            if (t - rateAt >= 1000) { st.speedHz = Math.round(st.speedN * 1000 / (t - rateAt)); st.speedN = 0; rateAt = t; }
            timer.tick(t);
            try { remoteAsked(t); tell(t); } catch (e) { log.warn('launch: hud menu: ' + e); }

            if (timer.state === 'armed' && !st.greenLogged && t >= timer.tGreen) { st.greenLogged = true; log.info('launch: green'); }
            if (timer.state === 'run' && !st.movedLogged) {
                st.movedLogged = true;
                const rt = (timer.tMove - timer.tGreen) / 1000;
                log.info(rt < 0 ? 'launch: RED LIGHT, moved ' + (-rt).toFixed(3) + ' s before green' : 'launch: moved, reaction ' + rt.toFixed(3) + ' s');
                /* every real launch is a highlight on the dashcam: a small file it watches, which only ever marks a clip */
                if (!demo && settings.get('highlight') !== false) log.info('launch: dashcam highlight ' + (shared.write('dashcam.highlight.launch.json', { from: 'launch' }) ? 'asked' : 'could not be asked'));
            }
            if (timer.state === 'done' && st.lastState !== 'done') finish();
            if (timer.state === 'idle' && st.lastState === 'armed' && timer.note === 'no launch') { sim.cancel(); runlog.cancel(); hint('NO LAUNCH WITHIN 30 S OF GREEN: DISARMED'); log.info('launch: disarmed, no launch'); }
            st.lastState = timer.state;
            if (st.hint && t > st.hintUntil) st.hint = '';

            /* cluster and head-up display */
            const unit = settings.get('speedUnit') === 'kmh' ? 'kmh' : 'mph';
            const shiftRpm = Number(settings.get('shiftRpm')) || 6800;
            let s = null;
            if (timer.state === 'armed') s = { phase: 'tree', lights: timer.lights(t), kmh: st.kmh, unit: unit, rpm: st.rpm, shiftRpm: shiftRpm, gear: st.gear };
            else if (timer.state === 'run') {
                const v = timer.view(t), L = timer.lights(t);
                s = { phase: 'run', lights: L, red: L.red, elapsed: v.elapsed, kmh: v.kmh, unit: unit, last: v.last, rpm: st.rpm, shiftRpm: shiftRpm, gear: st.gear, shift: settings.get('shiftBar') !== false };
                if (v.last) {
                    const k = v.last.key, was = st.bests ? st.bests[k] : undefined, kmhAt = timer.kmh ? timer.kmh[k] : undefined;
                    s.lastBest = num(was) && num(v.last.s) && v.last.s < was;
                    s.lastAt = num(kmhAt) ? D.speedText(kmhAt, unit, 0) + ' ' + D.unitName(unit) : '';
                }
            } else if (timer.state === 'done' && st.result && t - st.doneAt < RESULT_ON_GLASS_MS) {
                const hd = T.headline(st.result), at = hd ? D.distValue(st.result, hd.key, unit) : '';
                s = { phase: 'done', headline: hd, rt: st.result.rt, red: st.result.red, at: at.indexOf('@') > 0 ? at.slice(at.indexOf('@') + 2) + ' ' + D.unitName(unit) : '' };
            }
            remote.update(s, t);
            remote.flash(!!s && s.phase === 'run' && s.shift && num(st.rpm) && st.rpm >= shiftRpm && Math.floor(t / 100) % 2 === 0);
        }
        const tickTimer = setInterval(() => { try { tick(); } catch (e) { log.warn('tick: ' + e); } }, TICK_MS);
        process.on('exit', () => { try { clearInterval(tickTimer); remote.stop(); } catch (e) { /* going */ } });

        /* ---------- the centre screen ---------- */
        function model() {
            const t = now(), demo = car.demoActive;
            const unit = settings.get('speedUnit') === 'kmh' ? 'kmh' : 'mph';
            const state = timer.state;
            const list = shownRuns();
            const m = {
                notice: settings.get('noticeSeen') !== true,
                page: st.page,
                phase: state === 'armed' ? 'tree' : state === 'run' ? 'run' : state === 'done' && st.result ? 'slip' : 'staging',
                demo: demo, unit: unit,
                tree: (state === 'idle' ? settings.get('tree') : timer.sched && timer.sched.type) === 'pro' ? 'pro' : 'sportsman',
                rollout: state === 'idle' ? settings.get('rollout') === true : timer.rollout,
                shiftRpm: Number(settings.get('shiftRpm')) || 6800,
                waiting: !demo && !num(st.kmh),
                ready: ready(), hint: st.hint, wheel: wheelOk && settings.get('wheelArm') !== false,
                lights: timer.lights(t), rpm: st.rpm, blinkOn: Math.floor(t / 100) % 2 === 0,
                gearText: ready().gearText,
            };
            if (m.page === 'history') {
                const all = demo ? st.demoRuns : hist.runs;
                m.history = {
                    page: st.histPage,
                    runs: list.map((r) => Object.assign({}, r, { when: whenText(r.at), marks: marksFor(r, all) })),
                    bests: H.bests(demo ? all.map(plain) : all, m.rollout),
                };
            } else if (m.phase === 'run') {
                m.view = timer.view(t);
                m.rt = (timer.tMove - timer.tGreen) / 1000;
            } else if (m.phase === 'slip') {
                m.result = st.result; m.marks = st.marks; m.saved = st.saved;
                m.headline = T.headline(st.result);
            } else if (list.length) {
                m.lastRun = list[0];
                m.marks = marksFor(list[0], demo ? st.demoRuns : hist.runs);
            }
            return m;
        }

        async function render() {
            const cv = ctx.canvas(D.W, D.H).clear('#050507');
            try { D.centre(cv, model()); } catch (e) { log.warn('draw: ' + (e && e.stack || e)); }
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
