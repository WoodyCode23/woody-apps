'use strict';
/**
 * jpeg.js - JPEG to RGBA, and the one dependency this app cannot satisfy by itself.
 *
 * THE GAP (verified, not guessed): the head unit runs Node 8.16.2 with the core builtins only.
 * kit/tools/build.py copies the app's .js files plus the BMW oap-sdk into the package - there is
 * no npm install on the car and no native image codec. kit/runtime/canvas.js can *encode* PNG
 * (zlib) but nothing in the kit decodes an image. So a camera JPEG cannot become pixels until a
 * pure-JavaScript baseline decoder is vendored into this folder as a plain .js file.
 *
 *   Recommended: jpeg-js (eugeneware/jpeg-js, MIT), decoder.js is self-contained ES5 and runs on
 *   Node 8 unchanged. Drop it in as jpeg_decoder.js, keep its licence header, and this module
 *   picks it up automatically through the require below. ~70 KB of source, no dependencies.
 *
 * Until that file is there, decode() returns null and the doorbell overlay falls back to its
 * text banner, which is the behaviour this app wants anyway while the car is moving.
 *
 *   const out = jpeg.decode(buf);        // { w, h, rgba: Buffer } or null
 *   jpeg.size(buf);                      // { w, h } from the SOF marker, no decoding
 *   jpeg.available();                    // is a decoder vendored?
 *   jpeg.fit(src, sw, sh, dw, dh);       // nearest-neighbour box fit into a dw x dh RGBA buffer
 */
let decoder = null;
try { decoder = require('./jpeg_decoder'); } catch (e) { decoder = null; }

/** Is a decoder vendored into the app? */
function available() { return !!(decoder && (decoder.decode || typeof decoder === 'function')); }

/**
 * The image's size from its SOF0/SOF1/SOF2 marker, without decoding anything. Useful for sizing
 * the cluster layer before the first frame is turned into pixels, and for rejecting a stream
 * whose frames are far larger than the slot.
 */
function size(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xda) return null;                  /* scan data: no SOF found */
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

/** JPEG -> { w, h, rgba }. Null when no decoder is vendored or the data is not decodable. */
function decode(buf) {
    if (!available()) return null;
    try {
        const fn = decoder.decode || decoder;
        /* jpeg-js: decode(buffer, { useTArray: true }) -> { width, height, data (RGBA) } */
        const out = fn(buf, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
        if (!out || !out.width || !out.height || !out.data) return null;
        const rgba = Buffer.isBuffer(out.data) ? out.data : Buffer.from(out.data.buffer || out.data, 0, out.data.length);
        if (rgba.length < out.width * out.height * 4) return null;
        return { w: out.width, h: out.height, rgba: rgba };
    } catch (e) {
        return null;
    }
}

/**
 * Scale an RGBA image into a dw x dh RGBA buffer, nearest neighbour, aspect kept, letterboxed on
 * `pad` (default opaque black). Nearest neighbour on purpose: this runs on an Atom, and the layer
 * can be created with sampling 'bilinear' so the GPU does the smoothing for free.
 * `dst` may be passed in and is reused between frames (no allocation per frame).
 */
function fit(src, sw, sh, dw, dh, dst, pad) {
    const out = dst && dst.length === dw * dh * 4 ? dst : Buffer.alloc(dw * dh * 4);
    const p = pad || [0, 0, 0, 255];
    const k = Math.min(dw / sw, dh / sh);
    const tw = Math.max(1, Math.floor(sw * k)), th = Math.max(1, Math.floor(sh * k));
    const ox = (dw - tw) >> 1, oy = (dh - th) >> 1;
    for (let y = 0; y < dh; y++) {
        const row = y * dw * 4;
        const sy = y - oy;
        for (let x = 0; x < dw; x++) {
            const o = row + x * 4;
            const sx = x - ox;
            if (sx < 0 || sy < 0 || sx >= tw || sy >= th) {
                out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = p[3];
                continue;
            }
            const si = ((Math.min(sh - 1, (sy / k) | 0) * sw) + Math.min(sw - 1, (sx / k) | 0)) * 4;
            out[o] = src[si]; out[o + 1] = src[si + 1]; out[o + 2] = src[si + 2]; out[o + 3] = 255;
        }
    }
    return out;
}

module.exports = { decode, size, available, fit };
