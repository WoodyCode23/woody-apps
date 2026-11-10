'use strict';
/**
 * Tyre pressures and temperatures from TPMS (de.bmw.infotainment.vehicle.TPMS).
 *
 * BMW's own apps READ these fields rather than subscribe (x_call only reads TPMS; see Live Data's
 * signals.js), so they are polled every 10 s through signals.watch's pollMs.
 * Scaling, as Live Data has it: pressure raw * 0.1 bar (>= 65532 = none); temperature raw - 40 C
 * (65535 = none; kept to -40..150).
 */
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const CORNERS = ['FLH', 'FRH', 'RLH', 'RRH'];
const num = (v) => typeof v === 'number' && isFinite(v);

class Tyres {
    constructor(ctx) { this.ctx = ctx; this.p = {}; this.t = {}; this.target = {}; this.at = 0; }

    start() {
        const pr = (raw) => (num(raw) && raw < 65532 ? raw * 0.1 : null);
        const tc = (raw) => (num(raw) && raw !== 65535 && raw - 40 >= -40 && raw - 40 <= 150 ? raw - 40 : null);
        return this.ctx.signals.watch(TPMS, '1', {
            statusTyrePressure: (v) => { CORNERS.forEach((c) => { this.p[c] = pr(v && v['actualValuePressureTyre' + c]); }); this.at = Date.now(); },
            statusTyreTemperature: (v) => { CORNERS.forEach((c) => { this.t[c] = tc(v && v['actualValueTemperatureTyre' + c]); }); this.at = Date.now(); },
            statusTargetTyrePressure: (v) => { CORNERS.forEach((c) => { this.target[c] = pr(v && v['targetPressureTyre' + c]); }); },
        }, this.ctx.log, { pollMs: 10000 }).then((s) => { if (s && s.error) this.ctx.log.warn('tpms: ' + s.error); return s; });
    }

    /** { minT, minCorner, lowest: { corner, p, target } (largest shortfall), corners } - stale after 60 s */
    snapshot() {
        if (!this.at || Date.now() - this.at > 60000) return {};
        let minT = null, minCorner = null, lowest = null, worst = -Infinity;
        CORNERS.forEach((c) => {
            if (num(this.t[c]) && (minT === null || this.t[c] < minT)) { minT = this.t[c]; minCorner = c; }
            if (num(this.p[c]) && num(this.target[c]) && this.target[c] - this.p[c] > worst) {
                worst = this.target[c] - this.p[c]; lowest = { corner: c, p: this.p[c], target: this.target[c] };
            }
        });
        return { minT: minT, minCorner: minCorner, lowest: lowest,
                 corners: CORNERS.map((c) => ({ c: c, p: this.p[c], t: this.t[c], target: this.target[c] })) };
    }
}

module.exports = { Tyres: Tyres, CORNERS: CORNERS };
