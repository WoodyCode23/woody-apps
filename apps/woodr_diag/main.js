'use strict';
/**
 * Diagnostics - a read-only look at the car, in the red and black "Redline Terminal" look.
 *
 *   data.js    where the numbers come from (signals, and the kit's read-only diagnostic link on demand)
 *   tyres.js   tyre pressures and temperatures from TPMS (copied from Warm-Up HUD)
 *
 * Four pages, switched with the tabs on the screen or the bar's "Next page":
 *   OVERVIEW   one tile per area: faults, 12 V battery, tyres, service
 *   FAULTS     the control units that answer; pick one for its codes. There is no clear button, and there
 *              will not be one in this app.
 *   LIVE       the values that cost nothing to read (signals), plus the gearbox oil on demand
 *   SERVICE    the instrument cluster's service records
 *
 * Diagnostics are read when a button says so, never on a timer. Red means "needs attention" or "selected",
 * white is normal, grey is "not read".
 *
 * Read-only: nothing is written to the car. Never throws out of a callback: an uncaught error exits the app,
 * and the head unit then wipes the app's data.
 */
const mgu = require('./kit/mgu');
const { statusInfo } = require('./kit/diag');      /* only the status-byte labels; this app never makes a Diag */
const { Sources, hex2 } = require('./data');
const { shownUnits, presText } = require('./tyres');

const W = 1600, H = 520;
const MPH = 1.609344;
const BG = '#050507', PANEL = '#0b0b0e', LINE = '#2a2a31', SOFT = '#1f1f25', TEXT = '#f2f2f4', DIM = '#8f9199', MID = '#c9cad0', AMBER = '#ffb31a';
const REDS = { signal: '#ff1f3d', m: '#e1001a', orange: '#ff3b1f', pink: '#ff2d78' };
const PAGES = ['OVERVIEW', 'FAULTS', 'LIVE', 'SERVICE'];
const TOP = 84, BOTTOM = 486;                      /* the page area under the tabs */
const UNIT_ROWS = 7, UNIT_ROW = 42;
const CODE_ROWS = 5, CODE_ROW = 62;
const ITEM_ROWS = 7, ITEM_ROW = 40;
const LOW_TYRE_BAR = 0.2, LOW_BATT = 50;
const CORNER = { FLH: 'FRONT LEFT', FRH: 'FRONT RIGHT', RLH: 'REAR LEFT', RRH: 'REAR RIGHT' };
const DEG = String.fromCharCode(176);

const num = (v) => typeof v === 'number' && isFinite(v);

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const src = new Sources(ctx);
        let page = 0;
        let unitSel = 0, unitPage = 0;             /* Faults: the picked unit, and which screenful of units */
        let codeTop = 0, itemTop = 0;              /* first row shown in the two lists that scroll */
        let scrollPx = 0;                          /* a finger's drag, kept until it adds up to a row */
        let note = '', noteUntil = 0;

        const red = () => REDS[settings.get('accent')] || REDS.signal;
        const mph = () => settings.get('speedUnit') !== 'kmh';
        const units = () => { try { return shownUnits(settings, src.tyreUnits()); } catch (e) { return { temp: 'c', press: 'psi' }; } };

        /** a callback that can never take the app down */
        const safe = (what, fn) => function () {
            try {
                const r = fn.apply(null, arguments);
                if (r && typeof r.catch === 'function') return r.catch((e) => log.warn(what + ': ' + e));
                return r;
            } catch (e) { log.warn(what + ': ' + e); return undefined; }
        };
        function refresh() { render().catch((e) => log.warn('render: ' + e)); }
        function say(text, secs) { note = text; noteUntil = Date.now() + (secs || 5) * 1000; refresh(); }
        function go(p) { page = (p + PAGES.length) % PAGES.length; scrollPx = 0; refresh(); }

        /* ---------------- reading, always from a press ---------------- */

        function started(p, busyText) {
            Promise.resolve(p).then((ran) => { if (ran === false) say(busyText, 4); }).catch((e) => log.warn('read: ' + e));
            refresh();
        }
        function readUnits() { codeTop = 0; started(src.readUnits(), 'Just read: wait a few seconds before the next scan'); }
        function readGearbox() { started(src.readGearbox(), 'Just read: wait a few seconds'); }
        function readService() { itemTop = 0; started(src.readService(), 'Just read: wait a few seconds'); }
        function readAll() {
            if (src.busy()) { say('Still reading', 3); return; }
            codeTop = 0; itemTop = 0;
            src.readAll().catch((e) => log.warn('read all: ' + e));
            refresh();
        }
        function readPage() { if (page === 1) readUnits(); else if (page === 2) readGearbox(); else if (page === 3) readService(); else readAll(); }

        /* ---------------- drawing: boxes, lines and text ---------------- */

        function brackets(cv, x, y, w, h, s, c) {
            cv.line(x, y, x + s, y, 3, c); cv.line(x, y, x, y + s, 3, c);
            cv.line(x + w, y + h, x + w - s, y + h, 3, c); cv.line(x + w, y + h, x + w, y + h - s, 3, c);
        }

        function panel(cv, x, y, w, h, label, right, hot) {
            cv.fillRect(x, y, w, h, PANEL);
            cv.strokeRoundRect(x, y, w, h, 0, 1, LINE);
            brackets(cv, x, y, w, h, 18, red());
            if (label) cv.text(label, x + 20, y + 34, 18, DIM, { spacing: 2 });
            if (right) cv.text(right, x + w - 20, y + 34, 18, hot ? red() : DIM, { align: 'right', spacing: 2 });
        }

        function segs(cv, x, y, w, h, n, on, colour, gap) {
            const sw = (w - gap * (n - 1)) / n;
            for (let i = 0; i < n; i++) cv.fillRect(x + i * (sw + gap), y, sw, h, i < on ? colour : SOFT);
        }

        function button(cv, x, y, w, h, label, key, fn, on) {
            cv.fillRect(x, y, w, h, on === false ? PANEL : SOFT);
            cv.strokeRoundRect(x, y, w, h, 0, 2, on === false ? LINE : TEXT);
            cv.text(label, x + w / 2, y + h / 2 + 7, 18, on === false ? DIM : TEXT, { align: 'center', font: 'bold', spacing: 2 });
            if (on !== false) cv.target(x, y, w, h, safe(key, fn), key, 0);
        }

        /** str cut to fit maxW at this size */
        function fit(cv, str, size, maxW, opts) {
            let s = String(str);
            try {
                if (cv.textWidth(s, size, opts) <= maxW) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opts) > maxW) s = s.slice(0, -1);
                return s + '...';
            } catch (e) { return s; }
        }

        /** a list's scroll bar; tells the kit the page scrolls so a finger or the knob moves it */
        function scrollBar(cv, x, y, h, top, shown, total) {
            if (total <= shown) return;
            const bh = Math.max(30, Math.round(h * shown / total)), by = y + Math.round((h - bh) * top / (total - shown));
            cv.fillRect(x, y, 6, h, SOFT);
            cv.fillRect(x, by, 6, bh, MID);
            cv.scroll = { y: y, bar: { x: x, y: by, w: 6, h: bh } };
        }

        function header(cv) {
            cv.text('WOODY DIAGNOSTICS', 24, 44, 24, TEXT, { font: 'bold', spacing: 2 });
            let x = 24 + 330;
            try { x = 24 + cv.textWidth('WOODY DIAGNOSTICS', 24, { font: 'bold', spacing: 2 }) + 22; } catch (e) { /* keep the guess */ }
            cv.text('// READ-ONLY', x, 44, 18, red(), { spacing: 2 });
            const tw = 196, gap = 8, x0 = W - 24 - PAGES.length * tw - (PAGES.length - 1) * gap;
            PAGES.forEach((name, i) => {
                const tx = x0 + i * (tw + gap), on = i === page;
                cv.fillRect(tx, 14, tw, 46, on ? SOFT : PANEL);
                cv.strokeRoundRect(tx, 14, tw, 46, 0, 1, LINE);
                if (on) cv.fillRect(tx, 56, tw, 4, red());
                cv.text(name, tx + tw / 2, 44, 18, on ? TEXT : DIM, { align: 'center', font: on ? 'bold' : undefined, spacing: 2 });
                cv.target(tx, 14, tw, 46, safe('tab', () => go(i)), 'tab-' + i, 0);
            });
            cv.line(24, 70, W - 24, 70, 1, LINE);
        }

        /* ---------------- OVERVIEW ---------------- */

        function tile(cv, i, label, o) {
            const w = 376, x = 24 + i * (w + 16), y = TOP, h = 300;
            const c = o.state === 'bad' ? red() : o.state === 'ok' ? TEXT : DIM;
            panel(cv, x, y, w, h, label, o.status, o.state === 'bad');
            cv.text(o.value, x + w - 24, y + 164, o.value.length > 6 ? 62 : 92, c, { align: 'right', font: 'bold' });
            cv.text(fit(cv, o.line1 || '', 18, w - 44, { spacing: 1 }), x + 20, y + 210, 18, MID, { spacing: 1 });
            cv.text(fit(cv, o.line2 || '', 16, w - 44, { spacing: 1 }), x + 20, y + 240, 16, DIM, { spacing: 1 });
            segs(cv, x + 20, y + h - 30, w - 40, 10, 12, o.bar === undefined ? 0 : Math.max(0, Math.min(12, Math.round(o.bar * 12))), c, 4);
            cv.target(x, y, w, h, safe('tile', () => go(o.page)), 'tile-' + i, 0);
        }

        function faultsTile() {
            const s = src.unitScan, total = src.faultTotal();
            if (s.state === 'reading') return { value: '...', status: 'READING', line1: 'ASKING EVERY CONTROL UNIT', page: 1 };
            if (s.state === 'error') return { value: '--', status: 'NO ANSWER', state: 'bad', line1: 'THE SCAN DID NOT RUN', line2: s.error.toUpperCase(), page: 1 };
            if (s.state !== 'done') return { value: '--', status: 'NOT READ YET', line1: 'PRESS READ ALL NOW', page: 1 };
            if (total === null) {
                return { value: String(s.list.length), status: 'UNITS', state: 'ok', line1: 'CONTROL UNITS ANSWERED', line2: 'FAULT CODES: NOT IN THIS VERSION', bar: 1, page: 1 };
            }
            const withFaults = s.list.filter((u) => u.faults && u.faults.length).length;
            return { value: String(total), status: total ? 'ATTENTION' : 'OK', state: total ? 'bad' : 'ok',
                line1: total ? withFaults + ' OF ' + s.list.length + ' UNITS HAVE FAULTS' : 'NO FAULTS STORED', line2: s.list.length + ' CONTROL UNITS ANSWERED',
                bar: s.list.length ? withFaults / s.list.length : 0, page: 1 };
        }

        function batteryTile() {
            const b = src.battery();
            if (!num(b)) return { value: '--', status: 'NO VALUE', line1: '12 V STATE OF CHARGE', line2: 'THE CAR HAS NOT SENT IT YET', page: 2 };
            const low = b < LOW_BATT;
            return { value: Math.round(b) + '%', status: low ? 'LOW' : 'OK', state: low ? 'bad' : 'ok', line1: '12 V STATE OF CHARGE',
                line2: low ? 'BELOW ' + LOW_BATT + '%: CHARGE OR DRIVE LONGER' : 'AS THE CAR REPORTS IT', bar: b / 100, page: 2 };
        }

        function tyresTile() {
            const t = src.tyreData(), u = units();
            const cs = (t.corners || []).filter((c) => num(c.p));
            if (!cs.length) return { value: '--', status: 'NO VALUE', line1: 'TYRE PRESSURES', line2: 'THE CAR HAS NOT SENT THEM YET', page: 2 };
            const lo = t.lowest, short = lo ? lo.target - lo.p : 0, low = short >= LOW_TYRE_BAR;
            const least = cs.reduce((a, c) => (c.p < a.p ? c : a), cs[0]);
            const shown = lo && low ? lo : { corner: least.c, p: least.p, target: least.target };
            return { value: presText(shown.p, u.press), status: low ? 'LOW' : 'OK', state: low ? 'bad' : 'ok',
                line1: (low ? 'LOW: ' : 'LOWEST: ') + (CORNER[shown.corner] || shown.corner),
                line2: num(shown.target) ? 'THE CAR WANTS ' + presText(shown.target, u.press).toUpperCase() : 'NO TARGET FROM THE CAR',
                bar: num(shown.target) && shown.target > 0 ? shown.p / shown.target : 1, page: 2 };
        }

        function serviceTile() {
            const s = src.cbs;
            if (s.state === 'reading') return { value: '...', status: 'READING', line1: 'ASKING THE INSTRUMENT CLUSTER', page: 3 };
            if (s.state === 'error') return { value: '--', status: 'NO ANSWER', state: 'bad', line1: 'SERVICE RECORDS NOT READ', line2: s.error.toUpperCase(), page: 3 };
            if (s.state !== 'done') return { value: '--', status: 'NOT READ YET', line1: 'PRESS READ ALL NOW', page: 3 };
            const due = s.items.filter((x) => x.due === true), known = s.items.some((x) => x.due !== null);
            if (!known) return { value: String(s.items.length), status: 'ITEMS', state: 'ok', line1: 'SERVICE ITEMS ON RECORD', line2: 'DUE DATES: NOT DECODED YET', bar: 1, page: 3 };
            return { value: String(due.length), status: due.length ? 'DUE SOON' : 'OK', state: due.length ? 'bad' : 'ok',
                line1: due.length ? 'NEXT: ' + due[0].name.toUpperCase() : 'NOTHING DUE', line2: s.items.length + ' SERVICE ITEMS ON RECORD',
                bar: s.items.length ? due.length / s.items.length : 0, page: 3 };
        }

        function drawOverview(cv) {
            tile(cv, 0, 'FAULTS', faultsTile());
            tile(cv, 1, '12 V BATTERY', batteryTile());
            tile(cv, 2, 'TYRES', tyresTile());
            tile(cv, 3, 'SERVICE', serviceTile());
            const y = TOP + 316, h = BOTTOM - y;
            panel(cv, 24, y, 1552, h, '', '');
            cv.text('DIAGNOSTICS ARE READ WHEN YOU ASK, NOT ALL THE TIME.', 44, y + 36, 18, MID, { spacing: 1 });
            cv.text('BATTERY AND TYRES COME FROM THE CAR BY THEMSELVES. THIS APP ONLY READS: IT CLEARS AND CHANGES NOTHING.', 44, y + 64, 16, DIM, { spacing: 1 });
            const busy = src.busy();
            button(cv, 1576 - 20 - 300, y + 13, 300, h - 26, busy ? 'READING...' : 'READ ALL NOW', 'read-all', readAll, !busy);
        }

        /* ---------------- FAULTS ---------------- */

        /** the units in the order shown: the ones with faults first, then by address */
        function unitList() {
            const l = src.unitScan.list.slice();
            l.sort((a, b) => ((b.faults ? b.faults.length : 0) - (a.faults ? a.faults.length : 0)) || (a.addr - b.addr));
            return l;
        }

        function drawFaults(cv) {
            const s = src.unitScan, list = unitList(), total = src.faultTotal();
            const lx = 24, lw = 540, rx = 580, rw = 996, h = BOTTOM - TOP;

            panel(cv, lx, TOP, lw, h, 'CONTROL UNITS', s.state === 'done' ? list.length + ' ANSWERED' : '');
            const pages = Math.max(1, Math.ceil(list.length / UNIT_ROWS));
            if (unitPage >= pages) unitPage = 0;
            if (unitSel >= list.length) unitSel = 0;
            if (!list.length) {
                const t = s.state === 'reading' ? 'READING...' : s.state === 'error' ? 'NO ANSWER' : 'NOT READ YET';
                cv.text(t, lx + lw / 2, TOP + 200, 26, s.state === 'error' ? red() : DIM, { align: 'center', font: 'bold', spacing: 2 });
                cv.text(s.state === 'reading' ? 'THIS TAKES A FEW SECONDS' : 'PRESS READ AGAIN', lx + lw / 2, TOP + 236, 16, DIM, { align: 'center', spacing: 1 });
            }
            list.slice(unitPage * UNIT_ROWS, unitPage * UNIT_ROWS + UNIT_ROWS).forEach((u, k) => {
                const i = unitPage * UNIT_ROWS + k, y = TOP + 50 + k * UNIT_ROW, on = i === unitSel;
                const n = u.faults ? u.faults.length : null;
                if (on) { cv.fillRect(lx + 1, y, lw - 2, UNIT_ROW - 2, SOFT); cv.fillRect(lx + 1, y, 5, UNIT_ROW - 2, red()); }
                cv.text(fit(cv, u.name.toUpperCase(), 20, 330, { spacing: 1 }), lx + 22, y + 28, 20, on ? TEXT : MID, { font: on ? 'bold' : undefined, spacing: 1 });
                cv.text('0x' + hex2(u.addr), lx + lw - 96, y + 27, 16, DIM, { align: 'right' });
                cv.text(n === null ? '--' : String(n), lx + lw - 24, y + 30, 26, n === null ? DIM : n ? red() : MID, { align: 'right', font: 'bold' });
                cv.target(lx, y, lw, UNIT_ROW - 2, safe('unit', () => { unitSel = i; codeTop = 0; refresh(); }), 'unit-' + i, 0);
            });
            if (pages > 1) {
                button(cv, lx + 20, BOTTOM - 54, lw - 40, 42, 'MORE UNITS  ' + (unitPage + 1) + ' / ' + pages, 'units-more',
                    () => { unitPage = (unitPage + 1) % pages; unitSel = unitPage * UNIT_ROWS; codeTop = 0; refresh(); });
            }

            const u = list[unitSel];
            panel(cv, rx, TOP, rw, h, u ? fit(cv, u.name.toUpperCase() + (u.sgbd ? '  //  ' + u.sgbd : ''), 18, rw - 330, { spacing: 2 }) : 'FAULT CODES', '');
            button(cv, rx + rw - 20 - 250, TOP + 10, 250, 44, s.state === 'reading' ? 'READING...' : 'READ AGAIN', 'read-units', readUnits, s.state !== 'reading');
            cv.line(rx + 20, TOP + 64, rx + rw - 20, TOP + 64, 1, LINE);
            const cx = rx + rw / 2, top = TOP + 72;
            const middle = (big, c, a, b) => {
                cv.text(big, cx, TOP + 200, 30, c, { align: 'center', font: 'bold', spacing: 2 });
                if (a) cv.text(fit(cv, a, 18, rw - 60, { spacing: 1 }), cx, TOP + 242, 18, MID, { align: 'center', spacing: 1 });
                if (b) cv.text(fit(cv, b, 16, rw - 60, { spacing: 1 }), cx, TOP + 272, 16, DIM, { align: 'center', spacing: 1 });
            };
            if (s.state === 'reading') { middle('READING...', TEXT, 'ASKING EVERY CONTROL UNIT WHO IS THERE', 'NOTHING IS CHANGED OR CLEARED'); return; }
            if (s.state === 'error') { middle('NO ANSWER', red(), s.error.toUpperCase(), 'ANOTHER DIAGNOSTIC TOOL ON THE CAR BLOCKS THIS. TRY AGAIN WHEN IT IS DONE.'); return; }
            if (!u) { middle('NOT READ YET', DIM, 'PRESS READ AGAIN TO ASK THE CAR', 'READING ONLY: THIS APP CANNOT CLEAR A FAULT'); return; }
            if (!u.faults) {
                middle('FAULT CODES NOT READ', AMBER, 'THIS UNIT ANSWERED THE SCAN BUT NOT THE FAULT-MEMORY READ.',
                    String(u.why || 'PRESS READ AGAIN TO ASK IT ONCE MORE').toUpperCase());
                return;
            }
            if (!u.faults.length) { middle('NO FAULTS STORED', TEXT, 'THIS UNIT ANSWERED WITH AN EMPTY FAULT MEMORY', total ? total + ' FAULTS IN OTHER UNITS' : ''); return; }
            codeTop = Math.max(0, Math.min(codeTop, Math.max(0, u.faults.length - CODE_ROWS)));
            u.faults.slice(codeTop, codeTop + CODE_ROWS).forEach((f, k) => {
                const y = top + k * CODE_ROW, st = statusInfo(f.status);
                const c = st.sev === 'crit' ? red() : st.sev === 'warn' ? AMBER : DIM;
                cv.fillRect(rx + 20, y + 8, 5, CODE_ROW - 16, c);
                cv.text(f.code, rx + 40, y + 30, 26, TEXT, { font: 'bold', spacing: 1 });
                cv.text(st.label, rx + 190, y + 28, 16, c, { spacing: 2 });
                cv.text(fit(cv, f.text || 'No text for this code', 18, rw - 100), rx + 40, y + 54, 18, f.text ? MID : DIM);
                if (k) cv.line(rx + 20, y, rx + rw - 40, y, 1, SOFT);
            });
            cv.text(u.faults.length + (u.faults.length === 1 ? ' FAULT' : ' FAULTS'), rx + rw - 300, TOP + 38, 18, red(), { align: 'right', spacing: 2 });
            scrollBar(cv, rx + rw - 16, top + 4, CODE_ROWS * CODE_ROW - 8, codeTop, CODE_ROWS, u.faults.length);
        }

        /* ---------------- LIVE ---------------- */

        function cell(cv, i, label, value, unit, o) {
            const w = 376, h = 124, x = 24 + (i % 4) * (w + 16), y = TOP + Math.floor(i / 4) * (h + 15);
            const none = value === null || value === undefined;
            panel(cv, x, y, w, h, label, unit, false);
            const c = none ? DIM : o && o.bad ? red() : TEXT;
            const str = none ? (o && o.empty) || '--' : String(value);
            cv.text(str, x + w - 22, y + 98, str.length > 9 ? 30 : 56, c, { align: 'right', font: 'bold' });
            if (o && o.sub) cv.text(fit(cv, o.sub, 15, 190, { spacing: 1 }), x + 20, y + 98, 15, o.bad ? red() : DIM, { spacing: 1 });
            if (o && o.press) cv.target(x, y, w, h, safe('cell', o.press), 'cell-' + i, 0);
        }

        function tempText(c, f) { return !num(c) ? null : String(Math.round(f ? c * 9 / 5 + 32 : c)) + DEG; }

        function drawLive(cv) {
            const d = src.drive(), u = units(), f = u.temp === 'f', tu = f ? 'F' : 'C';
            const b = src.battery(), t = src.tyreData(), box = src.box, li = src.linkInfo();
            const gear = d.stage === 'P' || d.stage === 'R' || d.stage === 'N' ? d.stage
                : num(d.gear) && d.gear > 0 ? 'D' + d.gear : d.gear === 0 ? 'N' : d.gear === -1 ? 'R' : null;
            cell(cv, 0, 'ENGINE SPEED', num(d.rpm) ? Math.round(d.rpm / 10) * 10 : null, 'RPM');
            cell(cv, 1, 'ROAD SPEED', num(d.speed) ? Math.round(mph() ? d.speed / MPH : d.speed) : null, mph() ? 'MPH' : 'KM/H');
            cell(cv, 2, 'GEAR', gear, '');
            cell(cv, 3, '12 V BATTERY', num(b) ? Math.round(b) + '%' : null, 'CHARGE', { bad: num(b) && b < LOW_BATT, sub: num(b) && b < LOW_BATT ? 'LOW' : '' });
            cell(cv, 4, 'COOLANT', tempText(d.coolant, f), tu);
            cell(cv, 5, 'ENGINE OIL', tempText(d.oil, f), tu, { sub: num(d.oil) && d.oil < 90 ? 'WARMING' : '' });
            cell(cv, 6, 'GEARBOX OIL', box.state === 'done' ? tempText(box.value, f) : null, tu, {
                empty: box.state === 'reading' ? 'READING...' : box.state === 'error' ? 'NO ANSWER' : 'NOT READ YET',
                sub: box.state === 'reading' ? '' : box.state === 'done' ? 'TAP TO READ AGAIN' : 'TAP TO READ', press: readGearbox });
            cell(cv, 7, 'DIAGNOSTIC LINK', li.text, '', {
                sub: li.stats ? li.stats.replies + ' ANSWERS, ' + li.stats.missed + ' MISSED' : 'USED ONLY ON DEMAND' });
            ['FLH', 'FRH', 'RLH', 'RRH'].forEach((cn, k) => {
                const c = (t.corners || []).filter((x) => x.c === cn)[0] || {};
                const low = num(c.p) && num(c.target) && c.target - c.p >= LOW_TYRE_BAR;
                const sub = (num(c.t) ? tempText(c.t, f) + tu : '') + (num(c.target) ? (num(c.t) ? '  ' : '') + 'WANTS ' + presText(c.target, u.press).toUpperCase() : '');
                cell(cv, 8 + k, 'TYRE ' + CORNER[cn], num(c.p) ? presText(c.p, u.press).split(' ')[0] : null, u.press.toUpperCase(), { bad: low, sub: sub });
            });
        }

        /* ---------------- SERVICE ---------------- */

        function drawService(cv) {
            const s = src.cbs, x = 24, w = 1552, h = BOTTOM - TOP;
            panel(cv, x, TOP, w, h, 'SERVICE // FROM THE INSTRUMENT CLUSTER', '');
            button(cv, x + w - 20 - 250, TOP + 10, 250, 44, s.state === 'reading' ? 'READING...' : 'READ AGAIN', 'read-service', readService, s.state !== 'reading');
            cv.line(x + 20, TOP + 64, x + w - 20, TOP + 64, 1, LINE);
            const middle = (big, c, a, b) => {
                cv.text(big, W / 2, TOP + 200, 30, c, { align: 'center', font: 'bold', spacing: 2 });
                if (a) cv.text(fit(cv, a, 18, w - 80, { spacing: 1 }), W / 2, TOP + 242, 18, MID, { align: 'center', spacing: 1 });
                if (b) cv.text(fit(cv, b, 16, w - 80, { spacing: 1 }), W / 2, TOP + 272, 16, DIM, { align: 'center', spacing: 1 });
            };
            if (s.state === 'reading') { middle('READING...', TEXT, 'ASKING THE INSTRUMENT CLUSTER FOR ITS SERVICE RECORDS', 'NOTHING IS RESET'); return; }
            if (s.state === 'error') { middle('NO ANSWER', red(), s.error.toUpperCase(), 'TRY AGAIN WITH THE IGNITION ON AND NO OTHER DIAGNOSTIC TOOL CONNECTED'); return; }
            if (s.state !== 'done') { middle('NOT READ YET', DIM, 'PRESS READ AGAIN TO ASK THE CAR', 'READING ONLY: THIS APP CANNOT RESET A SERVICE'); return; }
            if (!s.items.length) { middle('NO SERVICE RECORDS', DIM, 'THE INSTRUMENT CLUSTER ANSWERED WITH AN EMPTY LIST', ''); return; }
            const decoded = s.items.some((it) => it.due !== null);
            const cols = [x + 44, x + 640, x + 900, x + 1160];
            const y0 = TOP + 92;
            ['ITEM', decoded ? 'REMAINING' : 'RECORD AS THE CAR SENT IT', decoded ? 'DUE' : '', decoded ? 'STATE' : ''].forEach((t, k) => { if (t) cv.text(t, cols[k], y0, 15, DIM, { spacing: 2 }); });
            itemTop = Math.max(0, Math.min(itemTop, Math.max(0, s.items.length - ITEM_ROWS)));
            s.items.slice(itemTop, itemTop + ITEM_ROWS).forEach((it, k) => {
                const y = y0 + 12 + k * ITEM_ROW, c = it.due ? red() : TEXT;
                cv.line(x + 20, y, x + w - 40, y, 1, SOFT);
                cv.fillRect(x + 22, y + 8, 5, ITEM_ROW - 16, it.due ? red() : it.due === false ? TEXT : DIM);
                cv.text(fit(cv, it.name.toUpperCase(), 20, 560, { spacing: 1 }), cols[0], y + 28, 20, c, { font: 'bold', spacing: 1 });
                if (decoded) {
                    cv.text(it.way || '--', cols[1], y + 28, 20, it.way ? MID : DIM);
                    cv.text(it.date || '--', cols[2], y + 28, 20, it.date ? MID : DIM);
                    cv.text(it.due ? 'DUE SOON' : 'OK', cols[3], y + 28, 18, c, { spacing: 2 });
                } else cv.text(it.raw, cols[1], y + 27, 18, DIM);
            });
            if (!decoded) cv.text('DISTANCE AND DATE ARE NOT DECODED YET: THE RECORDS ARE LOGGED SO THEY CAN BE WORKED OUT.', x + 44, BOTTOM - 14, 15, AMBER, { spacing: 1 });
            scrollBar(cv, x + w - 16, y0 + 16, ITEM_ROWS * ITEM_ROW - 8, itemTop, ITEM_ROWS, s.items.length);
        }

        /* ---------------- the frame ---------------- */

        async function render() {
            const cv = ctx.canvas(W, H).clear(BG);
            try {
                src.sync();
                header(cv);
                if (page === 0) drawOverview(cv);
                else if (page === 1) drawFaults(cv);
                else if (page === 2) drawLive(cv);
                else drawService(cv);
                const state = src.demo() ? 'DEMO DATA' : src.carPresent() ? '' : 'WAITING FOR THE CAR';
                if (state) cv.text(state, W / 2, 510, 16, src.demo() ? AMBER : MID, { align: 'center', spacing: 2 });
                if (Date.now() < noteUntil && note) cv.text(fit(cv, note.toUpperCase(), 16, 600, { spacing: 1 }), 24, 510, 16, TEXT, { spacing: 1 });
            } catch (e) { log.warn('draw: ' + (e && e.stack || e)); }
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------------- buttons, scrolling, start ---------------- */

        ui.onClick('BTN_PAGE', safe('BTN_PAGE', () => { page = (page + 1) % PAGES.length; scrollPx = 0; return render(); }));
        ui.onClick('BTN_ACTION', safe('BTN_ACTION', () => { readPage(); return render(); }));

        /* a finger dragged on a list, or the knob turned on it: whole rows, so nothing is drawn half cut off */
        ctx.onScroll(safe('scroll', (dy) => {
            const rowH = page === 1 ? CODE_ROW : ITEM_ROW;
            if (page !== 1 && page !== 3) return false;
            scrollPx += dy;
            const rows = scrollPx > 0 ? Math.floor(scrollPx / rowH) : Math.ceil(scrollPx / rowH);
            if (!rows) return true;
            scrollPx -= rows * rowH;
            let moved;
            if (page === 1) {
                const u = unitList()[unitSel], n = u && u.faults ? u.faults.length : 0;
                const to = Math.max(0, Math.min(codeTop + rows, Math.max(0, n - CODE_ROWS)));
                moved = to !== codeTop; codeTop = to;
            } else {
                const to = Math.max(0, Math.min(itemTop + rows, Math.max(0, src.cbs.items.length - ITEM_ROWS)));
                moved = to !== itemTop; itemTop = to;
            }
            if (moved) refresh();
            return moved;
        }));

        src.onChange = () => refresh();
        settings.onChange(() => refresh());
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
