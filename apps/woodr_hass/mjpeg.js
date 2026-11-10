'use strict';
/**
 * mjpeg.js - pull frames out of Home Assistant's camera streams.
 *
 * Two ways in, both over the REST API with the Bearer token:
 *
 *   /api/camera_proxy/<entity>          one JPEG still (what `snapshot` uses here)
 *   /api/camera_proxy_stream/<entity>   multipart/x-mixed-replace, one JPEG per part
 *
 * Stream() is the multipart reader: it splits on the boundary from the Content-Type header,
 * reads each part's own headers, and hands the JPEG body to onFrame. It drops a frame rather
 * than queue one, so a slow consumer cannot grow the heap - the newest frame is the only one
 * that matters on a doorbell.
 *
 * What it does NOT do is turn a JPEG into pixels. See jpeg.js: Node 8 on the head unit has zlib
 * but no JPEG decoder, and the kit only encodes PNG (kit/runtime/canvas.js png()). A pure-JS
 * baseline decoder has to be vendored into the app for the camera image to reach the cluster.
 */
const http = require('http');
const https = require('https');
const url = require('url');
const EventEmitter = require('events');

const MAX_JPEG = 3 * 1024 * 1024;        /* a doorbell still is tens of KB; this is a sanity cap */
const SOI = Buffer.from([0xff, 0xd8]);

/** One still frame. Resolves with a Buffer holding a JPEG. */
function snapshot(ha, entity, opts) {
    const o = opts || {};
    return ha.rest('GET', '/api/camera_proxy/' + encodeURIComponent(entity), null, {
        raw: true, accept: 'image/jpeg', timeout: o.timeout || 8000, maxBytes: MAX_JPEG,
    }).then((buf) => {
        if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
            throw new Error('camera_proxy did not return a JPEG');
        }
        return buf;
    });
}

/**
 * The MJPEG stream.
 *
 *   const s = new Stream(cfg, 'camera.front_door');
 *   s.on('frame', (jpeg) => ...);     // newest wins; frames are dropped, never queued
 *   s.on('error', (e) => ...);
 *   s.start(); s.stop();
 */
class Stream extends EventEmitter {
    constructor(cfg, entity) {
        super();
        this.cfg = cfg;
        this.entity = entity;
        this.req = null;
        this.res = null;
        this.buf = Buffer.alloc(0);
        this.boundary = null;
        this.frames = 0;
        this.bytes = 0;
        this.busy = false;        /* a frame is being handled: the next one replaces, not queues */
    }

    start() {
        if (this.req) return;
        const u = url.parse(this.cfg.baseUrl);
        const secure = u.protocol === 'https:';
        const lib = secure ? https : http;
        const req = lib.request({
            protocol: u.protocol, hostname: u.hostname, port: u.port || (secure ? 443 : 80),
            method: 'GET', path: '/api/camera_proxy_stream/' + encodeURIComponent(this.entity),
            headers: { Authorization: 'Bearer ' + this.cfg.token, Accept: 'multipart/x-mixed-replace' },
            rejectUnauthorized: secure ? this.cfg.verifyTls !== false : undefined,
            ca: secure ? (this.cfg.ca || undefined) : undefined,
        }, (res) => {
            this.res = res;
            if (res.statusCode !== 200) { this.emit('error', new Error('stream: HTTP ' + res.statusCode)); this.stop(); return; }
            const ct = String(res.headers['content-type'] || '');
            const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
            if (!m) { this.emit('error', new Error('stream: no multipart boundary in ' + ct)); this.stop(); return; }
            this.boundary = Buffer.from('--' + (m[1] || m[2]), 'latin1');
            this.emit('open');
            res.on('data', (d) => this._data(d));
            res.on('end', () => { this.emit('end'); this.stop(); });
            res.on('error', (e) => { this.emit('error', e); this.stop(); });
        });
        /* No overall timeout: the stream is meant to stay open. An idle socket is the failure to
         * watch for, and the doorbell's own dismissal timer bounds the whole episode anyway. */
        req.setTimeout(15000, () => { this.emit('error', new Error('stream: idle')); this.stop(); });
        req.on('error', (e) => { this.emit('error', e); this.stop(); });
        req.end();
        this.req = req;
    }

    stop() {
        const req = this.req, res = this.res;
        this.req = null; this.res = null;
        this.buf = Buffer.alloc(0);
        if (res) { try { res.destroy(); } catch (e) { /* going */ } }
        if (req) { try { req.abort(); } catch (e) { /* going */ } }
    }

    _data(d) {
        this.bytes += d.length;
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        if (this.buf.length > MAX_JPEG * 2) { this.emit('error', new Error('stream: part too large')); this.stop(); return; }
        for (;;) {
            const at = this.buf.indexOf(this.boundary);
            if (at < 0) return;
            /* Find the end of this part's headers, then the next boundary: that span is the JPEG. */
            const headEnd = this.buf.indexOf('\r\n\r\n', at);
            if (headEnd < 0) return;
            const bodyAt = headEnd + 4;
            const next = this.buf.indexOf(this.boundary, bodyAt);
            if (next < 0) return;                             /* the part is still arriving */
            let end = next;
            while (end > bodyAt && (this.buf[end - 1] === 0x0a || this.buf[end - 1] === 0x0d)) end--;
            const body = this.buf.slice(bodyAt, end);
            this.buf = this.buf.slice(next);
            if (body.length > 4 && body[0] === SOI[0] && body[1] === SOI[1]) {
                this.frames++;
                if (!this.busy) {
                    this.busy = true;
                    try { this.emit('frame', body); } catch (e) { this.emit('error', e); }
                    this.busy = false;
                }
            }
        }
    }
}

module.exports = { Stream, snapshot, MAX_JPEG };
