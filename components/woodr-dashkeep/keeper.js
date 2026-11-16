'use strict';
/**
 * keeper.js - keeps the dash cam's clips on the car after the stock recorder app has dropped them.
 *
 * The stock app keeps its newest 10 clips (about 7 minutes) in /var/opt/hdshare/ent/driverecorder, and the user
 * that writes them there has a 1 GB disk quota. This service, as root, gives every finished clip a second name in
 * KEEP (a hard link: no copy, nothing written twice) and takes the files off that quota (owner root), so the clip
 * stays when the stock app deletes its own name for it. KEEP has to be inside the same mount as the clips
 * (/var/opt/hdshare is mounted by itself, and a hard link cannot cross a mount: EXDEV), so it sits beside them. The oldest go when KEEP is over its cap, or when the disk
 * gets short.
 *
 * It takes requests only from the Dashcam app: /dev/shm/woody/dashcam.keep.json, honoured only when the file
 * belongs to the user the app manager runs woodr_dashcam as.
 *   { on: bool, capGb: 1..25, clear: <ms timestamp>, drop: [clip folder names], pin: [clip folder names] }
 * A pinned clip (a highlight) is not removed for the cap or by a clear, only by a drop; at most MAX_PINS count.
 * and reports in /dev/shm/woody/dashcam.kept.json { on, capGb, count, bytes, oldest, newest, freeGb, note, at }.
 * Read by Dashcam (the list, the copy to a USB stick). Nothing here talks to the car.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.env.DASHKEEP_SRC || '/var/opt/hdshare/ent/driverecorder';
const KEEP = process.env.DASHKEEP_DIR || '/var/opt/hdshare/ent/woody-dashcam';
const SHM = process.env.WOODY_SHM || '/dev/shm/woody';
const APPS = process.env.DASHKEEP_APPS || '/var/opt/public/oap';
const REQ = path.join(SHM, 'dashcam.keep.json'), OUT = path.join(SHM, 'dashcam.kept.json');
const TICK_MS = Number(process.env.DASHKEEP_TICK_MS) || 10000;
const SETTLE_MS = process.env.DASHKEEP_SETTLE_MS !== undefined ? Number(process.env.DASHKEEP_SETTLE_MS) : 45000;   /* finished: nothing in the clip changed for this long */
const MIN_FREE = 8 * 1073741824;                   /* never let the disk go under this */
const NAME = /^[0-9A-Za-z._()-]{8,80}_(Event|Crash)$/;
const MAX_PINS = 40;                               /* about 3.6 GB of highlights at most */
const FAKE = process.env.DASHKEEP_FAKE === '1';    /* tests: no chown, any owner's request, no free-space rule */

const log = (s) => console.log(s);
let cfg = { on: true, capGb: 10 }, clearDone = 0, note = '', lastSaid = '', pins = {};
/* Clips given up on request (copied to a stick, or cleared) that the stock app still lists: not kept again.
 * Kept in a file so a restart of this service does not bring them back; a name leaves the list once the stock
 * app has dropped the clip too. */
const GONE = path.join(KEEP, '.gone.json');
let gone = null;
function loadGone() { if (gone) return; gone = {}; try { JSON.parse(fs.readFileSync(GONE, 'utf8')).forEach((n) => { if (NAME.test(n)) gone[n] = true; }); } catch (e) { /* none yet */ } }
function saveGone() { try { fs.writeFileSync(GONE + '.tmp', JSON.stringify(Object.keys(gone))); fs.renameSync(GONE + '.tmp', GONE); } catch (e) { /* next time */ } }

function appUid() {
    try {
        const dirs = fs.readdirSync(APPS).filter((d) => /^oap_\d+$/.test(d));
        for (let i = 0; i < dirs.length; i++) {
            try { if (JSON.parse(fs.readFileSync(path.join(APPS, dirs[i], 'source', 'package.json'), 'utf8')).name === 'woodr_dashcam') return Number(dirs[i].slice(4)); } catch (e) { /* not it */ }
        }
    } catch (e) { /* no apps folder */ }
    return -1;
}

function readRequest() {
    let st;
    try { st = fs.lstatSync(REQ); } catch (e) { return null; }
    if (!st.isFile() || st.size > 65536) return null;
    if (!FAKE && st.uid !== appUid()) { note = 'request ignored: not from Dashcam'; return null; }
    try {
        const j = JSON.parse(fs.readFileSync(REQ, 'utf8'));
        const cap = Number(j.capGb);
        return {
            on: j.on !== false,
            capGb: cap >= 1 && cap <= 25 ? cap : 10,
            clear: Number(j.clear) > 0 ? Number(j.clear) : 0,
            drop: Array.isArray(j.drop) ? j.drop.filter((n) => typeof n === 'string' && NAME.test(n)).slice(0, 400) : [],
            pin: Array.isArray(j.pin) ? j.pin.filter((n) => typeof n === 'string' && NAME.test(n)).slice(-MAX_PINS) : [],
        };
    } catch (e) { return null; }
}

function list(dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => NAME.test(n)); } catch (e) { return []; }
    return names.map((n) => {
        let bytes = 0, at = 0;
        const files = [];
        try {
            fs.readdirSync(path.join(dir, n)).forEach((f) => { const s = fs.statSync(path.join(dir, n, f)); if (s.isFile()) { bytes += s.size; at = Math.max(at, s.mtime.getTime()); files.push(f); } });
        } catch (e) { /* going */ }
        return { name: n, bytes: bytes, at: at, files: files };
    }).sort((a, b) => a.at - b.at);
}

function removeDir(d) {
    try { fs.readdirSync(d).forEach((f) => fs.unlinkSync(path.join(d, f))); fs.rmdirSync(d); return true; } catch (e) { return false; }
}
const remove = (name) => removeDir(path.join(KEEP, name));

function freeBytes() {
    if (FAKE) return Infinity;
    try { const o = execFileSync('df', ['-k', KEEP], { encoding: 'utf8' }).trim().split('\n').pop().trim().split(/\s+/); return Number(o[3]) * 1024; } catch (e) { return Infinity; }
}

/** a second name in KEEP for every finished clip that has none yet; returns how many */
function keepNew() {
    const have = {};
    try { fs.readdirSync(KEEP).forEach((n) => { have[n] = true; }); } catch (e) { /* made by tick */ }
    let n = 0;
    list(SRC).forEach((c) => {
        if (have[c.name] || gone[c.name] || c.files.length < 3 || Date.now() - c.at < SETTLE_MS) return;
        if (!c.files.some((f) => /\.ts$/.test(f))) return;
        const d = path.join(KEEP, c.name), tmp = d + '.part';
        try {
            removeDir(tmp);
            fs.mkdirSync(tmp, 0o755);
            c.files.forEach((f) => {
                fs.linkSync(path.join(SRC, c.name, f), path.join(tmp, f));
                if (!FAKE) { fs.chownSync(path.join(tmp, f), 0, 0); fs.chmodSync(path.join(tmp, f), 0o644); }
            });
            fs.renameSync(tmp, d);
            n++;
        } catch (e) { note = 'keep ' + c.name + ': ' + (e.code || e.message); removeDir(tmp); }
    });
    return n;
}

function tick() {
    note = '';
    try { fs.mkdirSync(SHM); fs.chmodSync(SHM, 0o1777); } catch (e) { /* there */ }
    try { fs.mkdirSync(KEEP, 0o755); } catch (e) { /* there */ }
    loadGone();
    const r = readRequest();
    if (r) { cfg = { on: r.on, capGb: r.capGb }; pins = {}; r.pin.forEach((n) => { pins[n] = true; }); }
    let dropped = 0, kept = 0;
    if (r) {
        let changed = false;
        r.drop.forEach((n) => { if (remove(n)) { dropped++; gone[n] = true; changed = true; } });
        if (r.clear > clearDone && r.clear <= Date.now() + 60000) {
            list(KEEP).forEach((c) => { if (c.at <= r.clear && !pins[c.name] && remove(c.name)) dropped++; });
            list(SRC).forEach((c) => { if (c.at <= r.clear && !pins[c.name]) { gone[c.name] = true; changed = true; } });
            clearDone = r.clear;
        }
        if (changed) saveGone();
    }
    /* forget the names the stock app has let go of */
    const inSrc = {};
    try { fs.readdirSync(SRC).forEach((n) => { inSrc[n] = true; }); } catch (e) { /* no folder */ }
    const before = Object.keys(gone).length;
    Object.keys(gone).forEach((n) => { if (!inSrc[n]) delete gone[n]; });
    if (Object.keys(gone).length !== before) saveGone();
    if (cfg.on) kept = keepNew();
    /* over the cap, or the disk short: the oldest go (never the newest one) */
    const l = list(KEEP);
    let total = l.reduce((s, c) => s + c.bytes, 0), pruned = 0, free = freeBytes();
    const cap = cfg.capGb * 1073741824;
    /* the oldest clip that is not pinned goes first; the newest clip always stays */
    while (total > cap || free < MIN_FREE) {
        let i = -1;
        for (let k = 0; k < l.length - 1; k++) { if (!pins[l[k].name]) { i = k; break; } }
        if (i < 0) break;
        const c = l.splice(i, 1)[0];
        if (!remove(c.name)) break;
        total -= c.bytes; free += c.bytes; pruned++;
    }
    const out = { on: cfg.on, capGb: cfg.capGb, pinned: l.filter((c) => pins[c.name]).length, count: l.length, bytes: total, oldest: l.length ? l[0].at : 0, newest: l.length ? l[l.length - 1].at : 0,
        freeGb: free === Infinity ? null : Math.round(free / 107374182.4) / 10, cleared: clearDone, note: note, at: Date.now() };
    try { const tmp = OUT + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out)); fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, OUT); } catch (e) { /* tmpfs gone */ }
    const said = (kept ? kept + ' kept, ' : '') + (dropped ? dropped + ' removed on request, ' : '') + (pruned ? pruned + ' oldest removed, ' : '');
    if (said || note !== lastSaid) log(said + 'holding ' + l.length + ' clips, ' + (total / 1073741824).toFixed(2) + ' of ' + cfg.capGb + ' GB' + (note ? ' (' + note + ')' : ''));
    lastSaid = note;
    return out;
}

if (require.main === module) {
    log('dashkeep: ' + SRC + ' -> ' + KEEP);
    tick();
    setInterval(() => { try { tick(); } catch (e) { log('tick: ' + e); } }, TICK_MS);
} else module.exports = { tick: tick, list: list };
