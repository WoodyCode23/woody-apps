'use strict';
/**
 * Live - the drive at a glance, in the red and black "Redline Terminal" look.
 *
 * One screen made to be watched (or screen shared): speed, gear, a segmented rev bar that fills white,
 * then amber, then red and blinks at the shift point, oil and coolant, g-forces and the 12 V battery.
 * It is the first real app in the look tried out in the PC cockpit simulator, and it only uses what the
 * kit draws fast: boxes, lines and text. Corner brackets stand in for the simulator's cut corners.
 *
 * Read-only: it subscribes to signals and draws them. It writes nothing to the car.
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');

const W = 1600, H = 520;
const MPH = 1.609344;
const BG = '#050507', PANEL = '#0b0b0e', LINE = '#2a2a31', SOFT = '#1f1f25', TEXT = '#f2f2f4', DIM = '#8f9199', MID = '#c9cad0', AMBER = '#ffb31a';
const REDS = { signal: '#ff1f3d', m: '#e1001a', orange: '#ff3b1f', pink: '#ff2d78' };
const REDLINE = 7200;                 /* the rev bar's full scale */
const SEGS = 48;

const num = (v) => typeof v === 'number' && isFinite(v);

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let batt = null;
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear'], {
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: (v) => {
                    const p = v && v.conditionBatteryChargingCondition;
                    batt = (typeof p === 'number' && p >= 0 && p <= 100) ? p : null;      /* 151 = no value */
                },
            },
        });
        const peak = { gLong: 0, gLat: 0 };      /* the largest g seen since the app started, shown small */

        const red = () => REDS[settings.get('accent')] || REDS.signal;
        const mph = () => settings.get('speedUnit') !== 'kmh';
        const fahr = () => settings.get('tempUnit') === 'f';

        function brackets(cv, x, y, w, h, s, c) {
            cv.line(x, y, x + s, y, 3, c); cv.line(x, y, x, y + s, 3, c);
            cv.line(x + w, y + h, x + w - s, y + h, 3, c); cv.line(x + w, y + h, x + w, y + h - s, 3, c);
        }

        function panel(cv, x, y, w, h, label, right, hot) {
            cv.fillRect(x, y, w, h, PANEL);
            cv.strokeRoundRect(x, y, w, h, 0, 1, LINE);
            brackets(cv, x, y, w, h, 18, red());
            cv.text(label, x + 20, y + 34, 18, DIM, { spacing: 2 });
            if (right) cv.text(right, x + w - 20, y + 34, 18, hot ? red() : DIM, { align: 'right', spacing: 2 });
        }

        function segs(cv, x, y, w, h, n, on, colour, gap) {
            const sw = (w - gap * (n - 1)) / n;
            for (let i = 0; i < n; i++) cv.fillRect(x + i * (sw + gap), y, sw, h, i < on ? (typeof colour === 'function' ? colour(i) : colour) : SOFT);
        }

        /* the rev bar: each lit segment is white, amber or red by where it sits against the shift point */
        function revBar(cv, d) {
            const shift = Number(settings.get('shiftRpm')) || 6800, rpm = num(d.rpm) ? d.rpm : 0;
            const blink = rpm >= shift, phase = Math.floor(Date.now() / 100) % 2;
            segs(cv, 24, 60, 1552, 34, SEGS, Math.round(Math.min(1, rpm / REDLINE) * SEGS), (i) => {
                const r = (i + 1) / SEGS * REDLINE;
                if (blink) return phase ? red() : SOFT;
                return r >= shift - 500 ? red() : r >= shift - 1300 ? AMBER : TEXT;
            }, 5);
            for (let k = 0; k <= 7; k++) cv.text(String(k), 24 + 1552 * (k * 1000 / REDLINE), 118, 16, DIM, { align: k === 0 ? 'left' : 'center' });
            cv.text('ENGINE // RPM', 24, 44, 18, DIM, { spacing: 2 });
            cv.text(num(d.rpm) ? String(Math.round(d.rpm / 10) * 10) : '--', 1576, 44, 26, blink ? red() : TEXT, { align: 'right', font: 'bold' });
        }

        function speedBlock(cv, d) {
            const v = num(d.speed) ? (mph() ? d.speed / MPH : d.speed) : null;
            panel(cv, 24, 140, 560, 356, 'SPEED', mph() ? 'MPH' : 'KM/H');
            cv.text(v === null ? '--' : String(Math.round(v)), 304, 400, 230, TEXT, { align: 'center', font: 'bold' });
        }

        function gearBlock(cv, d) {
            /* P / R / N as the selector says; in D the engaged gear with it. The selector does not tell D from M here. */
            const g = num(d.gear) ? d.gear : null;
            const label = d.stage === 'P' || d.stage === 'R' || d.stage === 'N' ? d.stage
                : g !== null && g > 0 ? 'D' + g : g === 0 ? 'N' : g === -1 ? 'R' : car.guessed ? 'D' + car.guessed : '--';
            panel(cv, 604, 140, 300, 356, 'GEAR', '');
            cv.text(label, 754, 400, label.length > 1 ? 170 : 210, red(), { align: 'center', font: 'bold' });
        }

        function tempRow(cv, y, label, c, ready) {
            const v = !num(c) ? null : fahr() ? c * 9 / 5 + 32 : c;
            const warm = num(c) && c >= ready;
            cv.text(label, 944, y, 20, DIM, { spacing: 2 });
            cv.text(v === null ? '--' : Math.round(v) + String.fromCharCode(176), 1232, y + 6, 46, v === null ? DIM : warm ? TEXT : red(), { align: 'right', font: 'bold' });
            segs(cv, 944, y + 18, 288, 10, 12, num(c) ? Math.round(Math.max(0, Math.min(1, (c - 20) / 90)) * 12) : 0, warm ? TEXT : red(), 4);
        }

        function rightBlocks(cv, d) {
            panel(cv, 924, 140, 328, 356, 'TEMPERATURES', fahr() ? 'F' : 'C');
            tempRow(cv, 222, 'OIL', d.oil, 90);
            tempRow(cv, 322, 'COOLANT', d.coolant, 80);
            cv.text(num(d.oil) && d.oil < 90 ? 'WARMING: KEEP REVS LOW' : num(d.oil) ? 'OIL AT TEMPERATURE' : 'WAITING FOR THE CAR', 944, 468, 16, num(d.oil) && d.oil < 90 ? red() : DIM, { spacing: 1 });

            panel(cv, 1272, 140, 304, 168, 'G-FORCE', '');
            const gl = num(d.gLong) ? d.gLong : null, gt = num(d.gLat) ? d.gLat : null;
            if (gl !== null && Math.abs(gl) > Math.abs(peak.gLong)) peak.gLong = gl;
            if (gt !== null && Math.abs(gt) > Math.abs(peak.gLat)) peak.gLat = gt;
            const g2 = (v) => (v === null ? '--' : (v >= 0 ? '+' : '') + v.toFixed(2));
            cv.text('ACCEL', 1292, 218, 16, DIM); cv.text(g2(gl), 1556, 222, 40, TEXT, { align: 'right', font: 'bold' });
            cv.text('TURN', 1292, 268, 16, DIM); cv.text(g2(gt), 1556, 272, 40, TEXT, { align: 'right', font: 'bold' });
            cv.text('PEAK ' + Math.abs(peak.gLong).toFixed(2) + ' / ' + Math.abs(peak.gLat).toFixed(2), 1556, 298, 14, DIM, { align: 'right' });

            panel(cv, 1272, 328, 304, 168, '12 V BATTERY', batt !== null && batt < 50 ? 'LOW' : '', true);
            cv.text(batt === null ? '--' : Math.round(batt) + '%', 1556, 430, 64, batt === null ? DIM : batt < 50 ? red() : TEXT, { align: 'right', font: 'bold' });
            segs(cv, 1292, 456, 264, 12, 12, batt === null ? 0 : Math.round(batt / 100 * 12), batt !== null && batt < 50 ? red() : TEXT, 4);
        }

        async function render() {
            const d = car.data ? car.data() : car.live;
            const cv = ctx.canvas(W, H).clear(BG);
            revBar(cv, d);
            speedBlock(cv, d);
            gearBlock(cv, d);
            rightBlocks(cv, d);
            const live = d.demo ? 'DEMO DATA' : Date.now() - car.lastCar < 5000 ? '' : 'WAITING FOR THE CAR';
            if (live) cv.text(live, W / 2, 514, 16, MID, { align: 'center', spacing: 2 });
            await ui.image('MAIN_GFX', cv);
        }

        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
