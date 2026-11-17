'use strict';
/**
 * runlog.js - what the car did during a run, sample by sample, kept beside the timeslip so a launch can be
 * looked at afterwards: where the wheels spun, how hard it pulled, where it shifted.
 *
 * One file per run in the app's data folder (runs/run-<time>.json), the last KEEP kept. It holds times and the
 * car's own numbers only: never a place, never the car's identity. No kit imports (tools/test_launch.js runs it
 * under plain Node).
 *
 *   const rl = new RunLog(path.join(dataDir, 'runs'));
 *   rl.arm(t);                       the tree was armed at steady-clock ms t: start collecting
 *   rl.sample(t, { kmh, rpm, gear, gLong, gLat, torque });      any of them may be missing
 *   rl.cancel();                     no run came of it
 *   rl.finish({ at, greenMs, moveMs, ... })    the run is over: work out the summary, write the file
 *                                    -> { file, summary } or null when nothing was collected or it could not be written
 *
 * A row is [ms since armed, km/h, rpm, gear, g forward, g sideways, Nm]; null where the car gave nothing.
 *
 * WHEELSPIN is an estimate, not a measurement: this app has no signal for each wheel. The car's speed signal
 * comes from its wheels, its acceleration signal from a sensor in the body. Adding the acceleration up gives the
 * speed the body really has; where the speed signal runs ahead of that, the driven wheels are turning faster
 * than the car is moving. The sum drifts (the car squats, the road is not level), so it is only trusted for
 * the first SPIN_WINDOW_S seconds, and what the sensor reads while the car stands still is taken off first.
 */
const fs = require('fs');
const path = require('path');

const SHARE = 10;                /* run logs left where Dashcam can take them to its USB stick */
const KEEP = 20;                 /* run files kept */
const MAX_ROWS = 1600;           /* 64 s at one row every STEP_MS: longer than any run the timer allows */
const STEP_MS = 40;
const SPIN_WINDOW_S = 4;
const SPIN_KMH = 3;              /* the speed signal this far ahead of the body counts as spinning */
const G = 9.80665;

const num = (v) => typeof v === 'number' && isFinite(v);
const rnd = (v, k) => (num(v) ? Math.round(v * k) / k : null);

/**
 * rows as above, moveMs: when the car first moved (ms since armed). Returns
 * { peakG, peakGAtS, launchRpm, spinKmh, spinAtS, spinS, shifts: [{ s, to, rpm }], rows, hz } with null where
 * the car gave no data for it. Times are seconds after the car first moved.
 */
function analyse(rows, moveMs) {
    const out = { peakG: null, peakGAtS: null, launchRpm: null, spinKmh: null, spinAtS: null, spinS: null, shifts: [], rows: 0, hz: null };
    if (!Array.isArray(rows) || !rows.length) return out;
    if (!num(moveMs)) moveMs = rows[0][0];
    out.rows = rows.length;
    const span = (rows[rows.length - 1][0] - rows[0][0]) / 1000;
    out.hz = span > 0 ? rnd((rows.length - 1) / span, 10) : null;
    /* what the sensor reads standing still (a slope, its own offset) */
    let bn = 0, bias = 0;
    rows.forEach((r) => { if (r[0] < moveMs - 100 && num(r[4]) && (!num(r[1]) || r[1] < 0.5)) { bias += r[4]; bn++; } });
    bias = bn >= 3 ? bias / bn : 0;
    let body = null, prev = null, lastGear = null, spinMs = 0;
    rows.forEach((r) => {
        const s = (r[0] - moveMs) / 1000;
        if (s < 0) { if (num(r[3])) lastGear = r[3]; return; }
        if (out.launchRpm === null && num(r[2])) out.launchRpm = Math.round(r[2]);
        if (num(r[4])) { const g = r[4] - bias; if (out.peakG === null || g > out.peakG) { out.peakG = rnd(g, 100); out.peakGAtS = rnd(s, 100); } }
        if (num(r[3])) {
            if (lastGear !== null && r[3] > lastGear && lastGear >= 1 && out.shifts.length < 10) out.shifts.push({ s: rnd(s, 100), to: r[3], rpm: prev && num(prev[2]) ? Math.round(prev[2]) : null });
            lastGear = r[3];
        }
        if (s <= SPIN_WINDOW_S && num(r[1]) && num(r[4])) {
            if (body === null) body = r[1];              /* the speed it already had at the first row after moving */
            else if (prev && num(prev[4])) body += ((r[4] + prev[4]) / 2 - bias) * G * 3.6 * (r[0] - prev[0]) / 1000;
            const ahead = r[1] - body;
            if (out.spinKmh === null || ahead > out.spinKmh) { out.spinKmh = rnd(Math.max(0, ahead), 10); out.spinAtS = rnd(s, 100); }
            if (ahead > SPIN_KMH && prev) spinMs += r[0] - prev[0];
        }
        prev = r;
    });
    if (out.spinKmh !== null) out.spinS = rnd(spinMs / 1000, 100);
    return out;
}

class RunLog {
    constructor(dir) { this.dir = dir; this.rows = null; this.t0 = 0; this.last = -Infinity; this.error = ''; }

    arm(t) { this.rows = []; this.t0 = t; this.last = -Infinity; }

    cancel() { this.rows = null; }

    sample(t, d) {
        if (!this.rows || !d || !num(t) || t - this.last < STEP_MS || this.rows.length >= MAX_ROWS) return;
        this.last = t;
        this.rows.push([Math.round(t - this.t0), rnd(d.kmh, 100), num(d.rpm) ? Math.round(d.rpm) : null, num(d.gear) ? d.gear : null, rnd(d.gLong, 1000), rnd(d.gLat, 1000), num(d.torque) ? Math.round(d.torque) : null]);
    }

    /** info: { at (ISO time of the green light), greenMs, moveMs (steady-clock ms, as given to arm), and anything else worth keeping } */
    finish(info) {
        const rows = this.rows;
        this.rows = null;
        if (!rows || rows.length < 5) return null;
        info = info || {};
        const moveMs = num(info.moveMs) ? Math.round(info.moveMs - this.t0) : null, greenMs = num(info.greenMs) ? Math.round(info.greenMs - this.t0) : null;
        const summary = analyse(rows, moveMs);
        const at = typeof info.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(info.at) ? info.at : new Date().toISOString();
        const doc = Object.assign({}, info, { v: 1, at: at, greenMs: greenMs, moveMs: moveMs, cols: ['ms', 'kmh', 'rpm', 'gear', 'gLong', 'gLat', 'torque'], summary: summary, rows: rows });
        const file = 'run-' + at.slice(0, 19).replace(/[:T]/g, '-') + '.json';
        try {
            try { fs.mkdirSync(this.dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const tmp = path.join(this.dir, file + '.tmp');
            fs.writeFileSync(tmp, JSON.stringify(doc));
            fs.renameSync(tmp, path.join(this.dir, file));
            const all = fs.readdirSync(this.dir).filter((f) => /^run-[\d-]+\.json$/.test(f)).sort();
            all.slice(0, Math.max(0, all.length - KEEP)).forEach((f) => { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* next time */ } });
        } catch (e) { this.error = String(e && e.message || e); return null; }
        return { file: file, summary: summary };
    }

    /**
     * Copies of the newest `n` run logs in `outDir` (a folder other apps can read), and none older: Dashcam takes
     * them to its USB stick. Returns how many are there, or -1 when it could not be done. Never throws.
     *
     * outDir sits in a folder every app on the unit can write to, so it is not taken on trust: it must be a real
     * folder (not a link) that this app owns, or nothing is written or removed. Inside it only this app's own
     * regular files with a run log's name are removed, and a file is created new, never through a link.
     */
    publish(outDir, n) {
        try {
            const RUN = /^run-[\d-]+\.json$/, C = fs.constants || {};
            let all;
            try { all = fs.readdirSync(this.dir).filter((f) => RUN.test(f)).sort(); } catch (e) { all = []; }
            const want = all.slice(-Math.max(0, n));
            try { fs.mkdirSync(outDir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const me = typeof process.getuid === 'function' ? process.getuid() : null;
            const dst = fs.lstatSync(outDir);
            /* its parent is the apps' shared folder: sticky (nobody but an owner can rename or remove what is in it,
             * so the folder checked here cannot be swapped for another afterwards), or this app's own */
            if (process.platform !== 'win32') {
                const up = fs.lstatSync(path.dirname(outDir));
                if (!up.isDirectory() || up.isSymbolicLink() || (!(up.mode & 0o1000) && up.uid !== me)) throw new Error('the parent of the shared folder is not safe to share in');
            }
            /* and it is where its name says it is: a link of any kind resolves somewhere else */
            const real = fs.realpathSync(outDir), named = path.join(fs.realpathSync(path.dirname(outDir)), path.basename(outDir));
            if (!dst.isDirectory() || dst.isSymbolicLink() || real !== named || (me !== null && dst.uid !== me)) throw new Error('the shared folder is not this app\'s own');
            try { fs.chmodSync(outDir, 0o755); } catch (e) { /* best effort */ }
            const mine = (f) => { try { const s = fs.lstatSync(path.join(outDir, f)); return s.isFile() && (me === null || s.uid === me); } catch (e) { return false; } };
            const there = fs.readdirSync(outDir);
            /* out with what is no longer wanted, and with any temporary file a stopped copy left behind */
            there.filter((f) => (RUN.test(f) && want.indexOf(f) < 0) || /^run-[\d-]+\.json\.tmp$/.test(f)).forEach((f) => { if (mine(f)) { try { fs.unlinkSync(path.join(outDir, f)); } catch (e) { /* gone */ } } });
            want.filter((f) => there.indexOf(f) < 0 || !mine(f)).forEach((f) => {
                const data = fs.readFileSync(path.join(this.dir, f)), tmp = path.join(outDir, f + '.tmp');
                const fd = fs.openSync(tmp, (C.O_WRONLY || 1) | (C.O_CREAT || 0) | (C.O_EXCL || 0) | (C.O_NOFOLLOW || 0), 0o644);
                try { fs.writeSync(fd, data, 0, data.length); } finally { fs.closeSync(fd); }
                fs.renameSync(tmp, path.join(outDir, f));
            });
            const after = fs.lstatSync(outDir);
            if (after.ino !== dst.ino || after.dev !== dst.dev) throw new Error('the shared folder changed while it was written');
            return want.length;
        } catch (e) { this.error = String(e && e.message || e); return -1; }
    }
}

/** the summary as one line for the log and the timeslip, or '' when the car gave nothing to go on */
function line(s, unit) {
    if (!s) return '';
    const parts = [];
    if (num(s.peakG)) parts.push('PEAK ' + s.peakG.toFixed(2) + ' G');
    if (num(s.spinKmh)) parts.push(s.spinKmh >= SPIN_KMH ? 'WHEELSPIN EST ' + (unit === 'kmh' ? s.spinKmh.toFixed(0) + ' KM/H' : (s.spinKmh / 1.609344).toFixed(0) + ' MPH') + ' AT ' + s.spinAtS.toFixed(1) + ' S' : 'NO WHEELSPIN SEEN');
    if (num(s.launchRpm)) parts.push('LEFT AT ' + Math.round(s.launchRpm / 10) * 10 + ' RPM');
    return parts.join('  //  ');
}

module.exports = { SHARE: SHARE, RunLog: RunLog, analyse: analyse, line: line, KEEP: KEEP, MAX_ROWS: MAX_ROWS, STEP_MS: STEP_MS, SPIN_KMH: SPIN_KMH };
