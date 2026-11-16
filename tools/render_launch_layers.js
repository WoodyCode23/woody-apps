'use strict';
/**
 * render_launch_layers.js - Launch's instrument cluster and head-up display pictures, drawn on a PC.
 *
 *   node tools/render_launch_layers.js <outDir>
 *
 * The kit's offline preview only shows the centre screen: nothing on a PC stands in for cluster-render.
 * This draws the same pictures the app would send (apps/woodr_launch/draw.js, on the kit's own canvas) and
 * places each one in a full-size picture of its target, with the measured areas marked:
 *
 *   cluster-<state>.png   1088x480 `map` target; the white outline is the cluster's safe area (286,72 504x368)
 *   hud-<state>.png       800x480 `hud` target; the white outline is the window seen through the windscreen
 *                         (120,100 570x278); the grey blocks are where the car's own speed and rev band sit;
 *                         the thin red outline is the shift flash layer's bar
 *
 * It proves layout (sizes, text fit, placement inside the areas). It cannot prove what the car shows.
 * Uses the kit's canvas and fonts in this repository.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas.js'));
const D = require(path.join(__dirname, '..', 'apps', 'woodr_launch', 'draw.js'));

const out = path.resolve(process.argv[2] || 'out-launch-layers');
fs.mkdirSync(out, { recursive: true });

const amber = (i) => ({ ambers: [i === 0, i === 1, i === 2], green: false, red: false });
const STATES = {
    'tree-dark': { phase: 'tree', lights: { ambers: [false, false, false] } },
    'tree-amber2': { phase: 'tree', lights: amber(1) },
    'tree-pro': { phase: 'tree', lights: { ambers: [true, true, true] } },
    'tree-green': { phase: 'tree', lights: { ambers: [false, false, false], green: true } },
    'tree-red': { phase: 'tree', lights: { ambers: [false, false, false], red: true } },
    'run': { phase: 'run', lights: { green: true }, elapsed: 5.18, kmh: 126, unit: 'mph', last: { label: '330 FT', s: 5.05 }, rpm: 5600, shiftRpm: 6800, shift: 'under' },
    'run-shift': { phase: 'run', lights: { green: true }, elapsed: 10.42, kmh: 185, unit: 'mph', last: { label: '0-100 MPH', s: 8.15 }, rpm: 6900, shiftRpm: 6800, shift: 'under', flash: true },
    'run-kmh-red': { phase: 'run', lights: { red: true }, red: true, elapsed: 23.07, kmh: 262, unit: 'kmh', last: null, rpm: 6100, shiftRpm: 6800, shift: true },
    'done': { phase: 'done', headline: { key: 'mi4', label: '1/4 MILE', s: 11.75 }, rt: 0.4, red: false, at: '119.1 MPH' },
    'done-red': { phase: 'done', headline: { key: 'mph60', label: '0-60 MPH', s: 3.45 }, rt: -0.21, red: true, at: '' },
};

function outline(cv, r, c) { cv.strokeRoundRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, 0, 1, c); }

Object.keys(STATES).forEach((name) => {
    const s = STATES[name];
    /* the head-up display */
    const hud = new Canvas(800, 480).clear('#101014');
    hud.fillRect(D.HUD_WINDOW.x, D.HUD_WINDOW.y, D.HUD_WINDOW.w, D.HUD_WINDOW.h, '#000000');
    hud.fillRect(120, 318, 220, 60, '#3a3a40'); hud.text('CAR: SPEED', 130, 354, 16, '#9a9aa0');
    hud.fillRect(120, 105, 570, 77, '#3a3a40'); hud.text('CAR: REV BAND (ONE VIEW ONLY)', 130, 150, 16, '#9a9aa0');
    const hp = new Canvas(D.HUD.w, D.HUD.h);
    D.hud(hp, s);
    hud.copyRows(hp, D.HUD.x, D.HUD.y);
    if (s.flash) hud.fillRect(D.FLASH.x, D.FLASH.y, D.FLASH.w, D.FLASH.h, D.RED);
    else if (s.phase === 'run') outline(hud, D.FLASH, D.RED);
    outline(hud, D.HUD_WINDOW, '#ffffff');
    fs.writeFileSync(path.join(out, 'hud-' + name + '.png'), hud.png());
    /* the instrument cluster */
    const map = new Canvas(1088, 480).clear('#101014');
    map.fillRect(D.MAP_SAFE.x, D.MAP_SAFE.y, D.MAP_SAFE.w, D.MAP_SAFE.h, '#1c1c22');
    const cp = new Canvas(D.CLUSTER.w, D.CLUSTER.h);
    D.cluster(cp, s);
    map.copyRows(cp, D.CLUSTER.x, D.CLUSTER.y);
    outline(map, D.MAP_SAFE, '#ffffff');
    fs.writeFileSync(path.join(out, 'cluster-' + name + '.png'), map.png());
    console.log('wrote hud-' + name + '.png, cluster-' + name + '.png');
});

/* the whole cluster (setting "On the cluster" = whole cluster): the backdrop stretched over the panel above the gear strip
 * with the run's own picture and the split pop-up where the app places them: panel-<state>.png */
[['tree-amber2', 0.4, false], ['run', 2.3, false], ['run-shift', 4.6, true], ['done', 1.1, false]].forEach((v) => {
    const s = STATES[v[0]], P = D.PANEL_SIZE;
    const panel = new Canvas(P.w, P.h).clear('#000000');
    const back = new Canvas(D.BACK.w, D.BACK.h);
    D.backdrop(back, { phase: v[1], hot: v[2] });
    panel.drawImage(back.d, back.w, back.h, D.PANEL_BACK.x, D.PANEL_BACK.y, D.PANEL_BACK.w, D.PANEL_BACK.h);
    panel.fillRect(0, D.PANEL_BACK.h, P.w, P.h - D.PANEL_BACK.h, '#2a2a31'); panel.text('CAR: GEAR, PARK, BELT', 1210, 700, 26, '#9a9aa0');
    const cp = new Canvas(D.CLUSTER.w, D.CLUSTER.h);
    D.cluster(cp, Object.assign({}, s, { bare: true }));
    panel.drawImage(cp.d, cp.w, cp.h, D.PANEL_MAIN.x, D.PANEL_MAIN.y, D.PANEL_MAIN.w, D.PANEL_MAIN.h);
    if (s.phase === 'run' && s.last) {
        const pp = new Canvas(D.POP.w, D.POP.h);
        D.pop(pp, { label: s.last.label, s: s.last.s, at: '98 MPH', best: v[0] === 'run', bare: true });
        panel.drawImage(pp.d, pp.w, pp.h, D.PANEL_POP.x, D.PANEL_POP.y, D.PANEL_POP.w, D.PANEL_POP.h);
    }
    if (s.phase !== 'done') {
        const g = Object.assign({ kmh: 0, unit: 'mph', rpm: 3200, shiftRpm: 6800, gear: 1 }, s, { gear: v[0] === 'run-shift' ? 3 : v[0] === 'run' ? 2 : 1 });
        [[D.PANEL_WING_L, D.wingSpeed], [D.PANEL_WING_R, D.wingRevs]].forEach((w) => {
            const wc = new Canvas(D.WING.w, D.WING.h); w[1](wc, g);
            /* stretched and laid on with its own alpha, as the renderer does: clear corners stay clear */
            for (let y = 0; y < w[0].h; y++) for (let x = 0; x < w[0].w; x++) {
                const i = (Math.min(wc.h - 1, Math.floor(y * wc.h / w[0].h)) * wc.w + Math.min(wc.w - 1, Math.floor(x * wc.w / w[0].w))) * 4, a = wc.d[i + 3] / 255;
                if (a <= 0) continue;
                const j = ((w[0].y + y) * panel.w + w[0].x + x) * 4;
                for (let c = 0; c < 3; c++) panel.d[j + c] = wc.d[i + c] * a + panel.d[j + c] * (1 - a);
            }
        });
    }
    fs.writeFileSync(path.join(out, 'panel-' + v[0] + '.png'), panel.png());
    console.log('wrote panel-' + v[0] + '.png');
});
