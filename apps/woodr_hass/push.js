'use strict';
/**
 * push.js - the car's state into Home Assistant, so HA-side automations can use it.
 *
 * Two ways, and the webhook is the one to prefer:
 *
 *   1. Webhook (cfg.push.webhook): POST /api/webhook/<id> with a JSON body. One HTTP request
 *      carries every value at once, the webhook needs no authentication (the id is the secret),
 *      and on the HA side a single automation with a `webhook` trigger fans the values out into
 *      template sensors or input_numbers. Cheapest on the car and tidiest in HA.
 *
 *   2. Service calls: for each value, a call to a helper's set service
 *      (input_number.set_value / input_text.set_value). Simple to set up with no YAML, but one
 *      request per value and the helpers have to exist first. Used when no webhook is given.
 *
 * What is sent (nothing is sent that the app does not already read for its own screens; this is
 * read-only on the car's side - signals in, HTTP out):
 *
 *   speed_kmh, rpm, coolant_c, oil_c, gear, stage (P/R/N/D), condition (BMW's vehicle state
 *   number; 10 = drive-ready), moving (bool), ts (ms).
 *
 * Location is NOT included. The kit's signal groups (kit/runtime/car.js) cover rpm, temps,
 * speed, accel, gear, torque and condition - there is no position group, so GPS would mean
 * finding and declaring a navigation interface that has not been verified on this car. The HA
 * companion app on the driver's phone is the better source of location anyway. See
 * OPEN_QUESTIONS.md.
 *
 * Rate: settings "pushEvery" seconds, halved while the car is moving when "pushMoving" is on,
 * and a value that has not changed meaningfully is not resent (the webhook body is compared).
 */
const EventEmitter = require('events');

const MOVING_KMH = 2;
const r1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
const r0 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);

class Push extends EventEmitter {
    constructor(ctx, ha, cfg) {
        super();
        this.ctx = ctx;
        this.settings = ctx.settings;
        this.log = ctx.log;
        this.ha = ha;
        this.cfg = cfg;
        this.timer = null;
        this.last = '';
        this.lastAt = 0;
        this.sent = 0;
        this.failed = 0;
        this.error = '';
        this.car = null;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this._maybe(), 1000);
        if (this.timer.unref) this.timer.unref();
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** Latest car reading, from kit/car.js data(). */
    feed(d) { this.car = d; }

    status() {
        return {
            on: this.settings.get('pushCar') === true,
            how: this.cfg.push && this.cfg.push.webhook ? 'webhook ' + this.cfg.push.webhook : 'service calls',
            sent: this.sent, failed: this.failed, error: this.error,
            lastAt: this.lastAt,
        };
    }

    body() {
        const d = this.car || {};
        const moving = typeof d.speed === 'number' && d.speed > MOVING_KMH;
        return {
            source: (this.cfg.push && this.cfg.push.prefix) || 'bmw',
            ts: Date.now(),
            speed_kmh: r1(d.speed),
            rpm: r0(d.rpm),
            coolant_c: r0(d.coolant),
            oil_c: r0(d.oil),
            gear: typeof d.gear === 'number' ? d.gear : null,
            stage: d.stage || null,
            condition: typeof d.condition === 'number' ? d.condition : null,
            moving: moving,
        };
    }

    _periodMs() {
        const base = Math.max(5, Number(this.settings.get('pushEvery')) || 30) * 1000;
        const d = this.car || {};
        const moving = typeof d.speed === 'number' && d.speed > MOVING_KMH;
        return moving && this.settings.get('pushMoving') !== false ? Math.max(5000, base / 2) : base;
    }

    _maybe() {
        if (this.settings.get('pushCar') !== true) return;
        if (!this.car) return;
        if (Date.now() - this.lastAt < this._periodMs()) return;
        const body = this.body();
        /* ts always differs, so compare everything else: an unchanged parked car sends nothing. */
        const key = JSON.stringify(Object.assign({}, body, { ts: 0 }));
        if (key === this.last && Date.now() - this.lastAt < 300000) return;
        this.last = key;
        this.lastAt = Date.now();
        this.send(body);
    }

    /** Send one reading now. Returns a Promise that never rejects. */
    send(body) {
        const b = body || this.body();
        const hook = this.cfg.push && this.cfg.push.webhook;
        const done = (ok, why) => {
            if (ok) { this.sent++; this.error = ''; } else { this.failed++; this.error = why; this.log.warn('push: ' + why); }
            this.emit('pushed', ok);
        };
        if (hook) {
            return this.ha.rest('POST', '/api/webhook/' + encodeURIComponent(hook), b, { timeout: 8000 })
                .then(() => done(true)).catch((e) => done(false, e.message));
        }
        const prefix = (this.cfg.push && this.cfg.push.prefix) || 'bmw';
        const numbers = { speed_kmh: b.speed_kmh, rpm: b.rpm, coolant_c: b.coolant_c, oil_c: b.oil_c };
        const calls = Object.keys(numbers)
            .filter((k) => numbers[k] !== null)
            .map((k) => this.ha.call('input_number', 'set_value',
                { entity_id: 'input_number.' + prefix + '_' + k, value: numbers[k] }));
        if (b.stage) {
            calls.push(this.ha.call('input_text', 'set_value',
                { entity_id: 'input_text.' + prefix + '_stage', value: b.stage }));
        }
        return Promise.all(calls).then(() => done(true)).catch((e) => done(false, e.message));
    }
}

module.exports = { Push, MOVING_KMH };
