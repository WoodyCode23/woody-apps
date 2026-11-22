'use strict';
/* The looks a finished clip can have: a few settings of brightness, contrast, colour and warmth, given as the
 * `filter` value a canvas (or CSS) takes. Dash cam pictures are flat and a little grey; these lift them.
 *
 *   LOOKS                    { clean, night, warm, punchy }
 *   filter(name, adjust) -> 'brightness(1.05) contrast(1.18) saturate(1.3)'
 *     adjust = { brightness, contrast, saturate } multiplies the look's own (each 0.5 to 1.5); unknown names are clean
 */
var LOOKS = {
    clean: { brightness: 1, contrast: 1.04, saturate: 1.08, warmth: 0 },
    night: { brightness: 1.14, contrast: 1.1, saturate: 0.92, warmth: 0 },
    warm: { brightness: 1.03, contrast: 1.06, saturate: 1.15, warmth: 0.14 },
    punchy: { brightness: 1.05, contrast: 1.18, saturate: 1.3, warmth: 0 },
};

function mult(v) { return typeof v === 'number' && isFinite(v) ? Math.max(0.5, Math.min(1.5, v)) : 1; }
function r2(v) { return Math.round(v * 100) / 100; }

function filter(name, adjust) {
    var l = typeof name === 'string' && Object.prototype.hasOwnProperty.call(LOOKS, name) ? LOOKS[name] : LOOKS.clean, a = adjust || {};
    var out = 'brightness(' + r2(l.brightness * mult(a.brightness)) + ') contrast(' + r2(l.contrast * mult(a.contrast)) + ') saturate(' + r2(l.saturate * mult(a.saturate)) + ')';
    return l.warmth > 0 ? out + ' sepia(' + r2(l.warmth) + ')' : out;
}

module.exports = { LOOKS: LOOKS, filter: filter };
