'use strict';
/**
 * M3 Vitals - the handful of numbers worth looking at before and during a drive.
 *
 *   - oil and coolant with an explicit warm-up state (cold / warming / ready)
 *   - rpm, speed and the engaged gear
 *   - 12 V battery charge, which the car reports as a percentage, not volts
 *
 * Read-only: it subscribes to signals and draws them. It writes nothing to the car.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Car = require('./kit/car');

const W = 1600, H = 520;
const MPH = 1.609344;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        // 12 V battery arrives as a charge percentage on statusBattery2; the Car helper has no
        // group for it, so take it through `extra` and keep it ourselves.
        let batt = null;
        const car = new Car(ctx, ['temps', 'rpm', 'speed', 'gear'], {
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: (v) => {
                    const p = v && v.conditionBatteryChargingCondition;
                    // 151 is the invalid marker in BMW's range, not a real 151 %
                    batt = (typeof p === 'number' && p >= 0 && p <= 100) ? p : null;
                },
            },
        });

        const num = (v) => (typeof v === 'number' && isFinite(v));
        const temp = (c) => (!num(c) ? null : settings.get('tempUnit') === 'f' ? c * 9 / 5 + 32 : c);
        const tUnit = () => (settings.get('tempUnit') === 'f' ? 'F' : 'C');
        const spd = (k) => (!num(k) ? null : settings.get('speedUnit') === 'mph' ? k / MPH : k);
        const sUnit = () => (settings.get('speedUnit') === 'mph' ? 'mph' : 'km/h');
        const fmt = (v, d) => (v === null ? '--' : v.toFixed(d === undefined ? 0 : d));

        // warm-up state from oil, falling back to coolant when oil is not reporting yet
        function warmth(t) {
            const ready = Number(settings.get('oilReady')) || 90;
            if (!num(t)) return { label: 'No data', colour: t2 => t2.dim };
            if (t < 50) return { label: 'Cold - take it easy', colour: t2 => t2.warn };
            if (t < ready) return { label: 'Warming up', colour: t2 => t2.accent };
            return { label: 'Ready', colour: () => '#2fd27a' };
        }

        function drawTemps(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'Warm-up');
            const d = car.live;
            const oil = num(d.oil) ? d.oil : null;
            const w = warmth(oil !== null ? oil : d.coolant);

            cv.text(w.label, 48, 132, 44, w.colour(t), { font: 'bold' });

            const row = (label, celsius, y) => {
                cv.text(label, 48, y, 26, t.dim);
                const v = temp(celsius);
                cv.text(fmt(v, 1) + ' ' + String.fromCharCode(176) + tUnit(), 300, y, 40,
                    v === null ? t.dim : t.text, { font: 'bold' });
            };
            row('Oil', oil, 230);
            row('Coolant', num(d.coolant) ? d.coolant : null, 300);

            cv.text('Oil is the one that matters before you use the revs.', 48, 380, 20, t.dim);
        }

        function drawDrive(cv, t) {
            G.panel(cv, t, 804, 44, 772, 468, 'Drivetrain');
            const d = car.live;

            const rpm = num(d.rpm) ? d.rpm : null;
            cv.text(rpm === null ? '--' : String(Math.round(rpm)), 828, 140, 56, t.text, { font: 'bold' });
            cv.text('rpm', 828 + (rpm === null ? 60 : 170), 140, 24, t.dim);

            const v = spd(d.speed);
            cv.text(fmt(v), 1180, 140, 56, v === null ? t.dim : t.text, { font: 'bold' });
            cv.text(sUnit(), 1180 + 120, 140, 24, t.dim);

            const gear = num(d.gear) ? String(d.gear) : (car.guessed ? String(car.guessed) + '?' : '--');
            cv.text('Gear', 828, 230, 26, t.dim);
            cv.text(gear, 1000, 230, 40, t.text, { font: 'bold' });

            cv.text('12 V battery', 828, 300, 26, t.dim);
            const bc = batt === null ? t.dim : batt < 50 ? t.warn : t.text;
            cv.text(batt === null ? '--' : Math.round(batt) + ' %', 1000, 300, 40, bc, { font: 'bold' });

            if (batt !== null && batt < 50) {
                cv.roundRect(828, 340, 700, 44, 10, withAlpha(t.warn, 0.14));
                cv.text('Charge is low - worth a longer drive or a charger', 848, 370, 22, t.warn);
            }

            const live = Date.now() - car.lastCar < 5000;
            cv.text(live ? 'Live data' : 'Waiting for the car...', 828, 440, 20, live ? t.dim : t.warn);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawTemps(cv, t);
            drawDrive(cv, t);
            G.frame(cv, t, ['M3 Vitals'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
