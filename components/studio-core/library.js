'use strict';
/* What is in a folder of clips. An editor that has no library program behind it (the phone and web app, the car)
 * is handed a list of file names: this sorts them into clips, each with its video, its data file and its picture,
 * and the saved edits beside them, and groups the clips into drives.
 *
 * It knows both layouts: the PC library and a stick import ("2026-11-14 18.41.07.mp4" with .json and .jpg beside
 * it) and the car's own (a folder "14.11.2026_18_41_07_Event" holding the video and a Metadata.json). Names only:
 * no file is opened here. */

var clipname = require('./clipname');
var runlog = require('./runlog');

var MAX_FILES = 50000;
var GAP_S = 180;              /* a longer pause than this between two clips starts a new drive (as in the PC Studio) */
var VIDEO = /\.(mp4|m4v|mov|ts)$/i, RECIPE = /\.edit\.json$/i, JSON_FILE = /\.json$/i, PICTURE = /\.jpe?g$/i;

function pieces(name) { return name.replace(/[\\/]+$/, '').split(/[\\/]/); }

/* names: file names or paths, as the place lists them -> { clips: [{ clip, video, meta, picture, ts }], recipes:
 * [index], runs: [index] (Launch data logs), other: count }. video, meta and picture are indexes into names (-1 when there is none); ts says the
 * video is the car's transport stream, which a browser cannot play as it is. Clips are in time order; a clip with
 * no video is left out. */
function sort(names) {
    var list = Array.isArray(names) ? names : [], by = {}, recipes = [], runs = [], other = 0;
    var n = Math.min(list.length, MAX_FILES);
    for (var i = 0; i < n; i++) {
        var name = list[i];
        if (typeof name !== 'string' || !name || name.length > 1024) { other++; continue; }
        var parts = pieces(name), base = parts[parts.length - 1];
        if (RECIPE.test(base)) { recipes.push(i); continue; }
        if (runlog.isRunFile(base)) { runs.push(i); continue; }       /* a Launch run's data log, for the overlay */
        var kind = VIDEO.test(base) ? 'video' : JSON_FILE.test(base) ? 'meta' : PICTURE.test(base) ? 'picture' : '';
        var clip = kind ? clipname.fromAny(base) || (parts.length > 1 ? clipname.fromAny(parts[parts.length - 2]) : null) : null;
        if (!clip) { other++; continue; }
        var c = by[clip] || (by[clip] = { clip: clip, video: -1, meta: -1, picture: -1, ts: false });
        if (kind === 'video') {
            /* a clip present twice (the car's .ts and the PC's .mp4): the one a browser plays as it is wins */
            var ts = /\.ts$/i.test(base);
            if (c.video < 0 || (c.ts && !ts)) { c.video = i; c.ts = ts; }
        } else if (c[kind] < 0) c[kind] = i;
    }
    var clips = Object.keys(by).sort().map(function (k) { return by[k]; }).filter(function (c) { return c.video >= 0; });
    return { clips: clips, recipes: recipes, runs: runs, other: other + Math.max(0, list.length - n) };
}

/* clips: [{ clip, dur }] in any order -> drives, newest first: [{ id (its first clip), clips: [...] in order }].
 * A clip whose length is not known yet counts as 40 s, the car's usual clip. */
function drives(clips, gapS) {
    var gap = (typeof gapS === 'number' && gapS >= 0 ? gapS : GAP_S) * 1000;
    var list = (Array.isArray(clips) ? clips : []).filter(function (c) { return c && !isNaN(clipname.toDate(c.clip)); })
        .slice().sort(function (a, b) { return clipname.compare(a.clip, b.clip); });
    var out = [], cur = null, end = 0;
    list.forEach(function (c) {
        var at = clipname.toDate(c.clip), dur = typeof c.dur === 'number' && isFinite(c.dur) && c.dur > 0 ? c.dur : 40;
        if (!cur || at - end > gap) { cur = { id: c.clip, clips: [] }; out.push(cur); }
        cur.clips.push(c);
        end = Math.max(end, at + dur * 1000);
    });
    return out.reverse();
}

module.exports = { sort: sort, drives: drives, GAP_S: GAP_S };
