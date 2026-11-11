'use strict';
/**
 * light.js - the ambient light, written gently on top of the car's own setting.
 *
 * ComfortFunctionIuK.ambientLightInteriorColour, as measured on this car (Ambient Lab, 2026-11-10):
 *   presets 1-12 work (3 red, 10 green, 5/8 blue, 1/2/7 white, 12 pink, 4/6/9/11 others);
 *   brightness offset 0 = off, 128 = dimmer, 254 = brighter than the menu; menu 14 follows the driving mode.
 * A write sets the same thing BMW's own menu sets, so a preset chosen here is simply the car's colour from
 * then on. Temporary effects (rev-follow red, a flash) are always put back to "base": the car's own state
 * as it reported itself before the effect, field for field.
 *
 * At most one write per MIN_GAP_MS; a newer wish replaces one still waiting (latest wins).
 *
 *   const L = new Light(ctx)
 *   await L.start()
 *   L.preset(n) / L.temp(n, bright) / L.back() / L.flash()
 *   L.state -> { own, slot, raw, bright }
 */
const IFACE = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const UNFILLED = 'SIGNAL_UNBEFUELLT';
const MIN_GAP_MS = 1500;
const BRI = 'controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting';
const MENU = 'controlMenuAmbientePanoramicRoofInteriorLighting';

/* Seen on the car 2026-11-11: 4, 6, 9 and 11 are two-tone (the colour low in the cabin, white above). There is
 * no orange or amber preset. A swatch here is a paler tint of the low colour. */
const NAMES = { 1: 'White 1', 2: 'White 2', 3: 'Red', 4: 'Red / white', 5: 'Blue 1', 6: 'Teal / white', 7: 'White 3',
    8: 'Blue 2', 9: 'Blue / white', 10: 'Green', 11: 'Green / white', 12: 'Pink' };
const SWATCH = { 1: '#f4f4f4', 2: '#e8eef8', 3: '#e1001a', 4: '#ff8a94', 5: '#2a6cff', 6: '#7fe0d8', 7: '#fff6e0',
    8: '#1a4dcc', 9: '#8fb0ff', 10: '#2fd27a', 11: '#90e8b8', 12: '#ff4dc4' };

function blank() {
    return {
        [MENU]: UNFILLED,
        controlModeAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlDynamicInteriorLighting: UNFILLED,
        controlDynamicAmbienteInteriorLighting: UNFILLED,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        [BRI]: 255,
    };
}

function slotOf(raw) {
    const m = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = m ? Number(m[1]) : Number(raw);
    return n >= 1 && n <= 12 && Math.round(n) === n ? n : null;
}

class Light {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log;
        this.proxy = null; this.error = null;
        this.state = { own: null, slot: null, raw: {}, seen: 0 };
        this.base = null;            /* the car's own state, captured before a temporary effect */
        this.inEffect = false;
        this.lastWrite = 0; this.pending = null; this.timer = null; this.writes = 0;
    }

    async start() {
        const sub = await this.ctx.signals.watch(IFACE, '1', {
            statusAmbientLightInteriorColour: (v) => {
                this.state.raw = v || {}; this.state.seen++;
                const n = slotOf(v && v.statusMenuAmbientePanoramicRoofInteriorLighting);
                if (n !== null) { this.state.slot = n; if (!this.inEffect) this.state.own = n; }
            },
        }, this.log, { pollMs: 15000 });
        this.proxy = sub && sub.proxy;
        if (sub && sub.error) { this.error = sub.error; this.log.warn('ambient: ' + sub.error); }
        return !!this.proxy;
    }

    /* ---------- writing, paced ---------- */
    _queue(req, why) {
        this.pending = { req: req, why: why };
        if (this.timer) return;
        const go = () => {
            this.timer = null;
            const p = this.pending; this.pending = null;
            if (!p || !this.proxy) return;
            this.lastWrite = Date.now(); this.writes++;
            this.log.info('ambient: ' + p.why);
            Promise.resolve().then(() => this.ctx.signals.set(this.proxy, 'ambientLightInteriorColour', p.req))
                .catch((e) => this.log.warn('ambient write: ' + (e && e.message || e)));
            if (this.pending) this.timer = setTimeout(go, MIN_GAP_MS);
        };
        const wait = this.lastWrite + MIN_GAP_MS - Date.now();
        this.timer = setTimeout(go, Math.max(0, wait));
    }

    /** the request that puts back what the car reported (base), field for field */
    _restoreReq(base) {
        const r = blank();
        const b = base || { own: this.state.own, raw: this.state.raw };
        if (b.own) r[MENU] = 'FARBAUSWAHL_' + b.own;
        Object.keys(b.raw || {}).forEach((k) => {
            const ctl = k.replace(/^status/, 'control');
            if (ctl in r && ctl !== MENU && b.raw[k] !== undefined && b.raw[k] !== null) r[ctl] = b.raw[k];
        });
        return r;
    }

    /** a lasting choice: the car's colour becomes preset n (what its own menu would do) */
    preset(n) {
        if (this.inEffect) { this.inEffect = false; this.base = null; }
        const r = blank(); r[MENU] = 'FARBAUSWAHL_' + n;
        this.state.own = n;
        this._queue(r, 'preset ' + n + ' (' + (NAMES[n] || n) + ')');
    }

    /** a lasting brightness offset (0..254), or back to the menu's (null) */
    brightness(v) {
        const r = blank(); r[BRI] = v === null || v === undefined ? 255 : Math.max(0, Math.min(254, Math.round(v)));
        this._queue(r, 'brightness ' + (v === null ? 'menu' : v));
    }

    /** a temporary effect: preset n (null = keep the colour), brightness (null = keep); back() undoes it */
    temp(n, bright, why) {
        if (!this.inEffect) { this.base = { own: this.state.own, raw: Object.assign({}, this.state.raw) }; this.inEffect = true; }
        const r = blank();
        if (n) r[MENU] = 'FARBAUSWAHL_' + n;
        if (bright !== null && bright !== undefined) r[BRI] = bright;
        this._queue(r, why || ('effect ' + n + '/' + bright));
    }

    back(why) {
        if (!this.inEffect) return;
        const r = this._restoreReq(this.base);
        this.inEffect = false; this.base = null;
        this._queue(r, 'back to your light' + (why ? ' (' + why + ')' : ''));
    }

    /** one flash: off, then back (the light allows a change every 1.5 s, so this is a slow blink) */
    flash() {
        this.temp(null, 0, 'flash off');
        setTimeout(() => this.back('flash'), MIN_GAP_MS + 50);
    }

    /** leaving: never leave a temporary effect on */
    stop() {
        if (this.inEffect && this.proxy) {
            try { this.ctx.signals.set(this.proxy, 'ambientLightInteriorColour', this._restoreReq(this.base)); } catch (e) { /* going */ }
        }
        clearTimeout(this.timer);
    }
}

module.exports = { Light: Light, NAMES: NAMES, SWATCH: SWATCH, slotOf: slotOf, MIN_GAP_MS: MIN_GAP_MS };
