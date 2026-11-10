'use strict';
/**
 * ws.js - a minimal RFC 6455 WebSocket client for Node 8, over `net` / `tls` only.
 *
 * The head unit has no npm install step (kit/tools/build.py copies the app's .js files and the
 * BMW oap-sdk, nothing else), so the `ws` package is not available. This is the smallest client
 * that does the job: client-to-server masking, text and binary frames, fragmentation,
 * ping/pong, close.
 *
 *   const sock = new WebSock('wss://ha.local:8123/api/websocket', { timeout: 10000 });
 *   sock.on('open', () => sock.send('{"type":"auth"}'));
 *   sock.on('message', (data, binary) => ...);     // string for text, Buffer for binary
 *   sock.on('close', (code, why) => ...);
 *   sock.on('error', (e) => ...);
 *   sock.connect();  sock.close();
 *
 * Deliberate limits: no permessage-deflate (HA does not need it), server frames must not be
 * masked (RFC 6455 5.1), and frames are capped at MAX_FRAME so a confused peer cannot make the
 * app allocate the head unit out of memory.
 */
const net = require('net');
const lease = require('./netlease');
const tls = require('tls');
const crypto = require('crypto');
const url = require('url');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8 * 1024 * 1024;
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSock extends EventEmitter {
    constructor(target, opts) {
        super();
        const u = url.parse(target);
        this.secure = u.protocol === 'wss:';
        this.host = u.hostname;
        this.port = Number(u.port) || (this.secure ? 443 : 80);
        this.path = u.path || '/';
        this.opts = opts || {};
        this.sock = null;
        this.open = false;
        this.buf = Buffer.alloc(0);
        this.frag = null;            /* { op, parts } while a message is fragmented */
        this.handshook = false;
        this.key = '';
    }

    connect() {
        if (this.sock) return;
        this.key = crypto.randomBytes(16).toString('base64');
        const o = { host: this.host, port: this.port, lookup: lease.lookup };
        if (this.secure) {
            /* A self-signed HA certificate is common. Verification stays on unless the config
             * turns it off; a pinned CA (config "caFile") is the better answer. */
            o.rejectUnauthorized = this.opts.rejectUnauthorized !== false;
            o.servername = this.host;
            if (this.opts.ca) o.ca = this.opts.ca;
        }
        const sock = this.secure ? tls.connect(o) : net.connect(o);
        this.sock = sock;
        sock.setNoDelay(true);
        if (this.opts.timeout) sock.setTimeout(this.opts.timeout, () => this._fail('timeout'));
        sock.on(this.secure ? 'secureConnect' : 'connect', () => this._handshake());
        sock.on('data', (d) => { if (this.sock === sock) this._data(d); });
        sock.on('error', (e) => { if (this.sock === sock) this._fail(e.message || String(e)); });
        sock.on('close', () => {
            if (this.sock !== sock) return;
            const was = this.open;
            this.sock = null; this.open = false; this.handshook = false;
            this.emit('close', was ? (this.closeCode || 1006) : 1006, this.closeWhy || 'socket closed');
        });
    }

    _handshake() {
        const lines = [
            'GET ' + this.path + ' HTTP/1.1',
            'Host: ' + this.host + (this.port === (this.secure ? 443 : 80) ? '' : ':' + this.port),
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: ' + this.key,
            'Sec-WebSocket-Version: 13',
        ];
        if (this.opts.origin) lines.push('Origin: ' + this.opts.origin);
        (this.opts.headers || []).forEach((h) => lines.push(h));
        this._write(Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'));
    }

    _write(b) { if (this.sock) { try { this.sock.write(b); } catch (e) { this._fail(e.message); } } }

    _fail(why) {
        this.closeWhy = why;
        this.emit('error', new Error(why));
        if (!this.sock) return;
        const s = this.sock;
        this.sock = null; this.open = false;
        try { s.destroy(); } catch (e) { /* already gone */ }
        this.emit('close', 1006, why);
    }

    _data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        if (!this.handshook && !this._upgrade()) return;
        this._frames();
    }

    /** Read the HTTP 101 response. True once the frame stream begins. */
    _upgrade() {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) { if (this.buf.length > 16384) this._fail('handshake too long'); return false; }
        const head = this.buf.slice(0, end).toString('latin1');
        this.buf = this.buf.slice(end + 4);
        const status = /^HTTP\/1\.1 (\d+)/.exec(head);
        if (!status || status[1] !== '101') { this._fail('handshake: ' + (status ? 'HTTP ' + status[1] : 'not HTTP')); return false; }
        const want = crypto.createHash('sha1').update(this.key + GUID).digest('base64');
        const got = /\r\nsec-websocket-accept:\s*(\S+)/i.exec('\r\n' + head);
        if (!got || got[1] !== want) { this._fail('handshake: bad Sec-WebSocket-Accept'); return false; }
        this.handshook = true;
        this.open = true;
        if (this.sock && this.opts.timeout) this.sock.setTimeout(0);
        this.emit('open');
        return true;
    }

    /** Parse as many whole frames as the buffer holds. */
    _frames() {
        for (;;) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f, off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) {
                if (b.length < 10) return;
                if (b.readUInt32BE(2) !== 0) { this._fail('frame too large'); return; }
                len = b.readUInt32BE(6); off = 10;
            }
            if (masked) { this._fail('server masked a frame'); return; }
            if (len > MAX_FRAME) { this._fail('frame over ' + MAX_FRAME + ' bytes'); return; }
            if (b.length < off + len) return;
            const payload = b.slice(off, off + len);
            this.buf = b.slice(off + len);
            this._frame(fin, op, payload);
            if (!this.sock) return;
        }
    }

    _frame(fin, op, payload) {
        if (op === OP.PING) { this._send(OP.PONG, payload); return; }
        if (op === OP.PONG) { this.emit('pong'); return; }
        if (op === OP.CLOSE) {
            this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            this.closeWhy = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
            this._send(OP.CLOSE, payload.slice(0, 2));
            if (this.sock) { try { this.sock.end(); } catch (e) { /* going anyway */ } }
            return;
        }
        if (op === OP.CONT) {
            if (!this.frag) { this._fail('continuation without a start'); return; }
            this.frag.parts.push(payload);
            if (!fin) return;
            const whole = Buffer.concat(this.frag.parts), was = this.frag.op;
            this.frag = null;
            this._message(was, whole);
            return;
        }
        if (op !== OP.TEXT && op !== OP.BIN) { this._fail('reserved opcode ' + op); return; }
        if (!fin) { this.frag = { op: op, parts: [payload] }; return; }
        this._message(op, payload);
    }

    _message(op, buf) {
        if (op !== OP.TEXT) { this.emit('message', buf, true); return; }
        let s = null;
        try { s = buf.toString('utf8'); } catch (e) { this._fail('bad utf-8'); return; }
        this.emit('message', s, false);
    }

    /** data: string (text frame) or Buffer (binary frame). */
    send(data) {
        if (!this.open) return false;
        const bin = Buffer.isBuffer(data);
        this._send(bin ? OP.BIN : OP.TEXT, bin ? data : Buffer.from(String(data), 'utf8'));
        return true;
    }

    _send(op, payload) {
        const n = payload.length;
        const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
        const f = Buffer.alloc(head + 4 + n);
        f[0] = 0x80 | op;
        if (head === 2) f[1] = 0x80 | n;
        else if (head === 4) { f[1] = 0x80 | 126; f.writeUInt16BE(n, 2); }
        else { f[1] = 0x80 | 127; f.writeUInt32BE(0, 2); f.writeUInt32BE(n, 6); }
        const mask = crypto.randomBytes(4);
        mask.copy(f, head);
        for (let i = 0; i < n; i++) f[head + 4 + i] = payload[i] ^ mask[i & 3];
        this._write(f);
    }

    close(code, why) {
        if (!this.sock) return;
        if (this.open) {
            const w = Buffer.from(why || '', 'utf8');
            const p = Buffer.alloc(2 + w.length);
            p.writeUInt16BE(code || 1000, 0);
            w.copy(p, 2);
            this._send(OP.CLOSE, p);
        }
        const s = this.sock;
        this.sock = null; this.open = false;
        try { s.destroy(); } catch (e) { /* already gone */ }
    }
}

module.exports = { WebSock, MAX_FRAME };
