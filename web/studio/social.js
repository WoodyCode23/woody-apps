/* Dashcam Studio: drawing a social clip's frames. What each frame holds is decided by the core (compose.js); this
 * puts it on a canvas: the camera picture filling the frame and pushed in by the zoom, the look, the title and
 * caption, the speed, and the maker's mark; and for a launch the lamps, the run's figures and the timeslip.
 *
 *   StudioSocial.drawMoment(ctx, video, plan, fr, extra)
 *     fr = compose.frameAt(plan, i); extra = { speed: { n, unit } or null }
 *   StudioSocial.drawMontage(ctx, video, plan, fr, extra)      extra as for a Moment
 *   StudioSocial.drawLaunch(ctx, video, plan, fr, run, extra)
 *     run = the parsed run log; extra = { unit: 'mph' | 'kmh' }
 */
(function (root) {
'use strict';
var C = root.StudioCore;
var FONT = 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
function font(size, weight) { return (weight || 800) + ' ' + Math.round(size) + FONT; }

/* the chosen camera, filling the frame (its edges cut, never bars), pushed in around the middle, with the look */
function picture(ctx, video, plan, fr) {
    var W = plan.w, H = plan.h, vw = video.videoWidth, vh = video.videoHeight;
    ctx.fillStyle = '#050507'; ctx.fillRect(0, 0, W, H);
    if (!vw || !vh) return;
    var c = C.geometry.crop(fr.view, vw, vh), scale = Math.max(W / c.w, H / c.h) * fr.zoom;
    var dw = c.w * scale, dh = c.h * scale;
    try { ctx.filter = C.looks.filter(plan.look); } catch (e) { /* a browser without canvas filters: the picture as it is */ }
    try { ctx.drawImage(video, c.x, c.y, c.w, c.h, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) { /* not ready: the dark ground */ }
    try { ctx.filter = 'none'; } catch (e) { /* as above */ }
}

/* the title (top) and caption (bottom), fitted to the width */
function words(ctx, plan, fr, k) {
    var W = plan.w, H = plan.h;
    var measure = function (weight) { return function (text, size) { ctx.font = font(size * k, weight); return ctx.measureText(text).width; }; };
    ctx.textBaseline = 'alphabetic';
    fr.texts.forEach(function (t) {
        var title = t.role === 'title', fit = C.compose.fitText(measure(title ? 800 : 600), title ? t.text.toUpperCase() : t.text, W * 0.86, title ? 64 : 40, title ? 40 : 28);
        var size = fit.size * k, lh = size * 1.16, y = H * (title ? 0.18 : 0.82) - (fit.lines.length - 1) * lh / 2;
        ctx.globalAlpha = t.alpha;
        ctx.font = font(size, title ? 800 : 600); ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = size * 0.35; ctx.shadowOffsetY = size * 0.05;
        fit.lines.forEach(function (line, n) {
            if (title && n === 0) { ctx.shadowBlur = 0; ctx.fillStyle = '#ff1f3d'; ctx.fillRect(W / 2 - size * 0.9, y - size * 1.25, size * 1.8, Math.max(3, size * 0.09)); ctx.shadowBlur = size * 0.35; }
            ctx.fillStyle = '#ffffff';
            ctx.fillText(line, W / 2, y + n * lh);
        });
    });
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'transparent';
}

/* text with a dark edge, readable on any picture */
function edged(ctx, str, x, y, size, colour, align, weight) {
    ctx.font = font(size, weight); ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = Math.max(2, size / 9); ctx.strokeStyle = 'rgba(0,0,0,.78)'; ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y); ctx.fillStyle = colour; ctx.fillText(str, x, y);
}

function mark(ctx, plan, k) {
    ctx.textAlign = 'right'; ctx.font = font(30 * k, 600); ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText('BimmerApps', plan.w * 0.95, plan.h * 0.965);
}

function drawMoment(ctx, video, plan, fr, extra) {
    var W = plan.w, H = plan.h, k = Math.min(W, H) / 1080;      /* text sized by the short side, so widescreen is not oversized */
    ctx.save();
    picture(ctx, video, plan, fr);
    words(ctx, plan, fr, k);
    if (extra && extra.speed) {
        var s = 72 * k, x = W * 0.06, y2 = H * 0.93, n2 = String(extra.speed.n);
        edged(ctx, n2, x, y2, s, '#ffffff', 'left', 800);
        var w2 = ctx.measureText(n2).width;
        edged(ctx, extra.speed.unit, x + w2 + s * 0.2, y2, s * 0.4, '#ffffff', 'left', 600);
    }
    mark(ctx, plan, k);
    ctx.restore();
}

/* a montage frame: the picture, a white flash fading after each cut, the title, the speed, the mark */
function drawMontage(ctx, video, plan, fr, extra) {
    var W = plan.w, H = plan.h, k = Math.min(W, H) / 1080;
    ctx.save();
    picture(ctx, video, plan, fr);
    if (fr.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * fr.flash).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }
    words(ctx, plan, fr, k);
    if (extra && extra.speed) {
        var s = 72 * k, x = W * 0.06, y2 = H * 0.93, n2 = String(extra.speed.n);
        edged(ctx, n2, x, y2, s, '#ffffff', 'left', 800);
        var w2 = ctx.measureText(n2).width;
        edged(ctx, extra.speed.unit, x + w2 + s * 0.2, y2, s * 0.4, '#ffffff', 'left', 600);
    }
    mark(ctx, plan, k);
    ctx.restore();
}

function drawLaunch(ctx, video, plan, fr, run, extra) {
    var W = plan.w, H = plan.h, k = Math.min(W, H) / 1080, unit = extra && extra.unit === 'kmh' ? 'kmh' : 'mph';
    ctx.save();
    picture(ctx, video, plan, fr);
    words(ctx, plan, fr, k);
    if (fr.tree) {
        /* the lamps, across the top: three ambers and the green */
        var r = 34 * k, gap = r * 2.7, cx = W / 2 - gap * 1.5, cy = H * 0.09;
        ctx.fillStyle = 'rgba(5,5,7,.72)'; ctx.fillRect(cx - r * 1.6, cy - r * 1.5, gap * 3 + r * 3.2, r * 3);
        for (var n = 0; n < 4; n++) {
            var on = n < 3 ? fr.tree.amber > n : fr.tree.green;
            ctx.beginPath(); ctx.arc(cx + n * gap, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = on ? (n < 3 ? '#ffb31a' : '#2fd27a') : '#26262c'; ctx.fill();
        }
    }
    if (fr.part !== 'card') {
        var s = Math.max(0, Math.min(run.end, fr.src)), d = C.runlog.at(run, s), pad = W * 0.06, top = H * 0.3;         /* below the lamps and the title */
        /* the clock and the speed, down the left */
        edged(ctx, (fr.src < 0 ? 0 : s).toFixed(2), pad, top, 120 * k, fr.part === 'hold' ? '#ff1f3d' : '#ffffff', 'left', 800);
        edged(ctx, run.red ? 'RED LIGHT' : fr.src < 0 ? 'READY' : fr.part === 'slow' ? 'SLOW MOTION' : 'SECONDS', pad, top + 44 * k, 30 * k, '#d8d9de', 'left', 600);
        var sp = String(C.speedtrack.show(d.kmh === null ? 0 : d.kmh, unit));
        edged(ctx, sp, pad, H * 0.9, 150 * k, '#ffffff', 'left', 800);
        var spw = ctx.measureText(sp).width;
        edged(ctx, unit === 'kmh' ? 'KM/H' : 'MPH', pad + spw + 16 * k, H * 0.9, 40 * k, '#d8d9de', 'left', 600);
        /* the revs as a bar across, the gear and the pull on the right */
        var bw = W - pad * 2, bh = 16 * k, by = H * 0.925, rf = d.rpm === null ? 0 : Math.max(0, Math.min(1, d.rpm / 7200));
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(pad - 2, by - 2, bw + 4, bh + 4);
        ctx.fillStyle = '#2a2a31'; ctx.fillRect(pad, by, bw, bh);
        ctx.fillStyle = rf > 0.9 ? '#ff1f3d' : rf > 0.76 ? '#ffb31a' : '#f2f2f4'; ctx.fillRect(pad, by, Math.round(bw * rf), bh);
        if (d.gear !== null && d.gear >= 1) edged(ctx, String(d.gear), W - pad, H * 0.9, 150 * k, '#ffffff', 'right', 800);
        if (d.g !== null && fr.src >= 0) edged(ctx, d.g.toFixed(2) + ' G', W - pad, H * 0.9 - 150 * k, 54 * k, d.g >= 0.9 ? '#2fd27a' : '#ffffff', 'right', 700);
        /* a split, for two and a half seconds after it is passed */
        var shown = null;
        run.splits.forEach(function (x) { if (fr.src >= x.s && fr.src < x.s + 2.5) shown = x; });
        if (shown) {
            var label = shown.label + '   ' + shown.s.toFixed(2), fs = 56 * k;
            ctx.font = font(fs, 700);
            var lw = ctx.measureText(label).width + fs * 1.2, lx = (W - lw) / 2, ly = H * 0.72;
            ctx.fillStyle = 'rgba(5,5,7,.8)'; ctx.fillRect(lx, ly, lw, fs * 1.7);
            ctx.fillStyle = '#ff1f3d'; ctx.fillRect(lx, ly, Math.max(3, fs * 0.14), fs * 1.7);
            ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.fillText(label, W / 2, ly + fs * 1.2);
        }
    } else {
        /* the timeslip: the picture dimmed, the run's own figures in two columns */
        ctx.fillStyle = 'rgba(5,5,7,' + (0.84 * fr.card).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = fr.card;
        var rows = plan.rows, rh = 84 * k, cw = Math.min(W * 0.8, 820 * k), x0 = (W - cw) / 2, y0 = (H - (rows.length * rh + 150 * k)) / 2 + 90 * k;
        ctx.fillStyle = '#ff1f3d'; ctx.fillRect(x0, y0 - 96 * k, 90 * k, Math.max(3, 7 * k));
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.font = font(64 * k, 800); ctx.fillStyle = '#ffffff';
        ctx.fillText('TIMESLIP', x0, y0 - 20 * k);
        rows.forEach(function (row, n) {
            var y = y0 + (n + 1) * rh;
            ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(x0, y + 22 * k, cw, Math.max(1, 2 * k));
            ctx.textAlign = 'left'; ctx.font = font(40 * k, 600); ctx.fillStyle = '#c9cad0'; ctx.fillText(row.label, x0, y);
            ctx.textAlign = 'right'; ctx.font = font(52 * k, 800); ctx.fillStyle = '#ffffff'; ctx.fillText(row.value, x0 + cw, y);
        });
        ctx.globalAlpha = 1;
    }
    mark(ctx, plan, k);
    ctx.restore();
}

root.StudioSocial = { drawMoment: drawMoment, drawLaunch: drawLaunch, drawMontage: drawMontage };
})(window);
