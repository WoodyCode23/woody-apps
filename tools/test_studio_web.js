'use strict';
/* node tools/test_studio_web.js
 * The Studio's web app (web/studio) as far as it can be checked without a browser: the packed core is current and
 * loads as a browser would load it, the page's save rules never write over another edit, every element the script
 * asks for is on the page, and the page can talk to no server. What this cannot show is the page working under a
 * finger: that needs a browser (tools/serve_studio_web.cmd). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const WEB = path.join(__dirname, '..', 'web', 'studio');
let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const deepEqual = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; } };
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

/* ---- the packed core */
const packed = read('core.js').replace(/\r\n/g, '\n');
ok('core.js is what the core gives now (else: node tools/build_studio_web.js)', packed === require('./build_studio_web.js').build());
const box = { self: {} };
vm.runInNewContext(packed, box);
const C = box.self.StudioCore;
ok('it loads with no Node around it and has every part', !!C && Object.keys(C).sort().join() === 'audio,beats,clipname,compose,geometry,library,looks,recipe,runlog,speedtrack,timeline,tsmp4');
ok('and the parts work there', C.clipname.fromAny('14.11.2026_18_41_07_Event') === '2026-11-14 18.41.07' && C.recipe.check(C.recipe.create({ name: 'A', by: 'web' }, '2026-11-14T19:02:11Z')).ok);

/* ---- the page's own rules */
global.window = { StudioCore: require(path.join(__dirname, '..', 'components', 'studio-core')) };
const A = require(path.join(WEB, 'app.js'));
const R = global.window.StudioCore.recipe;
const mk = (name, id, updated) => { const r = R.create({ name: name, by: 'pc' }, updated || '2026-11-14T19:00:00Z', () => 0.5); r.id = id; return r; };
const evening = mk('Evening', 'aaaaaa');
const folder = [{ file: 'Evening.edit.json', recipe: evening }, { file: 'Broken.edit.json', recipe: null }, { file: 'Old.json', recipe: null }];

ok('a first save takes its own name', deepEqual(A.planSave('Night', null, folder), { file: 'Night.edit.json', keepAs: null, isNew: true }));
ok('a new edit with a taken name gets the next free one', deepEqual(A.planSave('Evening', null, folder), { file: 'Evening 2.edit.json', keepAs: null, isNew: true }));
ok('and the one after that', A.planSave('Evening', null, folder.concat([{ file: 'evening 2.EDIT.json', recipe: null }])).file === 'Evening 3.edit.json');
ok('a file this page cannot read is never written over', A.planSave('Broken', null, folder).file === 'Broken 2.edit.json');
ok('nor a first-generation edit of that name', A.planSave('Old', null, folder).file === 'Old 2.edit.json');
ok('the edit that was opened is written again in place', deepEqual(A.planSave('Evening', { id: 'aaaaaa', base: evening.updated }, folder), { file: 'Evening.edit.json', keepAs: null, isNew: false }));
ok('changed somewhere else since it was opened: the copy on disk is kept first', deepEqual(A.planSave('Evening', { id: 'aaaaaa', base: '2026-01-01T00:00:00Z' }, folder), { file: 'Evening.edit.json', keepAs: 'Evening.conflict.edit.json', isNew: false }));
ok('a second such copy does not replace the first', A.planSave('Evening', { id: 'aaaaaa', base: 'x' }, folder.concat([{ file: 'Evening.conflict.edit.json', recipe: evening }])).keepAs === 'Evening 2.conflict.edit.json');
ok('saved under another name: a new edit, the opened one untouched', deepEqual(A.planSave('Night', { id: 'aaaaaa', base: evening.updated }, folder), { file: 'Night.edit.json', keepAs: null, isNew: true }));
ok('an opened edit saved under ANOTHER edit\'s name does not take its file', (() => { const p = A.planSave('Evening', { id: 'bbbbbb', base: 'x' }, folder); return p.isNew && p.file === 'Evening 2.edit.json' && p.keepAs === null; })());
ok('names cannot leave the folder or pose as something else', ['..\\..\\evil', 'a/b', 'con', 'x.conflict', 'y.edit', ''].every((n) => { const f = A.planSave(n, null, []).file; return /^[A-Za-z0-9 .()_-]+\.edit\.json$/.test(f) && !/\.conflict\.edit\.json$|\.edit\.edit\.json$|^\./.test(f) && f.indexOf('..') < 0; }));

const clips = [{ clip: '2026-01-01 10.00.00', dur: 40 }, { clip: '2026-01-01 10.00.40', dur: 12.5 }];
const gone1 = { clip: '2030-05-05 05.05.05', t0: 2, t1: 9, view: 'rear', rate: 2 }, gone2 = { clip: '2031-06-06 06.06.06', t0: 1, t1: 4, view: 'all', rate: 1 };
const past = { clip: clips[1].clip, t0: 20, t1: 30, view: 'all', rate: 1 }, here = { clip: clips[0].clip, t0: 5, t1: 15, view: 'front', rate: 1 };
const fresh = [{ clip: clips[0].clip, t0: 6, t1: 15, view: 'front', rate: 1 }];
ok('pieces this drive cannot show are told apart', deepEqual(A.split([gone1, here, past], clips).map((k) => k.shown), [false, true, false]));
ok('and keep their place around the new pieces when saving', deepEqual(A.mergeParts([gone1, here, gone2, past], clips, fresh), [gone1, fresh[0], gone2, past]));
ok('an edit with nothing shown here keeps everything, new pieces last', deepEqual(A.mergeParts([gone1, gone2], clips, fresh), [gone1, gone2, fresh[0]]));
ok('a new edit is just its pieces', deepEqual(A.mergeParts([], clips, fresh), fresh));

/* ---- the finished video */
const only = (list) => (t) => list.indexOf(t) >= 0;
ok('the video is MP4 where the browser can record it', deepEqual(A.pickType(() => true), { type: 'video/mp4;codecs=avc1.640028', ext: 'mp4' }) && A.pickType(only(['video/mp4', 'video/webm'])).ext === 'mp4');
ok('WebM where it cannot, and nothing where it can record neither', deepEqual(A.pickType(only(['video/webm;codecs=vp8', 'video/webm'])), { type: 'video/webm;codecs=vp8', ext: 'webm' }) && A.pickType(() => false) === null);
ok('a browser whose check throws is taken as unable, not as a crash', A.pickType(() => { throw new Error('no'); }) === null);
ok('the file is named after the edit, safely', A.videoName('Evening run', '2026-11-14 18.41.07', 'mp4') === 'Evening run.mp4' && /^[A-Za-z0-9 .()_-]+\.webm$/.test(A.videoName('..\\..\\evil/x', 'd', 'webm')) && A.videoName('..\\..\\evil/x', 'd', 'webm').indexOf('..') < 0);
ok('or after the drive when the edit has no name', A.videoName('  ', '2026-11-14 18.41.07', 'mp4') === 'Drive 2026-11-14 18.41.mp4');
ok('picture quality follows the picture\'s size, within limits', A.bitrate(1280, 960) > 5000000 && A.bitrate(1280, 960) < A.bitrate(1920, 1440) && A.bitrate(10, 10) === 4000000 && A.bitrate(8000, 8000) === 24000000);

/* ---- the export engine */
const E = require(path.join(WEB, 'encode.js'));
ok('encode: unsupported browsers keep the old export', deepEqual(E.supported({}), { video: false, audio: false })
    && E.supported({ VideoEncoder: function () {}, Mp4Muxer: {} }).video === true
    && E.supported({ VideoEncoder: function () {}, Mp4Muxer: {} }).audio === false
    && E.supported({ VideoEncoder: function () {} }).video === false);
ok('encode: frame times are exact', deepEqual([0, 1, 30, 31].map((i) => E.stamp(i, 30)), [0, 33333, 1000000, 1033333]));
const fp = A.framePlan([{ a: 10, b: 13, rate: 1 }, { a: 50, b: 52, rate: 0.5 }, { a: 20, b: 24, rate: 2 }], 30);
ok('each frame of the video is a moment of the drive: pieces in order, slow motion longer, fast shorter', fp.frames === 270
    && deepEqual(fp.at(0), { k: 0, T: 10 }) && fp.at(89).k === 0 && Math.abs(fp.at(89).T - (10 + 89 / 30)) < 1e-9
    && deepEqual(fp.at(90), { k: 1, T: 50 }) && Math.abs(fp.at(150).T - 51) < 1e-9 && deepEqual(fp.at(210), { k: 2, T: 20 }) && Math.abs(fp.at(269).T - (20 + 59 / 30 * 2)) < 1e-9);
ok('and odd edits do not break it', A.framePlan([], 30).frames === 0 && A.framePlan([{ a: 5, b: 5, rate: 1 }], 30).frames === 0 && A.framePlan([{ a: 0, b: 1, rate: 0 }], 30).frames === 30 && A.framePlan([{ a: 0, b: 1, rate: 1 }], 30).at(999).T <= 1);

/* ---- the page */
const html = read('index.html'), app = read('app.js');
const ids = {}; (html.match(/\bid="([^"]+)"/g) || []).forEach((m) => { ids[m.slice(4, -1)] = true; });
const asked = (app.match(/\$\('([^']+)'\)/g) || []).map((m) => m.slice(3, -2));
ok('every element the script asks for is on the page (' + asked.length + ' uses)', asked.length > 40 && asked.every((id) => ids[id]));
ok('ids are not used twice', (html.match(/\bid="([^"]+)"/g) || []).length === Object.keys(ids).length);
ok('the page may connect to nothing', /connect-src 'none'/.test(html) && /default-src 'self'/.test(html) && /form-action 'none'/.test(html));
ok('encode: the MP4 writer is local, MIT, and loaded before the app', /MIT License/.test(read('vendor/mp4-muxer.js'))
    && html.indexOf('vendor/mp4-muxer.js') > 0 && html.indexOf('vendor/mp4-muxer.js') < html.indexOf('encode.js') && html.indexOf('encode.js') < html.indexOf('app.js')
    && !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|importScripts/.test(read('encode.js')));
ok('music: the owner picks their own file, and is told to use music they have the rights to', /id="m-file"[^>]*accept="audio\/\*"/.test(html) && /music you have the rights to/.test(html) && /id="m-vol"/.test(html));
ok('social clips: the drawing is local and loaded before the app, and puts no markup on the page', html.indexOf('social.js') > html.indexOf('core.js') && html.indexOf('social.js') < html.indexOf('app.js')
    && !/innerHTML|\bfetch\(|XMLHttpRequest/.test(read('social.js')) && /id="t-kind"/.test(html) && /id="t-title"[^>]*maxlength="60"/.test(html) && /id="t-caption"[^>]*maxlength="60"/.test(html));
const mx = app.slice(app.indexOf('function makeExact('), app.indexOf('function makeVideo()'));
ok('an export that cannot start leaves the page free: nothing is held before the last way out', mx.indexOf('making = ctl') > mx.lastIndexOf("return; }\n    var musicFile") && mx.indexOf('making = ctl') > mx.indexOf('too short to make a clip of') && mx.indexOf('making = ctl') > mx.indexOf('MAX_VIDEO_S'));
ok('and it always lets go again, whatever happened', /\}\)\.then\(function \(\) \{\n        making = null; hold\(false\);/.test(mx));
ok('while a video is being made nothing else moves the clip', /function pick\(id\) \{\n    if \(making\) return;/.test(app) && /function seek\(t\) \{\n    if \(making\) return/.test(app) && /function play\(\) \{ if \(making\) return;/.test(app)
    && /function tlSeek\(e, last\) \{\n    if \(making\) return;/.test(app) && /'keydown', function \(e\) \{\n    if \(making\) return;/.test(app));
ok('a drag along the timeline fetches one clip, not every clip it passes', /if \(last \|\| clipAt\(t\) === cur\) \{ dragT = null; seek\(t\); \} else dragT = t;/.test(app));
ok('a clip from the car is rewrapped off the page thread, by a worker that loads only the core', /new Worker\('ts-worker\.js'\)/.test(app) && /importScripts\('core\.js'\)/.test(read('ts-worker.js')) && !/\bfetch\(|XMLHttpRequest|WebSocket/.test(read('ts-worker.js')));
ok('a clip nobody wants any more stops being read', /if \(!live\(\)\) return Promise\.reject\(new Error\('superseded'\)\)/.test(app) && /e\.message !== 'superseded'/.test(app));
ok('the cameras are buttons, one per view', ['all', 'front', 'rear', 'left', 'right'].every((k) => html.indexOf('data-view="' + k + '"') > 0));
ok('the chosen drive lists its clips', /list\.className = 'cliplist'/.test(app) && /\.cliplist \{/.test(html));
ok('a clip that will not open or answer ends the export with a reason, never frozen frames', /a clip could not be read/.test(app) && /a clip stopped answering/.test(app) && /a clip took too long to open/.test(app) && !/setTimeout\(fin, 4000\)/.test(app));
ok('browsers without the encoders are told what the older way leaves out', /This browser cannot make that kind of clip: this is the whole edit\./.test(app) && /This browser cannot make a Launch clip/.test(app) && /This browser cannot add music: the video is silent\./.test(app) && /e\.code === 'no-encoder'/.test(app) && /none\.code = 'no-encoder'/.test(read('encode.js')));
ok('long videos and huge music files are turned away before the wait, not after', /job\.dur > MAX_VIDEO_S/.test(app) && /musicFile\.size > MAX_MUSIC_BYTES/.test(app));
ok('nothing is stored in the browser or put on the page as markup by the new files either', ['encode.js', 'social.js'].every((f) => !/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(read(f))));
ok('a Launch clip is made from a run found in the drive, and says so when there is none', /<option value="launch">/.test(html) && /No launch was found in this drive/.test(app) && /StudioSocial\.drawLaunch\(lg, v, lp, fr, run/.test(app)
    && mx.indexOf('making = ctl') > mx.indexOf('That run is too short to make a clip of'));
ok('a Montage listens to the music first, then cuts; nothing is held while it listens and a second press is ignored', /<option value="montage">/.test(html) && /StudioEncode\.findBeat\(bytes\)/.test(app) && /if \(listening\) return;/.test(app)
    && mx.indexOf('making = ctl') > mx.indexOf('too short to make a montage of') && /StudioSocial\.drawMontage\(gg, v, gp, fr/.test(app) && /No clear beat in that music/.test(app));
ok('nothing is loaded from anywhere else', !/https?:\/\//i.test(html) && !/https?:\/\//i.test(app) && !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/.test(app));
ok('the page stores nothing in the browser behind the person\'s back', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(app));
ok('no text is put on the page as markup', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app));
ok('the data file is only ever read through the speed track', (app.match(/JSON\.parse/g) || []).length === 1 && /speedtrack\.fromMeta\(doc\)/.test(app) && !/latitude|longitude|\bvin\b/i.test(app));
const words = (html + app).replace(/\/\*[\s\S]*?\*\//g, '');
ok('wording: nothing about selling, and no long dashes', !/\b(free|buy|purchase|price|for sale|order now)\b/i.test(words.replace(/\bfree\(|var free\b|free =|= free\b|function free/g, '')) && words.indexOf('—') < 0 && words.indexOf('–') < 0);
ok('every button and field has a name a screen reader can say', (html.match(/<(select|input)[^>]*>/g) || []).every((t) => /hidden|aria-label=|id="(e-name|s-view|s-fmt|c-fill|c-speed|c-run)"/.test(t)));

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
