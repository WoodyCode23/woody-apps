'use strict';
/**
 * A small client for mgu-updater's socket (native/mgu-updater/README.md, "The socket" - robertnisipeanu/mgu-store).
 * Written from the documented protocol rather than copied, so this app stays under this repo's terms.
 *
 * /dev/shm/mgu-updater/updater.sock, mode 0660 root:tm_oap_app (every OAP app has the group).
 * One JSON object per line each way. The updater sends its whole state on connect, after each request
 * and whenever it changes. Any app may send status / check / install / hello; the privileged requests
 * (uninstall, rollback, sources, tokens, logs, Wi-Fi, reboot) need the secret the updater writes to
 * the data folder of whichever app its config names as `store_app`.
 */
const net = require('net');
const EventEmitter = require('events');

const SOCK = process.env.MGU_UPDATER_SOCK || '/dev/shm/mgu-updater/updater.sock';

class UpdaterClient extends EventEmitter {
    constructor(opts) {
        super();
        this.path = (opts && opts.path) || SOCK;
        this.hello = opts && opts.hello;          /* { id, version } said on every connect */
        this.secret = null;
        this.sock = null; this.buf = ''; this.rid = 0; this.up = false; this.timer = null;
    }

    connect() {
        if (this.sock) return;
        const s = net.connect(this.path);
        this.sock = s;
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.up = true; this.emit('up');
            if (this.hello) this._write({ op: 'hello', id: this.hello.id, version: this.hello.version });
            this._write({ op: 'status' });
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => this.emit('down', e.code || e.message));
        s.on('close', () => {
            this.sock = null; this.buf = '';
            if (this.up) { this.up = false; this.emit('down', 'closed'); }
            /* the updater restarts when it updates itself: keep trying */
            if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.connect(); }, 2000);
        });
    }

    _data(d) {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
            if (!line.trim()) continue;
            let m; try { m = JSON.parse(line); } catch (e) { continue; }
            if (m.type === 'state') this.emit('state', m);
            else if (m.type === 'error') this.emit('reply-error', m.error, m.op, m);
            else this.emit(m.type || 'message', m);
        }
    }

    _write(obj) {
        if (!this.sock || !this.up) return false;
        obj.rid = ++this.rid;
        this.sock.write(JSON.stringify(obj) + '\n');
        return obj.rid;
    }

    /* anyone */
    check() { return this._write({ op: 'check' }); }
    install(id) { return this._write({ op: 'install', id: id }); }

    /* privileged: only work once this app holds the secret */
    _priv(obj) { if (!this.secret) { this.emit('reply-error', 'this app is not the Store yet (no secret)', obj.op); return false; } obj.secret = this.secret; return this._write(obj); }
    uninstall(id) { return this._priv({ op: 'uninstall', id: id }); }
    rollback(id) { return this._priv({ op: 'rollback', id: id }); }
    logs(unit, lines) { return this._priv({ op: 'logs', unit: unit, lines: lines || 80 }); }

    close() { clearTimeout(this.timer); this.timer = null; if (this.sock) { this.sock.removeAllListeners('close'); this.sock.destroy(); this.sock = null; } }
}

module.exports = { UpdaterClient: UpdaterClient, SOCK: SOCK };
