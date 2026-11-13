'use strict';
/**
 * strip.js - the two things HUD draws at the top of the head-up display: the song line and the rev bar.
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

/** the song line: a play mark, the title, the artist at the right */
function drawSong(cv, w, h, song) {
    cv.triangle([[4, 3], [15, h / 2 - 1], [4, h - 5]], ACCENT);
    cv.text(song.title, 22, h - 7, 15, '#ffffff', { font: 'bold' });
    if (song.artist) cv.text(song.artist, w - 4, h - 7, 12, '#b9bac2', { align: 'right' });
    cv.fillRect(4, h - 2, w - 8, 2, '#33333a');
}

module.exports = { drawBar: drawBar, drawSong: drawSong, PLACES: PLACES, SEGS: SEGS, RPM_FULL: RPM_FULL, WHITE: WHITE, OFF: OFF, ACCENT: ACCENT };
