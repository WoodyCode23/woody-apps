/* Dashcam Studio: rewrapping a clip from the car off the page's own thread, so the page stays responsive while a
 * 90 MB clip is made playable. It loads the shared core (the same code the page uses) and nothing else, and it
 * talks only to the page that started it.
 *
 *   in:  { id, buf (ArrayBuffer of the .ts file, handed over) }
 *   out: { id, ok: true, mp4 (ArrayBuffer, handed over) }  or  { id, ok: false, error }
 */
'use strict';
importScripts('core.js');
self.onmessage = function (e) {
    var d = e.data || {};
    try {
        var r = self.StudioCore.tsmp4.rewrap(new Uint8Array(d.buf));
        if (!r.ok) { self.postMessage({ id: d.id, ok: false, error: r.error }); return; }
        var out = r.mp4.byteOffset === 0 && r.mp4.buffer.byteLength === r.mp4.length ? r.mp4.buffer : r.mp4.slice().buffer;
        self.postMessage({ id: d.id, ok: true, mp4: out }, [out]);
    } catch (x) { self.postMessage({ id: d.id, ok: false, error: String(x && x.message || x) }); }
};
