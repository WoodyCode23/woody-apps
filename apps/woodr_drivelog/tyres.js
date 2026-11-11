'use strict';
/**
 * Tyre pressures and temperatures from TPMS (de.bmw.infotainment.vehicle.TPMS).
 *
 * The TPMS sends both in the car's DISPLAY units (Vehicle.statusNewCurrentUnitsStatusExt, as BMW's own x_call
 * reads them; Car Vitals found the same): pressure = raw x 0.1 in bar, kPa or psi, temperature = raw - 40 in
 * deg C or deg F. Measured on this car (set to psi / deg F), 2026-11-10: pressures raw 320-330 (32-33 psi),
 * targets 320 / 350-370 (32 / 35-37 psi), temperature raw 81 (41 F). Read as bar / deg C that was 537 psi and
 * 41 C. Everything here is returned in bar and deg C.
 *
 * Until the car says its units, each unit's plausible tyre pressure lies apart (bar 0.5-6, psi 7-60,
 * kPa 60-600), so only one fits; psi then also means deg F.
 *
 * BMW's own apps READ TPMS rather than subscribe, so it is polled every 10 s through signals.watch's pollMs.
 */
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
const CORNERS = ['FLH', 'FRH', 'RLH', 'RRH'];
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const num = (v) => typeof v === 'number' && isFinite(v);
const unitName = (map, v) => (map[v] || (Object.keys(map).map((k) => map[k]).indexOf(v) >= 0 ? v : null));

class Tyres {
    constructor(ctx) {
        this.ctx = ctx; this.p = {}; this.t = {}; this.target = {}; this.at = 0;
        this.units = { press: null, temp: null, psiSeen: false };
        this.raw = { p: {}, t: {}, target: {} };           /* kept raw, so a unit learnt later re-reads them */
    }

    /** raw -> bar */
    _bar(raw) {
        if (!num(raw) || raw >= 65532 || raw <= 0) return null;
        const v = raw * 0.1;
        const k = TO_BAR[this.units.press];
        if (k) return v * k;
        if (v >= 0.5 && v <= 6) return v;
        if (v >= 7 && v < 60) { this.units.psiSeen = true; return v / 14.5038; }
        if (v >= 60 && v <= 600) return v / 100;
        return null;
    }

    /** raw -> deg C */
    _degC(raw) {
        if (!num(raw) || raw === 65535) return null;
        const v = raw - 40;
        const f = this.units.temp ? this.units.temp === 'F' : this.units.psiSeen;
        const c = f ? (v - 32) * 5 / 9 : v;
        return c >= -40 && c <= 150 ? c : null;
    }

    _redo() {
        CORNERS.forEach((c) => {
            this.p[c] = this._bar(this.raw.p[c]);
            this.target[c] = this._bar(this.raw.target[c]);
            this.t[c] = this._degC(this.raw.t[c]);
        });
    }

    start() {
        const log = this.ctx.log;
        this.ctx.signals.watch(VEHICLE, '1', {
            statusNewCurrentUnitsStatusExt: (v) => {
                const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
                if (press === this.units.press && temp === this.units.temp) return;
                this.units.press = press; this.units.temp = temp;
                log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
                this._redo();
            },
        }, log).then((s) => { if (s && s.error) log.warn('units: ' + s.error); });
        return this.ctx.signals.watch(TPMS, '1', {
            statusTyrePressure: (v) => { CORNERS.forEach((c) => { this.raw.p[c] = v && v['actualValuePressureTyre' + c]; }); this._redo(); this.at = Date.now(); },
            statusTyreTemperature: (v) => { CORNERS.forEach((c) => { this.raw.t[c] = v && v['actualValueTemperatureTyre' + c]; }); this._redo(); this.at = Date.now(); },
            statusTargetTyrePressure: (v) => {
                CORNERS.forEach((c) => { this.raw.target[c] = v && v['targetPressureTyre' + c]; });
                this._redo();
                log.info('tpms target raw ' + CORNERS.map((c) => this.raw.target[c]).join('/') + ' -> bar ' + CORNERS.map((c) => (num(this.target[c]) ? this.target[c].toFixed(2) : '-')).join('/'));
            },
        }, log, { pollMs: 10000 }).then((s) => { if (s && s.error) log.warn('tpms: ' + s.error); return s; });
    }

    /** { minT, minCorner, lowest: { corner, p, target } (largest shortfall), corners } in bar / deg C - stale after 60 s */
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

/**
 * The units to show: a setting of 'car' (the default) follows the car's own display units, else the setting.
 *   -> { temp: 'c' | 'f', press: 'psi' | 'bar' | 'kpa' }
 */
function shownUnits(settings, carUnits) {
    const u = carUnits || {};
    let temp = settings.get('tempUnit') || 'car', press = settings.get('pressureUnit') || 'car';
    if (temp === 'car') temp = u.temp === 'F' || (!u.temp && u.psiSeen) ? 'f' : u.temp === 'C' ? 'c' : 'c';
    if (press === 'car') press = u.press === 'PSI' || (!u.press && u.psiSeen) ? 'psi' : u.press === 'KPA' ? 'kpa' : u.press === 'BAR' ? 'bar' : 'psi';
    return { temp: temp, press: press };
}

/** bar -> text in the unit */
function presText(bar, unit) {
    if (typeof bar !== 'number' || !isFinite(bar)) return '--';
    return unit === 'bar' ? bar.toFixed(1) + ' bar' : unit === 'kpa' ? Math.round(bar * 100) + ' kPa' : Math.round(bar * 14.5038) + ' psi';
}

module.exports = { Tyres: Tyres, CORNERS: CORNERS, shownUnits: shownUnits, presText: presText };
