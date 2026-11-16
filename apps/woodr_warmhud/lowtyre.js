'use strict';
/**
 * lowtyre.js - when the low-tyre warning is on the head-up display.
 *
 * A tyre below its target is worth saying, not worth saying for a whole drive: on a cold morning every tyre sits a
 * few psi under the target the car holds for warm tyres, and a warning that never leaves is one the driver learns
 * to ignore (and it hid everything else Warm-Up HUD had to show). So it shows for SHOW_MS when a tyre is first
 * found low, again each time that tyre has lost another AGAIN_BAR, and starts over once the tyres are back up.
 *
 *   const low = new LowTyre();
 *   low.show(shortfall, warn, now) -> true while the warning belongs on the display
 *     shortfall: target minus pressure of the worst tyre, in bar (null when unknown); warn: the setting, 0 = off
 */
const SHOW_MS = 20000, AGAIN_BAR = 0.1;

class LowTyre {
    constructor() { this.until = 0; this.level = null; }
    show(shortfall, warn, now) {
        if (!(warn > 0) || typeof shortfall !== 'number' || !isFinite(shortfall) || shortfall < warn) {
            /* back up (with a little room, so a reading on the line does not flap), or switched off: start over */
            if (!(warn > 0) || (typeof shortfall === 'number' && shortfall < warn - 0.03)) { this.level = null; this.until = 0; }
            return false;
        }
        if (this.level === null || shortfall >= this.level + AGAIN_BAR) { this.level = shortfall; this.until = now + SHOW_MS; }
        return now < this.until;
    }
}

module.exports = { LowTyre: LowTyre, SHOW_MS: SHOW_MS, AGAIN_BAR: AGAIN_BAR };
