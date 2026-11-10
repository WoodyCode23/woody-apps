'use strict';
/**
 * make_woody_icons.js - the Woody Apps icon family: black tile, red edge and glow, a glowing white W,
 * and a short red label naming the app. Writes apps/<id>/icon.png (140x140, what build.py picks up)
 * and out_icons/sheet.png to look at them side by side.
 *
 *   node tools/make_woody_icons.js
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const ROOT = path.join(__dirname, '..');
const S = 140;
const RED = '#e1001a', DEEP = '#5a0008', WHITE = '#ffffff';

const APPS = {
    woodr_store: 'APPS',
    woodr_warmhud: 'WARM',
    woodr_devhud: 'DEV',
    woodr_screenlab: 'SCREEN',
    woodr_inputlab: 'INPUT',
    woodr_ambientlab: 'AMBIENT',
    woodr_hass: 'HOME',
    woodr_vitals: 'VITALS',
};

/* the W: two Vs, as a polyline, drawn first as wide faint strokes (the glow) then solid */
function W(c, cx, cy, w, h) {
    const x0 = cx - w / 2, x1 = cx + w / 2, top = cy - h / 2, bot = cy + h / 2;
    const pts = [[x0, top], [x0 + w * 0.22, bot], [cx, top + h * 0.38], [x1 - w * 0.22, bot], [x1, top]];
    [[26, 0.05], [20, 0.08], [15, 0.12], [11, 0.2]].forEach(([wd, a]) => c.polyline(pts, wd, withAlpha(WHITE, a)));
    c.polyline(pts, 7, WHITE);
}

function icon(label) {
    const c = new Canvas(S, S);
    /* tile: black, a red wash rising from the bottom, a thin red edge */
    c.roundRect(2, 2, S - 4, S - 4, 26, '#000000');
    c.gradientRect(8, 70, S - 16, 62, [[0, withAlpha(RED, 0)], [1, withAlpha(RED, 0.32)]]);
    c.strokeRoundRect(2, 2, S - 4, S - 4, 26, 3, RED);
    c.strokeRoundRect(6, 6, S - 12, S - 12, 22, 1, withAlpha(RED, 0.35));
    /* red glow under the W, then the W */
    c.circle(70, 60, 40, withAlpha(RED, 0.10));
    c.circle(70, 60, 26, withAlpha(RED, 0.12));
    W(c, 70, 58, 84, 52);
    /* the app's name */
    let size = 20;
    while (c.textWidth(label, size, { font: 'bold' }) > 112 && size > 12) size--;
    c.text(label, 70, 118, size, RED, { font: 'bold', align: 'center' });
    return c;
}

const sheetCols = 4, keys = Object.keys(APPS);
const sheet = new Canvas(sheetCols * (S + 20) + 20, Math.ceil(keys.length / sheetCols) * (S + 20) + 20);
sheet.clear('#1b1b1f');
keys.forEach((id, i) => {
    const c = icon(APPS[id]);
    const dir = path.join(ROOT, 'apps', id);
    if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'icon.png'), c.png(9));
    sheet.blit(c, 20 + (i % sheetCols) * (S + 20), 20 + Math.floor(i / sheetCols) * (S + 20));
});
fs.mkdirSync(path.join(ROOT, 'out_icons'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out_icons', 'sheet.png'), sheet.png());
console.log('icons: ' + keys.join(', '));
