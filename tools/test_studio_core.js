'use strict';
/* npx -y node@8.16.2 tools/test_studio_core.js
 * The Studio's shared core (components/studio-core): the recipe, clip names, the timeline, the speed track and the
 * picture geometry. The fixture files are shared with the PC Studio's Python tests, so the two cannot drift. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CORE = path.join(__dirname, '..', 'components', 'studio-core');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(CORE, 'fixtures', n), 'utf8'));
let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const deepEqual = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; } };
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------------------------------------------------------------- the recipe */
const R = require(path.join(CORE, 'recipe.js'));
const recipes = fixture('recipes.json').cases;
const example = recipes[0].in;
recipes.forEach((c) => {
    let r;
    try { r = R.check(c.in); } catch (e) { r = { ok: null, recipe: null, errors: ['threw ' + e] }; }
    ok('recipe: ' + c.name, r.ok === c.ok && deepEqual(r.recipe, c.out) && r.errors.length === c.errors);
});
const withParts = (n) => { const r = clone(recipes[1].in); r.parts = []; for (let i = 0; i < n; i++) r.parts.push(clone(recipes[1].in.parts[0])); return r; };
ok('check does not change what it was given', (() => { const x = clone(recipes[recipes.length - 1].in), before = JSON.stringify(x); R.check(x); return JSON.stringify(x) === before; })());
ok('parse refuses oversized text', R.parse(new Array(R.MAX_BYTES + 2).join(' ')).ok === false);
ok('parse refuses non-JSON without throwing', R.parse('{nope').ok === false && R.parse(undefined).ok === false);
ok('500 parts are fine', R.check(withParts(500)).ok === true);
ok('501 parts refused', R.check(withParts(501)).ok === false);
ok('stringify then parse gives the same recipe', deepEqual(R.parse(R.stringify(example)).recipe, example));
ok('stringify keeps the spec\'s key order', Object.keys(JSON.parse(R.stringify(example))).join() === 'v,id,name,created,updated,by,format,fill,speed,parts');
ok('stringify of something invalid is empty', R.stringify({ v: 9 }) === '');
const made = R.create({ name: 'A', by: 'car' }, '2026-11-14T19:02:11Z', () => 0.5);
ok('create makes a valid recipe', R.check(made).ok && made.by === 'car' && made.created === made.updated && /^[a-z0-9]{6}$/.test(made.id) && made.parts.length === 0);
ok('create with a random source at its ends', /^[a-z0-9]{6}$/.test(R.create({}, '2026-11-14T19:02:11Z', () => 0).id) && /^[a-z0-9]{6}$/.test(R.create({}, '2026-11-14T19:02:11Z', () => 0.999999).id));
const touched = R.touch(example, 'web', '2026-12-01T00:00:00Z');
ok('touch sets who and when on a copy', touched.by === 'web' && touched.updated === '2026-12-01T00:00:00Z' && example.by === 'car' && touched.created === example.created);
ok('safeName strips path characters', R.safeName('..\\..\\x/y') === 'xy');
ok('safeName reserved name', R.safeName('con') === 'con_' && R.safeName('LPT3') === 'LPT3_' && R.safeName('console') === 'console');
ok('safeName empty', R.safeName('///') === 'Edit' && R.safeName(null) === 'Edit' && R.safeName('...') === 'Edit');
ok('safeName length and ends', R.safeName(new Array(200).join('a')).length === 80 && R.safeName('  a b.  ') === 'a b');
ok('fileName', R.fileName(example) === 'Back road evening.edit.json');
ok('conflictName', R.conflictName(example) === 'Back road evening.conflict.edit.json');
const older = clone(example), newer = clone(example);
newer.updated = '2026-11-15T08:00:00Z'; newer.name = 'Changed';
ok('resolve keeps the later one', R.resolve(older, newer).keep === newer && R.resolve(older, newer).other === older);
ok('resolve the other way round', R.resolve(newer, older).keep === newer && R.resolve(newer, older).other === older);
ok('resolve of equal content has no other', R.resolve(example, clone(example)).other === null);
const plainClock = clone(example), fineClock = clone(example);
plainClock.updated = '2026-11-14T19:00:00Z'; fineClock.updated = '2026-11-14T19:00:00.900Z'; fineClock.name = 'Later';
ok('later means later whatever the clock wrote', R.resolve(plainClock, fineClock).keep === fineClock && R.resolve(fineClock, plainClock).keep === fineClock);
ok('check gives the same answer twice, even for absurd numbers', (() => { const x = clone(example); x.parts[0].t1 = 1e306; x.parts[1].rate = 1e306; const once = R.check(x).recipe; return deepEqual(R.check(once).recipe, once) && once.parts.length === 1 && once.parts[0].rate === 1; })());
const tie = clone(example); tie.name = 'Other';
ok('resolve of a tie keeps the first', R.resolve(example, tie).keep === example && R.resolve(example, tie).other === tie);

/* ---------------------------------------------------------------- clip names and the timeline */
const C = require(path.join(CORE, 'clipname.js'));
const T = require(path.join(CORE, 'timeline.js'));
const tl = fixture('timeline.json'), clips = tl.clips;
ok('PC name', C.fromAny('2026-11-14 18.41.07.mp4') === '2026-11-14 18.41.07' && C.fromAny('2026-11-14 18.41.07') === '2026-11-14 18.41.07');
ok('car folder', C.fromAny('14.11.2026_18_41_07_Event') === '2026-11-14 18.41.07' && C.fromAny('14.11.2026_18_41_07') === '2026-11-14 18.41.07');
ok('a file inside the car\'s folder is not the name', C.fromAny('/var/opt/x/14.11.2026_18_41_07_Event/a.ts') === null);
ok('the car\'s folder by its path', C.fromAny('/var/opt/x/14.11.2026_18_41_07_Event') === '2026-11-14 18.41.07' && C.fromAny('/var/opt/x/14.11.2026_18_41_07_Event/') === '2026-11-14 18.41.07');
ok('windows path', C.fromAny('D:\\Dashcam\\2026-11-14\\2026-11-14 18.41.07.json') === '2026-11-14 18.41.07');
ok('month 13 refused', C.fromAny('2026-13-01 00.00.00') === null && C.fromAny('01.13.2026_00_00_00') === null);
ok('hour 24 and second 60 refused', C.fromAny('2026-01-01 24.00.00') === null && C.fromAny('2026-01-01 00.00.60') === null);
ok('junk refused', C.fromAny('holiday.mp4') === null && C.fromAny(null) === null && C.fromAny('') === null && C.fromAny({}) === null);
ok('a very long name is refused, not searched', C.fromAny(new Array(5000).join('1')) === null);
ok('clips sort by time', C.compare('2026-01-01 10.00.00', '2026-01-01 10.00.40') < 0 && C.compare('2026-12-31 23.59.59', '2027-01-01 00.00.00') < 0 && C.compare('2026-01-01 10.00.00', '2026-01-01 10.00.00') === 0);
ok('40 s between two names', C.toDate('2026-01-01 10.00.40') - C.toDate('2026-01-01 10.00.00') === 40000 && isNaN(C.toDate('nope')));
ok('offsets', deepEqual(T.offsets(clips), [0, 40, 80]));
tl.cases.forEach((c) => {
    ok('timeline, to parts: ' + c.name, deepEqual(T.segsToParts(c.segs, clips), c.parts));
    const back = T.partsToSegs(c.parts, clips);
    ok('timeline, and back: ' + c.name, deepEqual(back.segs, c.segs) && back.missing.length === 0);
});
const gone = { clip: '2030-01-01 00.00.00', t0: 0, t1: 5, view: 'all', rate: 1 };
ok('missing clip kept', deepEqual(T.partsToSegs([gone], clips), { segs: [], missing: [gone] }));
ok('a missing clip between two pieces does not join them', T.partsToSegs([{ clip: clips[0].clip, t0: 30, t1: 40, view: 'all', rate: 1 }, gone, { clip: clips[1].clip, t0: 0, t1: 5, view: 'all', rate: 1 }], clips).segs.length === 2);
ok('t1 past the clip is clamped', T.partsToSegs([{ clip: clips[0].clip, t0: 30, t1: 999, view: 'all', rate: 1 }], clips).segs[0].b === 40);
ok('a part wholly past the clip\'s end is left out', T.partsToSegs([{ clip: clips[2].clip, t0: 20, t1: 30, view: 'all', rate: 1 }], clips).segs.length === 0);
ok('a seg past the end of the drive is cut there', deepEqual(T.segsToParts([{ a: 90, b: 500, view: 'all', rate: 1 }], clips), [{ clip: clips[2].clip, t0: 10, t1: 12.5, view: 'all', rate: 1 }]));
ok('bad segs and bad lists give nothing, without throwing', T.segsToParts([{ a: 9, b: 3 }, null, { a: 'x', b: 2 }], clips).length === 0 && T.segsToParts(null, clips).length === 0 && T.segsToParts([{ a: 0, b: 5 }], null).length === 0 && T.partsToSegs(null, null).segs.length === 0);
ok('absurd lengths and times stay out of the parts', (() => { const p = T.segsToParts([{ a: 0, b: 1e308, view: 'all', rate: 1 }], [{ clip: clips[0].clip, dur: 1e308 }]); return p.every((x) => isFinite(x.t0) && isFinite(x.t1)); })());
ok('length honours rate', T.length([{ clip: 'x', t0: 0, t1: 10, view: 'all', rate: 2 }]) === 5 && T.length([]) === 0 && T.length(null) === 0);
const parts2 = [{ clip: clips[0].clip, t0: 0, t1: 10, view: 'all', rate: 1 }, { clip: clips[1].clip, t0: 5, t1: 25, view: 'front', rate: 2 }];
ok('locate', deepEqual(T.locate(parts2, 12), { i: 1, clip: parts2[1].clip, t: parts2[1].t0 + 2 * parts2[1].rate }));
ok('locate at the start', deepEqual(T.locate(parts2, 0), { i: 0, clip: parts2[0].clip, t: 0 }));
ok('locate past the end, or before the start', T.locate(parts2, 1e6) === null && T.locate(parts2, -1) === null && T.locate([], 0) === null);

/* ---------------------------------------------------------------- the speed track and the picture geometry */
const S = require(path.join(CORE, 'speedtrack.js'));
const G = require(path.join(CORE, 'geometry.js'));
const sample = fixture('meta-sample.json');
const tr = S.fromMeta(sample);
ok('six samples, a second apart', deepEqual(tr.t, [0, 1, 2, 3, 4, 5]) && deepEqual(tr.kmh, [0, 10, 20, 30, 40, 50]));
ok('the same from the inner object', deepEqual(S.fromMeta(sample[0]), tr));
ok('nothing but time and speed comes out', Object.keys(tr).sort().join() === 'kmh,t' && JSON.stringify(tr).indexOf('TESTVIN') < 0 && JSON.stringify(tr).indexOf('1.5') < 0);
ok('bad input gives an empty track', [null, undefined, 7, 'x', [], {}, { entries: 'x' }, { entries: [] }, { entries: [{ date: 'x', time: 'y' }] }, [{ entries: [null] }]].every((d) => { const r = S.fromMeta(d); return r.t.length === 0 && r.kmh.length === 0; }));
ok('a speed that is missing or text counts as 0', deepEqual(S.fromMeta({ entries: [{ date: '01.01.2026', time: '10:00:00' }, { date: '01.01.2026', time: '10:00:01', velocity: '12.5' }, { date: '01.01.2026', time: '10:00:02', velocity: 'fast' }] }).kmh, [0, 12.5, 0]));
const sly = { toString: 1, valueOf: 1 };      /* plain JSON can hold this, and turning it into a number throws */
ok('a speed, or a time, that is an object does not throw', (() => { try { const r = S.fromMeta({ entries: [{ date: '01.01.2026', time: '10:00:00', velocity: sly }, { date: sly, time: sly, velocity: [sly] }, { date: '01.01.2026', time: '10:00:02', velocity: 5 }] }); return deepEqual(r.kmh, [0, 0, 5]) && S.at({ t: [sly, 1, sly], kmh: [sly, 3, sly] }, 0.5) >= 0 && S.at({ t: sly, kmh: sly }, sly) === 0 && S.show(sly, sly) === 0; } catch (e) { return false; } })());
ok('at interpolates', Math.abs(S.at({ t: [0, 1], kmh: [10, 20] }, 0.5) - 15) < 1e-9 && Math.abs(S.at(tr, 2.25) - 22.5) < 1e-9);
ok('at clamps', S.at({ t: [0, 1], kmh: [10, 20] }, 9) === 20 && S.at({ t: [0, 1], kmh: [10, 20] }, -3) === 10 && S.at({ t: [], kmh: [] }, 1) === 0 && S.at(null, 1) === 0);
ok('mph', S.show(160.9344, 'mph') === 100 && S.show(99.6, 'kmh') === 100 && S.show('x', 'mph') === 0);
ok('front crop', deepEqual(G.crop('front', 1280, 960), { x: 0, y: 0, w: 640, h: 480 }));
ok('rear crop', deepEqual(G.crop('rear', 1280, 960), { x: 640, y: 0, w: 640, h: 480 }));
ok('left crop', deepEqual(G.crop('left', 1280, 960), { x: 0, y: 480, w: 640, h: 480 }));
ok('right crop', deepEqual(G.crop('right', 1280, 960), { x: 640, y: 480, w: 640, h: 480 }));
ok('all, and an unknown camera, are the whole picture', deepEqual(G.crop('all', 1280, 960), { x: 0, y: 0, w: 1280, h: 960 }) && deepEqual(G.crop('roof', 1280, 960), { x: 0, y: 0, w: 1280, h: 960 }));
ok('vertical fill of one camera', deepEqual(G.fit(640, 480, 'vertical', true), { sx: 185, sy: 0, sw: 270, sh: 480, dx: 0, dy: 0, dw: 1080, dh: 1920, W: 1080, H: 1920 }));
ok('vertical with bars', deepEqual(G.fit(640, 480, 'vertical', false), { sx: 0, sy: 0, sw: 640, sh: 480, dx: 0, dy: 555, dw: 1080, dh: 810, W: 1080, H: 1920 }));
ok('wide with bars', deepEqual(G.fit(640, 480, 'wide', false), { sx: 0, sy: 0, sw: 640, sh: 480, dx: 240, dy: 0, dw: 1440, dh: 1080, W: 1920, H: 1080 }));
ok('wide fill crops top and bottom', deepEqual(G.fit(640, 480, 'wide', true), { sx: 0, sy: 60, sw: 640, sh: 360, dx: 0, dy: 0, dw: 1920, dh: 1080, W: 1920, H: 1080 }));
ok('original of the whole picture is untouched', deepEqual(G.fit(1280, 960, 'original', false), { sx: 0, sy: 0, sw: 1280, sh: 960, dx: 0, dy: 0, dw: 1280, dh: 960, W: 1280, H: 960 }));
ok('unknown format falls back to original', G.fit(1280, 960, 'nope', false).W === 1280 && G.fit(1280, 960, 'constructor', false).W === 1280);
ok('a picture with no size does not divide by zero', (() => { const f = G.fit(0, 0, 'wide', true); return Object.keys(f).every((k) => isFinite(f[k])); })());
ok('the same shapes as the recipe', deepEqual(G.FORMATS, R.FORMATS) && deepEqual(Object.keys(G.VIEWS).sort(), R.VIEWS.slice().sort()));
ok('index exposes every part', Object.keys(require(CORE)).sort().join() === 'audio,beats,clipname,compose,geometry,library,looks,recipe,runlog,speedtrack,timeline,tsmp4');
/* ---------------------------------------------------------------- a folder of clips */
const L = require(path.join(CORE, 'library.js'));
const folder = [
    '2026-11-14/2026-11-14 18.41.07.mp4', '2026-11-14/2026-11-14 18.41.07.json', '2026-11-14/2026-11-14 18.41.07.jpg',
    '2026-11-14\\2026-11-14 18.41.48.mp4', 'edits/Back road evening.edit.json', 'edits/Old.json', 'index.json', 'highlights.json',
    '14.11.2026_18_42_29_Event/video.ts', '14.11.2026_18_42_29_Event/Metadata.json', 'notes.txt', '2026-11-14 18.41.07.ts',
    '2026-11-14/2026-11-14 18.50.00.json', null, 7, 'exports/Evening.mp4',
];
const sorted = L.sort(folder);
ok('a folder: three clips in time order, the PC and the car layout together', sorted.clips.map((c) => c.clip).join() === '2026-11-14 18.41.07,2026-11-14 18.41.48,2026-11-14 18.42.29');
ok('each clip has its video, data file and picture by index', deepEqual(sorted.clips[0], { clip: '2026-11-14 18.41.07', video: 0, meta: 1, picture: 2, ts: false }) && deepEqual(sorted.clips[1], { clip: '2026-11-14 18.41.48', video: 3, meta: -1, picture: -1, ts: false }));
ok('the car\'s clip is named by its folder and marked as a transport stream', deepEqual(sorted.clips[2], { clip: '2026-11-14 18.42.29', video: 8, meta: 9, picture: -1, ts: true }));
ok('a clip present as .ts and .mp4 uses the .mp4, whichever came first', L.sort(['2026-11-14 18.41.07.ts', '2026-11-14 18.41.07.mp4']).clips[0].video === 1 && L.sort(['2026-11-14 18.41.07.mp4', '2026-11-14 18.41.07.ts']).clips[0].video === 0);
ok('saved edits are found, other .json files are not', deepEqual(sorted.recipes, [4]));
ok('a data file with no video is not a clip, and everything else is counted as other', sorted.other === 7 && !sorted.clips.some((c) => c.clip === '2026-11-14 18.50.00'));
ok('junk lists give an empty library without throwing', L.sort(null).clips.length === 0 && L.sort([{}, [], undefined]).clips.length === 0 && L.sort('x').recipes.length === 0);
const dr = L.drives([{ clip: '2026-11-14 18.41.48', dur: 41 }, { clip: '2026-11-14 18.41.07', dur: 41 }, { clip: '2026-11-14 18.42.29' }, { clip: '2026-11-14 19.30.00', dur: 40 }, { clip: 'nope', dur: 1 }, null]);
ok('drives: clips that follow on are one drive, a long pause starts another, newest first', dr.length === 2 && dr[0].id === '2026-11-14 19.30.00' && dr[1].id === '2026-11-14 18.41.07' && dr[1].clips.map((c) => c.clip).join() === '2026-11-14 18.41.07,2026-11-14 18.41.48,2026-11-14 18.42.29');
ok('drives: exactly at the gap is still the same drive, a second more is not', L.drives([{ clip: '2026-01-01 10.00.00', dur: 40 }, { clip: '2026-01-01 10.03.40', dur: 40 }]).length === 1 && L.drives([{ clip: '2026-01-01 10.00.00', dur: 40 }, { clip: '2026-01-01 10.03.41', dur: 40 }]).length === 2);
ok('drives of nothing', L.drives(null).length === 0 && L.drives([]).length === 0);

/* ---------------------------------------------------------------- music under a finished video */
const A = require(path.join(CORE, 'audio.js'));
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);
const mo = { dur: 10, musicDur: 60, volume: 0.8, fadeIn: 1, fadeOut: 2 };
ok('audio: fades in, holds, fades out at the clip end', near(A.gainAt(0, mo), 0) && near(A.gainAt(0.5, mo), 0.4) && near(A.gainAt(5, mo), 0.8) && near(A.gainAt(9, mo), 0.4) && near(A.gainAt(10, mo), 0));
ok('audio: music shorter than the clip fades at its end', (() => { const s = Object.assign({}, mo, { musicDur: 6 }); return near(A.gainAt(5, s), 0.4) && near(A.gainAt(6, s), 0) && near(A.gainAt(8, s), 0); })());
ok('audio: no fades and odd input stay sane', near(A.gainAt(3, { dur: 5, musicDur: 5, volume: 1, fadeIn: 0, fadeOut: 0 }), 1) && near(A.gainAt(NaN, mo), 0) && near(A.gainAt(3, { dur: 5, musicDur: 5, volume: 7 }), 1)
    && near(A.gainAt(-1, mo), 0) && near(A.gainAt(1, null), 0) && near(A.gainAt(1, { dur: 5 }), 1));
ok('audio: the envelope has a gain for every step, never above the volume', A.envelope(mo, 100).length === 1000 && Array.prototype.every.call(A.envelope(mo, 100), (g) => g >= 0 && g <= 0.8000001) && A.envelope({}, 100).length === 2);

/* ---------------------------------------------------------------- the Moment template */
const P = require(path.join(CORE, 'compose.js')), LK = require(path.join(CORE, 'looks.js'));
const mpart = { clip: '2026-11-14 18.41.07', t0: 10, t1: 40, view: 'front', rate: 1 };
ok('moment: 15 s from a long piece, vertical 1080x1920 at 30 fps', (() => { const p = P.moment(mpart, { title: 'Cold start' }); return p.dur === 15 && p.frames === 450 && p.w === 1080 && p.h === 1920 && p.fps === 30; })());
ok('moment: a short piece makes a short clip', (() => { const p = P.moment(Object.assign({}, mpart, { t1: 15 }), {}); return p.dur === 5 && p.frames === 150; })());
ok('moment: slow motion counts', P.moment(Object.assign({}, mpart, { t1: 16, rate: 0.5 }), {}).dur === 12);
ok('moment: the zoom eases in and the title comes and goes', (() => { const p = P.moment(mpart, { title: 'T', caption: 'C' }); const a = P.frameAt(p, 0), m = P.frameAt(p, 225), z = P.frameAt(p, 449);
    return a.zoom === 1 && m.zoom > 1.05 && m.zoom < 1.07 && near(z.zoom, 1.12, 0.002) && a.texts.length === 0 && P.frameAt(p, 60).texts[0].alpha === 1 && P.frameAt(p, 60).texts[0].role === 'title'
        && P.frameAt(p, 200).texts.length === 0 && P.frameAt(p, 440).texts.some((t) => t.role === 'caption'); })());
ok('moment: each frame maps to the right second of the clip', P.frameAt(P.moment(mpart, {}), 30).src === 11 && P.frameAt(P.moment(Object.assign({}, mpart, { rate: 0.5 }), {}), 30).src === 10.5 && P.frameAt(P.moment(mpart, {}), 30).view === 'front');
ok('moment: square and wide shapes; an unknown shape is vertical', P.moment(mpart, { shape: 'square' }).h === 1080 && P.moment(mpart, { shape: 'wide' }).w === 1920 && P.moment(mpart, { shape: '__proto__' }).h === 1920);
ok('moment: nothing to work with is an empty clip, not an error', [null, {}, { t0: 5, t1: 5 }, { t0: 'a', t1: NaN, rate: -1 }].every((x) => P.moment(x, null).frames === 0)
    && P.moment(mpart, { title: 'a\u0000b\n  c' + 'x'.repeat(100) }).texts[0].text.length === 60 && P.frameAt(P.moment(mpart, {}), 9999).src <= 25 && P.frameAt(P.moment(mpart, {}), NaN).src === 10);
/* ---------------------------------------------------------------- the Launch template */
const lrun = { end: 12, green: -0.42, red: false, peakG: 1.26, launchRpm: 3204, splits: [{ key: 'ft60', label: '60 FT', s: 2.04 }, { key: 'mph60', label: '0-60 MPH', s: 3.63 }, { key: 'mi4', label: '1/4 MILE', s: 11.57 }] };
ok('launch: the lights, the slow launch, the run, the hold and the card, in that order and to the frame', (() => { const p = P.launch(lrun, { lead: 10 });
    return p.parts.map((x) => x.part).join() === 'tree,slow,run,hold,card' && near(p.parts[0].d, 2.7, 1e-9) && near(p.parts[1].d, 3.75, 1e-9) && near(p.parts[2].d, 11.97 - 1.2, 1e-9) && p.parts[2].rate === 1
        && near(p.dur, 2.7 + 3.75 + 10.77 + 1.2 + 3.5, 1e-9) && p.frames === Math.round(p.dur * 30) && p.w === 1080 && p.h === 1920 && p.dur <= 25; })());
ok('launch: each frame is the right moment of the run', (() => { const p = P.launch(lrun, { lead: 10 }), f = (t) => P.frameAt(p, Math.round(t * 30));
    return near(f(0).src, -3, 1e-9) && f(0).part === 'tree' && near(f(2.7 + 1).src, -0.3 + 0.4, 1e-9) && f(3.7).part === 'slow' && near(f(2.7 + 3.75 + 2.05).src, 3.25, 1e-9) && f(8.5).part === 'run'
        && near(f(p.dur - 4).src, 11.97, 1e-9) && f(p.dur - 4).part === 'hold' && f(p.dur - 1).part === 'card' && f(p.dur - 1).card === 1 && near(P.frameAt(p, 99999).src, 11.97, 1e-9) && P.frameAt(p, 0).view === 'front'; })());
ok('launch: the lamps count down to the green the log recorded', (() => { const p = P.launch(lrun, { lead: 10 }), at = (src) => P.frameAt(p, Math.round((src + 3) * 30)).tree;
    return at(-2.5).amber === 0 && !at(-2.5).green && at(-1.7).amber === 1 && at(-1.2).amber === 2 && at(-0.7).amber === 3 && !at(-0.7).green && P.frameAt(p, Math.round((2.7 + 0.5) * 30)).tree.green === true
        && P.frameAt(p, Math.round((2.7 + 3.75 + 3) * 30)).tree === null && P.frameAt(P.launch(Object.assign({}, lrun, { green: null }), { lead: 10 }), 0).tree === null; })());
ok('launch: the timeslip holds the log\'s own figures', deepEqual(P.launch(lrun, { lead: 10 }).rows, [{ label: 'REACTION', value: '0.420' }, { label: '60 FT', value: '2.04' }, { label: '0-60 MPH', value: '3.63' }, { label: '1/4 MILE', value: '11.57' }, { label: 'PEAK', value: '1.26 G' }, { label: 'LAUNCH', value: '3200 RPM' }])
    && P.launch(Object.assign({}, lrun, { red: true }), {}).rows[0].label === 'RED LIGHT');
ok('launch: little clip before the start, a long run, a tiny run, and nonsense', (() => { const short = P.launch(lrun, { lead: 0.1 }), long = P.launch({ end: 60, splits: [{ label: '1 MILE', s: 40 }] }, { lead: 5 }), tiny = P.launch({ end: 0.8, splits: [] }, { lead: 5 });
    return short.parts[0].part === 'slow' && near(short.parts[0].a, -0.1, 1e-9) && long.parts[2].d === 12 && long.parts[2].rate > 3 && long.dur <= 25 && tiny.parts.map((x) => x.part).join() === 'tree,slow,hold,card'
        && [null, {}, { end: -1, splits: [] }, { end: 5 }, { end: NaN, splits: [] }].every((x) => P.launch(x, null).frames === 0)
        && P.launch({ end: 5, splits: [{ label: 5, s: 1 }, { label: 'X', s: 99 }, null, { label: 'a\u0000b' + 'x'.repeat(40), s: 2 }] }, {}).rows.length === 1; })());
/* ---------------------------------------------------------------- the beat, and the montage cut on it */
const B = require(path.join(CORE, 'beats.js'));
/* music as a drum would make it: a short burst every `period` seconds from `first`, on a quiet bed */
function drums(period, first, secs, rate) {
    const out = new Float32Array(Math.round(secs * rate));
    for (let i = 0; i < out.length; i++) out[i] = 0.02 * Math.sin(i * 0.05);
    for (let t = first; t < secs; t += period) { const at = Math.round(t * rate); for (let j = 0; j < rate * 0.04 && at + j < out.length; j++) out[at + j] += 0.8 * Math.sin(j * 0.9) * (1 - j / (rate * 0.04)); }
    return out;
}
ok('beat: 120 a minute is found, and where the first one falls', (() => { const b = B.detect(drums(0.5, 0.2, 20, 8000), 8000); return !!b && near(b.bpm, 120, 1) && near(b.period, 0.5, 0.011) && near(b.first, 0.2, 0.03) && b.strength > 0.3; })());
ok('beat: 90 and 150 a minute too, at another sample rate', (() => { const a = B.detect(drums(60 / 90, 0, 24, 11025), 11025), c = B.detect(drums(0.4, 0.1, 24, 11025), 11025);
    return !!a && near(a.bpm, 90, 1.5) && !!c && near(c.bpm, 150, 3) && near(c.first, 0.1, 0.03); })());
ok('beat: no pulse, no beat (a held note, silence, noise that never repeats, too short, nonsense)', (() => {
    const tone = new Float32Array(8000 * 10), quiet = new Float32Array(8000 * 10);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(i * 0.3);
    return B.detect(tone, 8000) === null && B.detect(quiet, 8000) === null && B.detect(drums(0.5, 0, 2, 8000), 8000) === null
        && [null, {}, [], 'abc'].every((x) => B.detect(x, 8000) === null) && B.detect(tone, 0) === null && B.detect(tone, NaN) === null && B.detect([NaN, 'x', {}].concat(new Array(50000).fill(0)), 8000) === null; })());
ok('beat: the grid runs from the first beat to the end, and nonsense gives none', deepEqual(B.grid({ period: 0.5, first: 0.2 }, 2), [0.2, 0.7, 1.2, 1.7]) && B.grid(null, 5).length === 0 && B.grid({ period: 0, first: 0 }, 5).length === 0 && B.grid({ period: 0.5, first: 0 }, -1).length === 0);

const mp = [0, 1, 2, 3].map((i) => ({ t0: 100 * i + 10, t1: 100 * i + 30, view: i % 2 ? 'rear' : 'front', rate: 1 }));
ok('montage: without music, even parts of two and a half seconds from the middle of each piece', (() => { const p = P.montage(mp, { title: 'Sunday' });
    return p.kind === 'montage' && p.parts.length === 4 && p.parts.every((x) => x.d === 2.5) && p.dur === 10 && p.frames === 300 && !p.onBeat && near(p.parts[1].a, 110 + (20 - 2.5) / 2, 1e-9) && p.parts[1].view === 'rear' && p.w === 1080 && p.h === 1920; })());
ok('montage: with a beat, every cut after the first falls on one', (() => { const beat = { period: 0.5, first: 0.2 }, p = P.montage(mp, { beat: beat });
    const cuts = p.parts.slice(1).map((x) => x.at);
    return p.onBeat && p.parts.length === 4 && near(p.parts[0].d, 2.7, 1e-9) && p.parts.slice(1).every((x) => near(x.d, 2.5, 1e-9)) && cuts.every((c) => near(((c - 0.2) / 0.5) % 1, 0, 1e-6) || near(((c - 0.2) / 0.5) % 1, 1, 1e-6)); })());
ok('montage: a slow beat gives longer parts, a fast one more beats a part, never under the least', (() => { const slow = P.montage(mp, { beat: { period: 1.0, first: 0 } }), fast = P.montage(mp, { beat: { period: 0.34, first: 0 } });
    return near(slow.parts[1].d, 3.0, 1e-9) || near(slow.parts[1].d, 2.0, 1e-9) ? slow.parts[1].d >= 1.2 && fast.parts[1].d >= 1.2 && near(fast.parts[1].d / 0.34 % 1, 0, 1e-6) : false; })());
ok('montage: a piece shorter than a part is cut to whole beats, one shorter than a beat is left out', (() => { const p = P.montage([{ t0: 0, t1: 20 }, { t0: 50, t1: 51.3 }, { t0: 60, t1: 60.3 }, { t0: 70, t1: 90 }], { beat: { period: 0.5, first: 0 } });
    return p.parts.length === 3 && near(p.parts[1].d, 1.0, 1e-9) && p.parts.map((x) => x.k).join() === '0,1,3'; })());
ok('montage: slow motion pieces take as much of the drive as their rate says', (() => { const p = P.montage([{ t0: 0, t1: 10, rate: 0.5 }], {}); return p.parts[0].d === 2.5 && near(p.parts[0].a, (10 - 1.25) / 2, 1e-9) && near(P.frameAt(p, 30).src, p.parts[0].a + 0.5, 1e-9); })());
ok('montage: each frame is the right part and moment, with a flash after a cut and the title at the start', (() => { const p = P.montage(mp, { title: 'Sunday' }), f = (t) => P.frameAt(p, Math.round(t * 30));
    return f(0).part === 0 && f(0).flash === 0 && near(f(1).src, p.parts[0].a + 1, 1e-9) && f(2.5).part === 1 && f(2.5).flash === 1 && f(2.5).view === 'rear' && f(2.6).flash > 0 && f(2.7).flash === 0
        && near(f(2.5).src, p.parts[1].a, 1e-9) && f(1).texts.length === 1 && f(1).texts[0].role === 'title' && f(5).texts.length === 0 && f(1).zoom > 1 && f(1).zoom < 1.05 && P.frameAt(p, 99999).part === 3; })());
ok('montage: at most eight pieces and a minute; nothing to work with is an empty clip', (() => { const many = []; for (let i = 0; i < 40; i++) many.push({ t0: i * 100, t1: i * 100 + 50 });
    return P.montage(many, {}).parts.length === 8 && P.montage(many, { maxDur: 6 }).parts.length === 2 && P.montage(many, { maxDur: 9999 }).dur <= 60
        && [null, 'x', [], [null, {}, { t0: 5, t1: 5 }, { t0: 'a', t1: 9 }]].every((x) => P.montage(x, null).frames === 0) && P.montage(mp, { beat: { period: 99, first: 'x' } }).onBeat === false && P.montage(mp, { shape: '__proto__' }).h === 1920; })());

const tm = (s, size) => s.length * size * 0.55;
ok('text: long titles fit', (() => { const r = P.fitText(tm, 'A very long title about a cold start on a winter morning at the track', 900, 64, 40);
    return r.lines.length <= 2 && r.size >= 40 && r.lines.every((l) => tm(l, r.size) <= 900); })());
ok('text: a short one is one line at full size, a medium one shrinks before it wraps, one endless word is cut', deepEqual(P.fitText(tm, 'Cold start', 900, 64, 40), { lines: ['Cold start'], size: 64 })
    && P.fitText(tm, 'A slightly longer title here', 900, 64, 40).lines.length === 1 && P.fitText(tm, 'A slightly longer title here', 900, 64, 40).size < 64
    && (() => { const r = P.fitText(tm, 'x'.repeat(200), 900, 64, 40); return r.lines.length === 1 && tm(r.lines[0], r.size) <= 900 && /…$/.test(r.lines[0]); })() && deepEqual(P.fitText(tm, null, 900, 64, 40).lines, ['']));
ok('looks: four looks, a filter string each, unknown is clean', Object.keys(LK.LOOKS).join() === 'clean,night,warm,punchy' && /^brightness\([\d.]+\) contrast\([\d.]+\) saturate\([\d.]+\)/.test(LK.filter('punchy'))
    && LK.filter('nope') === LK.filter('clean') && LK.filter('constructor') === LK.filter('clean') && /sepia/.test(LK.filter('warm')) && LK.filter('punchy', { brightness: 99 }) === LK.filter('punchy', { brightness: 1.5 }));

const sources = fs.readdirSync(CORE).filter((f) => /\.js$/.test(f)).map((f) => fs.readFileSync(path.join(CORE, f), 'utf8'));
ok('the core uses no built-in modules', sources.length === 13 && !sources.some((s) => /require\(\s*['"](fs|path|os|child_process|crypto|util|buffer)['"]/.test(s)));
ok('the core never reads a position or a VIN', !sources.some((s) => /latitude|longitude|\.vin\b|\['vin'\]/i.test(s)));

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
