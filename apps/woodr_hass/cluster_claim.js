'use strict';
/**
 * cluster_claim.js - who is drawing on a cluster-render target right now.
 *
 * kit/runtime/hud_claim.js is the kit's convention for the HUD, and there is no equivalent for
 * the cluster's `map` and `panel` targets (checked: hud_claim.js is the only claim module in the
 * kit). This is the same idea widened to any target, so an app can tell a co-tenant (Waze on the
 * cluster) from an empty slot before it decides whether to contend with the stock HMI:
 *
 *   /dev/shm/mgu-cluster/<target>/<appId>     {"held":true,"at":<ms>,"role":"<role>"}
 *
 * touched every 2 s, stale after 6 s, on tmpfs so a head-unit start clears it. The folder is
 * opened 1777 like /tmp, as hud_claim does, so every app can write its own file.
 *
 *   const claim = new ClusterClaim('map', 'woodr_hass', log);
 *   claim.hold(true, 'alert');        // I am drawing on map
 *   ClusterClaim.others('map', 'woodr_hass')  -> [{ id, role, age }]
 *
 * This is advisory only. cluster-render itself composites layers from several clients on one
 * target by `class` and `z`, so two apps on `map` is not an error - the claim exists so this app
 * can choose `contend: 0` (never take the slot from BMW) when it is alone and `contend` is only
 * needed because a co-tenant already holds the mapping.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.MGU_CLUSTER_CLAIMS || '/dev/shm/mgu-cluster';
const TOUCH_MS = 2000, FRESH_MS = 6000;

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

function folder(dir) {
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { fs.chmodSync(dir, 0o1777); } catch (e) { /* another app made it: it opened it */ }
}

function dirFor(target) { return path.join(ROOT, String(target).replace(/[^a-z0-9_-]/gi, '')); }

class ClusterClaim {
    constructor(target, id, log) {
        this.target = target;
        this.id = id;
        this.log = log;
        this.dir = dirFor(target);
        this.file = path.join(this.dir, id);
        this.timer = null;
        this.role = '';
        this.failed = false;
    }

    hold(on, role) {
        this.role = role || this.role;
        if (!!on === !!this.timer) return;
        if (on) {
            this._touch();
            this.timer = setInterval(() => this._touch(), TOUCH_MS);
            if (this.timer.unref) this.timer.unref();
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
        try { writeWhole(this.file, JSON.stringify({ held: false, at: Date.now() }) + '\n'); } catch (e) { /* tmpfs gone */ }
    }

    _touch() {
        try {
            folder(ROOT);
            folder(this.dir);
            writeWhole(this.file, JSON.stringify({ held: true, at: Date.now(), role: this.role }) + '\n');
            this.failed = false;
        } catch (e) {
            if (!this.failed && this.log) this.log.warn('cluster claim: ' + e.message);
            this.failed = true;
        }
    }

    /** The other apps holding `target` now: [{ id, role, age }]. */
    static others(target, id) {
        const dir = dirFor(target);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { return []; }
        const now = Date.now();
        const out = [];
        names.forEach((n) => {
            if (n === id || n.indexOf('.tmp') >= 0) return;
            try {
                const f = path.join(dir, n);
                const age = now - fs.statSync(f).mtimeMs;
                if (age >= FRESH_MS) return;
                const j = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (j.held === true) out.push({ id: n, role: j.role || '', age: Math.round(age) });
            } catch (e) { /* half-written or gone */ }
        });
        return out;
    }
}

module.exports = { ClusterClaim, ROOT };
