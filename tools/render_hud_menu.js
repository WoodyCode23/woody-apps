'use strict';
/**
 * render_hud_menu.js - draw HUD's wheel menu, song and rev bar onto a full-size head-up display picture, on a PC.
 *
 *   node tools/render_hud_menu.js [outDir]
 *
 * Uses the app's own drawing functions (apps/woodr_hud/menu.js and strip.js) and the kit's canvas, with a sample
 * menu of the size a car with several apps running would have. It proves size, fit and colour, not what the car
 * shows. The grey outline is the display's visible window.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));
const menu = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'menu'));
const strip = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'strip'));

const out = path.resolve(process.argv[2] || 'out-hud');
fs.mkdirSync(out, { recursive: true });
const paste = (dst, src, x, y) => {
    for (let r = 0; r < src.h; r++) for (let c = 0; c < src.w; c++) {
        const i = (r * src.w + c) * 4, j = ((y + r) * dst.w + (x + c)) * 4;
        dst.d[j] = src.d[i]; dst.d[j + 1] = src.d[i + 1]; dst.d[j + 2] = src.d[i + 2]; dst.d[j + 3] = 255;
    }
};

const LIST = [
    { g: 'HUD', label: 'Rev bar', kind: 'bool', value: true },
    { g: 'HUD', label: 'Shift display', kind: 'choice', value: 'bar', options: [['bar', 'Rev bar'], ['frame', 'Frame round the map']] },
    { g: 'HUD', label: 'Position', kind: 'choice', value: 'top', options: [['top', 'Top of the display'], ['slot', 'Lower, clear of the car\'s own readouts']] },
    { g: 'HUD', label: 'Song', kind: 'bool', value: true },
    { g: 'Quick', label: 'Warm-Up', kind: 'action', value: 'Shown' },
    { g: 'Quick', label: 'Waze map', kind: 'action', value: 'medium' },
    { g: 'Quick', label: 'Ambient colour', kind: 'action', value: 'Next' },
    { g: 'Quick', label: 'Test the rev bar', kind: 'action', value: 'Run' },
    { g: 'Dashcam', label: 'Loop recording while driving', kind: 'bool', value: true },
    { g: 'Dashcam', label: 'Copy every clip to the USB stick', kind: 'bool', value: false },
    { g: 'Home Assistant', label: 'Doorbell on the cluster', kind: 'choice', value: 'parked', options: [['parked', 'While parked'], ['off', 'Off']] },
    { g: 'Launch', label: '1 ft rollout (the clock starts after the first foot)', kind: 'bool', value: false },
    { g: 'Warm-Up HUD', label: 'Show on head-up display', kind: 'bool', value: true },
    { g: 'Menu', label: 'Close', kind: 'close', value: '' },
];

[[0, '', 1, 'first'], [2, 'Position: Top of the display', 0.7, 'choice'], [8, 'Loop recording while driving: On', 0.4, 'another-app'], [11, '', 0.9, 'long-label'], [13, '', 0.2, 'close']].forEach((v) => {
    const hud = new Canvas(800, 480).clear('#101014');
    hud.fillRect(120, 100, 570, 278, '#000000');
    hud.strokeRoundRect(120, 100, 570, 278, 0, 1, '#444450');
    const g = strip.PLACES.top;
    const song = new Canvas(g.song.w, g.song.h).clear('#000000');
    strip.drawSong(song, g.song.w, g.song.h, { title: 'Sample Song Title', artist: 'Sample Artist', left: 171, frac: 0.3 });
    paste(hud, song, g.song.x, g.song.y);
    const bar = new Canvas(g.bar.w, g.bar.h).clear('#000000');
    strip.drawBar(bar, g.bar.w, g.bar.h, 13, () => '#e6e6ea');
    paste(hud, bar, g.bar.x, g.bar.y);
    const m = new Canvas(menu.MENU.w, menu.MENU.h);
    menu.draw(m, LIST, v[0], v[1], v[2]);
    paste(hud, m, menu.MENU.x, menu.MENU.y);
    const file = path.join(out, 'menu-' + v[3] + '.png');
    fs.writeFileSync(file, hud.png(6));
    console.log(file);
});
/* a short menu (three rows) must not wrap round on screen, and a long song must leave room for the time */
(() => {
    const hud = new Canvas(800, 480).clear('#101014');
    hud.fillRect(120, 100, 570, 278, '#000000');
    const g = strip.PLACES.top;
    const song = new Canvas(g.song.w, g.song.h).clear('#000000');
    strip.drawSong(song, g.song.w, g.song.h, { title: 'A Very Long Sample Song Title That Keeps Going And Going Past The Edge', artist: 'An Artist With A Long Name', left: 9, frac: 0.97 });
    paste(hud, song, g.song.x, g.song.y);
    const m = new Canvas(menu.MENU.w, menu.MENU.h);
    menu.draw(m, LIST.slice(0, 3), 0, '', null);
    paste(hud, m, menu.MENU.x, menu.MENU.y);
    const file = path.join(out, 'menu-short.png');
    fs.writeFileSync(file, hud.png(6));
    console.log(file);
})();
