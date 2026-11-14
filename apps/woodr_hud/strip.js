'use strict';
/**
 * strip.js - what HUD draws beside its menu: the rev bar, and the song as a card (or as one line at the top).
 * Kept apart from main.js so tools/render_hud_strip.js can draw the same pictures on a PC.
 */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };            /* clear of the car's own HUD content in every view (Screen Lab) */
const SEGS = 30, RPM_FULL = 7200, SEG_GAP = 3;
const WHITE = '#e6e6ea', OFF = '#2a2a31', ACCENT = '#ff1f3d';
/* where the song line and the rev bar sit: the very top of the HUD's visible window (as in the simulator), or
 * inside the slot that stays clear of the car's own content in every HUD view */
const PLACES = {
    top: { song: { x: 128, y: 100, w: 554, h: 22 }, bar: { x: 132, y: 126, w: 546, h: 14 } },
    slot: { song: { x: SLOT.x, y: SLOT.y, w: SLOT.w, h: 22 }, bar: { x: SLOT.x + 4, y: SLOT.y + 26, w: SLOT.w - 8, h: 14 } },
};

/** the rev bar: `filled` of SEGS segments lit, each in the colour its own rpm calls for */
function drawBar(cv, w, h, filled, colourAt) {
    const sw = (w - SEG_GAP * (SEGS - 1)) / SEGS;
    for (let i = 0; i < SEGS; i++) {
        const x = Math.round(i * (sw + SEG_GAP));
        cv.fillRect(x, 0, Math.max(2, Math.round(sw)), h, i < filled ? colourAt((i + 1) / SEGS * RPM_FULL) : OFF);
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

module.exports = { drawCard: drawCard, CARD: CARD, COVER: COVER, drawBar: drawBar, drawSong: drawSong, PLACES: PLACES, SEGS: SEGS, RPM_FULL: RPM_FULL, WHITE: WHITE, OFF: OFF, ACCENT: ACCENT };
