'use strict';
/**
 * taps.js - count taps of the high-beam-assistant button (left stalk) and report the count when they stop.
 *
 * The head unit only listens: every press still does what the car does with it (toggle the assistant). An EVEN
 * number of taps toggles it back to where it was, so even counts are free to mean something here:
 *   2 taps -> next colour,  4 taps -> rev-follow on/off.  Odd counts are left to the car alone.
 *
 * Source: de.bmw.body.Light IndicatorSteeringColumnComplete.statusPushButtonMainBeamAssistant
 * (TASTER_GEDRUECKT = pressed, KEINE_BETAETIGUNG = released), seen in Input Lab on this car.
 *
 *   const t = new Taps(ctx, (count) => ...); await t.start();
 */
const IFACE = 'de.bmw.body.Light';
const GAP_MS = 650;                  /* a tap this long after the last one starts a new series */

class Taps {
    constructor(ctx, onSeries) {
        this.ctx = ctx; this.onSeries = onSeries;
        this.count = 0; this.timer = null; this.down = false; this.error = null; this.lastStalk = 0;
    }

    async start() {
        const sub = await this.ctx.signals.watch(IFACE, '1', {
            IndicatorSteeringColumnComplete: (v) => this._edge(v),
        }, this.ctx.log);
        if (sub && sub.error) { this.error = sub.error; this.ctx.log.warn('taps: ' + sub.error); }
        return !this.error;
    }

    _edge(v) {
        const s = v && v.statusPushButtonMainBeamAssistant;
        const pressed = s === 'TASTER_GEDRUECKT' || s === 1;
        if (pressed && !this.down) {
            this.count++;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this._done(), GAP_MS);
        }
        this.down = pressed;
    }

    _done() {
        const n = this.count; this.count = 0; this.timer = null;
        if (n >= 2 && n % 2 === 0) {
            this.ctx.log.info('taps: ' + n);
            try { this.onSeries(n); } catch (e) { this.ctx.log.warn('taps handler: ' + e); }
        }
    }

    stop() { clearTimeout(this.timer); }
}

module.exports = { Taps: Taps, GAP_MS: GAP_MS };
