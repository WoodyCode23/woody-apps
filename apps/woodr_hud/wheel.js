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
 *   statusRotarySteps.operationStepsKnurlSteeringWheel               127 at rest, 127 + steps while it is rolled
 *
 *   const w = new Wheel(ctx, { onMenu: () => ..., onRoll: (steps) => ... }); await w.start();
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const REST = 127;

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
                /* Not a counter: the value rests at 127 and shows each movement as 127 + steps (128 = one step
                 * one way, 126 = one the other, 132 = five at once), then goes back to 127. Seen on the car:
                 * 126,125,127,126,127,128,127,128,129,128,127,128,132,127 (Input Lab 2026-11-10). */
                const n = v && v.operationStepsKnurlSteeringWheel;
                if (typeof n !== 'number' || n === 255 || n === REST) return;
                this._call('onRoll', n - REST);
            },
        }, this.ctx.log);
        if (sub && sub.error) { this.error = sub.error; this.ctx.log.warn('wheel: ' + sub.error); }
        return !this.error;
    }

    _call(name, arg) { try { if (this.on[name]) this.on[name](arg); } catch (e) { this.ctx.log.warn('wheel ' + name + ': ' + e); } }
}

module.exports = { Wheel: Wheel };
