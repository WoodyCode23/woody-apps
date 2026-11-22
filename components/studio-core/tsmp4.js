'use strict';
/* The car's clips are MPEG transport streams (.ts) holding one H.264 picture stream and no sound. A browser does
 * not play those. This rewraps one as an ordinary .mp4, in memory, without touching the pictures: the same bytes
 * of video in a different container, so it is fast and loses nothing. (The PC Studio does the same with a video
 * tool when it imports.)
 *
 *   var r = tsmp4.rewrap(bytes);          bytes: a Uint8Array of the whole .ts file
 *   r -> { ok: true, mp4: Uint8Array, frames, dur (seconds), w, h, codec: 'avc1.42c028' }
 *     or { ok: false, error: 'why' }
 *
 * What it handles is what the car writes: one video stream, H.264, pictures in the order they are shown. A stream
 * with reordered pictures still comes out playable in order of decoding, with the shown times kept as offsets.
 * Sound, a second video stream and encrypted streams are not handled; they give ok: false or are left out.
 * Never throws. No built-in modules: runs on the car's Node 8 and in a browser alike. */

var PACKET = 188, SYNC = 0x47, CLOCK = 90000;
var MAX_FRAMES = 200000;      /* three hours at 15 a second; past that this is not one of the car's clips */

/* ---------------------------------------------------------------- reading the transport stream */

function findStart(b) {
    for (var i = 0; i < Math.min(b.length - 2 * PACKET, 4 * PACKET); i++) if (b[i] === SYNC && b[i + PACKET] === SYNC && b[i + 2 * PACKET] === SYNC) return i;
    return -1;
}

/* the payload of one packet -> [start, end) inside b, or null when it has none */
function payloadOf(b, p) {
    var afc = (b[p + 3] >> 4) & 3, at = p + 4;
    if (afc === 0 || afc === 2) return null;
    if (afc === 3) at += 1 + b[p + 4];
    return at < p + PACKET ? [at, p + PACKET] : null;
}

/* the first H.264 stream's packet id, from the programme tables; -1 when they do not name one */
function videoPid(b, start) {
    var pmt = -1, limit = Math.min(b.length - PACKET + 1, start + 20000 * PACKET);
    for (var p = start; p < limit; p += PACKET) {
        if (b[p] !== SYNC || !(b[p + 1] & 0x40)) continue;
        var pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2], pl = payloadOf(b, p);
        if (!pl) continue;
        var s = pl[0] + 1 + b[pl[0]];                       /* past the pointer field */
        if (s + 12 > pl[1]) continue;
        var len = ((b[s + 1] & 0x0f) << 8) | b[s + 2], end = Math.min(pl[1], s + 3 + len - 4), i;
        if (pid === 0 && b[s] === 0x00 && pmt < 0) {
            for (i = s + 8; i + 4 <= end; i += 4) if (((b[i] << 8) | b[i + 1]) !== 0) { pmt = ((b[i + 2] & 0x1f) << 8) | b[i + 3]; break; }
        } else if (pid === pmt && b[s] === 0x02) {
            i = s + 12 + (((b[s + 10] & 0x0f) << 8) | b[s + 11]);
            while (i + 5 <= end) {
                if (b[i] === 0x1b) return ((b[i + 1] & 0x1f) << 8) | b[i + 2];
                i += 5 + (((b[i + 3] & 0x0f) << 8) | b[i + 4]);
            }
            return -1;
        }
    }
    return -1;
}

/* a 33-bit time stamp from five bytes of a packet header, in 90 kHz ticks */
function stamp(b, i) {
    return (b[i] & 0x0e) * 536870912 + (((b[i + 1] << 8) | b[i + 2]) >> 1) * 32768 + (((b[i + 3] << 8) | b[i + 4]) >> 1);
}

/* the stream's pictures: [{ pts, dts, chunks: [[start, end)...] }] with chunks pointing into b */
function pictures(b, start, pid) {
    var out = [], cur = null;
    for (var p = start; p + PACKET <= b.length; p += PACKET) {
        if (b[p] !== SYNC) {                                 /* lost the rhythm: find it again */
            var again = -1;
            for (var q = p + 1; q + PACKET < b.length && q < p + 4 * PACKET; q++) if (b[q] === SYNC && b[q + PACKET] === SYNC) { again = q; break; }
            if (again < 0) break;
            p = again - PACKET;
            continue;
        }
        if ((((b[p + 1] & 0x1f) << 8) | b[p + 2]) !== pid) continue;
        if (b[p + 3] & 0xc0) return null;                    /* scrambled */
        var pl = payloadOf(b, p);
        if (!pl) continue;
        var at = pl[0];
        if (b[p + 1] & 0x40) {                               /* a new picture starts in this packet */
            if (at + 9 > pl[1] || b[at] !== 0 || b[at + 1] !== 0 || b[at + 2] !== 1) { cur = null; continue; }
            var flags = b[at + 7], hlen = b[at + 8], pts = -1, dts = -1;
            if ((flags & 0x80) && at + 14 <= pl[1]) pts = stamp(b, at + 9);
            if ((flags & 0x40) && at + 19 <= pl[1]) dts = stamp(b, at + 14);
            cur = { pts: pts, dts: dts < 0 ? pts : dts, chunks: [] };
            out.push(cur);
            if (out.length > MAX_FRAMES) return null;
            at += 9 + hlen;
        }
        if (cur && at < pl[1]) cur.chunks.push([at, pl[1]]);
    }
    return out;
}

/* ---------------------------------------------------------------- reading the H.264 inside */

function join(b, chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i][1] - chunks[i][0];
    var out = new Uint8Array(n), at = 0;
    for (i = 0; i < chunks.length; i++) { out.set(b.subarray(chunks[i][0], chunks[i][1]), at); at += chunks[i][1] - chunks[i][0]; }
    return out;
}

/* the units of one picture (split at the 00 00 01 marks) -> [[start, end)...] inside d */
function units(d) {
    var out = [], from = -1, n = d.length;
    for (var i = 0; i + 2 < n; i++) {
        if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 1) continue;
        if (from >= 0) { var e = i; while (e > from && d[e - 1] === 0) e--; if (e > from) out.push([from, e]); }
        from = i + 3;
        i += 2;
    }
    if (from >= 0 && from < n) { var end = n; while (end > from && d[end - 1] === 0) end--; if (end > from) out.push([from, end]); }
    return out;
}

function Bits(d) { this.d = d; this.at = 0; }
Bits.prototype.bit = function () { var v = this.at < this.d.length * 8 ? (this.d[this.at >> 3] >> (7 - (this.at & 7))) & 1 : 0; this.at++; return v; };
Bits.prototype.bits = function (n) { var v = 0; for (var i = 0; i < n; i++) v = v * 2 + this.bit(); return v; };
Bits.prototype.ue = function () { var z = 0; while (z < 32 && this.bit() === 0) z++; return z >= 32 ? 0 : Math.pow(2, z) - 1 + this.bits(z); };
Bits.prototype.se = function () { var v = this.ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };

/* the picture's size, from the stream's parameter set */
function sizeOf(sps) {
    var raw = [], i;
    for (i = 0; i < sps.length; i++) { if (i >= 2 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue; raw.push(sps[i]); }
    var r = new Bits(raw);
    r.bits(8);
    var profile = r.bits(8), chroma = 1;
    r.bits(16); r.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
        chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue(); r.ue(); r.bit();
        if (r.bit()) {
            for (i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (!r.bit()) continue;
                var last = 8, next = 8, size = i < 6 ? 16 : 64;
                for (var j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
            }
        }
    }
    r.ue();
    var poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.bit(); r.se(); r.se(); var n = r.ue(); for (i = 0; i < n && i < 256; i++) r.se(); }
    r.ue(); r.bit();
    var wMbs = r.ue() + 1, hUnits = r.ue() + 1, frameOnly = r.bit();
    if (!frameOnly) r.bit();
    r.bit();
    var cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    var ux = chroma === 0 || chroma === 3 ? 1 : 2, uy = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
    return { w: wMbs * 16 - ux * (cl + cr), h: (2 - frameOnly) * hUnits * 16 - uy * (ct + cb) };
}

/* ---------------------------------------------------------------- writing the .mp4 */

function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >> 8) & 255, n & 255]; }
function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
function chars(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 255); return a; }

/* a box: its size, its four-letter type, then its parts (arrays of bytes or Uint8Arrays) */
function box(type) {
    var parts = Array.prototype.slice.call(arguments, 1), n = 8, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), at = 8;
    out.set(u32(n), 0); out.set(chars(type), 4);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
}
var MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

function moov(o, mdatAt) {
    var n = o.sizes.length, i;
    /* durations, run-length coded */
    var runs = [];
    for (i = 0; i < n; i++) { if (runs.length && runs[runs.length - 1][1] === o.durs[i]) runs[runs.length - 1][0]++; else runs.push([1, o.durs[i]]); }
    var stts = [].concat(u32(0), u32(runs.length));
    runs.forEach(function (r) { stts = stts.concat(u32(r[0]), u32(r[1])); });
    var stsz = new Uint8Array(12 + 4 * n);
    stsz.set(u32(n), 8);
    for (i = 0; i < n; i++) stsz.set(u32(o.sizes[i]), 12 + 4 * i);
    var stss = new Uint8Array(8 + 4 * o.keys.length);
    stss.set(u32(o.keys.length), 4);
    for (i = 0; i < o.keys.length; i++) stss.set(u32(o.keys[i] + 1), 8 + 4 * i);
    var tables = [box('stts', stts)];
    if (o.shifts) {                                           /* shown later than decoded: reordered pictures */
        var ctts = new Uint8Array(8 + 8 * n);
        ctts.set(u32(n), 4);
        for (i = 0; i < n; i++) { ctts.set(u32(1), 8 + 8 * i); ctts.set(u32(o.shifts[i]), 12 + 8 * i); }
        tables.push(box('ctts', ctts));
    }
    if (o.keys.length && o.keys.length < n) tables.push(box('stss', stss));
    tables.push(box('stsc', [].concat(u32(0), u32(1), u32(1), u32(n), u32(1))), box('stsz', stsz), box('stco', [].concat(u32(0), u32(1), u32(mdatAt))));

    var avcC = box('avcC', [1, o.sps[1], o.sps[2], o.sps[3], 0xff, 0xe1].concat(u16(o.sps.length)), o.sps, [1].concat(u16(o.pps.length)), o.pps);
    var avc1 = box('avc1', [].concat(zeros(6), u16(1), zeros(16), u16(o.w), u16(o.h), u32(0x480000), u32(0x480000), zeros(4), u16(1), zeros(32), u16(0x18), [255, 255]), avcC);
    var stbl = box.apply(null, ['stbl', box('stsd', [].concat(u32(0), u32(1)), avc1)].concat(tables));
    var minf = box('minf', box('vmhd', [].concat(u32(1), zeros(8))), box('dinf', box('dref', [].concat(u32(0), u32(1)), box('url ', u32(1)))), stbl);
    var mdia = box('mdia', box('mdhd', [].concat(u32(0), u32(0), u32(0), u32(CLOCK), u32(o.total), [0x55, 0xc4, 0, 0])),
        box('hdlr', [].concat(u32(0), u32(0), chars('vide'), zeros(12), chars('Video'), [0])), minf);
    var tkhd = box('tkhd', [].concat(u32(7), u32(0), u32(0), u32(1), u32(0), u32(o.total), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(o.w * 65536), u32(o.h * 65536)));
    var mvhd = box('mvhd', [].concat(u32(0), u32(0), u32(0), u32(CLOCK), u32(o.total), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)));
    return box('moov', mvhd, box('trak', tkhd, mdia));
}

function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

function work(b) {
    if (!b || typeof b.length !== 'number' || typeof b.subarray !== 'function') return { ok: false, error: 'not a file' };
    var start = findStart(b);
    if (start < 0) return { ok: false, error: 'not a transport stream' };
    var pid = videoPid(b, start);
    if (pid < 0) return { ok: false, error: 'no H.264 video in it' };
    var pics = pictures(b, start, pid);
    if (!pics) return { ok: false, error: 'the stream is scrambled or far too long' };

    var sps = null, pps = null, samples = [], total = 0, i, j;
    for (i = 0; i < pics.length; i++) {
        var d = join(b, pics[i].chunks), list = units(d), keep = [], size = 0, key = false;
        for (j = 0; j < list.length; j++) {
            var type = d[list[j][0]] & 0x1f;
            if (type === 7) { if (!sps) sps = d.slice ? d.slice(list[j][0], list[j][1]) : new Uint8Array(d.subarray(list[j][0], list[j][1])); continue; }
            if (type === 8) { if (!pps) pps = d.slice ? d.slice(list[j][0], list[j][1]) : new Uint8Array(d.subarray(list[j][0], list[j][1])); continue; }
            if (type === 9 || type === 12 || type === 0 || type > 23) continue;      /* delimiters, filler, and what is not H.264's own */
            if (type === 5) key = true;
            if (type === 1 || type === 5 || keep.length || type === 6) { keep.push(list[j]); size += 4 + list[j][1] - list[j][0]; }
        }
        if (!keep.some(function (u) { var t = d[u[0]] & 0x1f; return t === 1 || t === 5; })) continue;      /* no picture in it */
        if (!sps || !pps || (!samples.length && !key)) continue;          /* nothing can be shown before the first whole picture */
        samples.push({ d: d, units: keep, size: size, key: key, pts: pics[i].pts, dts: pics[i].dts });
        total += size;
    }
    if (!samples.length) return { ok: false, error: 'no pictures found' };
    if (sps.length < 4) return { ok: false, error: 'the stream describes itself badly' };
    var dim = sizeOf(sps);
    if (!(dim.w >= 16 && dim.w <= 8192 && dim.h >= 16 && dim.h <= 8192)) return { ok: false, error: 'the picture size makes no sense' };

    /* how long each picture stays up: the gap to the next one, and for the last, the usual gap */
    var n = samples.length, durs = [], sum = 0, usual = 6000, shifts = null;
    for (i = 0; i < n - 1; i++) {
        var gap = samples[i + 1].dts - samples[i].dts;
        if (samples[i].dts < 0 || samples[i + 1].dts < 0 || gap <= 0 || gap > CLOCK * 10) gap = usual; else usual = gap;
        durs.push(gap); sum += gap;
    }
    durs.push(usual); sum += usual;
    for (i = 0; i < n; i++) if (samples[i].pts >= 0 && samples[i].dts >= 0 && samples[i].pts !== samples[i].dts) { shifts = []; break; }
    if (shifts) for (i = 0; i < n; i++) shifts.push(Math.max(0, Math.min(CLOCK * 10, samples[i].pts - samples[i].dts)));

    var o = { sps: sps, pps: pps, w: dim.w, h: dim.h, total: sum, durs: durs, shifts: shifts,
        sizes: samples.map(function (s) { return s.size; }), keys: [] };
    for (i = 0; i < n; i++) if (samples[i].key) o.keys.push(i);
    var ftyp = box('ftyp', chars('isom'), u32(0x200), chars('isomiso2avc1mp41'));
    var head = moov(o, 0), mdatAt = ftyp.length + head.length + 8;
    if (mdatAt + total > 0xfffffff0) return { ok: false, error: 'too large to rewrap in one piece' };
    head = moov(o, mdatAt);
    var out = new Uint8Array(mdatAt + total), at = mdatAt;
    out.set(ftyp, 0); out.set(head, ftyp.length);
    out.set(u32(total + 8), ftyp.length + head.length); out.set(chars('mdat'), ftyp.length + head.length + 4);
    for (i = 0; i < n; i++) {
        for (j = 0; j < samples[i].units.length; j++) {
            var u = samples[i].units[j], len = u[1] - u[0];
            out.set(u32(len), at); out.set(samples[i].d.subarray(u[0], u[1]), at + 4);
            at += 4 + len;
        }
        samples[i].d = null;
    }
    return { ok: true, mp4: out, frames: n, dur: sum / CLOCK, w: dim.w, h: dim.h, codec: 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]) };
}

function rewrap(bytes) {
    try { return work(bytes); } catch (e) { return { ok: false, error: 'could not be read (' + (e && e.message ? e.message : e) + ')' }; }
}

module.exports = { rewrap: rewrap };
