'use strict';
/**
 * Ambient Lab - what does this car's ambient light accept?
 *
 * ComfortFunctionIuK.ambientLightInteriorColour carries more than the preset number BMW's menu uses:
 * a 12-bit hue, three per-zone ("layer") hues, a brightness offset and dynamic-effect fields. The
 * Ambient Config app (cauliflowermossgrape/idrive7-apps, MIT) only ever sets the preset and leaves
 * the rest "not filled". Each test here sets exactly one of the others, so the car's reaction can be
 * read off one field at a time.
 *
 * Markers for "not filled", as Ambient Config sends them: enums 'SIGNAL_UNBEFUELLT', the 12-bit hue
 * 4095, the 8-bit fields 255. Real values are therefore 0..4094 and 0..254.
 *
 * Every write is opt-in (setting allowWrites, default off), paced (MIN_GAP_MS), and followed by a
 * restore of the state the car reported just before the test.
 */
const UNFILLED = 'SIGNAL_UNBEFUELLT';
const MIN_GAP_MS = 1500;           /* Ambient Config's pacing: one write per 1.5 s at most */

function slotOf(raw) {
    const m = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = m ? Number(m[1]) : Number(raw);
    return n >= 1 && n <= 12 && Math.round(n) === n ? n : null;
}

/** an all-"not filled" request; tests override one field */
function blank() {
    return {
        controlMenuAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlModeAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlDynamicInteriorLighting: UNFILLED,
        controlDynamicAmbienteInteriorLighting: UNFILLED,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
    };
}

function withField(k, v) { const r = blank(); r[k] = v; return r; }

const HUE = 'controlHueInteriorLighting';
const BRI = 'controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting';
const L1 = 'controlHueValueLayer1IndividualGroup', L2 = 'controlHueValueLayer2IndividualGroup', L3 = 'controlHueValueLayer3IndividualGroup';

/* name, what to watch for, request builder (gets the state before the test) */
const TESTS = [
    { name: 'Restore my colour', note: 'Sends your own preset again. Use any time.', restore: true,
      req: (s) => withField('controlMenuAmbientePanoramicRoofInteriorLighting', 'FARBAUSWAHL_' + (s.own || 1)) },
    { name: 'Preset: next colour', note: 'Baseline: the one change known to work. If this fails, nothing else will.',
      req: (s) => withField('controlMenuAmbientePanoramicRoofInteriorLighting', 'FARBAUSWAHL_' + ((s.slot || 1) % 12 + 1)) },
    { name: 'Hue 0 (red?)', note: 'Free hue, 12-bit. Does the colour change to something not in the presets?', req: () => withField(HUE, 0) },
    { name: 'Hue 1365 (green?)', note: 'A third of the way round the hue circle.', req: () => withField(HUE, 1365) },
    { name: 'Hue 2730 (blue?)', note: 'Two thirds round.', req: () => withField(HUE, 2730) },
    { name: 'Hue 3800 (magenta?)', note: 'Near the end of the circle.', req: () => withField(HUE, 3800) },
    { name: 'Brightness offset 0', note: 'Dimmest? Watch whether the light dims.', req: () => withField(BRI, 0) },
    { name: 'Brightness offset 128', note: 'Middle.', req: () => withField(BRI, 128) },
    { name: 'Brightness offset 254', note: 'Brightest the field allows. Brighter than your menu setting?', req: () => withField(BRI, 254) },
    { name: 'Zone 1 hue 0', note: 'Per-zone colour, layer 1. Does only part of the cabin change?', req: () => withField(L1, 0) },
    { name: 'Zone 2 hue 85', note: 'Layer 2.', req: () => withField(L2, 85) },
    { name: 'Zone 3 hue 170', note: 'Layer 3.', req: () => withField(L3, 170) },
];

/** the request that puts back what the car reported before a test (only fields the status gave us) */
function restoreFrom(before) {
    const r = blank();
    if (before && before.slot) r.controlMenuAmbientePanoramicRoofInteriorLighting = 'FARBAUSWAHL_' + before.slot;
    const raw = (before && before.raw) || {};
    /* if the status echoes any of the free fields, put those values back too */
    Object.keys(raw).forEach((k) => {
        const ctl = k.replace(/^status/, 'control');
        if (ctl in r && k !== 'statusMenuAmbientePanoramicRoofInteriorLighting' && raw[k] !== undefined && raw[k] !== null) r[ctl] = raw[k];
    });
    return r;
}

module.exports = { TESTS, blank, restoreFrom, slotOf, MIN_GAP_MS, UNFILLED };
