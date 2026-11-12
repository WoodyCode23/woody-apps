'use strict';
/**
 * make_brand_icons.js - one icon.png per app, all in the BimmerApps mark's style.
 *
 *   node tools/make_brand_icons.js [outDir]      default: writes apps/<id>/icon.png for every app listed below
 *
 * The mark is a squared B inside four corner brackets with a row of four segments under it, the last one red.
 * Every app icon keeps the brackets and the segment row and swaps the B for its own white line drawing, so the
 * app menu reads as one family. 140x140, transparent, as the head unit's app tiles expect (kit/tools/make_icon.js).
 * An apps/<id>/icon.png wins over the app's iconGlyph at build time.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const W = '#f2f2f4', R = '#ff1f3d';
const ROOT = path.join(__dirname, '..', 'apps');

function frame(c) {
    const s = 20, m = 8, t = 4, e = 140 - m;
    c.line(m, m, m + s, m, t, W); c.line(m, m, m, m + s, t, W);
    c.line(e, m, e - s, m, t, W); c.line(e, m, e, m + s, t, W);
    c.line(m, e, m + s, e, t, W); c.line(m, e, m, e - s, t, W);
    c.line(e, e, e - s, e, t, W); c.line(e, e, e, e - s, t, W);
    for (let i = 0; i < 4; i++) c.fillRect(37 + i * 17, 112, 13, 11, i === 3 ? R : W);      /* the segment row */
}

/* each drawing lives in about x 30..110, y 24..100 */
const GLYPH = {
    mark(c) {      /* the B itself, for the store: bars with cut corners, as in the mark */
        c.fillRect(42, 26, 15, 76, W);                                   /* stem */
        c.fillRect(42, 26, 42, 14, W); c.fillRect(42, 57, 42, 14, W); c.fillRect(42, 88, 46, 14, W);   /* three bars */
        c.fillRect(80, 36, 14, 18, W); c.fillRect(84, 70, 14, 19, W);    /* the two bowls' right sides */
        c.triangle([[84, 26], [94, 36], [84, 36]], W); c.triangle([[80, 54], [94, 54], [84, 62]], W);
        c.triangle([[84, 61], [98, 70], [84, 70]], W); c.triangle([[88, 89], [98, 89], [88, 99]], W);
    },
    house(c) {
        c.polyline([[32, 62], [70, 28], [108, 62]], 7, W);
        c.polyline([[42, 58], [42, 98], [98, 98], [98, 58]], 7, W);
        c.fillRect(62, 72, 16, 26, R);
    },
    light(c) {     /* a lamp with rays */
        c.arc(70, 58, 15, 22, 0, 360, W);
        for (let a = 0; a < 360; a += 45) { const x = Math.sin(a * Math.PI / 180), y = -Math.cos(a * Math.PI / 180); c.line(70 + x * 30, 58 + y * 30, 70 + x * 40, 58 + y * 40, 6, a === 0 ? R : W); }
    },
    lab(c) {       /* a flask */
        c.polyline([[60, 26], [60, 54], [38, 96], [102, 96], [80, 54], [80, 26]], 7, W);
        c.line(54, 26, 86, 26, 7, W);
        c.fillRect(50, 80, 40, 8, R);
    },
    camera(c) {
        c.strokeRoundRect(30, 40, 80, 54, 6, 7, W);
        c.arc(70, 67, 11, 18, 0, 360, W);
        c.fillRect(46, 28, 22, 10, W);
        c.circle(98, 52, 5, R);
    },
    bars(c) {      /* progress bars */
        [[30, 34, 78], [30, 56, 52], [30, 78, 66]].forEach((b, i) => { c.fillRect(b[0], b[1], 80, 12, '#f2f2f455'); c.fillRect(b[0], b[1], b[2], 12, i === 1 ? R : W); });
    },
    log(c) {       /* lines being written down */
        [34, 54, 74, 94].forEach((y, i) => { c.circle(36, y, 5, i === 3 ? R : W); c.line(50, y, i === 3 ? 84 : 108, y, 7, W); });
    },
    hud(c) {       /* a windscreen with something shown on it */
        c.polyline([[30, 96], [44, 30], [96, 30], [110, 96], [30, 96]], 7, W);
        c.fillRect(56, 54, 28, 8, R);
        c.fillRect(50, 72, 40, 8, W);
    },
    wheel(c) {     /* a steering wheel */
        c.arc(70, 62, 30, 38, 0, 360, W);
        c.circle(70, 62, 9, W);
        c.line(34, 62, 61, 62, 7, W); c.line(79, 62, 106, 62, 7, W); c.line(70, 71, 70, 98, 7, R);
    },
    grid(c) {      /* a test pattern */
        c.strokeRoundRect(30, 28, 80, 70, 4, 6, W);
        c.line(70, 30, 70, 96, 4, W); c.line(32, 63, 108, 63, 4, W);
        c.arc(70, 63, 12, 17, 0, 360, R);
    },
    pulse(c) {     /* a heartbeat */
        c.polyline([[26, 66], [48, 66], [58, 38], [72, 94], [84, 54], [92, 66], [114, 66]], 7, W);
        c.circle(84, 54, 6, R);
    },
    thermo(c) {    /* a thermometer */
        c.strokeRoundRect(60, 24, 20, 56, 10, 6, W);
        c.circle(70, 84, 16, W);
        c.circle(70, 84, 8, R);
        c.fillRect(67, 44, 6, 36, R);
        [36, 50, 64].forEach((y) => c.line(90, y, 104, y, 5, W));
    },
    gauge(c) {     /* a rev sweep */
        c.arc(70, 76, 40, 48, -120, 120, W, { round: true });
        c.arc(70, 76, 40, 48, 70, 120, R, { round: true });
        c.line(70, 76, 92, 50, 7, W);
        c.circle(70, 76, 8, W);
    },
    tree(c) {      /* launch: three lights and a line to cross */
        [40, 70, 100].forEach((x, i) => c.circle(x, 46, 12, i === 2 ? R : W));
        c.fillRect(30, 78, 80, 8, W);
        for (let i = 0; i < 5; i++) c.fillRect(30 + i * 17, 90, 9, 9, W);
    },
    scan(c) {      /* diagnostics: a checklist being looked over, one line flagged */
        c.polyline([[76, 58], [76, 28], [32, 28], [32, 98], [70, 98]], 6, W);
        c.line(44, 44, 64, 44, 6, W); c.line(44, 62, 60, 62, 6, R); c.line(44, 80, 56, 80, 6, W);
        c.arc(88, 76, 10, 16, 0, 360, W);
        c.line(99, 87, 110, 98, 7, W);
    },
};

const APPS = {
    woodr_store: 'mark', woodr_hass: 'house', woodr_ambient: 'light', woodr_ambientlab: 'lab', woodr_dashcam: 'camera',
    woodr_devhud: 'bars', woodr_drivelog: 'log', woodr_hud: 'hud', woodr_inputlab: 'wheel', woodr_screenlab: 'grid',
    woodr_vitals: 'pulse', woodr_warmhud: 'thermo', woodr_live: 'gauge', woodr_launch: 'tree',
    woodr_diag: 'scan',
};

const outDir = process.argv[2];
Object.keys(APPS).forEach((id) => {
    const dir = outDir || path.join(ROOT, id);
    if (!outDir && !fs.existsSync(dir)) return;          /* an app that is not in this checkout yet */
    const c = new Canvas(140, 140);
    frame(c);
    GLYPH[APPS[id]](c);
    const file = outDir ? path.join(outDir, id + '.png') : path.join(dir, 'icon.png');
    fs.writeFileSync(file, c.png(9));
    console.log(file);
});
