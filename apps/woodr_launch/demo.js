'use strict';
/**
 * demo.js - a simulated car for demo mode: it stands staged, and once the tree is armed it leaves a little
 * after green, pulls through the gears past the quarter mile, brakes to a stop and stages again.
 * No kit imports and no clock of its own (step(t) takes the time), so tools/test_launch.js can drive it.
 *
 * The numbers are a plausible fast saloon, not a model of any car: grip-limited to about 0.95 g, then
 * power-limited, eight gears, a short pause in the pull at each shift.
 *
 *   const car = new DemoCar();
 *   car.go(tGreen, Math.random());     the tree was armed: leave 0.18 to 0.40 s after green
 *   car.cancel();                      the tree was cancelled
 *   car.step(t) -> { raw, rpm, gear, stage }     raw = speed in 1/64 km/h, as the car's signal counts
 */
const RATIOS = [0, 5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.822, 0.64];
const FINAL = 3.15, WHEEL_M = 2.07;            /* final drive, tyre circumference */
const MASS = 1880, POWER = 300000, GRIP = 9.3; /* kg, W at the wheels, m/s2 */
const REDLINE = 7000, IDLE = 850, HOLD_RPM = 2800;
const STOP_AFTER_M = 430;                      /* brake a little past the quarter mile (402 m) */

const rpmFor = (v, g) => v / WHEEL_M * 60 * RATIOS[g] * FINAL;

class DemoCar {
    constructor() { this.power = POWER; this.grip = GRIP; this.reset(); }

    reset() {
        this.v = 0; this.d = 0; this.gear = 1; this.phase = 'staged';
        this.goAt = null; this.last = null; this.shiftUntil = 0; this.rpm = IDLE;
    }

    go(tGreen, rnd) {
        if (this.phase !== 'staged') return;
        this.goAt = tGreen + 180 + Math.max(0, Math.min(1, rnd || 0)) * 220;
        this.phase = 'wait';
    }

    cancel() { if (this.phase === 'wait') { this.phase = 'staged'; this.goAt = null; } }

    _advance(t, dt) {
        if (this.phase === 'wait' && t >= this.goAt) { this.phase = 'pull'; this.v = 0; this.d = 0; this.gear = 1; }
        if (this.phase === 'pull') {
            const v = Math.max(this.v, 0.5);
            let a = Math.min(this.grip, this.power / (MASS * v)) - 0.46 * v * v / MASS - 0.15;
            if (t < this.shiftUntil) a = 0.6;
            this.v += a * dt;
            this.d += this.v * dt;
            if (rpmFor(this.v, this.gear) > REDLINE && this.gear < 8) { this.gear++; this.shiftUntil = t + 110; }
            if (this.d > STOP_AFTER_M) this.phase = 'brake';
        } else if (this.phase === 'brake') {
            this.v = Math.max(0, this.v - 9.5 * dt);
            this.d += this.v * dt;
            while (this.gear > 1 && rpmFor(this.v, this.gear) < 1800) this.gear--;
            if (this.v === 0) { this.phase = 'staged'; this.goAt = null; this.gear = 1; }
        }
        const road = rpmFor(this.v, this.gear);
        if (this.phase === 'pull') this.rpm = Math.min(REDLINE + 40, Math.max(road, 3200));
        else if (this.phase === 'wait') this.rpm = HOLD_RPM;
        else this.rpm = Math.max(IDLE, road);
    }

    step(t) {
        if (this.last === null) this.last = t;
        let left = Math.min(500, Math.max(0, t - this.last));
        let at = t - left;
        while (left > 0) {
            const h = Math.min(4, left);
            at += h; left -= h;
            this._advance(at, h / 1000);
        }
        this.last = t;
        return { raw: Math.round(this.v * 3.6 * 64), rpm: this.rpm, gear: this.gear, stage: 'D', phase: this.phase };
    }
}

module.exports = { DemoCar };
