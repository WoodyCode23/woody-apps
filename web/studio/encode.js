/* Dashcam Studio's export engine: the finished video made frame by frame with the browser's own encoders
 * (WebCodecs) and written as an MP4 in the page (vendor/mp4-muxer.js). Every frame gets its exact time, so the
 * video is as long as the edit to the frame, and sound can be laid beside it.
 *
 * Nothing leaves the device: the frames come from a canvas the page drew, the file is handed to the owner.
 *
 *   StudioEncode.supported(env) -> { video, audio }      can this browser do it (env defaults to the window)
 *   StudioEncode.stamp(i, fps)  -> microseconds          the time of frame i
 *   StudioEncode.encode(job)    -> Promise<Blob>         an MP4
 *     job = { canvas, fps, frames, bitrate, drawFrame(i) -> Promise (draws frame i on job.canvas),
 *             audio (an AudioBuffer as long as the video, or null), onProgress(done, total), signal }
 *   A stop through job.signal rejects with Error('stopped'). The blob's hadSound says whether sound went in.
 *   StudioEncode.mixMusic(bytes, { dur, volume, fadeIn, fadeOut }) -> Promise<AudioBuffer or null>
 *   StudioEncode.findBeat(bytes) -> Promise<{ bpm, period, first, strength } or null>
 */
(function (root) {
'use strict';

function stamp(i, fps) { return Math.round(i * 1e6 / fps); }

function supported(env) {
    env = env || root;
    var video = typeof env.VideoEncoder === 'function' && !!env.Mp4Muxer;
    return { video: video, audio: video && typeof env.AudioEncoder === 'function' };
}

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* the best H.264 setting this browser will encode at this size: High, then Main, then Baseline */
async function videoConfig(w, h, fps, bitrate) {
    var codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
    for (var i = 0; i < codecs.length; i++) {
        var cfg = { codec: codecs[i], width: w, height: h, bitrate: bitrate, framerate: fps, avc: { format: 'avc' } };
        try { var s = await root.VideoEncoder.isConfigSupported(cfg); if (s && s.supported) return cfg; } catch (e) { /* try the next */ }
    }
    return null;
}

var AUDIO = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
async function audioOk() {
    try { var s = await root.AudioEncoder.isConfigSupported(AUDIO); return !!(s && s.supported); } catch (e) { return false; }
}

async function encode(job) {
    var M = root.Mp4Muxer, canvas = job.canvas, fps = job.fps, n = job.frames;
    /* H.264 wants even sizes: an odd canvas is drawn onto an even one a pixel smaller */
    var w = canvas.width - canvas.width % 2, h = canvas.height - canvas.height % 2;
    var src = canvas, even = null;
    if (w !== canvas.width || h !== canvas.height) { even = document.createElement('canvas'); even.width = w; even.height = h; src = even; }
    var cfg = await videoConfig(w, h, fps, job.bitrate);
    if (!cfg) { var none = new Error('this browser cannot encode this video'); none.code = 'no-encoder'; throw none; }
    var withAudio = !!job.audio && supported().audio && await audioOk();
    var target = new M.ArrayBufferTarget();
    var opts = { target: target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' };
    if (withAudio) opts.audio = { codec: 'aac', numberOfChannels: AUDIO.numberOfChannels, sampleRate: AUDIO.sampleRate };
    var muxer = new M.Muxer(opts);
    var failed = null;
    var venc = new root.VideoEncoder({ output: function (chunk, meta) { try { muxer.addVideoChunk(chunk, meta); } catch (e) { failed = failed || e; } }, error: function (e) { failed = failed || e; } });
    venc.configure(cfg);
    var aenc = null;
    var close = function () { try { if (venc.state !== 'closed') venc.close(); } catch (e) { /* closed */ } try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch (e) { /* closed */ } };
    try {
        for (var i = 0; i < n; i++) {
            if (job.signal && job.signal.aborted) throw new Error('stopped');
            if (failed) throw failed;
            await job.drawFrame(i);
            if (even) even.getContext('2d').drawImage(canvas, 0, 0);
            var frame = new root.VideoFrame(src, { timestamp: stamp(i, fps), duration: stamp(1, fps) });
            try { venc.encode(frame, { keyFrame: i % fps === 0 }); } finally { frame.close(); }
            while (venc.encodeQueueSize > 8) await sleep(4);
            if (job.onProgress) job.onProgress(i + 1, n);
        }
        await venc.flush();
        if (withAudio) {
            aenc = new root.AudioEncoder({ output: function (chunk, meta) { try { muxer.addAudioChunk(chunk, meta); } catch (e) { failed = failed || e; } }, error: function (e) { failed = failed || e; } });
            aenc.configure(AUDIO);
            var buf = job.audio, total = Math.min(buf.length, Math.round(n / fps * AUDIO.sampleRate)), STEP = 1024;
            var ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
            for (var at = 0; at < total; at += STEP) {
                if (job.signal && job.signal.aborted) throw new Error('stopped');
                var len = Math.min(STEP, total - at), data = new Float32Array(len * 2);
                data.set(ch0.subarray(at, at + len), 0); data.set(ch1.subarray(at, at + len), len);
                var ad = new root.AudioData({ format: 'f32-planar', sampleRate: AUDIO.sampleRate, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(at * 1e6 / AUDIO.sampleRate), data: data });
                aenc.encode(ad); ad.close();
                while (aenc.encodeQueueSize > 16) await sleep(2);
            }
            await aenc.flush();
        }
        if (failed) throw failed;
        muxer.finalize();
    } finally { close(); }
    var blob = new Blob([target.buffer], { type: 'video/mp4' });
    blob.hadSound = withAudio;
    return blob;
}

/* The owner's music as the video's sound: decoded, set to the video's length, faded as the core says.
 * data: the file's bytes. opts = { dur, volume, fadeIn, fadeOut }. -> an AudioBuffer, or null when the file is not
 * sound this browser can read. */
async function mixMusic(data, opts) {
    try {
        var rate = AUDIO.sampleRate, len = Math.max(2, Math.ceil(opts.dur * rate));
        var Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
        var ctx = new Ctx(2, len, rate);
        var music = await ctx.decodeAudioData(data.slice(0));
        var src = ctx.createBufferSource(), gain = ctx.createGain();
        src.buffer = music;
        var env = root.StudioCore.audio.envelope({ dur: opts.dur, musicDur: music.duration, volume: opts.volume, fadeIn: opts.fadeIn, fadeOut: opts.fadeOut }, 100);
        gain.gain.setValueCurveAtTime(env, 0, opts.dur);
        src.connect(gain); gain.connect(ctx.destination);
        src.start(0);
        return await ctx.startRendering();
    } catch (e) { return null; }
}

/* The beat of the owner's music (the core's beats.detect), or null: a file that is not sound, or music without
 * a clear pulse. Decoded at a low rate and as one channel: a beat needs no more, and it is quick. */
async function findBeat(data) {
    try {
        var Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext, RATE = 11025;
        var probe = new Ctx(1, 2, 44100), music = await probe.decodeAudioData(data.slice(0));
        var secs = Math.min(music.duration, 120);                 /* the first two minutes say what the beat is */
        if (!(secs >= 4)) return null;
        var ctx = new Ctx(1, Math.ceil(secs * RATE), RATE), src = ctx.createBufferSource();
        src.buffer = music; src.connect(ctx.destination); src.start(0);
        var mono = await ctx.startRendering();
        return root.StudioCore.beats.detect(mono.getChannelData(0), RATE);
    } catch (e) { return null; }
}

var api = { supported: supported, stamp: stamp, encode: encode, mixMusic: mixMusic, findBeat: findBeat, AUDIO: AUDIO };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StudioEncode = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
