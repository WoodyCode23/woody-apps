'use strict';
/**
 * history.js - the saved runs: one JSON object per line in the app's data folder, the newest last, the last
 * KEEP kept. No kit imports (tools/test_launch.js runs it under plain Node).
 *
 * A saved run holds the time it was made, the name of its data log and that log's summary (runlog.js), every split reached, the settings it was made with (tree type,
 * rollout, speed unit) and how good the speed signal was during it. It never holds a place: the app reads
 * no position and writes none.
 *
 *   const h = new History(path.join(dataDir, 'runs.jsonl'));
 *   h.load();            read the file (bad lines are skipped, a missing file is an empty history)
 *   h.add(record)        append one run and trim to KEEP; returns false when the file could not be written
 *   h.runs               oldest first
 *   record(result, extra)    a timing.js result as a saved line
 *   bests(runs, rollout)     the best of each split among real runs made with that rollout setting
 *   marks(run, runs)         { key: true } for each split where this run holds (or ties) the best
 */
const fs = require('fs');

const KEEP = 50;
const num = (v) => typeof v === 'number' && isFinite(v);
const r3 = (v) => (num(v) ? Math.round(v * 1000) / 1000 : null);
const r1 = (v) => (num(v) ? Math.round(v * 10) / 10 : null);

function roundAll(obj, fn) {
    const out = {};
    Object.keys(obj || {}).forEach((k) => { const v = fn(obj[k]); if (v !== null) out[k] = v; });
    return out;
}

/** A finished run (timing.js result) as the object that is saved. extra: { at, unit, shiftRpm, tempC, demo }. */
function record(result, extra) {
    const x = extra || {};
    return {
        v: 1,
        at: x.at || new Date().toISOString(),
        tree: result.tree,
        rollout: !!result.rollout,
        rt: r3(result.rt),
        red: !!result.red,
        et: roundAll(result.et, r3),
        kmh: roundAll(result.kmh, r1),
        trap: roundAll(result.trap, r1),
        peakKmh: r1(result.peakKmh),
        peakRpm: num(result.peakRpm) ? Math.round(result.peakRpm) : null,
        end: result.end,
        unit: x.unit || 'mph',
        shiftRpm: num(x.shiftRpm) ? x.shiftRpm : null,
        tempC: num(x.tempC) ? r1(x.tempC) : null,
        hz: r1(result.hz),
        gapMs: num(result.maxGapMs) ? result.maxGapMs : null,
        demo: x.demo ? true : undefined,
    };
}

function parse(text) {
    const runs = [];
    String(text || '').split('\n').forEach((line) => {
        if (!line.trim()) return;
        try {
            const r = JSON.parse(line);
            if (r && typeof r === 'object' && r.et && typeof r.et === 'object') runs.push(r);
        } catch (e) { /* a torn or foreign line: skipped */ }
    });
    return runs;
}

function trim(runs, keep) {
    const n = keep === undefined ? KEEP : keep;
    return runs.length > n ? runs.slice(runs.length - n) : runs;
}

/** Runs that may be compared with one another: real (not demo), same rollout setting. */
function comparable(runs, rollout) {
    return (runs || []).filter((r) => r && !r.demo && !!r.rollout === !!rollout);
}

/** { key: best seconds } over the comparable runs; 'rt' is the best reaction that was not a red light. */
function bests(runs, rollout) {
    const best = {};
    comparable(runs, rollout).forEach((r) => {
        Object.keys(r.et || {}).forEach((k) => {
            const v = r.et[k];
            if (num(v) && v > 0 && (best[k] === undefined || v < best[k])) best[k] = v;
        });
        if (!r.red && num(r.rt) && r.rt >= 0 && (best.rt === undefined || r.rt < best.rt)) best.rt = r.rt;
    });
    return best;
}

/** The splits where this run is the best of its kind. A demo run never holds a best. */
function marks(run, runs) {
    const out = {};
    if (!run || run.demo) return out;
    const b = bests(runs, run.rollout);
    Object.keys(run.et || {}).forEach((k) => { if (num(run.et[k]) && b[k] !== undefined && run.et[k] <= b[k]) out[k] = true; });
    if (!run.red && num(run.rt) && run.rt >= 0 && b.rt !== undefined && run.rt <= b.rt) out.rt = true;
    return out;
}

class History {
    constructor(file, keep) {
        this.file = file;
        this.keep = keep === undefined ? KEEP : keep;
        this.runs = [];
        this.error = '';
    }

    load() {
        try { this.runs = trim(parse(fs.readFileSync(this.file, 'utf8')), this.keep); } catch (e) { this.runs = []; }
        return this.runs;
    }

    /** Append a run. The file is rewritten whole (temp file renamed over it) only when it has to be trimmed. */
    add(rec) {
        const before = this.runs.length;
        this.runs = trim(this.runs.concat([rec]), this.keep);
        try {
            if (before + 1 > this.keep) {
                const tmp = this.file + '.' + process.pid + '.tmp';
                fs.writeFileSync(tmp, this.runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
                fs.renameSync(tmp, this.file);
            } else fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
            this.error = '';
            return true;
        } catch (e) {
            this.error = String(e && e.message || e);
            return false;
        }
    }
}

module.exports = { History, record, parse, trim, bests, marks, comparable, KEEP };
