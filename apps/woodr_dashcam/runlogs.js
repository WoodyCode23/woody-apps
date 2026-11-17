'use strict';
/**
 * runlogs.js - Launch's run logs, taken to the USB stick beside the clips.
 *
 * Launch (which writes nothing but its own files) leaves copies of its newest run logs in
 * /dev/shm/woody/launch.runs/. Dashcam owns the stick and its write session, so it is the one that copies them,
 * to <stick>/Launch/run-<time>.json. With clips and logs on one stick, an editor can put a run's figures on the
 * clip of that run with nothing else fetched from the car.
 *
 * That folder is one any app on the unit can write to, so what is found there is not trusted: only names that
 * look like a run log, only regular files (never a link), only small ones, only a few. The bytes are copied as
 * they are and never read as anything; the editor that opens them checks them again.
 *
 *   pending(dir, onStick) -> names to copy, oldest first
 *   copyTo(dir, dest, names) -> { copied, failed, why }     (needs the stick writable: call under the session)
 */
const fs = require('fs');
const path = require('path');

const RUN_FILE = /^run-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.json$/;
const MAX_BYTES = 2 * 1024 * 1024, MAX_FILES = 20;
const FOLDER = 'Launch';

/** the run logs in `dir` that `onStick` (file names) does not hold, oldest first; never more than MAX_FILES */
function pending(dir, onStick) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const have = {};
    (onStick || []).forEach((n) => { have[n] = true; });
    return names.filter((n) => RUN_FILE.test(n) && !have[n]).filter((n) => {
        try { const s = fs.lstatSync(path.join(dir, n)); return s.isFile() && s.size > 0 && s.size <= MAX_BYTES; } catch (e) { return false; }
    }).sort().slice(-MAX_FILES);
}

/** one file, opened once and judged by what was opened (not followed if it became a link since it was listed) */
function readSafe(file) {
    const C = fs.constants || {};
    const fd = fs.openSync(file, (C.O_RDONLY || 0) | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
    try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.size <= 0 || s.size > MAX_BYTES) throw new Error('not a run log');
        const buf = Buffer.alloc(s.size);
        let n = 0;
        while (n < s.size) { const got = fs.readSync(fd, buf, n, s.size - n, null); if (got <= 0) break; n += got; }
        return buf.slice(0, n);
    } finally { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}

function copyTo(dir, dest, names) {
    const out = { copied: 0, failed: 0, why: '' };
    try { fs.mkdirSync(dest); } catch (e) { if (e.code !== 'EEXIST') { out.failed = (names || []).length; out.why = String(e.message || e); return out; } }
    (names || []).forEach((name) => {
        if (!RUN_FILE.test(name)) return;
        try {
            const tmp = path.join(dest, name + '.tmp');
            fs.writeFileSync(tmp, readSafe(path.join(dir, name)));
            fs.renameSync(tmp, path.join(dest, name));
            out.copied++;
        } catch (e) { out.failed++; out.why = String(e && e.message || e); }
    });
    return out;
}

module.exports = { pending: pending, copyTo: copyTo, FOLDER: FOLDER, MAX_FILES: MAX_FILES, MAX_BYTES: MAX_BYTES };
