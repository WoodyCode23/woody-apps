'use strict';
/**
 * Screen Lab - calibration patterns for cluster-render's targets.
 *
 * Every target is bigger than what you can actually see: the HUD's scene is 800x480 but only a
 * window of it reaches the windshield, and that window differs between cars. Put a grid up,
 * photograph it, read the numbers off, and you have YOUR geometry.
 *
 * The patterns draw through a tiny "pen" so the same code serves two surfaces: a full-size
 * Canvas pushed to cluster-render, and the screen's Recorder scaled down for the preview.
 * Both offer fillRect and text, which is all these patterns need.
 *
 * Image layers only on the HUD - a heavy shader there has restarted the cluster on car.
 */

/* labels repeat along the centre crosshair: the scene's edges are often outside what you can see */
/* iDrive 7 scene sizes, from cluster-render's hello: map:1088x480,panel:1920x720,hud:800x480 */
const TARGETS = {
    hud:   { w: 800,  h: 480, label: 'Head-up display' },
    map:   { w: 1088, h: 480, label: 'Cluster map slot' },
    panel: { w: 1920, h: 720, label: 'Cluster panel slot' },
};

/* the HUD window measured by bimmer-lab (via redline/hud.js). A starting guess - replacing it is the point. */
const KNOWN_SAFE = {
    /* measured by bimmer-lab (via redline/hud.js) - a starting guess, replacing it is the point */
    hud: { x: 120, y: 100, w: 570, h: 278 },             /* measured on this car from photos */
    /* IC_HIGH's own advertised safe area, read off this car with `carplay_patch.js status` */
    map: { x: 286, y: 72, w: 504, h: 368 },
};

/* BMW's own HUD content, from photos of this car: drawn as outlines so you can see what to avoid */
const STOCK = { hud: [
    { x: 120, y: 318, w: 220, h: 60, label: 'BMW speed (all views)' },
    { x: 120, y: 105, w: 570, h: 77, label: 'BMW M view rev band' },
    { x: 120, y: 105, w: 95, h: 140, label: '' },
] };
const SLOT = { hud: { x: 220, y: 185, w: 470, h: 133 } };

const AXIS = '#3ad1ff', GRID = '#4a4a4a', GRID10 = '#7a7a7a', EDGE = '#ff4d4d',
      SAFE = '#2fd27a', PROBE = '#ffd34d', TEXT = '#ffffff';

/**
 * The car's driving mode (FES actualValueModeDrivingExperience, a name or a wire number) -> 'sport',
 * 'comfort', 'eco' or null. Same mapping as redline/hud.js driveModeOf (MPL-2.0, Robert Nisipeanu), so
 * our apps and Redline agree on which HUD profile is live.
 */
function driveModeOf(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : (n >= 4 && n <= 6) || n === 10 || (n >= 17 && n <= 22) ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const s = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(s) ? 'sport' : /HYBRID|ELECTRIC|BATTERY|ADAPTIV/.test(s) ? 'comfort' : /ECO/.test(s) ? 'eco'
        : /COMFORT|TRAFFIC/.test(s) ? 'comfort' : null;
}

/** draw in target pixels onto any surface with fillRect + text, scaled by k and offset to ox,oy */
function pen(surf, ox, oy, k) {
    return {
        k: k,
        rect: function (x, y, w, h, c) {
            surf.fillRect(ox + x * k, oy + y * k, Math.max(1, w * k), Math.max(1, h * k), c);
        },
        text: function (s, x, y, size, c, o) {
            const px = size * k;
            if (px < 7) return;                     /* unreadable when scaled down: skip rather than smear */
            surf.text(s, ox + x * k, oy + y * k, px, c, o || {});
        },
    };
}

function drawGrid(p, W, H, step) {
    for (let x = 0; x <= W; x += step) {
        const major = x % (step * 2) === 0;
        p.rect(x, 0, 1, H, major ? GRID10 : GRID);
        if (major && x > 0) { p.text(String(x), x + 4, 20, 16, GRID10); p.text(String(x), x + 4, H / 2 + 22, 18, AXIS); }
    }
    for (let y = 0; y <= H; y += step) {
        const major = y % (step * 2) === 0;
        p.rect(0, y, W, 1, major ? GRID10 : GRID);
        if (major && y > 0) { p.text(String(y), 4, y + 18, 16, GRID10); p.text(String(y), W / 2 + 6, y + 18, 18, AXIS); }
    }
    p.rect(W / 2 - 1, 0, 2, H, AXIS);
    p.rect(0, H / 2 - 1, W, 2, AXIS);
    p.text('centre ' + Math.round(W / 2) + ',' + Math.round(H / 2), W / 2 + 8, H / 2 - 8, 18, AXIS);
}

function drawEdges(p, W, H) {
    const t = 3, arm = 60;
    p.rect(0, 0, W, t, EDGE); p.rect(0, H - t, W, t, EDGE);
    p.rect(0, 0, t, H, EDGE); p.rect(W - t, 0, t, H, EDGE);
    /* L marks in each corner: whichever arm you cannot see tells you which edge is cropped */
    p.rect(0, 0, arm, 8, TEXT);        p.rect(0, 0, 8, arm, TEXT);
    p.rect(W - arm, 0, arm, 8, TEXT);  p.rect(W - 8, 0, 8, arm, TEXT);
    p.rect(0, H - 8, arm, 8, TEXT);    p.rect(0, H - arm, 8, arm, TEXT);
    p.rect(W - arm, H - 8, arm, 8, TEXT); p.rect(W - 8, H - arm, 8, arm, TEXT);
    p.text('0,0', 14, 34, 22, TEXT, { font: 'bold' });
    p.text(W + ' x ' + H, W - 14, H - 14, 22, TEXT, { font: 'bold', align: 'right' });
}

function clampProbe(pr, W, H) {
    const x = Math.max(0, Math.min(pr.x, W - 10)), y = Math.max(0, Math.min(pr.y, H - 10));
    return { x: x, y: y, w: Math.max(10, Math.min(pr.w, W - x)), h: Math.max(10, Math.min(pr.h, H - y)) };
}

function drawProbe(p, pr) {
    const t = 2;
    p.rect(pr.x, pr.y, pr.w, t, PROBE); p.rect(pr.x, pr.y + pr.h - t, pr.w, t, PROBE);
    p.rect(pr.x, pr.y, t, pr.h, PROBE); p.rect(pr.x + pr.w - t, pr.y, t, pr.h, PROBE);
    p.text(pr.x + ',' + pr.y, pr.x + 6, pr.y + 24, 20, PROBE, { font: 'bold' });
    p.text(pr.w + ' x ' + pr.h, pr.x + pr.w - 6, pr.y + pr.h - 8, 20, PROBE, { font: 'bold', align: 'right' });
}

function drawSweep(p, W, H) {
    const s = 70;
    const spots = [[0, 0, '1'], [W - s, 0, '2'], [0, H - s, '3'], [W - s, H - s, '4'],
                   [(W - s) / 2, 0, '5'], [(W - s) / 2, H - s, '6'], [0, (H - s) / 2, '7'], [W - s, (H - s) / 2, '8']];
    spots.forEach(function (sp) {
        p.rect(sp[0], sp[1], s, s, '#ffffff');
        p.text(sp[2], sp[0] + s / 2, sp[1] + s / 2 + 14, 40, '#000000', { font: 'bold', align: 'center' });
    });
}

/** paint the whole pattern for `target` through pen `p` */
function paint(p, target, opts) {
    const T = TARGETS[target];
    if (!T) return null;
    const mode = opts.pattern;
    p.rect(0, 0, T.w, T.h, '#000000');
    if (mode === 'grid') { drawGrid(p, T.w, T.h, opts.grid); drawEdges(p, T.w, T.h); }
    else if (mode === 'edges') drawEdges(p, T.w, T.h);
    else if (mode === 'sweep') drawSweep(p, T.w, T.h);

    if (opts.safe && KNOWN_SAFE[target]) {
        const s = KNOWN_SAFE[target], t = 2;
        p.rect(s.x, s.y, s.w, t, SAFE); p.rect(s.x, s.y + s.h - t, s.w, t, SAFE);
        p.rect(s.x, s.y, t, s.h, SAFE); p.rect(s.x + s.w - t, s.y, t, s.h, SAFE);
        p.text('known safe ' + s.x + ',' + s.y + ' ' + s.w + 'x' + s.h, s.x + 6, s.y - 8, 18, SAFE);
    }
    if (opts.safe && STOCK[target]) {
        STOCK[target].forEach(function (z) {
            const t = 2, c = '#ff6ad5';
            p.rect(z.x, z.y, z.w, t, c); p.rect(z.x, z.y + z.h - t, z.w, t, c);
            p.rect(z.x, z.y, t, z.h, c); p.rect(z.x + z.w - t, z.y, t, z.h, c);
            if (z.label) p.text(z.label, z.x + 6, z.y + 20, 16, c);
        });
        const sl = SLOT[target];
        if (sl) { p.rect(sl.x, sl.y, sl.w, 1, '#2fd27a'); p.rect(sl.x, sl.y + sl.h - 1, sl.w, 1, '#2fd27a');
                  p.text('clear in every view ' + sl.w + 'x' + sl.h, sl.x + 6, sl.y + 22, 16, '#2fd27a'); }
    }
    let probe = null;
    if (mode === 'probe' || mode === 'grid') { probe = clampProbe(opts.probe, T.w, T.h); drawProbe(p, probe); }
    p.text(T.label + '  ' + T.w + 'x' + T.h, T.w / 2, T.h - 18, 22, TEXT, { font: 'bold', align: 'center' });
    /* label the photo: which driving mode (and so which stock HUD view) this pattern was shot in */
    if (opts.modeLabel) p.text('MODE ' + opts.modeLabel, T.w / 2 + 8, T.h / 2 + 50, 24, PROBE, { font: 'bold' });
    return probe;
}

module.exports = { STOCK: STOCK, SLOT: SLOT, driveModeOf: driveModeOf, TARGETS: TARGETS, KNOWN_SAFE: KNOWN_SAFE, pen: pen, paint: paint, clampProbe: clampProbe };
