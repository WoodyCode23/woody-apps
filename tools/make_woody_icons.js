'use strict';
/**
 * make_woody_icons.js - the Woody Apps icon family.
 *
 * Every icon: black tile, red edge and red glow, a glowing white W across the top, and below it a picture
 * of what the app does in white and red. Writes apps/<id>/icon.png (140x140, what build.py packs and the
 * Store shows) and out_icons/sheet.png (all of them side by side, larger, to look at).
 *
 *   node tools/make_woody_icons.js
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const ROOT = path.join(__dirname, '..');
const S = 140;
const RED = '#e1001a', HOT = '#ff3344', WHITE = '#ffffff';
const DIM = withAlpha(WHITE, 0.3);
const rad = (d) => d * Math.PI / 180;
const pt = (cx, cy, r, a) => [cx + Math.sin(rad(a)) * r, cy - Math.cos(rad(a)) * r];

/* a soft glow behind a shape: wide faint strokes of the same path */
function glowLine(c, pts, colour, width) {
    [[width + 14, 0.06], [width + 9, 0.1], [width + 5, 0.16]].forEach(([w, a]) => c.polyline(pts, w, withAlpha(colour, a)));
    c.polyline(pts, width, colour);
}

/* the W, glowing, centred at cx,cy */
function W(c, cx, cy, w, h) {
    const x0 = cx - w / 2, x1 = cx + w / 2, top = cy - h / 2, bot = cy + h / 2;
    const pts = [[x0, top], [x0 + w * 0.22, bot], [cx, top + h * 0.4], [x1 - w * 0.22, bot], [x1, top]];
    [[18, 0.06], [13, 0.1], [9, 0.18]].forEach(([wd, a]) => c.polyline(pts, wd, withAlpha(WHITE, a)));
    c.polyline(pts, 5, WHITE);
}

function tile(c) {
    c.roundRect(2, 2, S - 4, S - 4, 26, '#000000');
    c.gradientRect(8, 64, S - 16, 68, [[0, withAlpha(RED, 0)], [1, withAlpha(RED, 0.28)]]);
    c.strokeRoundRect(2, 2, S - 4, S - 4, 26, 3, RED);
    c.strokeRoundRect(6, 6, S - 12, S - 12, 22, 1, withAlpha(RED, 0.35));
    c.circle(70, 28, 22, withAlpha(RED, 0.12));
    W(c, 70, 27, 50, 26);
}

/* ---------- one picture per app, in the area y 50..128 ---------- */
const PICS = {
    /* Woody Apps: a grid of apps with a download arrow */
    woodr_store(c) {
        [[34, 56], [62, 56], [34, 84], [62, 84]].forEach(([x, y], i) => c.roundRect(x, y, 22, 22, 6, i === 3 ? RED : WHITE));
        c.line(104, 56, 104, 92, 6, WHITE);
        c.triangle([[92, 86], [116, 86], [104, 102]], WHITE);
        c.fillRect(90, 108, 28, 5, RED);
    },
    /* Warm-Up HUD: a thermometer filling with red, heat rising */
    woodr_warmhud(c) {
        c.roundRect(56, 52, 18, 52, 9, WHITE);
        c.roundRect(60, 56, 10, 48, 5, '#000000');
        c.roundRect(61, 76, 8, 30, 4, RED);
        c.circle(65, 110, 14, WHITE);
        c.circle(65, 110, 9, RED);
        [0, 1, 2].forEach((k) => c.fillRect(78, 62 + k * 12, 10, 4, WHITE));
        glowLine(c, [[96, 108], [92, 98], [98, 88], [94, 78], [99, 66]], HOT, 4);
    },
    /* Dev HUD: progress bars, the way it draws them */
    woodr_devhud(c) {
        [[0.75, RED], [0.45, WHITE], [0.9, HOT]].forEach(([f, col], k) => {
            const y = 58 + k * 22;
            c.roundRect(26, y, 88, 12, 6, withAlpha(WHITE, 0.2));
            c.roundRect(26, y, Math.round(88 * f), 12, 6, col);
        });
    },
    /* Screen Lab: a screen with a calibration grid and crosshair */
    woodr_screenlab(c) {
        c.strokeRoundRect(26, 54, 88, 58, 6, 4, WHITE);
        for (let x = 40; x < 114; x += 14) c.line(x, 58, x, 108, 1, DIM);
        for (let y = 66; y < 112; y += 12) c.line(30, y, 110, y, 1, DIM);
        c.line(70, 60, 70, 106, 3, RED);
        c.line(32, 83, 108, 83, 3, RED);
        c.arc(70, 83, 9, 12, 0, 360, RED);
        c.fillRect(56, 116, 28, 5, WHITE);
    },
    /* Input Lab: a steering wheel with a red button lit */
    woodr_inputlab(c) {
        c.arc(70, 88, 30, 37, 0, 360, WHITE);
        c.circle(70, 88, 10, WHITE);
        c.line(36, 92, 60, 90, 7, WHITE);
        c.line(104, 92, 80, 90, 7, WHITE);
        c.line(70, 98, 70, 120, 7, WHITE);
        c.circle(52, 98, 6, withAlpha(RED, 0.4));
        c.circle(52, 98, 4, HOT);
        c.circle(88, 98, 4, RED);
    },
    /* Ambient Lab: a glowing light strip (like the one along the dash and doors) casting light down */
    woodr_ambientlab(c) {
        const strip = [];
        for (let x = 26; x <= 114; x += 4) strip.push([x, 70 + Math.sin((x - 26) / 88 * Math.PI) * -8]);
        /* the light it throws: a soft red cone, brightest near the strip */
        for (let k = 0; k < 6; k++) {
            const y0 = 72 + k * 8, sp = 6 + k * 5;
            c.convex([[30 - sp * 0.3, y0], [110 + sp * 0.3, y0], [112 + sp * 0.3, y0 + 8], [28 - sp * 0.3, y0 + 8]], withAlpha(RED, 0.30 - k * 0.045));
        }
        glowLine(c, strip, HOT, 6);
        c.polyline(strip, 2, WHITE);
        /* three lit points on the strip */
        [40, 70, 100].forEach((x) => { c.circle(x, 70 + Math.sin((x - 26) / 88 * Math.PI) * -8, 4, WHITE); });
        c.fillRect(30, 118, 80, 4, withAlpha(WHITE, 0.25));
    },
    /* Ambient Studio: a palette of the car's colours around a lit centre */
    woodr_ambient(c) {
        const cols = ['#e1001a', '#2fd27a', '#2a6cff', '#ff4dc4', '#ff8a1a', '#ffffff'];
        cols.forEach((col, k) => {
            const [x, y] = pt(70, 90, 28, k * 60);
            c.circle(x, y, 12, withAlpha(col, 0.25));
            c.circle(x, y, 8, col);
        });
        c.circle(70, 90, 10, withAlpha(WHITE, 0.2));
        c.circle(70, 90, 6, WHITE);
    },
    /* Woody HUD: a windshield with a menu on it, the picked row in red, a red shift frame round it */
    woodr_hud(c) {
        c.convex([[30, 58], [110, 58], [118, 116], [22, 116]], withAlpha(WHITE, 0.08));
        c.strokeRoundRect(38, 64, 64, 46, 6, 3, HOT);
        c.fillRect(46, 72, 48, 6, withAlpha(WHITE, 0.55));
        c.roundRect(44, 82, 52, 9, 3, RED);
        c.fillRect(46, 96, 40, 6, withAlpha(WHITE, 0.55));
    },
    /* Woody Dashcam: a camera body and lens, a red REC dot, a loop arrow */
    woodr_dashcam(c) {
        c.roundRect(32, 64, 64, 44, 8, WHITE);
        c.triangle([[96, 78], [116, 66], [116, 106]], WHITE);
        c.triangle([[96, 94], [116, 66], [116, 106]], WHITE);
        c.circle(56, 86, 14, '#000000');
        c.circle(56, 86, 9, withAlpha(WHITE, 0.6));
        c.circle(84, 74, 6, RED);
        c.circle(84, 74, 10, withAlpha(RED, 0.3));
        c.arc(64, 118, 18, 22, 100, 300, withAlpha(HOT, 0.8));
    },
    /* Drive Log: a line chart being written, with a red pen point */
    woodr_drivelog(c) {
        c.line(28, 56, 28, 116, 3, withAlpha(WHITE, 0.5));
        c.line(28, 116, 114, 116, 3, withAlpha(WHITE, 0.5));
        glowLine(c, [[32, 104], [48, 96], [60, 100], [74, 78], [88, 84], [104, 62]], WHITE, 3);
        c.circle(104, 62, 7, withAlpha(RED, 0.4));
        c.circle(104, 62, 4, HOT);
    },
    /* Home Assistant: a house with a lit red door and a signal over it */
    woodr_hass(c) {
        c.triangle([[30, 86], [70, 54], [110, 86]], WHITE);
        c.triangle([[40, 84], [70, 61], [100, 84]], '#000000');
        c.strokeRoundRect(40, 84, 60, 36, 2, 5, WHITE);
        c.roundRect(62, 98, 16, 22, 2, RED);
        c.circle(74, 109, 2, WHITE);
        c.arc(100, 60, 8, 11, -50, 50, HOT);
        c.arc(100, 60, 15, 18, -50, 50, withAlpha(HOT, 0.6));
    },
    /* Vitals: a heartbeat across a gauge */
    woodr_vitals(c) {
        c.arc(70, 100, 34, 39, -100, 100, withAlpha(WHITE, 0.4), { round: true });
        glowLine(c, [[22, 92], [46, 92], [54, 74], [64, 112], [74, 62], [84, 100], [92, 92], [118, 92]], HOT, 4);
    },
};

function icon(id) {
    const c = new Canvas(S, S);
    tile(c);
    PICS[id](c);
    return c;
}

const keys = Object.keys(PICS), cols = 4, cell = S * 2 + 20;
const sheet = new Canvas(cols * cell + 20, Math.ceil(keys.length / cols) * cell + 20);
sheet.clear('#1b1b1f');
keys.forEach((id, i) => {
    const c = icon(id);
    const dir = path.join(ROOT, 'apps', id);
    if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'icon.png'), c.png(9));
    sheet.drawImage(c.d, S, S, 20 + (i % cols) * cell, 20 + Math.floor(i / cols) * cell, S * 2, S * 2);
});
fs.mkdirSync(path.join(ROOT, 'out_icons'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out_icons', 'sheet.png'), sheet.png());
console.log('icons: ' + keys.join(', '));
