'use strict';
/**
 * song.js - what CarPlay is playing, for the one-line strip at the top of the head-up display.
 *
 * Source: de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer, instance "CarPlayMedia", field
 * currentItemMetadata (found on the car 2026-11-11). The exact shape of that struct has not been written
 * down yet, so this reads it defensively: it looks through whatever arrives for a text field whose name says
 * title and one that says artist, and logs the field names once so the reader can be pinned to them later.
 * Nothing is sent: it only listens. Without the signal (no CarPlay, another car) there is simply no song line.
 *
 *   const song = new Song(ctx, () => redraw()); await song.start();   song.now -> { title, artist } or null
 */
const IFACE = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const INSTANCE = 'CarPlayMedia';
const MAX = 60;

/** the first non-empty string under a key matching `re`, searching nested objects a few levels deep */
function find(obj, re, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return '';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const v = obj[keys[i]];
        if (typeof v === 'string' && v.trim() && re.test(keys[i])) return v.trim();
    }
    for (let i = 0; i < keys.length; i++) {
        const v = obj[keys[i]];
        if (v && typeof v === 'object') { const s = find(v, re, depth + 1); if (s) return s; }
    }
    return '';
}

/** { title, artist } from a metadata struct of unknown shape, or null when it names no title */
function read(meta) {
    const title = find(meta, /title|track|song/i, 0);
    if (!title) return null;
    const artist = find(meta, /artist|performer|author/i, 0);
    const clip = (s) => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);
    return { title: clip(title), artist: clip(artist) };
}

class Song {
    constructor(ctx, onChange) { this.ctx = ctx; this.onChange = onChange; this.now = null; this.error = null; this.logged = false; }

    async start() {
        try {
            const sub = await this.ctx.signals.watch(IFACE, INSTANCE, {
                currentItemMetadata: (v) => {
                    try {
                        if (!this.logged && v && typeof v === 'object') { this.logged = true; this.ctx.log.info('song: metadata fields ' + Object.keys(v).join(',')); }
                        const next = read(v);
                        const key = next ? next.title + '|' + next.artist : '';
                        if (key === this.key) return;
                        this.key = key; this.now = next;
                        if (this.onChange) this.onChange();
                    } catch (e) { this.ctx.log.warn('song: ' + e); }
                },
            }, this.ctx.log);
            if (sub && sub.error) { this.error = sub.error; this.ctx.log.info('song: not available (' + sub.error + ')'); }
        } catch (e) { this.error = String(e); this.ctx.log.info('song: not available (' + e + ')'); }
        return !this.error;
    }
}

module.exports = { Song: Song, read: read };
