'use strict';
/**
 * strip.js - what HUD draws beside its menu: the rev bar, and the song as a card (or as one line at the top).
 * Kept apart from main.js so tools/render_hud_strip.js can draw the same pictures on a PC.
 */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };            /* clear of the car's own HUD content in every view (Screen Lab) */
const RPM_FULL = 7200;
const WHITE = '#e6e6ea', OFF = '#2a2a31', ACCENT = '#ff1f3d';
/* where the song line and the rev bar sit: the very top of the HUD's visible window (as in the simulator), or
 * inside the slot that stays clear of the car's own content in every HUD view */
const PLACES = {
    /* bar: the band with its numbers. barSlim: the band alone, where the song line needs the row above it */
    top: { song: { x: 128, y: 100, w: 554, h: 22 }, bar: { x: 132, y: 112, w: 546, h: 30 }, barSlim: { x: 132, y: 126, w: 546, h: 14 } },
    slot: { song: { x: SLOT.x, y: SLOT.y, w: SLOT.w, h: 22 }, bar: { x: SLOT.x + 4, y: SLOT.y + 26, w: SLOT.w - 8, h: 30 } },
};

/* The rev bar is one band leaning to the right, cut by a thin gap at every 1000 rpm, with the numbers 1 to 7
 * over the gaps when the layer is tall enough for them. */
const LEAN = 0.5, STEP = 3, NUM = 12, YELLOW = '#ffd34d', RED_TRACK = '#4a1220', NUM_DIM = '#8d8e96';
function band(w, h) {
    const tall = h >= 28, y0 = tall ? NUM + 5 : 2, y1 = h - 1, lean = Math.round((y1 - y0) * LEAN);
    return { tall: tall, y0: y0, y1: y1, lean: lean, span: w - lean - 1 };
}

/** how far the band is filled at `rpm`, in pixels, in steps of STEP so that it is drawn again no more often than it has to be */
function barFill(w, h, rpm) {
    const f = Number(rpm) / RPM_FULL, b = band(w, h);
    return Math.round((f > 0 ? (f < 1 ? f : 1) : 0) * b.span / STEP) * STEP;
}

/**
 * The zones while the oil is cold: the red starts lower and climbs to its own place as the oil warms.
 * zones: { green, yellow, red, shift } rpm as set; cold: { oil, readyAt } deg C from Warm-Up HUD, or null.
 * From COLD_RPM at COLD_OIL degrees and below, in a straight line to the set red at readyAt, in steps of 100.
 * Guidance only, on the careful side: not a BMW figure. Warm, or with nothing known, the zones come back as set.
 */
const COLD_RPM = 3000, COLD_OIL = 20;
function coldZones(zones, cold) {
    const z = { green: Number(zones.green) || 4000, yellow: Number(zones.yellow) || 5500, red: Number(zones.red) || 6300, shift: Number(zones.shift) || 6800, cold: false };
    const oil = cold && cold.oil, ready = cold && cold.readyAt;
    if (typeof oil !== 'number' || !isFinite(oil) || typeof ready !== 'number' || !isFinite(ready) || ready <= COLD_OIL || oil >= ready || z.red <= COLD_RPM) return z;
    const f = Math.max(0, (oil - COLD_OIL) / (ready - COLD_OIL));
    const red = Math.round((COLD_RPM + f * (z.red - COLD_RPM)) / 100) * 100;
    if (red >= z.red) return z;
    const yellow = Math.min(z.yellow, red - 700);
    return { green: Math.min(z.green, yellow - 500), yellow: yellow, red: red, shift: Math.min(z.shift, red + 500), cold: true };
}

/** the rev bar filled to `fill` pixels (see barFill): white, then yellow from zones.yellow rpm, then red from zones.red */
function drawBar(cv, w, h, fill, zones) {
    const b = band(w, h), xOf = (rpm) => rpm / RPM_FULL * b.span;
    const yellow = Math.min(RPM_FULL, Math.max(0, Number(zones && zones.yellow) || 5500)), red = Math.min(RPM_FULL, Math.max(yellow, Number(zones && zones.red) || 6300));
    const slab = (xa, xb, c) => { if (xb > xa) cv.quad([[xa + b.lean, b.y0], [xb + b.lean, b.y0], [xb, b.y1], [xa, b.y1]], c); };
    fill = Math.max(0, Math.min(b.span, fill));
    slab(0, xOf(red), OFF);
    slab(xOf(red), b.span, RED_TRACK);
    [[0, yellow, WHITE], [yellow, red, YELLOW], [red, RPM_FULL, ACCENT]].forEach((z) => slab(xOf(z[0]), Math.min(fill, xOf(z[1])), z[2]));
    /* depth: the lower part of the band a little darker, and a bright leading edge */
    const ym = b.y0 + (b.y1 - b.y0) * 0.55, lm = Math.round((b.y1 - ym) * LEAN);
    if (fill > 0) cv.quad([[lm, ym], [fill + lm, ym], [fill, b.y1], [0, b.y1]], [0, 0, 0, 64]);
    if (fill > 4) slab(fill - 3, fill, '#ffffff');
    const shown = fill / b.span * RPM_FULL;
    for (let n = 1; n * 500 < RPM_FULL; n++) {
        const rpm = n * 500, x = xOf(rpm);
        if (n % 2) { if (b.tall) cv.fillRect(Math.round(x + b.lean), b.y0 - 4, 1, 3, rpm >= red ? ACCENT : NUM_DIM); continue; }
        slab(x - 1, x + 1, '#000000');
        if (b.tall) cv.text(String(n / 2), x + b.lean + 1, NUM, NUM, rpm >= red ? ACCENT : rpm <= shown ? '#ffffff' : NUM_DIM, { font: 'bold', align: 'center', literal: true });
    }
}

const AMBER = '#ffb31a';

function fit(cv, s, size, maxW, opts) {
    s = String(s).slice(0, 120);      /* never more work than this, whatever the text is */
    if (maxW <= 0) return '';
    if (cv.textWidth(s, size, opts) <= maxW) return s;
    while (s.length > 1 && cv.textWidth(s + '…', size, opts) > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '…';
}

/**
 * The song: a play mark, the title, the artist and the time left, only as wide as they need, with a line under
 * them that fills as the song plays. song = { title, artist, left: seconds or null, frac: 0..1 or null }.
 */
function drawSong(cv, w, h, song) {
    const base = h - 7, bold = { font: 'bold' };
    cv.triangle([[4, 3], [15, h / 2 - 1], [4, h - 5]], ACCENT);
    let left = '';
    if (typeof song.left === 'number' && song.left >= 0) { const s = Math.ceil(song.left); left = '-' + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
    const leftW = left ? cv.textWidth(left, 12) + 12 : 0;
    let x = 22;
    const title = fit(cv, song.title, 15, w - x - leftW - 8, bold);
    cv.text(title, x, base, 15, '#ffffff', bold);
    x += cv.textWidth(title, 15, bold) + 10;
    const artist = song.artist ? fit(cv, song.artist, 13, Math.min(220, w - x - leftW - 8)) : '';
    if (artist && artist.length > 2) { cv.text(artist, x, base, 13, '#b9bac2'); x += cv.textWidth(artist, 13) + 10; }
    if (left) { cv.text(left, x, base, 12, AMBER); x += leftW - 2; }
    const end = Math.min(w - 4, x);
    cv.fillRect(4, h - 2, end - 4, 2, '#33333a');
    if (typeof song.frac === 'number') cv.fillRect(4, h - 2, Math.round((end - 4) * Math.max(0, Math.min(1, song.frac))), 2, ACCENT);
}

/* The song as a card: bottom right of the display's visible window, opposite the car's own speed readout. */
const CARD = { x: 424, y: 308, w: 260, h: 64 };
const COVER = 52;                     /* the album cover's side, in the card */
const CARD_BG = [22, 24, 30];

/** Paste a COVER x COVER RGBA picture with rounded corners; outside the corners the card's own colour stays. */
function pasteCover(cv, img, x0, y0, r) {
    const n = COVER;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            /* distance from the nearest corner's centre, only inside a corner square */
            const cx = x < r ? r - 0.5 : x >= n - r ? n - r - 0.5 : x, cy = y < r ? r - 0.5 : y >= n - r ? n - r - 0.5 : y;
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy > r * r) continue;
            const i = (y * n + x) * 4, j = ((y0 + y) * cv.w + (x0 + x)) * 4;
            cv.d[j] = img.d[i]; cv.d[j + 1] = img.d[i + 1]; cv.d[j + 2] = img.d[i + 2]; cv.d[j + 3] = 255;
        }
    }
}

/**
 * The song as a card, the way a music app shows it: the album cover, the title over the artist, the time left
 * and a rounded line that fills as the song plays. song = { title, artist, left, frac, cover: { d } or null }.
 * Without a cover there is a plain tile with a play mark.
 */
function drawCard(cv, w, h, song) {
    const bg = 'rgb(' + CARD_BG.join(',') + ')', bold = { font: 'bold' };
    cv.roundRect(0, 0, w, h, 18, '#16181e');
    const cx = 6, cy = (h - COVER) / 2;
    if (song.cover && song.cover.d && song.cover.d.length >= COVER * COVER * 4) pasteCover(cv, song.cover, cx, cy, 10);
    else {
        cv.roundRect(cx, cy, COVER, COVER, 10, '#2a2d36');
        cv.triangle([[cx + 20, cy + 15], [cx + 38, cy + 26], [cx + 20, cy + 37]], ACCENT);
    }
    const x = cx + COVER + 10, right = w - 12;
    cv.text(fit(cv, song.title, 17, right - x, bold), x, 26, 17, '#ffffff', bold);
    let left = '';
    if (typeof song.left === 'number' && song.left >= 0) { const sec = Math.ceil(song.left); left = '-' + Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }
    const leftW = left ? cv.textWidth(left, 12) + 8 : 0;
    if (song.artist) cv.text(fit(cv, song.artist, 13, right - x - leftW), x, 44, 13, '#b9bac2');
    if (left) cv.text(left, right, 44, 12, AMBER, { align: 'right' });
    const len = right - x;
    cv.roundRect(x, 52, len, 4, 2, '#30333c');
    if (typeof song.frac === 'number') cv.roundRect(x, 52, Math.max(4, Math.round(len * Math.max(0, Math.min(1, song.frac)))), 4, 2, ACCENT);
    return bg;
}

module.exports = { coldZones: coldZones, drawCard: drawCard, CARD: CARD, COVER: COVER, drawBar: drawBar, barFill: barFill, drawSong: drawSong, PLACES: PLACES, RPM_FULL: RPM_FULL, WHITE: WHITE, OFF: OFF, ACCENT: ACCENT };
