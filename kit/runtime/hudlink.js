'use strict';
/**
 * hudlink.js - every app's switches and choices, offered to the head-up display's menu.
 *
 * The kit calls serve() for every app it runs, so an app needs to do nothing: each "bool" and "choice" setting
 * in its app.json shows up in the HUD menu under the app's name, with its current value, and can be changed
 * from the steering wheel. Leave one out with "hud": false in app.json (one-shot buttons such as "Test the
 * doorbell now", or anything that should only be changed on the centre screen). Name it differently on the
 * display with "hudLabel": "Short name". "hud": false at the top of app.json keeps the whole app out.
 *
 * How (the same small-files pattern as shared.js; each app is its own user, the folder is 1777, files 0644):
 *
 *   /dev/shm/woody/hud/<app id>.json       written by the app, again on every change and every BEAT_MS:
 *       { id, title, version, at, items: [{ key, label, type: 'bool' | 'choice', value, options: [[value, label]] }] }
 *   /dev/shm/woody/hud/<app id>.req.json   written by the HUD menu: { n, key, value, at }
 *
 * The app applies a request only when its key is one it offers and its value is valid for it (true / false, or
 * one of the options), then publishes again; anything else is ignored. A request is a settings change and nothing
 * more: actions (doors, cameras, saving a clip) are not settings and do not travel this way, because any app on
 * the unit could write a request file. tmpfs: the folder is empty after a head-unit start and fills as apps start.
 *
 *   App side (the kit):   hudlink.serve(spec, settings, log)
 *   HUD side:             hudlink.apps()                      -> [{ id, title, version, items }] of running apps
 *                         hudlink.request(id, key, value)     -> true when the request was written
 *                         hudlink.next(item)                  -> the value one press moves to
 *
 * Node 8 on the car. Nothing here throws out of a timer.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.WOODY_SHM || '/dev/shm/woody';
const DIR = path.join(ROOT, 'hud');
const BEAT_MS = 10000;                /* an app says "still here" this often */
const POLL_MS = 400;                  /* how often an app looks for a request */
const STALE_MS = 35000;               /* an app not heard from for this long is not listed */
const REQ_MAX_AGE_MS = 5000;          /* a request older than this is never applied */
/* what the HUD takes from another app's file, whatever that file holds: any app on the unit can write one */
const MAX_FILE = 64 * 1024, MAX_ITEMS = 40, MAX_OPTIONS = 12, MAX_TITLE = 40, MAX_LABEL = 48, MAX_OPTION = 32, MAX_KEY = 64;

function folder() {
    [ROOT, DIR].forEach((d) => {
        try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        try { fs.chmodSync(d, 0o1777); } catch (e) { /* made by another app: it opened it */ }
    });
}

function writeWhole(file, obj) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { fs.chmodSync(tmp, 0o644); } catch (e) { /* best effort */ }
    fs.renameSync(tmp, file);
}

/**
 * A file another app wrote, or null. Opened once and judged by what was opened: not followed if it is a link,
 * never waited on if it is a pipe, only a regular file, and at most MAX_FILE bytes are ever read, so a file
 * swapped or grown between a check and a read gains nothing.
 */
function readJson(file) {
    let fd = -1;
    try {
        const C = fs.constants || {};
        fd = fs.openSync(file, (C.O_RDONLY || 0) | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_FILE) return null;
        const buf = Buffer.alloc(MAX_FILE + 1);
        let n = 0;
        for (;;) {
            const got = fs.readSync(fd, buf, n, buf.length - n, null);
            if (got <= 0) break;
            n += got;
            if (n > MAX_FILE) return null;
        }
        return JSON.parse(buf.toString('utf8', 0, n));
    } catch (e) { return null; }
    finally { if (fd >= 0) { try { fs.closeSync(fd); } catch (e) { /* closed */ } } }
}

const cut = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
const plain = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** One item from another app's file, cut to size and to the fields the menu uses, or null when it is not usable. */
function clean(it) {
    if (!it || typeof it.key !== 'string' || !it.key || it.key.length > MAX_KEY) return null;
    if (it.type === 'bool') return { key: it.key, label: cut(it.label || it.key, MAX_LABEL), type: 'bool', value: it.value === true };
    if (it.type !== 'choice' || !Array.isArray(it.options)) return null;
    const options = it.options.slice(0, MAX_OPTIONS).filter((o) => Array.isArray(o) && plain(o[0])).map((o) => [typeof o[0] === 'string' ? cut(o[0], MAX_KEY) : o[0], cut(o[1] === undefined ? o[0] : o[1], MAX_OPTION)]);
    if (!options.length) return null;
    return { key: it.key, label: cut(it.label || it.key, MAX_LABEL), type: 'choice', value: plain(it.value) ? it.value : null, options: options };
}

const safeId = (id) => /^[a-z0-9_]{1,64}$/.test(String(id));

/** The settings of a schema the HUD may show, as items with their current values. */
function offered(schema, settings) {
    return (schema || []).filter((s) => s && s.key && (s.type === 'bool' || s.type === 'choice') && s.hud !== false && !s.hidden
        && (typeof settings.shown !== 'function' || settings.shown(s))
        && (s.type === 'bool' || (Array.isArray(s.options) && s.options.length > 0)))
        .map((s) => {
            const it = { key: String(s.key), label: String(s.hudLabel || s.label || s.key).slice(0, 48), type: s.type, value: settings.get(s.key) };
            if (s.type === 'choice') it.options = s.options.map((o) => (Array.isArray(o) ? [o[0], String(o[1] === undefined ? o[0] : o[1]).slice(0, 32)] : [o, String(o).slice(0, 32)]));
            return it;
        });
}

/** Is value one this item can take? */
function valid(item, value) {
    if (!item) return false;
    if (item.type === 'bool') return value === true || value === false;
    return (item.options || []).some((o) => o[0] === value);
}

/** The value one press moves an item to: a switch flips, a choice steps to its next option and wraps. */
function next(item) {
    if (!item) return undefined;
    if (item.type === 'bool') return !item.value;
    const opts = item.options || [];
    if (!opts.length) return item.value;
    const i = opts.findIndex((o) => o[0] === item.value);
    return opts[(i + 1) % opts.length][0];
}

/**
 * App side. Publishes this app's switches and choices and applies the HUD's requests to its settings.
 * Returns { stop, publish } (or null where there is no shared folder: the PC preview, a read-only unit).
 */
function serve(spec, settings, log) {
    if (!spec || !safeId(spec.id) || !settings || spec.hud === false) return null;
    const warn = (m) => { try { if (log && log.warn) log.warn('hudlink: ' + m); } catch (e) { /* no log */ } };
    try { folder(); } catch (e) { return null; }
    const file = path.join(DIR, spec.id + '.json'), reqFile = path.join(DIR, spec.id + '.req.json');
    const started = Date.now();
    let lastN = null, lastText = '', lastBeat = 0;

    const publish = (force) => {
        try {
            const items = offered(spec.settings, settings);
            const text = JSON.stringify(items);
            const now = Date.now();
            if (!force && text === lastText && now - lastBeat < BEAT_MS) return;
            lastText = text; lastBeat = now;
            writeWhole(file, { id: spec.id, title: String(spec.title || spec.id).slice(0, 40), version: String(spec.version || ''), at: now, items: items });
        } catch (e) { warn('publish: ' + e.message); }
    };

    const poll = () => {
        try {
            const r = readJson(reqFile);
            if (r && r.n !== lastN) {
                lastN = r.n;
                const now = Date.now();
                /* only a request made while this app ran, and made just now: never one left from before */
                if (typeof r.at === 'number' && r.at >= started && now - r.at <= REQ_MAX_AGE_MS && now >= r.at - 1000) {
                    const item = offered(spec.settings, settings).filter((x) => x.key === r.key)[0];
                    if (valid(item, r.value)) { if (item.value !== r.value) settings.set(item.key, r.value); }
                    else warn('request ignored: ' + String(r.key).slice(0, 40));
                }
            }
        } catch (e) { warn('poll: ' + e.message); }
        publish(false);      /* also picks up a change made on the centre screen */
    };

    publish(true);
    const timer = setInterval(poll, POLL_MS);
    if (timer.unref) timer.unref();
    return {
        publish: () => publish(true),
        stop: () => { clearInterval(timer); try { fs.unlinkSync(file); } catch (e) { /* already gone */ } },
    };
}

/** HUD side: the running apps that offer something, sorted by title. `except` leaves one app id out (the HUD itself). */
function apps(except) {
    let names;
    try { names = fs.readdirSync(DIR); } catch (e) { return []; }
    const now = Date.now(), out = [];
    names.forEach((name) => {
        if (!/^[a-z0-9_]{1,64}\.json$/.test(name) || /\.req\.json$/.test(name)) return;
        const a = readJson(path.join(DIR, name));
        if (!a || a.id !== name.slice(0, -5) || a.id === except || !Array.isArray(a.items) || !a.items.length) return;
        if (typeof a.at !== 'number' || now - a.at > STALE_MS) return;
        const items = a.items.slice(0, MAX_ITEMS).map(clean).filter(Boolean);
        if (items.length) out.push({ id: a.id, title: cut(a.title || a.id, MAX_TITLE), version: cut(a.version, 20), items: items });
    });
    return out.sort((x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0));
}

let counter = 0;
/** HUD side: ask app `id` to set `key` to `value`. The app decides; read apps() again to see what it did. */
function request(id, key, value) {
    if (!safeId(id)) return false;
    try {
        folder();
        writeWhole(path.join(DIR, id + '.req.json'), { n: process.pid + '-' + Date.now() + '-' + (counter++), key: String(key), value: value, at: Date.now() });
        return true;
    } catch (e) { return false; }
}

module.exports = { serve: serve, apps: apps, request: request, next: next, offered: offered, valid: valid, DIR: DIR, STALE_MS: STALE_MS };
