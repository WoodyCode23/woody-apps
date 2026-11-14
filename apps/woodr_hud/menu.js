'use strict';
/**
 * menu.js - the wheel menu's picture: a roller of five rows, the chosen one large in the middle and the two
 * each side of it smaller and dimmer, each with its current value at the right.
 *
 *   top line     the chosen row's group (an app's name) and its place in the whole menu, "03 / 15"
 *   thin rule    above a row that starts a new group
 *   below        one line that says what the last press did, and a bar that shrinks to the automatic close
 *
 * A row: { g: group, label, kind: 'bool' | 'choice' | 'action' | 'group' | 'back' | 'close', value, options: [[value, label]] }.
 * Kept apart from main.js so tools/render_hud_menu.js can draw the same picture on a PC.
 */
const MENU = { x: 140, y: 146, w: 530, h: 226 };      /* inside the display's visible 570 x 278, under the rev bar */
const WHITE = '#f2f2f4', NEAR = '#a3a7b1', FAR = '#6a6e79', DIM = '#8d919c', RULE = '#2b2f39';
const RED = '#ff1f3d', GREEN = '#2fd27a', AMBER = '#ffb31a';
/* rows from two above the chosen one to two below: top edge, text size */
const ROWS = [{ o: -2, y: 28, size: 15 }, { o: -1, y: 49, size: 20 }, { o: 0, y: 76, size: 32 }, { o: 1, y: 121, size: 20 }, { o: 2, y: 148, size: 15 }];

/** what a row's value reads as, and for the chosen row its colour */
function valueText(it, value) {
    const v = value === undefined ? it.value : value;
    if (it.kind === 'bool') return v ? 'On' : 'Off';
    if (it.kind === 'group') return v + '  >';      /* how many rows are inside, and that a press goes in */
    if (it.kind === 'back' || it.kind === 'close') return '';
    if (it.kind === 'choice') {
        const o = (it.options || []).filter((x) => x[0] === v)[0];
        return o ? String(o[1]) : String(v === undefined || v === null ? '' : v);
    }
    return v ? String(v) : '';
}
function valueColour(it) {
    if (it.kind === 'bool') return it.value ? GREEN : DIM;
    if (it.kind === 'action') return AMBER;
    if (it.kind === 'group') return DIM;
    return WHITE;
}

/** text cut to fit maxW, with an ellipsis */
function fit(cv, s, size, maxW, opts) {
    s = String(s).slice(0, 120);      /* never more work than this, whatever the text is */
    if (cv.textWidth(s, size, opts) <= maxW) return s;
    while (s.length > 1 && cv.textWidth(s + '…', size, opts) > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '…';
}

/**
 * Draw the menu. list: every row; at: the chosen one; say: the line under the rows ('' for none);
 * idle: 1 just touched .. 0 about to close (null: no bar).
 */
function draw(cv, list, at, say, idle) {
    const w = MENU.w, h = MENU.h, n = list.length;
    cv.fillRect(0, 0, w, h, '#000000');
    if (!n) return;
    const cur = list[at] || list[0];
    cv.text(fit(cv, String(cur.g || '').toUpperCase(), 14, w - 120, { font: 'bold' }), 6, 17, 14, AMBER, { font: 'bold' });
    cv.text((at + 1 < 10 ? '0' : '') + (at + 1) + ' / ' + n, w - 6, 17, 13, DIM, { align: 'right' });
    ROWS.forEach((r) => {
        let i = at + r.o;
        if (n >= 5) i = ((i % n) + n) % n; else if (i < 0 || i >= n) return;      /* a short menu does not wrap round on screen */
        const it = list[i], on = r.o === 0, bold = on ? { font: 'bold' } : undefined;
        const colour = on ? WHITE : Math.abs(r.o) === 1 ? NEAR : FAR;
        const prev = n >= 5 ? list[(((i - 1) % n) + n) % n] : list[i - 1];
        if (r.o > -2 && prev && prev.g !== it.g) cv.fillRect(6, r.y - 1, w - 12, 1, RULE);
        const vt = fit(cv, valueText(it), r.size, Math.round(w * 0.42), bold);
        const vw = vt ? cv.textWidth(vt, r.size, bold) : 0;
        const x = on ? 18 : 22, base = r.y + r.size + (on ? 2 : 1);
        if (on) cv.fillRect(6, r.y + 4, 6, r.size + 4, RED);
        cv.text(fit(cv, it.label, r.size, w - x - vw - 24, bold), x, base, r.size, colour, bold);
        if (vt) cv.text(vt, w - 6, base, r.size, on ? valueColour(it) : colour, Object.assign({ align: 'right' }, bold || {}));
    });
    if (say) cv.text(fit(cv, say, 15, w - 12), 6, 194, 15, AMBER);
    if (typeof idle === 'number') {
        cv.fillRect(6, 214, w - 12, 3, RULE);
        cv.fillRect(6, 214, Math.round((w - 12) * Math.max(0, Math.min(1, idle))), 3, DIM);
    }
}

module.exports = { MENU: MENU, draw: draw, valueText: valueText, fit: fit };
