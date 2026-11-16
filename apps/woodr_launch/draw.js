'use strict';
/**
 * draw.js - everything Launch draws: the centre screen's pages and the two small pictures for the instrument
 * cluster and the head-up display. No kit imports: each function takes a canvas (the kit's Recorder or
 * Canvas, both have the same drawing calls) and a plain model object, so the layers can be drawn onto a
 * test canvas on a PC (tools/render_launch_layers.js).
 *
 * Only what the kit draws fast: boxes, lines and text. Black, one red, white and grey, thin lines, corner
 * brackets and segmented bars, as in the cockpit simulator the look was tried out in.
 */
const W = 1600, H = 520;
const MPH = 1.609344, FT = 0.3048;
const BG = '#050507', PANEL = '#0b0b0e', LINE = '#2a2a31', SOFT = '#1f1f25', TEXT = '#f2f2f4', DIM = '#8f9199', MID = '#c9cad0';
const RED = '#ff1f3d', AMBER = '#ffb31a', GREEN = '#2fd27a', OFF = '#1a1a1f', DEEP = '#140508';
const REDLINE = 7200;                 /* the rev bars' full scale */

/* Where the small pictures go, in each cluster-render target's own pixels.
 *   map: 1088x480, the cluster's advertised safe area on this car is 286,72 504x368
 *   hud: 800x480, the window seen through the windscreen is 120,100 570x278; the car's own speed sits bottom
 *        left of it and its rev band (M view) along the top, which leaves 220,185 470x133 clear in every view */
const MAP_SAFE = { x: 286, y: 72, w: 504, h: 368 };
const HUD_WINDOW = { x: 120, y: 100, w: 570, h: 278 };
const HUD_SLOT = { x: 220, y: 185, w: 470, h: 133 };
const CLUSTER = { x: 370, y: 156, w: 336, h: 200 };
const HUD = { x: 235, y: 189, w: 440, h: 124 };
/* The whole instrument cluster is one 1920 x 720 picture (cluster-render's 'panel' target). The dials leave its
 * middle free: x 700 to 1360, y 150 to 600, from an outline drawn on this car's glass and photographed. The run
 * goes there as two small layers, both drawn small and shown larger (the cluster is read at arm's length):
 * the CLUSTER picture above, and under it a strip that comes up for three seconds as each split is passed.
 * Never one layer the size of the panel: that makes the car drop its own cluster picture (seen 2026-11-14). */
const PANEL_SIZE = { w: 1920, h: 720 };
const PANEL_STAGE = { x: 700, y: 150, w: 660, h: 450 };
const PANEL_MAIN = { x: 730, y: 150, w: 600, h: 357 };        /* CLUSTER's 336 x 200, about 1.8 times larger */
const PANEL_POP = { x: 730, y: 512, w: 600, h: 86 };          /* POP's 336 x 48, the same scale */
const POP = { w: 336, h: 48 };
const FLASH = { x: HUD.x + 8, y: HUD.y + 4, w: HUD.w - 16, h: 16 };      /* over the HUD picture's rev bar */

const num = (v) => typeof v === 'number' && isFinite(v);
const secs = (s) => (num(s) ? s.toFixed(2) : '-');
const speedIn = (kmh, unit) => (num(kmh) ? (unit === 'kmh' ? kmh : kmh / MPH) : null);
const unitName = (unit) => (unit === 'kmh' ? 'KM/H' : 'MPH');
const speedText = (kmh, unit, dp) => { const v = speedIn(kmh, unit); return v === null ? '-' : v.toFixed(dp || 0); };
const rtText = (r) => (!r || !num(r.rt) ? '-' : (r.rt < 0 ? '-' : '') + Math.abs(r.rt).toFixed(2));

function brackets(cv, x, y, w, h, s, c) {
    cv.line(x, y, x + s, y, 3, c); cv.line(x, y, x, y + s, 3, c);
    cv.line(x + w, y + h, x + w - s, y + h, 3, c); cv.line(x + w, y + h, x + w, y + h - s, 3, c);
}

function panel(cv, x, y, w, h, label, right, hot) {
    cv.fillRect(x, y, w, h, PANEL);
    cv.strokeRoundRect(x, y, w, h, 0, 1, LINE);
    brackets(cv, x, y, w, h, 18, RED);
    if (label) cv.text(label, x + 20, y + 32, 18, DIM, { spacing: 2 });
    if (right) cv.text(right, x + w - 20, y + 32, 18, hot ? RED : DIM, { align: 'right', spacing: 2 });
}

function segs(cv, x, y, w, h, n, on, colour, gap) {
    const sw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) cv.fillRect(x + i * (sw + gap), y, sw, h, i < on ? (typeof colour === 'function' ? colour(i) : colour) : SOFT);
}

/* a rev bar: white, then amber, then red towards the shift point; all red (and blinking) from it */
function revBar(cv, x, y, w, h, n, rpm, shift, blinkOn, gap) {
    const r = num(rpm) ? rpm : 0, over = r >= shift;
    segs(cv, x, y, w, h, n, Math.round(Math.min(1, r / REDLINE) * n), (i) => {
        const at = (i + 1) / n * REDLINE;
        if (over) return blinkOn ? RED : SOFT;
        return at >= shift - 500 ? RED : at >= shift - 1300 ? AMBER : TEXT;
    }, gap);
}

/* ---------------- the centre screen ---------------- */

function header(cv, m, phase) {
    cv.text('LAUNCH', 24, 68, 22, TEXT, { font: 'bold', spacing: 4 });
    cv.text('// ' + phase, 150, 68, 18, DIM, { spacing: 2 });
    let x = 1576;
    const chip = (s, hot) => { x -= cv.text(s, x, 68, 16, hot ? RED : DIM, { align: 'right', spacing: 2 }) + 34; };
    if (m.demo) chip('DEMO DATA', true);
    chip(unitName(m.unit), false);
    chip(m.rollout ? '1 FT ROLLOUT ON' : 'ROLLOUT OFF', m.rollout);
    chip(m.tree === 'pro' ? 'PRO TREE' : 'SPORTSMAN TREE', false);
    cv.fillRect(24, 80, 1552, 1, LINE);
}

/* the tree: three amber rows, green, red; two lamps a row, as a strip's tree has a lamp for each lane */
function treePanel(cv, m) {
    const x = 24, y = 96, w = 306, h = 400, L = m.lights || {};
    panel(cv, x, y, w, h, 'TREE', m.tree === 'pro' ? 'PRO' : 'SPORTSMAN');
    const rows = [[!!(L.ambers && L.ambers[0]), AMBER], [!!(L.ambers && L.ambers[1]), AMBER], [!!(L.ambers && L.ambers[2]), AMBER], [!!L.green, GREEN], [!!L.red, RED]];
    rows.forEach((r, i) => {
        const ly = y + 52 + i * 68;
        for (let k = 0; k < 2; k++) {
            const lx = x + 28 + k * 140;
            cv.fillRect(lx, ly, 110, 52, r[0] ? r[1] : OFF);
            if (!r[0]) cv.strokeRoundRect(lx, ly, 110, 52, 0, 2, LINE);
        }
    });
}

/* one line of a list: label left, value right, a small BEST tag when the value is the best of its kind */
function row(cv, x, y, w, label, value, o) {
    o = o || {};
    cv.fillRect(x, y, w, 1, SOFT);
    const done = value !== '-';
    cv.text(label, x, y + 31, o.small ? 16 : 18, done ? MID : DIM, { spacing: 2 });
    const vw = cv.text(value, x + w, y + 33, o.small ? 24 : 28, !done ? DIM : o.hot || o.best ? RED : TEXT, { align: 'right', font: 'bold' });
    if (o.best && done) cv.text('BEST', x + w - vw - 14, y + 30, 13, RED, { align: 'right', spacing: 2 });
}

/* "11.62 @ 123.4 MPH" for a distance mark: its time, and the speed there (the 66 ft trap average for 1/8 and 1/4) */
function distValue(r, key, unit) {
    if (!r || !r.et || !num(r.et[key])) return '-';
    const v = r.trap && num(r.trap[key]) ? r.trap[key] : r.kmh && num(r.kmh[key]) ? r.kmh[key] : null;
    return secs(r.et[key]) + (v === null ? '' : ' @ ' + speedText(v, unit, 1));
}

/* the short list on the right of the staging, tree and run pages */
function sidePanel(cv, m, r, title, live) {
    const x = 1036, y = 96, w = 540, h = 400;
    panel(cv, x, y, w, h, title, r && r.demo ? 'DEMO' : '', true);
    if (!r) { cv.text('NO RUN YET', x + w / 2, y + 220, 20, DIM, { align: 'center', spacing: 3 }); return; }
    const mk = m.marks || {}, u = m.unit, et = r.et || {};
    const list = [
        ['REACTION', live && !num(r.rt) ? '-' : rtText(r), { hot: !!r.red, best: mk.rt }],
        ['60 FT', secs(et.ft60), { best: mk.ft60 }],
        u === 'kmh' ? ['0-100 KM/H', secs(et.kmh100), { best: mk.kmh100 }] : ['0-60 MPH', secs(et.mph60), { best: mk.mph60 }],
        u === 'kmh' ? ['100-200 KM/H', secs(et.kmh100_200), { best: mk.kmh100_200 }] : ['0-100 MPH', secs(et.mph100), { best: mk.mph100 }],
        ['1/8 MILE', distValue(r, 'mi8', u), { best: mk.mi8 }],
        ['1/4 MILE', distValue(r, 'mi4', u), { best: mk.mi4 }],
        ['PEAK ' + unitName(u), speedText(r.peakKmh, u, 0), {}],
    ];
    list.forEach((l, i) => row(cv, x + 24, y + 48 + i * 48, w - 48, l[0], l[1], live ? { hot: l[2].hot } : l[2]));
}

function check(cv, y, label, value, state) {
    const c = state === 'ok' ? TEXT : state === 'no' ? RED : DIM;
    cv.fillRect(366, y - 18, 18, 18, state === 'ok' ? TEXT : OFF);
    cv.strokeRoundRect(366, y - 18, 18, 18, 0, 2, c);
    cv.text(label, 400, y, 22, state === 'no' ? RED : MID, { spacing: 2 });
    cv.text(value, 1000, y + 2, 30, c, { align: 'right', font: 'bold' });
}

function staging(cv, m) {
    const rd = m.ready || {};
    header(cv, m, 'STAGING');
    treePanel(cv, m);
    const head = m.waiting ? 'WAITING FOR THE CAR' : rd.all ? 'READY TO STAGE' : 'NOT READY';
    cv.text(head, 366, 168, 56, rd.all ? TEXT : DIM, { font: 'bold', spacing: 2 });
    cv.text(m.hint || (rd.all ? 'ARM WITH THE ARM / RESET BUTTON' + (m.wheel ? ', OR PRESS THE ROLLER ON THE WHEEL' : '') : 'STOP, SELECT DRIVE, ENGINE RUNNING'),
        366, 204, 17, m.hint || rd.all ? RED : DIM, { spacing: 2 });
    check(cv, 276, 'STOPPED', num(rd.kmh) ? speedText(rd.kmh, m.unit, 0) + ' ' + unitName(m.unit) : '-', rd.stopped === null ? 'none' : rd.stopped ? 'ok' : 'no');
    check(cv, 336, 'IN GEAR', rd.gearText || '-', rd.gear === 'ok' ? 'ok' : rd.gear === 'no' ? 'no' : 'none');
    check(cv, 396, 'ENGINE RUNNING', num(rd.rpm) ? Math.round(rd.rpm / 10) * 10 + ' RPM' : '-', rd.engine === null ? 'none' : rd.engine ? 'ok' : 'no');
    if (rd.gear === 'unknown') cv.text('THE CAR DOES NOT REPORT THE GEAR: ARMING IS ALLOWED WITHOUT IT', 366, 428, 14, DIM, { spacing: 1 });
    cv.text('THIS APP ONLY MEASURES. IT ARMS AND CHANGES NOTHING ON THE CAR.', 366, 462, 15, DIM, { spacing: 1 });
    cv.text('CLOSED COURSES AND PRIVATE LAND ONLY.', 366, 486, 15, DIM, { spacing: 1 });
    sidePanel(cv, m, m.lastRun, 'LAST RUN', false);
}

function tree(cv, m) {
    const L = m.lights || {};
    header(cv, m, 'TREE');
    treePanel(cv, m);
    if (L.red) cv.text('RED LIGHT', 683, 300, 110, RED, { align: 'center', font: 'bold', spacing: 4 });
    else if (L.green) cv.text('GO', 683, 340, 230, GREEN, { align: 'center', font: 'bold', spacing: 8 });
    else {
        cv.text('WAIT FOR GREEN', 683, 290, 70, TEXT, { align: 'center', font: 'bold', spacing: 4 });
        cv.text(m.tree === 'pro' ? 'ALL THREE AMBERS, THEN GREEN 0.4 S LATER' : 'THREE AMBERS 0.5 S APART, THEN GREEN', 683, 336, 17, DIM, { align: 'center', spacing: 2 });
    }
    cv.text('ARM / RESET CANCELS', 683, 470, 16, DIM, { align: 'center', spacing: 2 });
    sidePanel(cv, m, m.lastRun, 'LAST RUN', false);
}

function run(cv, m) {
    const v = m.view || {}, u = m.unit;
    header(cv, m, m.lights && m.lights.red ? 'RUN // RED LIGHT' : 'RUN');
    treePanel(cv, m);
    revBar(cv, 366, 100, 634, 22, 32, m.rpm, m.shiftRpm, m.blinkOn, 4);
    cv.text(m.rollout && !(v.elapsed > 0) ? 'ROLLING OUT THE FIRST FOOT' : 'ELAPSED, SECONDS', 683, 160, 17, DIM, { align: 'center', spacing: 3 });
    cv.text(num(v.elapsed) ? v.elapsed.toFixed(2) : '0.00', 683, 322, 180, TEXT, { align: 'center', font: 'bold' });
    cv.text(speedText(v.kmh, u, 0), 520, 410, 64, TEXT, { align: 'right', font: 'bold' });
    cv.text(unitName(u), 534, 410, 20, DIM, { spacing: 2 });
    const d = num(v.distM) ? (u === 'kmh' ? Math.round(v.distM) + '' : Math.round(v.distM / FT) + '') : '-';
    cv.text(d, 860, 410, 64, TEXT, { align: 'right', font: 'bold' });
    cv.text(u === 'kmh' ? 'M' : 'FT', 874, 410, 20, DIM, { spacing: 2 });
    cv.text(m.gearText || '', 1000, 410, 40, RED, { align: 'right', font: 'bold' });
    if (v.last) cv.text(v.last.label + '   ' + secs(v.last.s), 683, 476, 30, RED, { align: 'center', font: 'bold', spacing: 2 });
    sidePanel(cv, m, { rt: m.rt, red: m.lights && m.lights.red, et: v.et || {}, kmh: v.speeds || {}, trap: v.trap || {}, peakKmh: v.peakKmh, demo: m.demo }, 'THIS RUN', true);
}

function slip(cv, m) {
    const r = m.result, u = m.unit, mk = m.marks || {}, et = (r && r.et) || {};
    header(cv, m, r && r.aborted ? 'NO TIME' : 'TIMESLIP');
    panel(cv, 24, 96, 396, 384, r.demo ? 'DEMO RUN' : 'THIS RUN', r.when || '', false);
    const hd = m.headline;
    if (hd) {
        cv.text(hd.label + ', SECONDS', 222, 176, 17, MID, { align: 'center', spacing: 3 });
        cv.text(secs(hd.s), 222, 292, 124, RED, { align: 'center', font: 'bold' });
        const at = distValue(r, hd.key, u);
        if (at.indexOf('@') > 0) cv.text(at.slice(at.indexOf('@')) + ' ' + unitName(u), 222, 334, 28, TEXT, { align: 'center', font: 'bold' });
        if (mk[hd.key]) { cv.fillRect(152, 350, 140, 30, RED); cv.text('NEW BEST', 222, 372, 17, BG, { align: 'center', font: 'bold', spacing: 3 }); }
    } else {
        cv.text('NO SPLIT REACHED', 222, 250, 30, DIM, { align: 'center', font: 'bold', spacing: 2 });
        cv.text('THE RUN ENDED BEFORE 60 FT OR 30 MPH', 222, 286, 14, DIM, { align: 'center', spacing: 1 });
    }
    if (r.red) { cv.fillRect(44, 392, 356, 40, DEEP); cv.strokeRoundRect(44, 392, 356, 40, 0, 2, RED); cv.text('RED LIGHT: MOVED BEFORE GREEN', 222, 419, 17, RED, { align: 'center', font: 'bold', spacing: 2 }); }
    else cv.text('REACTION ' + rtText(r) + ' S', 222, 420, 24, TEXT, { align: 'center', font: 'bold', spacing: 2 });
    const ends = { lift: 'ENDED: LIFTED', stopped: 'ENDED: STOPPED', cap: 'ENDED: 60 S LIMIT', complete: 'ENDED: EVERY SPLIT IN' };
    cv.text((ends[r.end] || '') + (m.saved === false ? '  //  NOT SAVED' : ''), 222, 462, 14, DIM, { align: 'center', spacing: 2 });

    const A = [
        ['REACTION', rtText(r), { hot: !!r.red, best: mk.rt }],
        ['60 FT', secs(et.ft60), { best: mk.ft60 }],
        ['330 FT', secs(et.ft330), { best: mk.ft330 }],
        ['1/8 MILE', distValue(r, 'mi8', u), { best: mk.mi8 }],
        ['1000 FT', secs(et.ft1000), { best: mk.ft1000 }],
        ['1/4 MILE', distValue(r, 'mi4', u), { best: mk.mi4 }],
        ['1/2 MILE', distValue(r, 'mi2', u), { best: mk.mi2 }],
        ['1 MILE', distValue(r, 'mi1', u), { best: mk.mi1 }],
    ];
    const B = [
        ['0-30 MPH', secs(et.mph30), { best: mk.mph30 }],
        ['0-60 MPH', secs(et.mph60), { best: mk.mph60 }],
        ['0-100 MPH', secs(et.mph100), { best: mk.mph100 }],
        ['60-130 MPH', secs(et.mph60_130), { best: mk.mph60_130 }],
        ['0-100 KM/H', secs(et.kmh100), { best: mk.kmh100 }],
        ['100-200 KM/H', secs(et.kmh100_200), { best: mk.kmh100_200 }],
        ['PEAK SPEED, ' + unitName(u), speedText(r.peakKmh, u, 1), {}],
        ['PEAK RPM', num(r.peakRpm) ? String(Math.round(r.peakRpm / 10) * 10) : '-', {}],
    ];
    A.forEach((l, i) => row(cv, 448, 96 + i * 48, 540, l[0], l[1], l[2]));
    B.forEach((l, i) => row(cv, 1036, 96 + i * 48, 540, l[0], l[1], l[2]));
    cv.fillRect(448, 480, 540, 1, SOFT); cv.fillRect(1036, 480, 540, 1, SOFT);
    cv.text('SPEED-SENSOR TIMING, NOT GPS VERIFIED', 24, 508, 15, MID, { spacing: 2 });
    /* from the run's data log (runlog.js): how hard it pulled and whether the wheels ran ahead of the car */
    if (r.logLine) cv.text(String(r.logLine).slice(0, 90), 222, 444, 12, MID, { align: 'center', spacing: 1 });
    cv.text(r.rollout ? '1 FT ROLLOUT ON: THE CLOCK STARTS AFTER THE FIRST FOOT' : 'ROLLOUT OFF: THE CLOCK STARTS AT FIRST MOVEMENT',
        1576, 508, 15, MID, { align: 'right', spacing: 2 });
}

const HIST_COLS = [
    ['WHEN', 24, 'left'], ['TREE', 250, 'left'], ['ROLLOUT', 400, 'left'], ['RT', 560, 'right'], ['60 FT', 690, 'right'],
    ['0-60', 820, 'right'], ['0-100', 950, 'right'], ['1/8', 1080, 'right'], ['1/4', 1210, 'right'], ['TRAP', 1370, 'right'], ['PEAK', 1576, 'right'],
];
const HIST_ROWS = 9;

function historyPage(cv, m) {
    const h = m.history || { runs: [], page: 0 }, u = m.unit;
    const pages = Math.max(1, Math.ceil(h.runs.length / HIST_ROWS)), page = Math.min(h.page || 0, pages - 1);
    header(cv, m, 'HISTORY');
    HIST_COLS.forEach((c) => cv.text(c[0] === 'TRAP' || c[0] === 'PEAK' ? c[0] + ' ' + unitName(u) : c[0], c[1], 112, 15, DIM, { align: c[2], spacing: 2 }));
    cv.fillRect(24, 122, 1552, 1, LINE);
    const line = (y, cells, colours, tag) => {
        cells.forEach((s, i) => cv.text(s, HIST_COLS[i][1], y, i === 0 ? 19 : 22, colours[i] || TEXT, { align: HIST_COLS[i][2], font: i === 0 ? undefined : 'bold' }));
        if (tag) cv.text(tag, 1576, y - 22, 11, RED, { align: 'right', spacing: 2 });
    };
    const b = h.bests || {};
    const any = Object.keys(b).length > 0;
    line(156, ['BEST OF EACH', '', m.rollout ? '1 FT' : 'OFF', secs(b.rt), secs(b.ft60), secs(b.mph60), secs(b.mph100), secs(b.mi8), secs(b.mi4), '', ''],
        [RED, null, MID, any ? RED : DIM, any ? RED : DIM, any ? RED : DIM, any ? RED : DIM, any ? RED : DIM, any ? RED : DIM]);
    cv.fillRect(24, 168, 1552, 1, LINE);
    if (!h.runs.length) cv.text('NO RUNS SAVED YET', 800, 320, 24, DIM, { align: 'center', spacing: 3 });
    h.runs.slice(page * HIST_ROWS, page * HIST_ROWS + HIST_ROWS).forEach((r, i) => {
        const y = 202 + i * 34, et = r.et || {}, mk = r.marks || {};
        const col = (k) => (mk[k] ? RED : !num(et[k]) ? DIM : TEXT);
        line(y, [r.when || '', r.tree === 'pro' ? 'PRO' : 'SPORTSMAN', r.rollout ? '1 FT' : 'OFF', rtText(r), secs(et.ft60), secs(et.mph60), secs(et.mph100), secs(et.mi8), secs(et.mi4),
            speedText(r.trap && num(r.trap.mi4) ? r.trap.mi4 : r.trap && num(r.trap.mi8) ? r.trap.mi8 : null, u, 1), speedText(r.peakKmh, u, 0)],
        [r.demo ? DIM : MID, DIM, r.rollout ? RED : DIM, r.red ? RED : mk.rt ? RED : TEXT, col('ft60'), col('mph60'), col('mph100'), col('mi8'), col('mi4'), TEXT, TEXT]);
        if (r.demo) cv.text('DEMO', 170, y, 12, RED, { spacing: 2 });
        else if (r.red) cv.text('RED', 170, y, 12, RED, { spacing: 2 });
        cv.fillRect(24, y + 11, 1552, 1, SOFT);
    });
    cv.text('RED = BEST AMONG RUNS WITH THE SAME ROLLOUT SETTING.  ARM / RESET: OLDER RUNS.  HISTORY: BACK.', 24, 512, 14, DIM, { spacing: 1 });
    cv.text((h.runs.length ? (page * HIST_ROWS + 1) + '-' + Math.min(h.runs.length, (page + 1) * HIST_ROWS) + ' OF ' + h.runs.length : '0 RUNS') + '  //  NO PLACE IS EVER RECORDED',
        1576, 512, 14, MID, { align: 'right', spacing: 1 });
}

function notice(cv, m) {
    header(cv, m, 'BEFORE THE FIRST RUN');
    panel(cv, 200, 110, 1200, 372, 'PLEASE READ', 'SHOWN ONCE', false);
    const lines = [
        [TEXT, 30, 'THIS APP ONLY MEASURES.'],
        [MID, 21, 'It reads the car\'s speed and engine speed and draws a countdown and a timeslip.'],
        [MID, 21, 'It does not arm launch control, change traction settings, or control the car in any way.'],
        [TEXT, 30, 'CLOSED COURSES AND PRIVATE LAND ONLY.'],
        [MID, 21, 'Obey the law where you are. Never time a run on a public road.'],
        [MID, 21, 'Times come from the speed sensor, not from GPS or a timing beam: treat them as a guide.'],
    ];
    let y = 186;
    lines.forEach((l) => { y += l[1] > 24 ? 14 : 0; cv.text(l[2], 240, y, l[1], l[0], l[1] > 24 ? { font: 'bold', spacing: 2 } : undefined); y += l[1] > 24 ? 40 : 34; });
    cv.text('PRESS ARM / RESET TO ACCEPT', 800, 462, 20, RED, { align: 'center', font: 'bold', spacing: 3 });
}

/** One frame of the centre screen. m.page: 'main' | 'history'; m.phase: 'staging' | 'tree' | 'run' | 'slip'. */
function centre(cv, m) {
    if (m.notice) return notice(cv, m);
    if (m.page === 'history') return historyPage(cv, m);
    if (m.phase === 'tree') return tree(cv, m);
    if (m.phase === 'run') return run(cv, m);
    if (m.phase === 'slip' && m.result) return slip(cv, m);
    return staging(cv, m);
}

/* ---------------- the small pictures ---------------- */

/* four lamps in a row: three ambers and the green; all red on a red light */
function lampRow(cv, x, y, w, h, gap, L, round) {
    const lw = (w - 3 * gap) / 4;
    for (let i = 0; i < 4; i++) {
        const on = L.red ? true : i < 3 ? !!(L.ambers && L.ambers[i]) : !!L.green;
        const c = L.red ? RED : i < 3 ? AMBER : GREEN;
        const lx = x + i * (lw + gap);
        if (round) cv.circle(lx + lw / 2, y + h / 2, Math.min(lw, h) / 2, on ? c : '#1c1c22');      /* lamps, as on a real tree */
        else cv.fillRect(lx, y, lw, h, on ? c : '#26262c');
    }
}

/**
 * The head-up display picture (HUD.w x HUD.h). Black reads as clear glass, so only lamps, digits and a bar.
 * s = { phase: 'tree' | 'run' | 'done', lights, elapsed, kmh, unit, last, rpm, shiftRpm, shift (draw the rev
 *       bar: true, false or 'under'), headline, at (the speed at the headline mark, as text), rt, red }
 */
function hud(cv, s) {
    const w = cv.w, h = cv.h;
    cv.clear('#000000');
    if (s.phase === 'tree') {
        const L = s.lights || {};
        lampRow(cv, 20, 18, w - 40, 58, 14, L);
        cv.text(L.red ? 'RED LIGHT' : L.green ? 'GO' : 'WAIT FOR GREEN', w / 2, 110, 26, L.red ? RED : L.green ? GREEN : '#ffffff', { align: 'center', font: 'bold', spacing: 3 });
        return;
    }
    if (s.phase === 'done') {
        const hd = s.headline;
        cv.text(hd ? hd.label : 'NO TIME', 10, 30, 22, '#c9cad0', { font: 'bold', spacing: 2 });
        cv.text(s.red ? 'RED LIGHT' : 'RT ' + (num(s.rt) ? s.rt.toFixed(2) : '-'), w - 10, 30, 22, s.red ? RED : '#c9cad0', { align: 'right', font: 'bold', spacing: 1 });
        cv.text(hd ? secs(hd.s) : '-', 10, 106, 76, '#ffffff', { font: 'bold' });
        if (s.at) cv.text('@ ' + s.at, w - 10, 100, 34, '#ffffff', { align: 'right', font: 'bold' });
        return;
    }
    /* past the shift point the bar is all red; with the flash layer over it ('under') it goes dark there
     * instead, and the flash layer's red bar blinks on top without a pixel being sent */
    if (s.shift) revBar(cv, 8, 4, w - 16, 16, 24, s.rpm, s.shiftRpm, s.shift !== 'under', 3);
    cv.text(num(s.elapsed) ? s.elapsed.toFixed(2) : '0.00', 10, 92, 74, '#ffffff', { font: 'bold' });
    cv.text(speedText(s.kmh, s.unit, 0), w - 10, 78, 52, '#ffffff', { align: 'right', font: 'bold' });
    cv.text(unitName(s.unit), w - 10, 100, 16, '#c9cad0', { align: 'right', spacing: 2 });
    if (s.red) cv.text('RED LIGHT', 10, 118, 20, RED, { font: 'bold', spacing: 2 });
    else if (s.last) cv.text(s.last.label + '  ' + secs(s.last.s), 10, 118, 20, RED, { font: 'bold', spacing: 1 });
}

/** The instrument cluster picture (CLUSTER.w x CLUSTER.h): a black box with brackets, same content as the HUD. */
function cluster(cv, s) {
    const w = cv.w, h = cv.h;
    cv.clear('#000000');
    /* s.bare: in the whole-cluster tunnel, which is its frame; nothing boxed in */
    if (!s.bare) {
        cv.strokeRoundRect(1, 1, w - 2, h - 2, 0, 1, LINE);
        brackets(cv, 2, 2, w - 4, h - 4, 16, RED);
        cv.text('LAUNCH', 14, 28, 15, DIM, { spacing: 3 });
    }
    if (s.phase === 'tree') {
        const L = s.lights || {};
        lampRow(cv, 22, 54, w - 44, 70, 12, L, !!s.bare);
        cv.text(L.red ? 'RED LIGHT' : L.green ? 'GO' : 'WAIT FOR GREEN', w / 2, 168, 26, L.red ? RED : L.green ? GREEN : TEXT, { align: 'center', font: 'bold', spacing: 3 });
        return;
    }
    if (s.phase === 'done') {
        const hd = s.headline;
        cv.text(s.red ? 'RED LIGHT' : 'RT ' + (num(s.rt) ? s.rt.toFixed(2) : '-'), w - 14, 28, 15, s.red ? RED : DIM, { align: 'right', spacing: 2 });
        cv.text(hd ? hd.label : 'NO TIME', w / 2, 62, 18, MID, { align: 'center', spacing: 3 });
        cv.text(hd ? secs(hd.s) : '-', w / 2, 140, 84, RED, { align: 'center', font: 'bold' });
        if (s.at) cv.text('@ ' + s.at, w / 2, 182, 26, TEXT, { align: 'center', font: 'bold' });
        return;
    }
    if (s.red) cv.text('RED LIGHT', w - 14, 28, 15, RED, { align: 'right', spacing: 2 });
    cv.text(num(s.elapsed) ? s.elapsed.toFixed(2) : '0.00', w / 2, 118, 88, TEXT, { align: 'center', font: 'bold' });
    /* in the whole-cluster tunnel the speed has a gauge of its own on the left */
    if (!s.bare) cv.text(speedText(s.kmh, s.unit, 0) + ' ' + unitName(s.unit), w / 2, 154, 26, TEXT, { align: 'center', font: 'bold', spacing: 1 });
    if (s.last) cv.text(s.last.label + '  ' + secs(s.last.s), w / 2, 186, 20, RED, { align: 'center', font: 'bold', spacing: 1 });
}

/*
 * The whole-cluster backdrop (BACK.w x BACK.h, shown stretched over PANEL_BACK, the panel above the gear strip): a lit road
 * running to a bright horizon, with streaks of light in the sky.
 * Spokes run from the middle to the edges and rings travel outwards along them, faster with the car's speed;
 * blue normally, red at the shift point and on a red light. Drawn small because it is sent many times a second
 * and the cluster's upload budget is shared: lines this soft lose nothing by being stretched. The spokes never
 * move, so they are drawn once per colour and copied; a frame is then only the rings.
 * b = { phase: rings travelled (any number), hot: red instead of blue }
 */
/* It stops at y 646: the strip under that holds the car's gear letter, and the cluster draws black boxes of its
 * own over anything that covers it (seen on this car on 2026-11-14, and reported by others for M cars). */
const PANEL_BACK = { x: 0, y: 0, w: 1920, h: 646 };
const BACK = { w: 400, h: 135 }, RINGS = 8, COOL = [25, 230, 255], HOT = [255, 31, 61];
/* kept dark: the run's picture and the pop-up under it (down to the gear strip), with a margin that fades */
const BACK_CLEAR = { x: PANEL_MAIN.x - 20, y: PANEL_MAIN.y - 20, w: PANEL_MAIN.w + 40 }, BACK_FADE = 6, BACK_FADE_PX = 14;
const BACK_VP = (PANEL_MAIN.x + PANEL_MAIN.w / 2) / PANEL_SIZE.w;      /* the tunnel's far end: behind the run's own picture, which is a little right of the middle */
const backBases = {};
const HORIZON = 0.385;                 /* how far down the picture the horizon lies */
const GLOW = [255, 60, 160];           /* the light behind the horizon */
/* streaks of light in the sky, each [lane 0..1 across the sky's height, where along its way 0..1, side -1 or 1, brightness] */
const STREAKS = [];
(function () { let seed = 11; const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; for (let i = 0; i < 22; i++) STREAKS.push([r(), r(), i % 2 ? 1 : -1, 60 + Math.round(r() * 110)]); })();
function backBase(cv, hot) {
    const key = (hot ? 'h' : 'c') + cv.w + 'x' + cv.h;
    if (backBases[key]) return backBases[key];
    const w = cv.w, h = cv.h, cx = w * BACK_VP, hz = Math.round(h * HORIZON), c = hot ? HOT : COOL, g = hot ? HOT : GLOW, b = new cv.constructor(w, h);
    b.clear('#000000');
    for (let y = 0; y < hz; y++) { const t = y / hz; b.fillRect(0, y, w, 1, [g[0], g[1], g[2], Math.round(80 * t * t * t)]); }       /* the glow rises to the horizon */
    for (let k = -14; k <= 14; k++) b.line(cx + k * w / 54, hz + 1, cx + k * w / 6.8, h, 1, [c[0], c[1], c[2], 140]);                 /* the road's lines run to the far end */
    b.fillRect(0, hz - 1, w, 1, [255, 255, 255, 235]);
    b.fillRect(0, hz, w, 2, [c[0], c[1], c[2], 210]);
    backBases[key] = b;
    return b;
}
function backdrop(cv, b) {
    const w = cv.w, h = cv.h, cx = w * BACK_VP, hz = Math.round(h * HORIZON), hot = !!(b && b.hot), c = hot ? HOT : COOL;
    const phase = b && num(b.phase) ? b.phase : 0, turn = (((phase % RINGS) + RINGS) % RINGS) / RINGS;      /* 0..1 once round */
    cv.d.set(backBase(cv, hot).d);
    /* the road's cross lines come towards the car: close together far away, wide apart and bright near */
    for (let i = 0; i < RINGS; i++) {
        const u = ((((i + phase) % RINGS) + RINGS) % RINGS) / RINGS;
        cv.fillRect(0, hz + 2 + (h - hz - 2) * u * u, w, u > 0.6 ? 2 : 1, [c[0], c[1], c[2], Math.round(50 + 200 * u)]);
    }
    /* the sky's streaks fly outwards from the far end, longer the further out they are */
    STREAKS.forEach((k) => {
        const p = (k[1] + turn * 2) % 1, reach = k[2] > 0 ? w - cx : cx, x = cx + k[2] * reach * (0.08 + 0.92 * p * p), len = 3 + 26 * p;
        cv.fillRect(k[2] > 0 ? x : x - len, 2 + k[0] * (hz - 10), len, 1, [255, 255, 255, Math.round(k[3] * (0.3 + 0.7 * p))]);
    });
    /* the middle, where the run's own pictures sit, is kept dark: no line runs into the numbers, and the edge
     * of those pictures cannot be seen. Black laid on in steps, so the scene fades out instead of being cut. */
    const sx = w / PANEL_BACK.w, sy = h / PANEL_BACK.h;
    for (let i = BACK_FADE; i >= 0; i--) {
        const x0 = (BACK_CLEAR.x - i * BACK_FADE_PX) * sx, y0 = (BACK_CLEAR.y - i * BACK_FADE_PX) * sy, x1 = (BACK_CLEAR.x + BACK_CLEAR.w + i * BACK_FADE_PX) * sx;
        cv.fillRect(x0, y0, x1 - x0, h - y0, [0, 0, 0, i ? 80 : 255]);
    }
}

/*
 * The whole cluster's own gauges. The car takes its dials away while the scene is up, so the two things a
 * driver looks for there are drawn in their place: the speed on the left, the revs and the gear on the right.
 * Each is a ring of light that fills with the reading, drawn small (WING.w x WING.h) and shown two and a half
 * times larger where the dial was.
 * s = { kmh, unit, rpm, shiftRpm, gear (a number, or nothing) }
 */
const WING = { w: 160, h: 160 };
const PANEL_WING_L = { x: 180, y: 110, w: 400, h: 400 }, PANEL_WING_R = { x: 1440, y: 110, w: 400, h: 400 };
const ARC0 = 225, ARC1 = 495;          /* the ring, in degrees clockwise from straight up: open at the bottom, filling from lower left over the top */
const SPEED_FULL = { mph: 180, kmh: 300 };
function ring(cv, frac, colour, redFrom) {
    const cx = cv.w / 2, cy = cv.h / 2, sweep = ARC1 - ARC0;
    frac = num(frac) ? Math.max(0, Math.min(1, frac)) : 0;
    cv.d.fill(0);                                   /* clear outside the gauge: the scene shows round it */
    cv.circle(cx, cy, 79, '#04060a');
    cv.arc(cx, cy, 62, 73, ARC0, ARC1, '#161b24');
    if (num(redFrom) && redFrom < 1) cv.arc(cx, cy, 62, 73, ARC0 + sweep * Math.max(0, redFrom), ARC1, '#4a1220');
    if (frac > 0.004) cv.arc(cx, cy, 62, 73, ARC0, ARC0 + sweep * frac, colour);
    cv.arc(cx, cy, 76, 77.5, ARC0, ARC1, [COOL[0], COOL[1], COOL[2], 110]);
    for (let i = 0; i <= 6; i++) { const a = (ARC0 + sweep * i / 6) * Math.PI / 180; cv.line(cx + Math.sin(a) * 54, cy - Math.cos(a) * 54, cx + Math.sin(a) * 60, cy - Math.cos(a) * 60, 1.5, DIM); }
}
/** what the speed gauge would show, as text: drawn again only when this changes */
function wingSpeedKey(s) { return speedText(s && s.kmh, s && s.unit, 0) + '|' + unitName(s && s.unit); }
function wingSpeed(cv, s) {
    const v = speedIn(s && s.kmh, s && s.unit);
    ring(cv, v === null ? 0 : v / SPEED_FULL[s && s.unit === 'kmh' ? 'kmh' : 'mph'], '#19e6ff');
    cv.text(speedText(s && s.kmh, s && s.unit, 0), cv.w / 2, 94, 46, TEXT, { align: 'center', font: 'bold' });
    cv.text(unitName(s && s.unit), cv.w / 2, 112, 11, DIM, { align: 'center', spacing: 3 });
}
/** the revs to the nearest hundred, whether it is at the shift point, and the gear */
function wingRevsKey(s) {
    const rpm = s && num(s.rpm) ? s.rpm : 0;
    return Math.round(rpm / 100) + '|' + (s && num(s.shiftRpm) && rpm >= s.shiftRpm ? 1 : 0) + '|' + (s && num(s.gear) && s.gear >= 1 ? s.gear : '');
}
function wingRevs(cv, s) {
    const rpm = s && num(s.rpm) ? s.rpm : 0, shift = s && num(s.shiftRpm) ? s.shiftRpm : REDLINE, hot = rpm >= shift;
    ring(cv, rpm / REDLINE, hot ? RED : rpm >= shift - 1300 ? AMBER : TEXT, shift / REDLINE);
    cv.text((rpm / 1000).toFixed(1), cv.w / 2, 90, 40, hot ? RED : TEXT, { align: 'center', font: 'bold' });
    cv.text('RPM X1000', cv.w / 2, 106, 9, DIM, { align: 'center', spacing: 2 });
    cv.text(s && num(s.gear) && s.gear >= 1 ? String(s.gear) : '-', cv.w / 2, 146, 30, hot ? RED : TEXT, { align: 'center', font: 'bold' });
}

/**
 * The split pop-up (POP.w x POP.h): the mark just passed and its time, with the speed there when the timer has
 * one. Green when it beats the best on file, white otherwise.
 * p = { label, s, at (text or ''), best, bare (no box: in the whole-cluster tunnel) }
 */
function pop(cv, p) {
    const w = cv.w, h = cv.h, c = p.best ? GREEN : TEXT;
    cv.clear('#000000');
    if (!p.bare) cv.strokeRoundRect(1, 1, w - 2, h - 2, 0, 1, p.best ? GREEN : LINE);
    else cv.fillRect(12, 4, w - 24, 1, p.best ? GREEN : LINE);      /* a single rule between the run and its split */
    cv.text(String(p.label || ''), 12, 32, p.at ? 17 : 20, c, { font: 'bold', spacing: 1 });
    cv.text(secs(p.s) + (p.at ? '  @ ' + p.at : ''), w - 12, 33, p.at ? 20 : 26, c, { align: 'right', font: 'bold' });
}

module.exports = {
    pop, PANEL_SIZE, PANEL_STAGE, PANEL_MAIN, PANEL_POP, POP, backdrop, BACK, PANEL_BACK, RINGS, WING, PANEL_WING_L, PANEL_WING_R, wingSpeed, wingSpeedKey, wingRevs, wingRevsKey,
    centre, hud, cluster, distValue, speedText, unitName, secs, rtText,
    W, H, MAP_SAFE, HUD_WINDOW, HUD_SLOT, CLUSTER, HUD, FLASH, HIST_ROWS, REDLINE, RED,
};
