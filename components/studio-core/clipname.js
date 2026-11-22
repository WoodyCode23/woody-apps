'use strict';
/* One name per clip, wherever it is: its start time, "YYYY-MM-DD HH.MM.SS", local to the car.
 *
 * The PC library and a stick import call a clip "2026-11-14 18.41.07.mp4"; the car keeps it in a folder called
 * "14.11.2026_18_41_07_Event". Both come out as "2026-11-14 18.41.07", which is what a recipe's parts carry, so an
 * edit made in one place finds its clips in another. */

var PC = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)\.(\d\d)(\.[A-Za-z0-9]{1,5})?$/;
var CAR = /^(\d\d)\.(\d\d)\.(\d{4})_(\d\d)_(\d\d)_(\d\d)(_[A-Za-z]{1,20})?$/;
var NAME = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)\.(\d\d)$/;

function valid(y, mo, d, h, mi, s) { return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59 && y >= 2000; }

/* a file name, a folder name or a path to either -> the clip's name, or null */
function fromAny(name) {
    if (typeof name !== 'string' || !name || name.length > 1024) return null;
    var last = name.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    var m = PC.exec(last), y, mo, d;
    if (m) { y = m[1]; mo = m[2]; d = m[3]; } else {
        m = CAR.exec(last);
        if (!m) return null;
        d = m[1]; mo = m[2]; y = m[3];
    }
    if (!valid(+y, +mo, +d, +m[4], +m[5], +m[6])) return null;
    return y + '-' + mo + '-' + d + ' ' + m[4] + '.' + m[5] + '.' + m[6];
}

/* milliseconds, reading the name as if it were UTC: only for ordering and for gaps between clips, which are the
 * same whatever the car's time zone was */
function toDate(clip) {
    var m = typeof clip === 'string' ? NAME.exec(clip) : null;
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/* the names are written biggest unit first, so they sort as text */
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

module.exports = { fromAny: fromAny, toDate: toDate, compare: compare };
