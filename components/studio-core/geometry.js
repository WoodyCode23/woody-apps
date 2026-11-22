'use strict';
/* Where the picture goes. A clip is one picture with the four cameras in a 2 x 2 grid; an edit shows the whole
 * grid or one camera, in one of five output shapes, either filling the frame (edges cropped) or whole with bars.
 * Every editor and every exporter takes its rectangles from here, so a preview and the finished video agree. */

var FORMATS = { original: [1280, 960], wide: [1920, 1080], vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080] };
var VIEWS = { all: null, front: [0, 0], rear: [1, 0], left: [0, 1], right: [1, 1] };      /* column, row in the grid */

function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
function size(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : 0; }

/* the camera's rectangle inside a clip picture of w x h */
function crop(view, w, h) {
    var W = size(w), H = size(h), at = own(VIEWS, view) ? VIEWS[view] : null;
    if (!at) return { x: 0, y: 0, w: W, h: H };
    var hw = Math.floor(W / 2), hh = Math.floor(H / 2);
    return { x: at[0] * hw, y: at[1] * hh, w: hw, h: hh };
}

/* A source picture of sw x sh into the output shape. -> the part of the source to take (sx, sy, sw, sh, measured
 * inside that source picture) and where it lands (dx, dy, dw, dh) in an output of W x H. With fill the source is
 * cropped about its middle to the output's proportions; without, it is shown whole and centred. */
function fit(sw, sh, format, fill) {
    var f = own(FORMATS, format) ? FORMATS[format] : FORMATS.original, W = f[0], H = f[1];
    var w = size(sw), h = size(sh);
    if (!w || !h) return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: W, dh: H, W: W, H: H };
    if (fill) {
        var cw = w, ch = h;
        if (w * H > h * W) cw = Math.round(h * W / H); else ch = Math.round(w * H / W);
        return { sx: Math.round((w - cw) / 2), sy: Math.round((h - ch) / 2), sw: cw, sh: ch, dx: 0, dy: 0, dw: W, dh: H, W: W, H: H };
    }
    var k = Math.min(W / w, H / h), dw = Math.round(w * k), dh = Math.round(h * k);
    return { sx: 0, sy: 0, sw: w, sh: h, dx: Math.round((W - dw) / 2), dy: Math.round((H - dh) / 2), dw: dw, dh: dh, W: W, H: H };
}

module.exports = { FORMATS: FORMATS, VIEWS: VIEWS, crop: crop, fit: fit };
