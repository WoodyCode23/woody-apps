'use strict';
/**
 * wheel.js - the press of the steering wheel's right-hand roller, as a second way to arm the tree.
 * Listens only: the car does with the press what it always does.
 *
 * Source: de.bmw.infotainment.controlelements.SteeringWheelPushButton
 *   statusRotaryPress.operationPushButtonKnurlSteeringWheel     RAENDELRAD_GEDRUECKT (1) while pressed
 *
 *   const w = new Wheel(ctx, () => ...); await w.start();       false when the car does not offer it
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';

class Wheel {
    constructor(ctx, onPress) { this.ctx = ctx; this.onPress = onPress; this.down = false; this.error = null; }

    async start() {
        let sub = null;
        try {
            sub = await this.ctx.signals.watch(IFACE, '1', {
                statusRotaryPress: (v) => {
                    try {
                        const s = v && v.operationPushButtonKnurlSteeringWheel;
                        const down = s === 'RAENDELRAD_GEDRUECKT' || s === 1;
                        if (down && !this.down && this.onPress) this.onPress();
                        this.down = down;
                    } catch (e) { this.ctx.log.warn('wheel press: ' + e); }
                },
            }, this.ctx.log);
        } catch (e) { this.error = String(e && e.message || e); }
        if (sub && sub.error) this.error = sub.error;
        if (this.error) this.ctx.log.warn('wheel: ' + this.error);
        return !this.error;
    }
}

module.exports = { Wheel: Wheel };
