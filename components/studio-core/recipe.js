'use strict';
/* The Studio's edit, version 1: a small recipe saved beside the clips as <name>.edit.json.
 *
 * It says which clips, where each cut starts and ends, which camera and which shape. It never holds a VIN, a
 * position, a file path or a person's name: check() copies the known keys and nothing else, on the way in and on
 * the way out, so whatever a file carries, those cannot ride along.
 *
 * Runs on the car (Node 8), in a browser and under the tests: no built-in modules, and nothing here throws on bad
 * input. The same rules are in the PC Studio's recipe.py; both are held to fixtures/recipes.json. */

var VERSION = 1;
var MAX_BYTES = 262144;       /* a recipe is a few kB; anything near this is not one */
var MAX_PARTS = 500;
var VIEWS = ['all', 'front', 'rear', 'left', 'right'];
var FORMATS = { original: [1280, 960], wide: [1920, 1080], vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080] };
var PLACES = ['car', 'phone', 'web', 'pc'];
var UNITS = ['mph', 'kmh'];
var ID = /^[a-z0-9]{4,12}$/;
var WHEN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
var LIMIT = 1e9;              /* no time, rate or length in a recipe is anywhere near this; past it, it is not a number to us */
var CLIP = /^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d$/;
var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
var MIN_PART = 0.05;          /* seconds; shorter than this is a slip of the hand, not a cut */

function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function isNum(n) { return typeof n === 'number' && isFinite(n) && Math.abs(n) <= LIMIT; }

/* a recipe's name: no control characters, no slashes (so it is never a path), at most 80 units and never cut
 * through the middle of a character (recipe.py cuts it the same way) */
function cleanName(name) {
    if (typeof name !== 'string') return 'Edit';
    var s = name.replace(/[\u0000-\u001f\\\/]/g, '').slice(0, 80).replace(/[\ud800-\udbff]$/, '');
    s = s.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '').replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
    return s || 'Edit';
}
function oneOf(list, v, dflt) { return typeof v === 'string' && list.indexOf(v) >= 0 ? v : dflt; }
function r3(x) { return Math.floor(x * 1000 + 0.5) / 1000; }

function checkPart(p, i, errors) {
    if (!isObj(p)) { errors.push('part ' + i + ' is not an object'); return null; }
    if (typeof p.clip !== 'string' || !CLIP.test(p.clip)) { errors.push('part ' + i + ' does not name a clip'); return null; }
    if (!isNum(p.t0) || !isNum(p.t1)) { errors.push('part ' + i + ' has no times'); return null; }
    var t0 = r3(Math.max(0, p.t0)), t1 = r3(p.t1);
    if (t1 - t0 < MIN_PART) { errors.push('part ' + i + ' is empty'); return null; }
    var rate = isNum(p.rate) && p.rate !== 0 ? Math.min(8, Math.max(0.1, p.rate)) : 1;
    return { clip: p.clip, t0: t0, t1: t1, view: oneOf(VIEWS, p.view, 'all'), rate: rate };
}

/* -> { ok, recipe, errors }. recipe is a clean copy (known keys only, values in range) or null. A part that cannot
 * be used is left out and named in errors; the recipe is still ok. */
function check(obj) {
    var errors = [];
    if (!isObj(obj)) return { ok: false, recipe: null, errors: ['not a recipe'] };
    if (obj.v !== VERSION) errors.push('not version ' + VERSION);
    if (typeof obj.id !== 'string' || !ID.test(obj.id)) errors.push('bad id');
    if (typeof obj.created !== 'string' || !WHEN.test(obj.created)) errors.push('bad created time');
    if (typeof obj.updated !== 'string' || !WHEN.test(obj.updated)) errors.push('bad updated time');
    if (!Array.isArray(obj.parts)) errors.push('parts is not a list');
    else if (obj.parts.length > MAX_PARTS) errors.push('more than ' + MAX_PARTS + ' parts');
    if (errors.length) return { ok: false, recipe: null, errors: errors };

    var speed = isObj(obj.speed) ? obj.speed : {};
    var parts = [];
    for (var i = 0; i < obj.parts.length; i++) {
        var p = checkPart(obj.parts[i], i, errors);
        if (p) parts.push(p);
    }
    return { ok: true, errors: errors, recipe: {
        v: VERSION,
        id: obj.id,
        name: cleanName(obj.name),
        created: obj.created,
        updated: obj.updated,
        by: oneOf(PLACES, obj.by, 'pc'),
        format: typeof obj.format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, obj.format) ? obj.format : 'original',
        fill: !!obj.fill,
        speed: { show: !!speed.show, unit: oneOf(UNITS, speed.unit, 'mph') },
        parts: parts,
    } };
}

function parse(text) {
    if (typeof text !== 'string') return { ok: false, recipe: null, errors: ['not text'] };
    if (text.length > MAX_BYTES) return { ok: false, recipe: null, errors: ['too large to be a recipe'] };
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, recipe: null, errors: ['not JSON'] }; }
    return check(obj);
}

/* '' for something that is not a recipe, so nothing invalid is ever written */
function stringify(recipe) {
    var r = check(recipe);
    return r.ok ? JSON.stringify(r.recipe, null, 1) : '';
}

function newId(rand) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', id = '';
    for (var i = 0; i < 6; i++) id += abc.charAt(Math.min(abc.length - 1, Math.max(0, Math.floor((rand ? rand() : Math.random()) * abc.length))));
    return id;
}

function create(opts, nowIso, rand) {
    var o = isObj(opts) ? opts : {};
    return check({ v: VERSION, id: newId(rand), name: o.name, created: nowIso, updated: nowIso, by: o.by, format: o.format, fill: o.fill, speed: o.speed, parts: [] }).recipe;
}

function touch(recipe, by, nowIso) {
    var r = check(recipe).recipe;
    if (!r) return null;
    r.by = oneOf(PLACES, by, r.by);
    r.updated = nowIso;
    return check(r).recipe;
}

/* a name that is safe as a file name everywhere the clips go: a stick (FAT), Windows, the car, a phone */
function safeName(name) {
    var s = typeof name === 'string' ? name : '';
    s = s.replace(/[^A-Za-z0-9 .()_-]/g, '').replace(/^[ .]+/, '').slice(0, 80).replace(/[ .]+$/, '');
    if (!s) return 'Edit';
    return RESERVED.test(s) ? s + '_' : s;
}
function fileName(recipe) { return safeName(recipe && recipe.name) + '.edit.json'; }
function conflictName(recipe) { return safeName(recipe && recipe.name) + '.conflict.edit.json'; }

/* a recipe's updated time in a form that sorts as text: one clock writes 19:00:00Z, another 19:00:00.900Z */
function whenKey(r) {
    var u = r && typeof r.updated === 'string' && WHEN.test(r.updated) ? r.updated : '';
    if (!u) return '';
    return u.slice(0, 19) + '.' + (u.length > 20 ? u.slice(20, -1) : '') + '000'.slice(u.length > 20 ? u.length - 21 : 0);
}

/* Two copies of one edit (the same id) saved in two places: the later one is kept, the other is handed back to be
 * saved beside it, never dropped. other is null when they say the same thing. */
function resolve(a, b) {
    if (stringify(a) === stringify(b)) return { keep: a, other: null };
    return whenKey(b) > whenKey(a) ? { keep: b, other: a } : { keep: a, other: b };
}

module.exports = {
    VERSION: VERSION, MAX_BYTES: MAX_BYTES, MAX_PARTS: MAX_PARTS, VIEWS: VIEWS, FORMATS: FORMATS,
    check: check, parse: parse, stringify: stringify, create: create, touch: touch,
    safeName: safeName, fileName: fileName, conflictName: conflictName, resolve: resolve,
};
