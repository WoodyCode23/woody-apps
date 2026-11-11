'use strict';
/**
 * shared.js - small files in /dev/shm/woody that let the Woody apps steer each other without sockets.
 *
 *   hud.json     written by Woody HUD's menu: { warmup: 'auto' | 'hide' | 'show', at }   (Warm-Up HUD reads it)
 *   ambient.json written by Woody HUD's menu: { cmd: 'next', n, at }                      (Ambient Studio reads it)
 *   garage.json  written by Home Assistant:   { ok, state, since, at }                    (Ambient Studio reads it)
 *
 * Each app runs as its own user, so the folder is 1777 (anyone writes, only a file's owner replaces it) and the
 * files 0644. Written whole (temp file renamed over), so a reader never sees half a file. tmpfs: gone at the
 * head unit's next start, which is what "for this drive" means.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.WOODY_SHM || '/dev/shm/woody';

function folder() {
    try { fs.mkdirSync(DIR); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { fs.chmodSync(DIR, 0o1777); } catch (e) { /* made by another app: it opened it */ }
}

function write(name, obj) {
    try {
        folder();
        const f = path.join(DIR, name), tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.assign({ at: Date.now() }, obj)));
        try { fs.chmodSync(tmp, 0o644); } catch (e) { /* best effort */ }
        fs.renameSync(tmp, f);
        return true;
    } catch (e) { return false; }
}

/** the object, or null when missing / unreadable / older than maxAgeMs (if given) */
function read(name, maxAgeMs) {
    try {
        const f = path.join(DIR, name);
        if (maxAgeMs && Date.now() - fs.statSync(f).mtime.getTime() > maxAgeMs) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { return null; }
}

module.exports = { write: write, read: read, DIR: DIR };
