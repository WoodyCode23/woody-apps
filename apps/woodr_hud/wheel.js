'use strict';
/**
 * wheel.js - the steering wheel's menu button (the one with three lines, "special function" in the interface) and the
 * right-hand roller, as the HUD menu's controls. Listens only: the car does with them what it always does.
 *
 *   On this car (Input Lab, 2026-11-10): the menu button opens BMW's list on the HUD; rolling the roller scrolls it;
 *   pressing the roller picks in it (so it is NOT used here: that would also pick in BMW's list).
 *
 * Source: de.bmw.infotainment.controlelements.SteeringWheelPushButton
 *   statusSpecialFunctionButton.operationPushButtonSpecialFunction   TASTER_GEDRUECKT (1) / KEINE_AKTION (0)
 *   statusRotarySteps.operationStepsKnurlSteeringWheel               a counter (0-255) that moves by the steps rolled
 *
 *   const w = new Wheel(ctx, { onMenu: () => ..., onRoll: (steps) => ... }); await w.start();
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';

class Wheel {
    constructor(ctx, on) { this.ctx = ctx; this.on = on || {}; this.menuDown = false; this.lastSteps = null; this.error = null; }

    async start() {
        const sub = await this.ctx.signals.watch(IFACE, '1', {
            statusSpecialFunctionButton: (v) => {
                const s = v && v.operationPushButtonSpecialFunction;
                const down = s === 'TASTER_GEDRUECKT' || s === 1;
                if (down && !this.menuDown) this._call('onMenu');
                this.menuDown = down;
            },
            statusRotarySteps: (v) => {
                const n = v && v.operationStepsKnurlSteeringWheel;
                if (typeof n !== 'number' || n === 255) return;
                if (this.lastSteps !== null) {
                    let d = n - this.lastSteps;
                    if (d > 127) d -= 256; else if (d < -127) d += 256;      /* the counter wraps */
                    if (d) this._call('onRoll', d);
                }
                this.lastSteps = n;
            },
        }, this.ctx.log);
        if (sub && sub.error) { this.error = sub.error; this.ctx.log.warn('wheel: ' + sub.error); }
        return !this.error;
    }

    _call(name, arg) { try { if (this.on[name]) this.on[name](arg); } catch (e) { this.ctx.log.warn('wheel ' + name + ': ' + e); } }
}

module.exports = { Wheel: Wheel };
