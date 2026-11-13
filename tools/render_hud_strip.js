'use strict';
/**
 * render_hud_strip.js - draw Woody HUD's song line and rev bar onto a full-size head-up display picture, on a PC.
 *
 *   node tools/render_hud_strip.js [outDir]
 *
 * The kit's preview shows only the centre screen, so this is how the head-up display strip is looked at before
 * it goes near the car. It uses the app's own drawing functions (apps/woodr_hud/strip.js) and the kit's
 * canvas, and outlines the display's visible window. It proves size, fit and colour, not what the car shows.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const api = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'strip'));

const out = path.resolve(process.argv[2] || 'out-hud');
fs.mkdirSync(out, { recursive: true });
const colourAt = (rpm) => (rpm >= 6300 ? '#ff1f3d' : rpm >= 5500 ? '#ffd34d' : '#e6e6ea');
const paste = (dst, srcCv, x, y) => {
    for (let r = 0; r < srcCv.h; r++) for (let c = 0; c < srcCv.w; c++) {
        const i = (r * srcCv.w + c) * 4, j = ((y + r) * dst.w + (x + c)) * 4;
        dst.d[j] = srcCv.d[i]; dst.d[j + 1] = srcCv.d[i + 1]; dst.d[j + 2] = srcCv.d[i + 2]; dst.d[j + 3] = 255;
    }
};

[['top', 3200, 'idle-ish'], ['top', 5800, 'yellow'], ['top', 6900, 'red'], ['slot', 5800, 'slot']].forEach((v) => {
    const g = api.PLACES[v[0]];
    const hud = new Canvas(800, 480).clear('#101014');
    hud.fillRect(120, 100, 570, 278, '#000000');                     /* the visible window */
    hud.strokeRoundRect(120, 100, 570, 278, 0, 1, '#444450');
    const song = new Canvas(g.song.w, g.song.h).clear('#000000');
    api.drawSong(song, g.song.w, g.song.h, { title: 'Sample Song Title That Is Fairly Long', artist: 'Sample Artist' });
    paste(hud, song, g.song.x, g.song.y);
    const bar = new Canvas(g.bar.w, g.bar.h).clear('#000000');
    api.drawBar(bar, g.bar.w, g.bar.h, Math.round(v[1] / api.RPM_FULL * api.SEGS), colourAt);
    paste(hud, bar, g.bar.x, g.bar.y);
    const file = path.join(out, 'hud-' + v[2] + '.png');
    fs.writeFileSync(file, hud.png(6));
    console.log(file);
});
