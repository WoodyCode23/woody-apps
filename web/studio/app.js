/* Dashcam Studio in a browser: open a folder of clips, play them, cut an edit, save it as a recipe file.
 *
 * There is no server behind this page. Every file is read on this device and stays on it: the page makes no
 * network request at all after it has loaded (its Content-Security-Policy forbids them). The rules for what an
 * edit is live in core.js (packed from components/studio-core), the same code the car app and the PC Studio's
 * tests use, so a recipe saved here opens there.
 *
 * The clip's data file beside it holds the car's identity and where it was. It is read through the core's
 * speedtrack, which takes the speed and nothing else; the rest is never kept, shown or written.
 *
 * The finished video is made here too, frame by frame with the browser's own encoders (encode.js), with the owner's
 * music if they pick some, and as a social clip (a Moment) if they choose one. Nothing is uploaded to make it.
 * Browsers without those encoders film the edit as it plays instead: silent, and the whole edit only.
 *
 * Not here yet: the other templates, and installing to a phone's home screen. */
(function () {
'use strict';
var C = window.StudioCore;
var $ = function (id) { return document.getElementById(id); };

/* ---------------------------------------------------------------- what can be decided without a page (tested in Node) */

/* Where a save goes, given the edits already in the folder. existing: [{ file, recipe (or null when unreadable) }].
 * The rule is the PC Studio's: a save never writes over, or removes, an edit other than the one that was opened.
 *   -> { file, keepAs (a file name to copy the one on disk to first, or null), isNew } */
function planSave(name, opened, existing) {
    var safe = C.recipe.safeName(name);
    while (/\.(edit|conflict)$/i.test(safe)) safe = C.recipe.safeName(safe.replace(/\.[^.]*$/, ''));
    var taken = {};
    (existing || []).forEach(function (e) { taken[String(e.file).toLowerCase()] = e; });
    /* stem, or 'stem 2', 'stem 3'...: the first for which no file with any of these endings is there */
    var free = function (stem, ends) {
        for (var n = 1; ; n++) {
            var name = n === 1 ? stem : stem + ' ' + n;
            if (!ends.some(function (e) { return taken[(name + e).toLowerCase()]; })) return name;
        }
    };
    var target = safe + '.edit.json', there = taken[target.toLowerCase()];
    var same = opened && opened.id && there && there.recipe && there.recipe.id === opened.id;
    if (same) return { file: there.file, keepAs: there.recipe.updated !== opened.base ? free(safe, ['.conflict.edit.json']) + '.conflict.edit.json' : null, isNew: false };
    return { file: free(safe, ['.edit.json', '.json']) + '.edit.json', keepAs: null, isNew: true };
}

/* The parts of a recipe as this drive can show them, and the ones it cannot (kept in place when saving). */
function split(parts, clips) {
    return (parts || []).map(function (p) { return { part: p, shown: C.timeline.partsToSegs([p], clips).segs.length > 0 }; });
}
/* new pieces go where the first shown piece was; pieces this drive cannot show keep their order around them */
function mergeParts(oldParts, clips, fresh) {
    var kept = split(oldParts, clips), at = kept.length;
    for (var i = 0; i < kept.length; i++) if (kept[i].shown) { at = i; break; }
    var hidden = function (list) { return list.filter(function (k) { return !k.shown; }).map(function (k) { return k.part; }); };
    return hidden(kept.slice(0, at)).concat(fresh, hidden(kept.slice(at)));
}

/* The kind of video file this browser can record, best first: MP4 plays everywhere and posts anywhere, WebM is what
 * some browsers have instead. can(type) is MediaRecorder.isTypeSupported. -> { type, ext } or null */
var VIDEO_TYPES = [['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4;codecs=avc1.42E01E', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']];
function pickType(can) {
    for (var i = 0; i < VIDEO_TYPES.length; i++) { var ok = false; try { ok = !!can(VIDEO_TYPES[i][0]); } catch (e) { ok = false; } if (ok) return { type: VIDEO_TYPES[i][0], ext: VIDEO_TYPES[i][1] }; }
    return null;
}
/* the finished video's file name: the edit's name made safe, or the drive's time when it has none */
function videoName(name, driveId, ext) {
    var stem = String(name || '').trim() ? C.recipe.safeName(name) : 'Drive ' + String(driveId || '').slice(0, 16).replace(/[^0-9 -]/g, '.');
    return stem + '.' + ext;
}
/* bits a second for a picture of this size: enough that a road at speed does not turn to blocks, within what phones record at */
function bitrate(w, h) { return Math.max(4000000, Math.min(24000000, Math.round(w * h * 30 * 0.14))); }

/* Which moment of the drive each frame of the finished video shows. segs: the edit's pieces [{ a, b, rate }] in drive
 * time. -> { frames, at(i) -> { k (the piece), T (drive time) } }. A piece at half speed takes twice the frames. */
function framePlan(segs, fps) {
    var starts = [], total = 0;
    segs.forEach(function (s) { starts.push(total); total += Math.max(0, s.b - s.a) / (s.rate > 0 ? s.rate : 1); });
    var frames = Math.round(total * fps);
    return {
        frames: frames, dur: total,
        at: function (i) {
            var tau = Math.max(0, Math.min(frames - 1, i)) / fps, k = segs.length - 1;
            while (k > 0 && starts[k] > tau + 1e-9) k--;
            var s = segs[k], T = s.a + (tau - starts[k]) * (s.rate > 0 ? s.rate : 1);
            return { k: k, T: Math.max(s.a, Math.min(s.b, T)) };
        },
    };
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { planSave: planSave, mergeParts: mergeParts, split: split, pickType: pickType, videoName: videoName, bitrate: bitrate, framePlan: framePlan }; return; }

/* ---------------------------------------------------------------- state */

var files = [];               /* { name (path as listed), file (File) } */
var dir = null;               /* a folder handle, when the browser gave one we may write into */
var lib = { clips: [], recipes: [], runs: [], other: 0 };
var info = {};                /* clip name -> { dur, track, i (index in lib.clips) } */
var drives = [], D = null, clips = [], offs = [], total = 0;
var cur = -1, T = 0, playing = false, wantPlay = false, loadSeq = 0;
var urls = [];                /* [{ clip, url }] object URLs made, newest last */
var mark = { a: null, b: null };
var edit = fresh();
var esel = -1, eplay = -1, saved = [];
var runs = [], placed = [];   /* Launch data logs in the folder, and those found in this drive: [{ run, at (s into the drive), how }] */
var listening = false;        /* the music is being listened to for its beat, before a montage is made */
var making = null;            /* the exact export under way: its AbortController */
var xp = null;                /* the video being made: { rec, chunks, kind, len, done } */
var v = $('v'), pic = $('pic'), g = pic.getContext('2d'), tl = $('tl'), tg = tl.getContext('2d');

function fresh() { return { segs: [], id: null, base: null, created: null, parts: [], file: null }; }
function note(s) { $('note').textContent = s || ''; }
function mmss(t) { t = Math.max(0, t); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
var VIEW_NAME = { all: 'All four', front: 'Front', rear: 'Rear', left: 'Left', right: 'Right' };

/* ---------------------------------------------------------------- opening */

function take(list, handle) {
    files = list.filter(function (f) { return f && f.file && typeof f.name === 'string'; });
    dir = handle || null;
    lib = C.library.sort(files.map(function (f) { return f.name; }));
    info = {};
    lib.clips.forEach(function (c, i) { info[c.clip] = { dur: 0, track: null, i: i }; });
    if (!lib.clips.length) { $('e-note').textContent = files.length ? 'No dash cam clips in there (' + files.length + ' other files). Pick the folder that holds the clips.' : 'Nothing was picked.'; return; }
    $('empty').hidden = true;
    $('status').textContent = 'Reading ' + lib.clips.length + ' clips...';
    readLengths().then(function () {
        drives = C.library.drives(lib.clips.map(function (c) { return { clip: c.clip, dur: info[c.clip].dur || 0 }; }));
        var ts = lib.clips.filter(function (c) { return c.ts; }).length;
        $('status').textContent = lib.clips.length + ' clips in ' + drives.length + ' drive' + (drives.length === 1 ? '' : 's') + (ts ? ' (' + ts + ' straight from the car)' : '') + (dir ? '' : '. Edits will be saved as downloads');
        return readSaved();
    }).then(readRuns).then(function () { drawDrives(); if (drives.length) pick(drives[0].id); }).catch(function (e) { $('status').textContent = 'Could not read the folder (' + e.message + ')'; });
}

/* each clip's length and speed, from its data file when it has one (the video itself says the rest later) */
function readLengths() {
    var todo = lib.clips.filter(function (c) { return c.meta >= 0; }), i = 0, done = 0;
    function next() {
        if (i >= todo.length) return Promise.resolve();
        var c = todo[i++], f = files[c.meta].file;
        var after = function () { done++; if (done % 20 === 0 || done === todo.length) $('status').textContent = 'Reading the clips: ' + done + ' of ' + todo.length; return next(); };
        if (f.size > 8 * 1024 * 1024) return after();
        return f.text().then(function (text) {
            var doc = null;
            try { doc = JSON.parse(text); } catch (e) { /* not a data file */ }
            var track = C.speedtrack.fromMeta(doc);          /* speed only; doc is dropped here */
            doc = null;
            if (track.t.length > 1) { info[c.clip].track = track; info[c.clip].dur = track.t[track.t.length - 1] + (track.t[1] - track.t[0]); }
        }).catch(function () { /* unreadable: the video will say */ }).then(after);
    }
    /* six at a time: a stick answers small reads slowly, one after another is the slowest way to ask */
    var lanes = [];
    for (var k = 0; k < 6; k++) lanes.push(next());
    return Promise.all(lanes);
}

function readSaved() {
    saved = [];
    var i = 0;
    function next() {
        if (i >= lib.recipes.length) return Promise.resolve();
        var f = files[lib.recipes[i++]], base = f.name.split(/[\\/]/).pop();
        if (f.file.size > C.recipe.MAX_BYTES) { saved.push({ file: base, recipe: null }); return next(); }
        return f.file.text().then(function (text) { var r = C.recipe.parse(text); saved.push({ file: base, recipe: r.ok ? r.recipe : null }); }).catch(function () { saved.push({ file: base, recipe: null }); }).then(next);
    }
    return next();
}

/* Launch's data logs, when the folder holds any (copied off the car beside the clips) */
function readRuns() {
    runs = [];
    var list = (lib.runs || []).slice(0, 60), i = 0;
    function next() {
        if (i >= list.length) return Promise.resolve();
        var f = files[list[i++]];
        if (f.file.size > C.runlog.MAX_BYTES) return next();
        return f.file.text().then(function (text) { var r = C.runlog.parse(text); if (r.ok) runs.push(r.run); }).catch(function () { /* unreadable: left out */ }).then(next);
    }
    return next();
}

/* Which runs happened in this drive, and when: each run's own speed is matched against the speed the clips
 * recorded. A drive whose clips carry no speed cannot be matched, and shows no run. */
function placeRuns() {
    placed = [];
    if (!runs.length || !clips.length) return;
    var track = { t: [], kmh: [] };
    clips.forEach(function (c, i) { var tr = info[c.clip].track; if (tr) for (var k = 0; k < tr.t.length; k++) { track.t.push(offs[i] + tr.t[k]); track.kmh.push(tr.kmh[k]); } });
    if (track.t.length < 4) return;
    runs.forEach(function (run) { var hit = C.runlog.align(run, track); if (hit) placed.push({ run: run, at: hit.at, nudge: 0 }); });
    placed.sort(function (a, b) { return a.at - b.at; });
}
function runNow() {
    for (var i = 0; i < placed.length; i++) { var p = placed[i], s = T - (p.at + p.nudge); if (s >= -3 && s <= p.run.end + 5) return { p: p, s: s }; }
    return null;
}
function drawRunInfo() {
    var on = placed.length > 0;
    $('run-row').hidden = !on;
    if (on) $('run-info').textContent = placed.length + ' launch' + (placed.length === 1 ? '' : 'es') + ' in this drive, at ' + placed.map(function (p) { return mmss(p.at + p.nudge); }).join(', ');
}
function nudge(d) { var now = runNow() || (placed.length ? { p: placed[0] } : null); if (!now) return; now.p.nudge = Math.round((now.p.nudge + d) * 10) / 10; drawRunInfo(); }

function fromInput(input) { take(Array.prototype.map.call(input.files, function (f) { return { name: f.webkitRelativePath || f.name, file: f }; }), null); input.value = ''; }

/* a folder the browser lets us write into (Chrome, Edge): walked a few levels deep */
function openFolder() {
    if (!window.showDirectoryPicker) { $('in-folder').click(); return; }
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
        var out = [];
        function walk(h, path, depth) {
            var jobs = [], it = h.values();
            function step() {
                return it.next().then(function (r) {
                    if (r.done || out.length > 50000) return Promise.all(jobs);
                    var e = r.value;
                    if (e.kind === 'file') jobs.push(e.getFile().then(function (f) { out.push({ name: path + e.name, file: f }); }).catch(function () { /* skipped */ }));
                    else if (depth < 3 && e.name !== 'exports') jobs.push(walk(e, path + e.name + '/', depth + 1));
                    return step();
                });
            }
            return step();
        }
        return walk(handle, '', 0).then(function () { take(out, handle); });
    }).catch(function (e) { if (e && e.name !== 'AbortError') $('e-note').textContent = 'That folder could not be opened (' + e.message + ')'; });
}

function fromDrop(ev) {
    ev.preventDefault(); $('empty').classList.remove('over');
    var items = ev.dataTransfer && ev.dataTransfer.items ? Array.prototype.slice.call(ev.dataTransfer.items) : [], out = [], jobs = [];
    function walk(entry, path, depth) {
        return new Promise(function (done) {
            if (entry.isFile) entry.file(function (f) { out.push({ name: path + entry.name, file: f }); done(); }, function () { done(); });
            else if (entry.isDirectory && depth < 4) {
                var reader = entry.createReader(), all = [];
                (function more() { reader.readEntries(function (list) { if (!list.length) { Promise.all(all).then(function () { done(); }); return; } list.forEach(function (e) { all.push(walk(e, path + entry.name + '/', depth + 1)); }); more(); }, function () { done(); }); })();
            } else done();
        });
    }
    items.forEach(function (it) { var e = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (e) jobs.push(walk(e, '', 0)); });
    if (!jobs.length && ev.dataTransfer && ev.dataTransfer.files) { take(Array.prototype.map.call(ev.dataTransfer.files, function (f) { return { name: f.name, file: f }; }), null); return; }
    Promise.all(jobs).then(function () { take(out, null); });
}

/* ---------------------------------------------------------------- drives and playing */

var clipShown = -1, clipsOpen = true;
function drawDrives() {
    var box = $('drives'); box.textContent = '';
    drives.forEach(function (d) {
        var b = document.createElement('button'), secs = d.clips.reduce(function (a, c) { return a + (info[c.clip].dur || 40); }, 0), chosen = D && D.id === d.id;
        b.className = 'item' + (chosen ? ' sel' : '');
        b.textContent = d.id.slice(0, 10) + '  ' + d.id.slice(11, 16).replace('.', ':');
        var s = document.createElement('small'); s.textContent = d.clips.length + ' clips, ' + mmss(secs) + (chosen ? (clipsOpen ? '  (press to fold)' : '  (press for its clips)') : '');
        b.appendChild(s);
        b.setAttribute('aria-expanded', chosen && clipsOpen ? 'true' : 'false');
        /* the chosen drive opens and folds its list of clips; another drive is chosen and opens */
        b.onclick = function () { if (chosen) { clipsOpen = !clipsOpen; drawDrives(); } else { clipsOpen = true; pick(d.id); } };
        box.appendChild(b);
        if (!chosen || !clipsOpen) return;
        var list = document.createElement('div'); list.className = 'cliplist'; list.id = 'cliplist';
        clips.forEach(function (c, i) {
            var row = document.createElement('button');
            row.className = 'clip' + (i === cur ? ' now' : '');
            row.textContent = c.clip.slice(11, 19).replace(/\./g, ':');
            var len = document.createElement('small'); len.textContent = mmss(c.dur) + (lib.clips[info[c.clip].i].ts ? '' : '  mp4');
            row.appendChild(len);
            row.onclick = function () { if (making) return; pause(); seek(offs[i] + 0.01); };
            list.appendChild(row);
        });
        box.appendChild(list);
    });
    clipShown = cur;
}
/* which clip is on screen, marked in the open list without drawing the list again */
function markClip() {
    clipShown = cur;
    var list = document.getElementById('cliplist');
    if (!list) return;
    Array.prototype.forEach.call(list.children, function (row, i) { var on = i === cur; if (on !== row.classList.contains('now')) row.classList.toggle('now', on); });
    var now = list.children[cur];
    if (now && now.scrollIntoView) { try { now.scrollIntoView({ block: 'nearest' }); } catch (e) { /* an old browser: it stays where it is */ } }
}

function layout() {
    clips = D.clips.map(function (c) { return { clip: c.clip, dur: info[c.clip].dur || 40 }; });
    offs = C.timeline.offsets(clips);
    total = clips.reduce(function (a, c) { return a + c.dur; }, 0);
}

function pick(id) {
    if (making) return;                              /* a video is being made from this drive */
    D = drives.filter(function (d) { return d.id === id; })[0];
    if (!D) return;
    pause(); layout();
    cur = -1; T = 0; mark = { a: null, b: null }; edit = fresh(); esel = -1; eplay = -1;
    $('e-name').value = '';
    placeRuns(); drawRunInfo();
    drawDrives(); drawEdit(); drawSaved(); seek(placed.length ? Math.max(0, placed[0].at - 3) : 0); note('');
}

function clipAt(t) { var i = clips.length - 1; while (i > 0 && offs[i] > t) i--; return i; }

/* Which clips are wanted now: the one being shown, and the next one being got ready. A clip nobody wants any more
 * stops being read (a clip from the car is about 90 MB, and a stick is slow). */
var want = {}, preparing = {}, prefetched = '';
var tsWorker = null, tsJobs = {}, tsId = 0, tsBroken = false;

/* the whole file, read in parts: given up as soon as the clip is no longer wanted, and it says how far it is */
function readWhole(file, live, onPart) {
    var size = file.size, parts = [], at = 0, STEP = 8 * 1048576;
    var next = function () {
        if (!live()) return Promise.reject(new Error('superseded'));
        if (at >= size) {
            var out = new Uint8Array(size), o = 0;
            parts.forEach(function (p) { out.set(new Uint8Array(p), o); o += p.byteLength; });
            parts = [];
            return Promise.resolve(out.buffer);
        }
        return file.slice(at, Math.min(size, at + STEP)).arrayBuffer().then(function (buf) { parts.push(buf); at += buf.byteLength; onPart(size ? at / size : 1); return next(); });
    };
    return next();
}

/* the car's stream made playable, off the page's own thread where the browser allows (ts-worker.js); here otherwise */
function rewrapAsync(buf) {
    var here = function () { var r = C.tsmp4.rewrap(new Uint8Array(buf)); return r.ok ? { ok: true, mp4: r.mp4 } : { ok: false, error: r.error }; };
    if (tsBroken || !window.Worker) return Promise.resolve().then(here);
    return new Promise(function (done) {
        try {
            if (!tsWorker) {
                tsWorker = new Worker('ts-worker.js');
                tsWorker.onmessage = function (e) { var d = e.data || {}, f = tsJobs[d.id]; if (!f) return; delete tsJobs[d.id]; f(d.ok ? { ok: true, mp4: new Uint8Array(d.mp4) } : { ok: false, error: d.error }); };
                tsWorker.onerror = function () { tsBroken = true; var jobs = tsJobs; tsJobs = {}; Object.keys(jobs).forEach(function (k) { jobs[k](null); }); };
            }
            var id = ++tsId, copy = buf.slice(0);          /* the worker takes its own copy: this one is kept in case it fails */
            tsJobs[id] = function (r) { done(r || here()); };
            tsWorker.postMessage({ id: id, buf: copy }, [copy]);
        } catch (e) { tsBroken = true; done(here()); }
    });
}

/* the video for a clip, as something the video element plays: the file itself, or the car's stream rewrapped */
function urlFor(c, quiet) {
    var hit = urls.filter(function (u) { return u.clip === c.clip; })[0];
    if (hit) return Promise.resolve(hit.url);
    if (preparing[c.clip]) return preparing[c.clip];
    var f = files[c.video].file;
    var keep = function (blob) {
        var url = URL.createObjectURL(blob);
        urls.push({ clip: c.clip, url: url });
        while (urls.length > 3) URL.revokeObjectURL(urls.shift().url);
        return url;
    };
    if (!c.ts) return Promise.resolve(keep(f));
    var shown = function () { return !quiet || (cur >= 0 && clips[cur] && clips[cur].clip === c.clip); };      /* a clip got ready ahead says nothing, until it is the one waited for */
    var p = readWhole(f, function () { return !!want[c.clip]; }, function (fr) { if (shown()) note('Getting the clip ready: ' + Math.round(fr * 100) + '%'); })
        .then(rewrapAsync)
        .then(function (r) { if (!r.ok) throw new Error(r.error); if (shown()) note(''); return keep(new Blob([r.mp4], { type: 'video/mp4' })); });
    preparing[c.clip] = p;
    var over = function () { delete preparing[c.clip]; };
    p.then(over, over);
    return p;
}

/* while a clip plays, the next one is got ready behind it, so the join between two clips does not stall */
function prefetch(i) {
    if (i < 0 || i >= clips.length) return;
    var c = lib.clips[info[clips[i].clip].i];
    if (!c || !c.ts || prefetched === c.clip) return;
    prefetched = c.clip; want[c.clip] = true;
    urlFor(c, true).catch(function () { prefetched = ''; });
}

function load(i, at) {
    var seq = ++loadSeq, c = lib.clips[info[clips[i].clip].i];
    cur = i;
    want = {}; want[c.clip] = true; prefetched = '';
    return urlFor(c).then(function (url) {
        if (seq !== loadSeq) return;
        return new Promise(function (done) {
            v.onloadedmetadata = function () {
                if (seq !== loadSeq) { done(); return; }
                /* the video's own length is the truth; a clip that had no data file gets its real length here */
                if (isFinite(v.duration) && Math.abs(v.duration - clips[i].dur) > 0.05) { info[clips[i].clip].dur = v.duration; layout(); drawDrives(); }
                v.currentTime = Math.min(Math.max(0, at), Math.max(0, clips[i].dur - 0.05));
                done();
            };
            v.onerror = function () { if (seq === loadSeq) note('This clip could not be played here'); done(); };
            v.src = url;
        });
    }).catch(function (e) { if (seq === loadSeq && e.message !== 'superseded') note('This clip could not be opened (' + e.message + ')'); });
}

function seek(t) {
    if (making) return Promise.resolve();            /* the export has the clip */
    T = Math.max(0, Math.min(total - 0.05, t));
    var i = clipAt(T), at = T - offs[i];
    if (i !== cur) return load(i, at).then(function () { if (wantPlay) v.play().catch(function () {}); });
    try { v.currentTime = at; } catch (e) { /* not ready */ }
    return Promise.resolve();
}
function play() { if (making) return; wantPlay = true; playing = true; $('b-play').textContent = 'Pause'; v.play().catch(function () {}); }
function pause() { if (xp) endVideo(false); wantPlay = false; playing = false; eplay = -1; v.playbackRate = 1; $('b-play').textContent = 'Play'; try { v.pause(); } catch (e) { /* no clip */ } }

function playEdit(k) {
    if (!edit.segs.length) { note('The edit is empty'); return; }
    eplay = k || 0; esel = eplay;
    var s = edit.segs[eplay];
    $('s-view').value = s.view;
    seek(s.a).then(function () { v.playbackRate = s.rate; play(); drawEdit(); });
}

var viewShown = '';
/* one frame: where we are, the picture, the timeline */
function frame() {
    requestAnimationFrame(frame);
    if (!D || cur < 0) return;
    if (!v.seeking && v.readyState >= 2) T = offs[cur] + v.currentTime;
    if (dragT !== null) T = dragT;
    if (cur !== clipShown) markClip();
    if (playing) {
        if (!making && !xp && clips[cur] && v.currentTime > clips[cur].dur * 0.4) prefetch(cur + 1);
        if (eplay >= 0 && edit.segs[eplay] && T >= edit.segs[eplay].b - 0.04) { if (eplay + 1 < edit.segs.length) playEdit(eplay + 1); else { if (xp) endVideo(true); pause(); } }
        else if (v.ended || v.currentTime >= clips[cur].dur - 0.04) { if (cur + 1 < clips.length) seek(offs[cur + 1]); else pause(); }
    }
    drawPic(); drawTimeline();
    if ($('s-view').value !== viewShown) { viewShown = $('s-view').value; showView(); }
    if (xp) filming();
    $('clock').textContent = mmss(T) + ' / ' + mmss(total);
}

function drawPic() {
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    var view = $('s-view').value, crop = C.geometry.crop(view, vw, vh), f = C.geometry.fit(crop.w, crop.h, $('s-fmt').value, $('c-fill').checked);
    if (pic.width !== f.W || pic.height !== f.H) { pic.width = f.W; pic.height = f.H; }
    g.fillStyle = '#050507'; g.fillRect(0, 0, f.W, f.H);
    try { g.drawImage(v, crop.x + f.sx, crop.y + f.sy, f.sw, f.sh, f.dx, f.dy, f.dw, f.dh); } catch (e) { return; }
    var track = info[clips[cur].clip].track, launch = $('c-run').checked ? runNow() : null;
    if (launch) drawRun(f, launch.p.run, launch.s);
    if ($('c-speed').checked && track && !launch) {
        var unit = $('s-unit').value, n = C.speedtrack.show(C.speedtrack.at(track, v.currentTime), unit), size = Math.round(f.H * 0.07);
        g.font = '700 ' + size + 'px system-ui, sans-serif'; g.textBaseline = 'alphabetic';
        var x = Math.round(f.W * 0.04), y = f.H - Math.round(f.H * 0.05);
        g.lineWidth = Math.max(2, size / 9); g.strokeStyle = 'rgba(0,0,0,.75)'; g.fillStyle = '#fff';
        g.strokeText(String(n), x, y); g.fillText(String(n), x, y);
        var w = g.measureText(String(n)).width;
        g.font = '600 ' + Math.round(size * 0.4) + 'px system-ui, sans-serif';
        g.strokeText(unit === 'kmh' ? 'KM/H' : 'MPH', x + w + size * 0.2, y); g.fillText(unit === 'kmh' ? 'KM/H' : 'MPH', x + w + size * 0.2, y);
    }
    if (xp || making) {                               /* the maker's mark, on the finished video only */
        var ms = Math.max(12, Math.round(f.H * 0.028));
        g.font = '600 ' + ms + 'px system-ui, sans-serif'; g.textBaseline = 'alphabetic'; g.textAlign = 'right';
        g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText('BimmerApps', f.W - Math.round(f.W * 0.03), f.H - Math.round(f.H * 0.035));
        g.textAlign = 'left';
    }
}

/* ---------------------------------------------------------------- the launch on the picture */

/* A run's data drawn on the clip: the clock, the speed, the revs with the gear, the pull, and each split for a
 * moment as it is passed. s: seconds since the car first moved (negative just before). */
function drawRun(f, run, s) {
    var W = f.W, H = f.H, u = Math.max(10, Math.round(H * 0.045)), pad = Math.round(H * 0.04), unit = $('s-unit').value;
    var live = s >= 0 && s <= run.end, d = C.runlog.at(run, Math.max(0, Math.min(run.end, s)));
    var text = function (str, x, y, size, colour, align, weight) {
        g.font = (weight || 700) + ' ' + Math.round(size) + 'px system-ui, sans-serif'; g.textAlign = align || 'left'; g.textBaseline = 'alphabetic';
        g.lineWidth = Math.max(2, size / 9); g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(str, x, y); g.fillStyle = colour; g.fillText(str, x, y);
    };
    /* the clock, top left: counting during the run, holding the last time after it */
    var clock = s < 0 ? 0 : Math.min(s, run.end);
    text(clock.toFixed(2), pad, pad + u * 2, u * 2.2, live ? '#ffffff' : '#ff1f3d');
    text(run.red ? 'RED LIGHT' : s < 0 ? 'READY' : live ? 'SECONDS' : 'RUN OVER', pad, pad + u * 2.9, u * 0.6, '#c9cad0', 'left', 600);
    /* the speed, bottom left, where the plain speed readout sits otherwise */
    var sp = String(C.speedtrack.show(d.kmh === null ? 0 : d.kmh, unit));
    text(sp, pad, H - pad, u * 1.6, '#ffffff');
    var spw = g.measureText(sp).width;
    text(unit === 'kmh' ? 'KM/H' : 'MPH', pad + spw + u * 0.3, H - pad, u * 0.6, '#c9cad0', 'left', 600);
    /* revs and gear, top right: a bar that turns red near the top */
    var bw = Math.round(W * 0.3), bh = Math.round(u * 0.5), bx = W - pad - bw, by = pad + Math.round(u * 0.4), rf = d.rpm === null ? 0 : Math.max(0, Math.min(1, d.rpm / 7200));
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    g.fillStyle = '#2a2a31'; g.fillRect(bx, by, bw, bh);
    g.fillStyle = rf > 0.9 ? '#ff1f3d' : rf > 0.76 ? '#ffb31a' : '#f2f2f4'; g.fillRect(bx, by, Math.round(bw * rf), bh);
    if (d.rpm !== null) text(String(Math.round(d.rpm / 10) * 10) + ' RPM', W - pad, by + bh + u * 0.9, u * 0.7, '#ffffff', 'right', 600);
    if (d.gear !== null && d.gear >= 1) text(String(d.gear), bx - u * 0.4, by + bh + u * 0.5, u * 1.5, '#ffffff', 'right');
    /* the pull, bottom right */
    if (d.g !== null && s >= 0) {
        text(d.g.toFixed(2) + ' G', W - pad, H - pad - (xp || making ? u * 0.9 : 0), u * 1.1, d.g >= 0.9 ? '#2fd27a' : '#ffffff', 'right');
    }
    /* a split, for two and a half seconds after it is passed: bottom middle */
    var shown = null;
    run.splits.forEach(function (x) { if (s >= x.s && s < x.s + 2.5) shown = x; });
    if (shown) {
        var label = shown.label + '   ' + shown.s.toFixed(2);
        g.font = '700 ' + Math.round(u * 1.1) + 'px system-ui, sans-serif';
        var lw = g.measureText(label).width + u * 1.2, lx = (W - lw) / 2, ly = H - pad - u * 1.7;
        g.fillStyle = 'rgba(5,5,7,.78)'; g.fillRect(lx, ly, lw, u * 1.7);
        g.fillStyle = '#ff1f3d'; g.fillRect(lx, ly, Math.max(3, u * 0.14), u * 1.7);
        text(label, W / 2, ly + u * 1.2, u * 1.1, '#ffffff', 'center');
    }
    g.textAlign = 'left';
}

/* ---------------------------------------------------------------- the finished video */

/* Play the edit through once while the browser's recorder films the picture. The recorder is held whenever the
 * picture is not moving (a clip being opened, a jump to the next piece), so those waits are not in the video. */
/* a promise that gives up: a clip that never opens must not hang an export */
function within(p, ms, why) { return Promise.race([p, new Promise(function (done, fail) { setTimeout(function () { fail(new Error(why)); }, ms); })]); }

/* Show exactly drive time t in the video element, and say when its picture is there to be drawn. "seeked" alone is
 * not that moment: the browser can say it a frame before the new picture can be drawn, and the frame before would
 * go into the video twice. So the frame itself is waited for, where the browser can say (requestVideoFrameCallback).
 * Rejects when the export was stopped, when a clip cannot be read, or when it stops answering. */
function seekExact(t) {
    if (making && making.signal.aborted) return Promise.reject(new Error('stopped'));
    /* a millisecond in: a time exactly on the line between two frames can come back as the earlier one */
    var i = clipAt(t), at = Math.max(0, Math.min(clips[i].dur - 0.02, t - offs[i] + 0.001));
    var ready = i !== cur || v.error || !v.videoWidth ? within(load(i, at), 20000, 'a clip took too long to open') : Promise.resolve();
    return ready.then(function () {
        if (v.error || !v.videoWidth) throw new Error('a clip could not be read');
        return new Promise(function (done, fail) {
            var tm = 0, gotSeek = false, gotFrame = false, over = false;
            var fin = function () { if (over || !gotSeek || !gotFrame) return; over = true; clearTimeout(tm); v.removeEventListener('seeked', onSeek); done(); };
            var frame = function () { gotFrame = true; fin(); };
            var onSeek = function () {
                gotSeek = true;
                /* no word of the frame itself: two screen refreshes (or a tenth of a second) after the seek */
                if (!v.requestVideoFrameCallback) requestAnimationFrame(function () { requestAnimationFrame(frame); });
                setTimeout(frame, 100);
                fin();
            };
            if (Math.abs(v.currentTime - at) < 0.0005 && !v.seeking && v.readyState >= 2) { over = true; done(); return; }
            tm = setTimeout(function () { if (over) return; over = true; v.removeEventListener('seeked', onSeek); fail(new Error('a clip stopped answering')); }, 8000);
            if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frame);
            v.addEventListener('seeked', onSeek);
            try { v.currentTime = at; } catch (e) { clearTimeout(tm); over = true; fail(new Error('a clip could not be read')); }
        });
    }).then(function () { T = offs[cur] + v.currentTime; });
}

/* while a video is being made nothing else may move the clip or change the picture: every control but Stop is held */
function hold(on) {
    Array.prototype.forEach.call(document.querySelectorAll('button, select, input'), function (el) {
        if (el.id === 'b-video') return;
        if (on) { if (!el.disabled) { el.disabled = true; el.setAttribute('data-held', '1'); } }
        else if (el.getAttribute('data-held')) { el.disabled = false; el.removeAttribute('data-held'); }
    });
}

var MAX_VIDEO_S = 600;             /* the file is built in memory: longer than ten minutes belongs to the PC Studio */
var MAX_MUSIC_BYTES = 150 * 1024 * 1024;

/* The finished video, frame by frame (encode.js): each frame is found in the clips, drawn as the page draws it,
 * and encoded with its exact time. Faster than playing it through, and the same length as the edit to the frame. */
function makeExact(beat) {
    pause();
    var segs = edit.segs.map(function (s) { return { a: s.a, b: s.b, rate: s.rate, view: s.view }; });
    var plan = framePlan(segs, 30);
    var kind = $('t-kind').value;
    if (!plan.frames && kind !== 'launch') { note('The edit is empty'); return; }
    var step = function (i) { var f = plan.at(i); $('s-view').value = segs[f.k].view; return seekExact(f.T).then(function () { drawPic(); }); };
    var job = { canvas: pic, frames: plan.frames, dur: plan.dur, step: step };
    if (kind === 'moment') {
        /* a social clip of one piece (the selected one, else the first), drawn by social.js as the core lays it out */
        var s0 = segs[esel >= 0 && segs[esel] ? esel : 0];
        var mp = C.compose.moment({ t0: s0.a, t1: s0.b, view: s0.view, rate: s0.rate }, { title: $('t-title').value, caption: $('t-caption').value, look: $('t-look').value, shape: $('t-shape').value });
        if (!mp.frames) { note('That piece is too short to make a clip of'); return; }
        var mc = document.createElement('canvas'); mc.width = mp.w; mc.height = mp.h;
        var mg = mc.getContext('2d');
        job = { canvas: mc, frames: mp.frames, dur: mp.dur, step: function (i) {
            var fr = C.compose.frameAt(mp, i);
            return seekExact(fr.src).then(function () {
                var track = info[clips[cur].clip].track, unit = $('s-unit').value;
                var speed = $('c-speed').checked && track ? { n: C.speedtrack.show(C.speedtrack.at(track, v.currentTime), unit), unit: unit === 'kmh' ? 'KM/H' : 'MPH' } : null;
                StudioSocial.drawMoment(mg, v, mp, fr, { speed: speed });
            });
        } };
    }
    if (kind === 'montage') {
        /* up to eight pieces, a couple of seconds of each, cut on the music's beat when it has one. The beat has to
         * be known before the cuts can be placed, so the music is listened to first and this comes round again. */
        var mfile = $('m-file').files && $('m-file').files[0];
        if (beat === undefined && mfile && mfile.size <= MAX_MUSIC_BYTES) {
            if (listening) return;
            listening = true;
            note('Listening to the music for its beat...');
            mfile.arrayBuffer().then(function (bytes) { return StudioEncode.findBeat(bytes); }).catch(function () { return null; })
                .then(function (found) { listening = false; makeExact(found || null); });
            return;
        }
        var gp = C.compose.montage(segs.map(function (x) { return { t0: x.a, t1: x.b, view: x.view, rate: x.rate }; }), { title: $('t-title').value, look: $('t-look').value, shape: $('t-shape').value, beat: beat || null });
        if (!gp.frames) { note('Those pieces are too short to make a montage of'); return; }
        var gc = document.createElement('canvas'); gc.width = gp.w; gc.height = gp.h;
        var gg = gc.getContext('2d');
        job = { canvas: gc, frames: gp.frames, dur: gp.dur, beat: gp.onBeat ? beat : null, step: function (i) {
            var fr = C.compose.frameAt(gp, i);
            return seekExact(fr.src).then(function () {
                var track = info[clips[cur].clip].track, unit = $('s-unit').value;
                var speed = $('c-speed').checked && track ? { n: C.speedtrack.show(C.speedtrack.at(track, v.currentTime), unit), unit: unit === 'kmh' ? 'KM/H' : 'MPH' } : null;
                StudioSocial.drawMontage(gg, v, gp, fr, { speed: speed });
            });
        } };
    }
    if (kind === 'launch') {
        /* a launch from its data log: the one under the playhead, else the first found in this drive */
        var hit = runNow(), pl = hit ? hit.p : placed[0];
        if (!pl) { note('No launch was found in this drive. Open the folder that also holds the run\'s data file from the Launch app'); return; }
        var t0 = pl.at + pl.nudge, run = pl.run;
        var lp = C.compose.launch(run, { lead: t0, title: $('t-title').value, look: $('t-look').value, shape: $('t-shape').value });
        if (!lp.frames) { note('That run is too short to make a clip of'); return; }
        var lc = document.createElement('canvas'); lc.width = lp.w; lc.height = lp.h;
        var lg = lc.getContext('2d'), unit0 = $('s-unit').value;
        job = { canvas: lc, frames: lp.frames, dur: lp.dur, step: function (i) {
            var fr = C.compose.frameAt(lp, i);
            return seekExact(Math.max(0, Math.min(total - 0.05, t0 + fr.src))).then(function () { StudioSocial.drawLaunch(lg, v, lp, fr, run, { unit: unit0 }); });
        } };
    }
    if (job.dur > MAX_VIDEO_S) { note('That is ' + mmss(job.dur) + ' long. This page makes videos up to ' + mmss(MAX_VIDEO_S) + '; the Studio on your computer makes longer ones from the saved edit'); return; }
    var musicFile = $('m-file').files && $('m-file').files[0], sound = { asked: !!musicFile, read: false, big: false };
    if (musicFile && musicFile.size > MAX_MUSIC_BYTES) { sound.big = true; musicFile = null; }
    /* from here on the export is under way: everything above returns without leaving the page held */
    var ctl = new AbortController(), view0 = $('s-view').value, drive0 = D, again = false;
    making = ctl;
    hold(true);
    $('b-video').textContent = 'Stop';
    var music = !musicFile ? Promise.resolve(null) : musicFile.arrayBuffer().then(function (bytes) {
        note('Reading the music...');
        return StudioEncode.mixMusic(bytes, { dur: job.dur, volume: Number($('m-vol').value) / 100, fadeIn: Math.min(1, job.dur / 4), fadeOut: Math.min(2, job.dur / 3) });
    }).catch(function () { return null; });
    music.then(function (buffer) { sound.read = !!buffer; sound.buffer = buffer; return job.step(0); }).then(function () {
        return StudioEncode.encode({ canvas: job.canvas, fps: 30, frames: job.frames, bitrate: bitrate(job.canvas.width, job.canvas.height), drawFrame: job.step, audio: sound.buffer, signal: ctl.signal,
            onProgress: function (d, n) { note('Making the video: frame ' + d + ' of ' + n); } });
    }).then(function (blob) {
        var name = videoName($('e-name').value, drive0.id, 'mp4');
        downloadBlob(name, blob);
        var quiet = !sound.asked ? '' : sound.big ? ' That music file is too large: the video is silent.' : !sound.read ? ' That music file could not be read: the video is silent.' : !blob.hadSound ? ' This browser cannot add sound: the video is silent.' : '';
        var cut = kind !== 'montage' ? '' : job.beat ? ' Cut on the beat (' + Math.round(job.beat.bpm) + ' a minute).' : sound.read ? ' No clear beat in that music: the cuts are evenly spaced.' : '';
        note('Made ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' MB). It is in your downloads.' + quiet + cut);
    }).catch(function (e) {
        if (e && e.code === 'no-encoder') { again = true; return; }          /* no H.264 encoder here: the older way can still make one */
        note(e && e.message === 'stopped' ? 'Stopped. No video was made' : 'No video was made: ' + (e && e.message || e));
    }).then(function () {
        making = null; hold(false);
        $('s-view').value = view0;
        $('b-video').textContent = 'Make the video';
        if (again && edit.segs.length) makeRecorded();
    });
}

function makeVideo() {
    if (making) { making.abort(); note('Stopping...'); return; }
    if (listening) return;
    if (xp) { pause(); note('Stopped. No video was made'); return; }
    if (!D || (!edit.segs.length && $('t-kind').value !== 'launch')) { note('Add a piece to the edit first'); return; }
    if (window.StudioEncode && StudioEncode.supported().video) { makeExact(); return; }
    if (!edit.segs.length) { note('This browser cannot make a Launch clip. Add a piece to the edit to make a plain video'); return; }
    makeRecorded();
}

/* The older way, for browsers without the encoders: the edit played through once and filmed. It cannot make a
 * Moment or add music, and says so. */
function makeRecorded() {
    var lost = ($('t-kind').value !== 'edit' ? ' This browser cannot make that kind of clip: this is the whole edit.' : '') + ($('m-file').files && $('m-file').files[0] ? ' This browser cannot add music: the video is silent.' : '');
    if (!window.MediaRecorder || !pic.captureStream) { note('This browser cannot make the video. The Studio on your computer can, from the saved edit'); return; }
    var kind = pickType(function (t) { return MediaRecorder.isTypeSupported(t); });
    if (!kind) { note('This browser cannot make the video. The Studio on your computer can, from the saved edit'); return; }
    pause();
    var rec;
    try { rec = new MediaRecorder(pic.captureStream(30), { mimeType: kind.type, videoBitsPerSecond: bitrate(pic.width, pic.height) }); }
    catch (e) { note('The video could not be started (' + e.message + ')'); return; }
    var job = { rec: rec, chunks: [], kind: kind, done: false, len: edit.segs.reduce(function (a, s) { return a + (s.b - s.a) / s.rate; }, 0), at: 0, last: 0 };
    rec.ondataavailable = function (e) { if (e.data && e.data.size) job.chunks.push(e.data); };
    rec.onerror = function () { if (xp === job) { xp = null; pause(); } note('The video could not be made here'); $('b-video').textContent = 'Make the video'; };
    rec.onstop = function () {
        $('b-video').textContent = 'Make the video';
        if (!job.done) return;
        var blob = new Blob(job.chunks, { type: kind.type.split(';')[0] }), name = videoName($('e-name').value, D.id, kind.ext);
        if (!blob.size) { note('The video came out empty. Try again with the page in front'); return; }
        downloadBlob(name, blob);
        note('Made ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' MB). It is in your downloads.' + lost);
    };
    xp = job;
    $('b-video').textContent = 'Stop';
    rec.start(1000); rec.pause();
    playEdit(0);
}
/* called on every frame while a video is being made: film only while the picture moves, and say how far it is */
function filming() {
    var job = xp, moving = playing && eplay >= 0 && !v.seeking && !v.paused && v.readyState >= 3, now = performance.now();
    try {
        if (moving && job.rec.state === 'paused') job.rec.resume();
        else if (!moving && job.rec.state === 'recording') job.rec.pause();
    } catch (e) { /* the recorder says so itself through onerror */ }
    if (moving && job.last) job.at += (now - job.last) / 1000;
    job.last = moving ? now : 0;
    note('Making the video: ' + mmss(job.at) + ' of ' + mmss(job.len) + '. Keep this page in front until it is done');
}
function endVideo(whole) {
    var job = xp;
    xp = null;
    if (!job) return;
    job.done = !!whole;
    try { if (job.rec.state !== 'inactive') job.rec.stop(); } catch (e) { /* already stopped */ }
    if (!whole) note('Stopped. No video was made');
}
function downloadBlob(name, blob) {
    var a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

function drawTimeline() {
    var W = tl.clientWidth, H = tl.clientHeight, dpr = window.devicePixelRatio || 1;
    if (tl.width !== Math.round(W * dpr)) { tl.width = Math.round(W * dpr); tl.height = Math.round(H * dpr); }
    tg.setTransform(dpr, 0, 0, dpr, 0, 0);
    var X = function (t) { return total ? t / total * W : 0; };
    tg.fillStyle = '#0b0b0e'; tg.fillRect(0, 0, W, H);
    for (var i = 0; i < clips.length; i++) { tg.fillStyle = i % 2 ? '#15151a' : '#1c1c22'; tg.fillRect(X(offs[i]), 18, X(clips[i].dur) - 1, H - 36); }
    /* the speed, as a line across the drive */
    tg.strokeStyle = '#3a3b44'; tg.lineWidth = 1; tg.beginPath();
    var top = 1;
    clips.forEach(function (c) { var tr = info[c.clip].track; if (tr) for (var k = 0; k < tr.kmh.length; k += 15) top = Math.max(top, tr.kmh[k]); });
    clips.forEach(function (c, i) {
        var tr = info[c.clip].track;
        if (!tr) return;
        for (var k = 0; k < tr.t.length; k += 15) { var x = X(offs[i] + tr.t[k]), y = H - 20 - tr.kmh[k] / top * (H - 44); if (k === 0 && i === 0) tg.moveTo(x, y); else tg.lineTo(x, y); }
    });
    tg.stroke();
    edit.segs.forEach(function (s, i) { tg.fillStyle = i === esel ? 'rgba(255,31,61,.45)' : 'rgba(255,255,255,.16)'; tg.fillRect(X(s.a), 18, Math.max(2, X(s.b) - X(s.a)), H - 36); });
    if (mark.a !== null) {
        var b = mark.b !== null ? mark.b : T;
        tg.fillStyle = 'rgba(255,179,26,.28)'; tg.fillRect(X(Math.min(mark.a, b)), 4, Math.max(2, Math.abs(X(b) - X(mark.a))), H - 8);
    }
    tg.fillStyle = '#ff1f3d'; tg.fillRect(X(T) - 1, 0, 2, H);
    tg.fillStyle = '#8f9199'; tg.font = '11px system-ui, sans-serif'; tg.textBaseline = 'top';
    tg.fillText(D.id.slice(11, 16).replace('.', ':'), 4, 3);
}

/* ---------------------------------------------------------------- the edit */

function drawEdit() {
    var box = $('pieces'); box.textContent = '';
    edit.segs.forEach(function (s, i) {
        var d = document.createElement('div'); d.className = 'piece' + (i === esel ? ' sel' : '');
        var topRow = document.createElement('div'); topRow.className = 'top';
        var b = document.createElement('b'); b.textContent = (i + 1) + '. ' + VIEW_NAME[s.view] + (s.rate !== 1 ? '  ' + s.rate + 'x' : '');
        var sm = document.createElement('small'); sm.textContent = mmss((s.b - s.a) / s.rate) + ' at ' + mmss(s.a);
        topRow.appendChild(b); topRow.appendChild(sm);
        topRow.onclick = function () { esel = i; pause(); $('s-view').value = s.view; seek(s.a); drawEdit(); };
        var ctl = document.createElement('div'); ctl.className = 'ctl';
        var sv = document.createElement('select'); sv.setAttribute('aria-label', 'Camera for piece ' + (i + 1));
        Object.keys(VIEW_NAME).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = VIEW_NAME[k]; sv.appendChild(o); });
        sv.value = s.view; sv.onchange = function () { s.view = sv.value; drawEdit(); };
        var sr = document.createElement('select'); sr.setAttribute('aria-label', 'Speed of piece ' + (i + 1));
        [0.25, 0.5, 1, 2, 4].forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k + 'x'; sr.appendChild(o); });
        if ([0.25, 0.5, 1, 2, 4].indexOf(s.rate) < 0) { var o = document.createElement('option'); o.value = s.rate; o.textContent = s.rate + 'x'; sr.appendChild(o); }
        sr.value = s.rate; sr.onchange = function () { s.rate = Number(sr.value); drawEdit(); };
        var btn = function (label, title, fn, off) { var x = document.createElement('button'); x.textContent = label; x.title = title; x.setAttribute('aria-label', title); x.disabled = !!off; x.onclick = fn; return x; };
        ctl.appendChild(sv); ctl.appendChild(sr);
        ctl.appendChild(btn('Up', 'Move piece ' + (i + 1) + ' earlier', function () { edit.segs.splice(i - 1, 0, edit.segs.splice(i, 1)[0]); esel = i - 1; drawEdit(); }, i === 0));
        ctl.appendChild(btn('Down', 'Move piece ' + (i + 1) + ' later', function () { edit.segs.splice(i + 1, 0, edit.segs.splice(i, 1)[0]); esel = i + 1; drawEdit(); }, i === edit.segs.length - 1));
        ctl.appendChild(btn('Remove', 'Remove piece ' + (i + 1), function () { edit.segs.splice(i, 1); esel = -1; drawEdit(); }));
        d.appendChild(topRow); d.appendChild(ctl); box.appendChild(d);
    });
    var len = edit.segs.reduce(function (a, s) { return a + (s.b - s.a) / s.rate; }, 0), hidden = split(edit.parts, clips).filter(function (k) { return !k.shown; }).length;
    $('e-info').textContent = edit.segs.length ? edit.segs.length + ' piece' + (edit.segs.length === 1 ? '' : 's') + ', ' + mmss(len) + (hidden ? '. ' + hidden + ' more from clips that are not in this drive; they stay in the edit' : '')
        : 'Mark a start and an end on the timeline, then Add to edit.';
}

function addMarked() {
    if (mark.a === null) { note('Mark a start first'); return; }
    var a = Math.min(mark.a, mark.b !== null ? mark.b : T), b = Math.max(mark.a, mark.b !== null ? mark.b : T);
    if (b - a < 0.1) { note('That piece is too short'); return; }
    edit.segs.push({ a: a, b: b, view: $('s-view').value, rate: 1 });
    esel = edit.segs.length - 1; mark = { a: null, b: null }; note(''); drawEdit();
}

function drawSaved() {
    var box = $('saved'); box.textContent = '';
    var here = {};
    clips.forEach(function (c) { here[c.clip] = true; });
    var list = saved.filter(function (e) { return e.recipe && e.recipe.parts.some(function (p) { return here[p.clip]; }); });
    if (!list.length) { var p = document.createElement('p'); p.className = 'help'; p.textContent = 'None for this drive yet.'; box.appendChild(p); return; }
    list.forEach(function (e) {
        var b = document.createElement('button'), conflict = /\.conflict\.edit\.json$/i.test(e.file);
        b.className = 'item'; b.textContent = e.recipe.name + (conflict ? ' (other copy)' : '');
        var s = document.createElement('small'); s.textContent = e.recipe.parts.length + ' pieces, saved on the ' + e.recipe.by;
        b.appendChild(s);
        b.onclick = function () { openSaved(e, conflict); };
        box.appendChild(b);
    });
}

function openSaved(e, conflict) {
    var r = e.recipe, shown = split(r.parts, clips).filter(function (k) { return k.shown; }).map(function (k) { return k.part; });
    pause();
    edit = { segs: C.timeline.partsToSegs(shown, clips).segs, id: conflict ? null : r.id, base: conflict ? null : r.updated, created: conflict ? null : r.created, parts: conflict ? [] : r.parts, file: conflict ? null : e.file };
    $('e-name').value = r.name + (conflict ? ' other copy' : '');
    $('s-fmt').value = r.format; $('c-fill').checked = r.fill; $('c-speed').checked = r.speed.show; $('s-unit').value = r.speed.unit;
    esel = -1; drawEdit();
    note('Opened "' + r.name + '"');
    if (edit.segs.length) seek(edit.segs[0].a);
}

/* ---------------------------------------------------------------- saving */

function save() {
    if (!D) return;
    if (!edit.segs.length && !edit.parts.length) { note('The edit is empty'); return; }
    var name = $('e-name').value.trim() || 'Edit ' + D.id.slice(0, 16).replace('.', '');
    var opened = edit.id ? { id: edit.id, base: edit.base } : null;
    var plan = planSave(name, opened, saved);
    var when = nowIso();
    var r = plan.isNew ? C.recipe.create({ name: name, by: 'web' }, when) : { v: 1, id: edit.id, created: edit.created, updated: when, by: 'web', name: name, parts: [] };
    if (plan.isNew && plan.file.toLowerCase() !== (C.recipe.safeName(name) + '.edit.json').toLowerCase()) name = plan.file.replace(/\.edit\.json$/i, '');
    r.name = name; r.format = $('s-fmt').value; r.fill = $('c-fill').checked; r.speed = { show: $('c-speed').checked, unit: $('s-unit').value };
    r.parts = mergeParts(plan.isNew ? [] : edit.parts, clips, C.timeline.segsToParts(edit.segs, clips));
    r = C.recipe.touch(r, 'web', when);
    var text = r ? C.recipe.stringify(r) : '';
    if (!text) { note('Not saved: the edit could not be written'); return; }
    var done = function (how) {
        var i = -1;
        saved.forEach(function (e, k) { if (e.file.toLowerCase() === plan.file.toLowerCase()) i = k; });
        if (plan.keepAs && i >= 0) saved.push({ file: plan.keepAs, recipe: saved[i].recipe });
        if (i >= 0) saved[i] = { file: plan.file, recipe: r }; else saved.push({ file: plan.file, recipe: r });
        edit.id = r.id; edit.base = r.updated; edit.created = r.created; edit.parts = r.parts; edit.file = plan.file;
        $('e-name').value = r.name; drawSaved();
        note('Saved "' + r.name + '" ' + how + (plan.keepAs ? '. It had been changed somewhere else; that version is kept as "other copy"' : ''));
    };
    if (!dir) { download(plan.file, text); done('as a download: put it in an "edits" folder beside the clips'); return; }
    dir.getDirectoryHandle('edits', { create: true }).then(function (folder) {
        var write = function (file, body) { return folder.getFileHandle(file, { create: true }).then(function (h) { return h.createWritable(); }).then(function (w) { return w.write(body).then(function () { return w.close(); }); }); };
        var first = plan.keepAs ? folder.getFileHandle(plan.file).then(function (h) { return h.getFile(); }).then(function (f) { return f.text(); }).then(function (old) { return write(plan.keepAs, old); }) : Promise.resolve();
        return first.then(function () { return write(plan.file, text); });
    }).then(function () { done('in the folder'); }).catch(function (e) { download(plan.file, text); done('as a download, because the folder could not be written (' + e.message + ')'); });
}

function download(name, text) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

/* ---------------------------------------------------------------- wiring */

$('b-folder').onclick = $('e-folder').onclick = openFolder;
$('b-files').onclick = $('e-files').onclick = function () { $('in-files').click(); };
$('in-folder').onchange = function () { fromInput(this); };
$('in-files').onchange = function () { fromInput(this); };
['dragenter', 'dragover'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); $('empty').classList.add('over'); }); });
document.addEventListener('dragleave', function () { $('empty').classList.remove('over'); });
document.addEventListener('drop', fromDrop);

$('b-play').onclick = function () { if (playing) pause(); else if (D) play(); };
$('b-in').onclick = function () { mark.a = T; mark.b = null; };
$('b-out').onclick = function () { if (mark.a === null) mark.a = 0; mark.b = T; };
$('b-add').onclick = addMarked;
$('b-playedit').onclick = function () { playEdit(0); };
$('b-clear').onclick = function () { pause(); var name = $('e-name').value; edit = fresh(); esel = -1; $('e-name').value = name; drawEdit(); note('Cleared. Saving now makes a new edit'); };
$('b-save').onclick = save;
$('b-video').onclick = makeVideo;
$('t-kind').onchange = function () {
    $('t-more').hidden = this.value === 'edit'; $('t-caption-row').hidden = this.value !== 'moment';
    $('t-help').textContent = this.value === 'montage' ? 'A Montage is up to eight of your pieces, a couple of seconds from the middle of each, with a flash at every cut. Add music below and the cuts fall on its beat.'
        : this.value === 'launch' ? 'A Launch is one run from the Launch app\'s data log: the lights, the launch in slow motion, the run with its figures, and a timeslip. Park the playhead on the run you want, or the first one is used.'
        : 'A Moment is the piece you selected (or the first), up to 15 seconds, with a slow push-in. Add music below.';
};
$('b-run-back').onclick = function () { nudge(-0.1); };
$('b-run-fwd').onclick = function () { nudge(0.1); };
function showView() { Array.prototype.forEach.call($('views').children, function (b) { b.classList.toggle('on', b.getAttribute('data-view') === $('s-view').value); }); }
$('s-view').onchange = function () { if (esel >= 0 && edit.segs[esel] && !playing) { edit.segs[esel].view = this.value; drawEdit(); } showView(); };
Array.prototype.forEach.call($('views').children, function (b) { b.onclick = function () { if (making) return; $('s-view').value = b.getAttribute('data-view'); $('s-view').onchange(); }; });
showView();

var dragging = false, dragT = null;
/* A drag across clips used to ask for every clip it passed over, each about 90 MB off the stick, all at once.
 * Now the playhead follows the pointer and only the clip it is let go on (or a clip already here) is shown. */
function tlSeek(e, last) {
    if (making) return;
    var r = tl.getBoundingClientRect(), t = Math.max(0, Math.min(total - 0.05, (e.clientX - r.left) / r.width * total));
    pause();
    if (last || clipAt(t) === cur) { dragT = null; seek(t); } else dragT = t;
}
tl.addEventListener('pointerdown', function (e) { if (!D) return; dragging = true; tl.setPointerCapture(e.pointerId); tlSeek(e, false); });
tl.addEventListener('pointermove', function (e) { if (dragging) tlSeek(e, false); });
tl.addEventListener('pointerup', function (e) { if (dragging) { dragging = false; tlSeek(e, true); } });
tl.addEventListener('pointercancel', function () { dragging = false; if (dragT !== null) { var t = dragT; dragT = null; seek(t); } });

document.addEventListener('keydown', function (e) {
    if (making) return;
    if (!D || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox') return;
    var k = e.key;
    if (k === ' ') { e.preventDefault(); if (e.target.tagName === 'BUTTON') return; if (playing) pause(); else play(); }
    else if (k === 'i' || k === 'I') $('b-in').onclick();
    else if (k === 'o' || k === 'O') $('b-out').onclick();
    else if (k === 'Enter' && e.target.tagName !== 'BUTTON') addMarked();
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); pause(); seek(T + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)); }
    else if (k === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (/^[1-5]$/.test(k)) { $('s-view').value = ['all', 'front', 'rear', 'left', 'right'][Number(k) - 1]; $('s-view').onchange(); }
});

requestAnimationFrame(frame);
})();
