'use strict';
/**
 * tiles.js - the entity grid on the centre screen (1600x520).
 *
 * Four tiles across, two down, 8 per page; pages come from config.js (ha.json or the HA dashboard
 * entity). A tile shows the friendly name, the state, and for a numeric entity its unit. Drawing
 * goes through ctx.canvas()'s Recorder (kit/runtime/record.js): clear, roundRect,
 * strokeRoundRect, text, textWidth, target - no drawImage, which is Canvas only.
 *
 * Touch and the controller both work through G.button / cv.target, which the kit turns into hit
 * rectangles; BTN_ACTION activates the selected tile for cars driven with the iDrive wheel.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const COLS = 4, ROWS = 2;
const GRID = { x: 24, y: 112, w: 1552, h: 332 };
const GAP = 14;

const ON_STATES = ['on', 'open', 'unlocked', 'home', 'playing', 'cleaning', 'heat', 'cool', 'auto'];
const BAD_STATES = ['unavailable', 'unknown', 'none', ''];

/** Is this state "lit"? */
function isOn(state) { return ON_STATES.indexOf(String(state)) >= 0; }
function isBad(state) { return BAD_STATES.indexOf(String(state == null ? '' : state)) >= 0; }

/** What to print for a state, with its unit when HA gives one. */
function shown(st, tile) {
    if (!st) return '--';
    const unit = tile.unit || (st.attributes && st.attributes.unit_of_measurement) || '';
    const v = String(st.state);
    if (isBad(v)) return v === '' ? '--' : v;
    const n = Number(v);
    if (isFinite(n) && v.trim() !== '') {
        const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
        return r + (unit ? ' ' + unit : '');
    }
    return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
}

/** The tile's name, preferring HA's friendly_name over the one in the config. */
function nameOf(st, tile) {
    if (st && st.attributes && st.attributes.friendly_name) return st.attributes.friendly_name;
    return tile.name;
}

function cellRect(i) {
    const cw = (GRID.w - GAP * (COLS - 1)) / COLS;
    const ch = (GRID.h - GAP * (ROWS - 1)) / ROWS;
    const c = i % COLS, r = Math.floor(i / COLS);
    return { x: GRID.x + c * (cw + GAP), y: GRID.y + r * (ch + GAP), w: cw, h: ch };
}

/**
 * Draw one page of tiles.
 *   page   = { title, tiles: [...] }
 *   get(entity) -> HA state object or null
 *   onTap(tile, index)
 *   sel    = index of the tile BTN_ACTION would activate
 *   busy   = { entity: true } for a call in flight
 */
function draw(cv, t, page, get, onTap, sel, busy) {
    const tiles = (page && page.tiles) || [];
    for (let i = 0; i < COLS * ROWS; i++) {
        const r = cellRect(i);
        const tile = tiles[i];
        if (!tile) {
            cv.roundRect(r.x, r.y, r.w, r.h, 12, withAlpha(t.text, 0.04));
            continue;
        }
        const st = get(tile.entity);
        const on = st && isOn(st.state);
        const bad = !st || isBad(st.state);
        const live = busy && busy[tile.entity];
        cv.roundRect(r.x, r.y, r.w, r.h, 12, on ? withAlpha(t.accent, 0.20) : withAlpha(t.text, 0.07));
        if (i === sel) cv.strokeRoundRect(r.x, r.y, r.w, r.h, 12, 3, t.accent);
        else if (on) cv.strokeRoundRect(r.x, r.y, r.w, r.h, 12, 2, withAlpha(t.accent, 0.6));

        cv.text(nameOf(st, tile), r.x + 18, r.y + 38, 24, bad ? t.dim : t.text);
        cv.text(shown(st, tile), r.x + 18, r.y + 100, 44, bad ? t.warn : on ? t.accent : t.text, { font: 'bold' });
        const foot = live ? 'sending...' : tile.tap === 'none' ? '' : tile.confirm ? 'press twice' : tile.tap;
        if (foot) cv.text(foot, r.x + 18, r.y + r.h - 18, 18, t.dim);
        if (tile.tap !== 'none') cv.target(r.x, r.y, r.w, r.h, () => onTap(tile, i), 'tile-' + i, 12);
    }
    return tiles.length;
}

module.exports = { draw, cellRect, isOn, isBad, shown, nameOf, COLS, ROWS, PER_PAGE: COLS * ROWS, GRID };
