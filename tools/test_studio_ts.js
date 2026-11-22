'use strict';
/* npx -y node@8.16.2 tools/test_studio_ts.js [a real .ts or .mp4 clip]
 * The core's transport-stream rewrap (components/studio-core/tsmp4.js) against streams made here with ffmpeg and
 * checked with ffprobe: the .mp4 that comes out must hold the same pictures, the same size and length, and decode
 * without an error. Needs ffmpeg and ffprobe on the PATH; without them it says so and fails, since nothing else
 * proves the rewrap. With a clip named on the command line that clip is put through as well (nothing about it is
 * printed but counts and sizes). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { rewrap } = require(path.join(__dirname, '..', 'components', 'studio-core', 'tsmp4.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmp4-'));
let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const run = (cmd, args) => cp.spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const done = () => { try { fs.readdirSync(tmp).forEach((f) => fs.unlinkSync(path.join(tmp, f))); fs.rmdirSync(tmp); } catch (e) { /* temp */ } console.log(failed ? 'FAILED: ' + failed : 'all ok'); process.exit(failed ? 1 : 0); };

if (run('ffmpeg', ['-version']).status !== 0 || run('ffprobe', ['-version']).status !== 0) { ok('ffmpeg and ffprobe are on the PATH', false); done(); }

/* what ffprobe says about a file's video: { codec, w, h, frames, dur, errors } */
function probe(file) {
    const p = run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file]);
    let j = {};
    try { j = JSON.parse(p.stdout); } catch (e) { /* reported below */ }
    const s = (j.streams || [])[0] || {};
    const dec = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return { codec: s.codec_name, w: s.width, h: s.height, frames: Number(s.nb_read_frames), dur: Number((j.format || {}).duration), errors: (p.stderr + dec.stderr).trim() };
}

function check(label, tsFile, want) {
    const bytes = new Uint8Array(fs.readFileSync(tsFile));
    const t0 = Date.now(), r = rewrap(bytes), ms = Date.now() - t0;
    ok(label + ': rewrapped (' + (r.ok ? r.frames + ' pictures, ' + Math.round(bytes.length / 1024) + ' KB in ' + ms + ' ms' : r.error) + ')', r.ok === true);
    if (!r.ok) return;
    const out = path.join(tmp, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(r.mp4.buffer, r.mp4.byteOffset, r.mp4.length));
    const got = probe(out), src = probe(tsFile);
    ok(label + ': a video tool reads it as H.264 with no error', got.codec === 'h264' && got.errors === '');
    ok(label + ': the same number of pictures as the stream (' + src.frames + ')', got.frames === src.frames && r.frames === src.frames);
    ok(label + ': the same picture size (' + src.w + 'x' + src.h + ')', got.w === src.w && got.h === src.h && r.w === src.w && r.h === src.h);
    ok(label + ': the same length within a picture (' + got.dur.toFixed(2) + ' s)', Math.abs(got.dur - r.dur) < 0.01 && (!want || Math.abs(got.dur - want) < 0.15));
    ok(label + ': the codec name a browser is told', /^avc1\.[0-9a-f]{6}$/.test(r.codec));
    ok(label + ': no larger than the stream it came from', r.mp4.length < bytes.length);
}

/* made here: the car's kind (baseline, 1280 x 960, 15 a second), and a harder one with reordered pictures */
const make = (name, args) => { const f = path.join(tmp, name); const r = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x960:rate=15', '-t', '4'].concat(args, ['-f', 'mpegts', f])); return r.status === 0 ? f : null; };
const plain = make('plain.ts', ['-c:v', 'libx264', '-profile:v', 'baseline', '-g', '15', '-pix_fmt', 'yuv420p']);
const hard = make('hard.ts', ['-c:v', 'libx264', '-profile:v', 'high', '-bf', '2', '-g', '30', '-pix_fmt', 'yuv420p', '-vf', 'crop=1276:954']);
ok('test streams made', !!plain && !!hard);
if (plain) check('the car\'s kind', plain, 4);
if (hard) check('reordered pictures, an odd size', hard, 4);

/* hostile and broken input: an answer, never a throw */
const bad = (label, bytes, why) => { let r; try { r = rewrap(bytes); } catch (e) { r = { threw: String(e) }; } ok(label, r && r.ok === false && typeof r.error === 'string' && !r.threw && (!why || why.test(r.error))); };
bad('nothing', null, /not a file/);
bad('a string', 'hello', /not a file/);
bad('an empty file', new Uint8Array(0), /not a transport stream/);
bad('a picture file', new Uint8Array(4000).fill(0xff), /not a transport stream/);
bad('sync bytes and nothing else', (() => { const b = new Uint8Array(188 * 50); for (let i = 0; i < 50; i++) b[i * 188] = 0x47; return b; })(), /no H\.264/);
if (plain) {
    const whole = new Uint8Array(fs.readFileSync(plain));
    const cut = rewrap(whole.subarray(0, Math.floor(whole.length / 2)));
    ok('half a file still gives its first half', cut.ok === true && cut.frames > 10 && cut.frames < 60);
    const noisy = new Uint8Array(whole);
    for (let i = 5000; i < noisy.length; i += 9973) noisy[i] ^= 0x5a;
    let r; try { r = rewrap(noisy); } catch (e) { r = { threw: String(e) }; }
    ok('a damaged file gives an answer, not a throw', !r.threw && typeof r.ok === 'boolean');
    const off = new Uint8Array(whole.length + 37);
    off.set(whole, 37);
    ok('junk before the first packet is stepped over', rewrap(off).ok === true);
}

/* a real clip, when one is named */
const real = process.argv[2];
if (real && fs.existsSync(real)) {
    let ts = real;
    if (!/\.ts$/i.test(real)) { ts = path.join(tmp, 'real.ts'); const r = run('ffmpeg', ['-v', 'error', '-y', '-i', real, '-an', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', ts]); ok('the named clip made into a stream', r.status === 0); }
    if (fs.existsSync(ts)) check('a real clip', ts, 0);
}
done();
