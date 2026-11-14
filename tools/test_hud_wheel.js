'use strict';
/* npx -y node@8.16.2 tools/test_hud_wheel.js
 * HUD's wheel menu off the car: the app's own background code run against stand-ins for the kit, the wheel and the
 * cluster renderer, to check which button does what, with the wheel gate's setting off and on. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'apps', 'woodr_hud');
const KIT = path.join(__dirname, '..', 'kit', 'runtime');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hudwheel-'));
process.env.WOODY_SHM = path.join(tmp, 'woody');

let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* stand-ins: the kit's run() hands us the app, the car has no engine running, the wheel is ours to press */
let impl = null, wheelOn = null;
const layers = [];
const stubs = {
    './kit/mgu': { run: (i) => { impl = i; } },
    './kit/gauges': {},
    './kit/car': function Car() { this.live = { rpm: 0 }; },
    './wheel': { Wheel: function (ctx, on) { wheelOn = on; this.start = () => Promise.resolve(true); } },
    './waze': { Waze: function () { this.st = null; this.poll = () => Promise.resolve(); this.hudBox = () => null; this.setSize = () => Promise.resolve(); } },
    './song': { Song: function () { this.now = null; this.start = () => Promise.resolve(false); this.progress = () => null; this.cover = null; this.coverId = 0; } },
    './cluster_render_client': { ClusterRender: function () { this.on = () => {}; this.connect = () => {}; this.image = () => { layers.push('made'); return layers.length; }; this.pixels = () => {}; this.drop = () => { layers.push('dropped'); }; this.set = () => {}; this.close = () => {}; } },
    './kit/canvas': require(path.join(KIT, 'canvas.js')),
    './kit/hudlink': require(path.join(KIT, 'hudlink.js')),
};
const realLoad = Module._load;
Module._load = function (request, parent) {
    if (parent && parent.filename && parent.filename.indexOf(APP) === 0 && stubs[request]) return stubs[request];
    return realLoad.apply(this, arguments);
};
require(path.join(APP, 'main.js'));

const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const values = {};
spec.settings.forEach((s) => { values[s.key] = s.default; });
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; }, shown: () => true, onChange: () => {} };
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) };

(async () => {
    const bgm = await impl.background({ log: log, settings: settings, spec: spec, signals: {}, dataDir: tmp });
    const st = bgm.st;
    const cur = () => bgm.items()[st.at];
    const roll = (n) => { for (let i = 0; i < Math.abs(n); i++) wheelOn.onRoll(n > 0 ? -1 : 1); };      /* on the car, down is d < 0 */
    const gateFile = (n) => path.join(process.env.WOODY_SHM, n);
    const fresh = (n) => { try { return Date.now() - fs.statSync(gateFile(n)).mtime.getTime() < 700; } catch (e) { return false; } };

    /* ---- the gate's setting off (the default): the menu button does everything, the roller's press nothing ---- */
    ok('the gate setting is off by default', values.gate === false);
    wheelOn.onMenu();
    ok('menu button opens the menu on Highlight', st.menuOpen && cur().key === 'highlight');
    roll(1);
    ok('rolling down moves to the next row, a group', cur().kind === 'group');
    wheelOn.onPress();
    ok('gate off: the roller\'s press does nothing', st.group === null);
    wheelOn.onMenu();
    ok('gate off: the menu button goes into the group', st.group === cur().g && st.menuOpen);
    const shiftWas = values.shift;
    wheelOn.onMenu();
    ok('gate off: the menu button changes the chosen setting and the menu stays open', values[cur().key] !== undefined && st.menuOpen && (cur().key !== 'shift' || values.shift !== shiftWas));
    await sleep(500);
    ok('gate off: no gate file is touched', !fresh('wheelgate.menu') && !fresh('wheelgate.roll'));
    ok('gate off: no "Car\'s audio list" row', (() => { st.group = 'Quick actions'; const has = bgm.items().some((it) => it.key === 'carlist'); st.group = null; return !has; })());
    st.menuOpen = false;

    /* ---- the gate's setting on: the roller's press selects, the menu button goes back and closes ---- */
    values.gate = true;
    await sleep(500);
    ok('gate on, menu closed: only the menu button\'s file is kept fresh', fresh('wheelgate.menu') && !fresh('wheelgate.roll'));
    wheelOn.onPress();
    ok('gate on: the roller\'s press does not open the menu', !st.menuOpen);
    wheelOn.onMenu();
    ok('gate on: the menu button opens it', st.menuOpen && cur().key === 'highlight');
    await sleep(500);
    ok('gate on, menu open: the roller\'s file is kept fresh too', fresh('wheelgate.roll'));
    roll(1);
    wheelOn.onPress();
    ok('gate on: the roller\'s press goes into the group', st.group !== null && st.menuOpen);
    const key = cur().key, was = values[key];
    wheelOn.onPress();
    ok('gate on: the roller\'s press changes the chosen setting and the menu stays open', values[key] !== was && st.menuOpen);
    wheelOn.onMenu();
    ok('gate on: the menu button goes back a level without changing anything', st.group === null && st.menuOpen && values[key] !== was);
    wheelOn.onMenu();
    ok('gate on: the menu button at the top closes the menu', !st.menuOpen);
    await sleep(900);
    ok('menu closed again: the roller\'s file goes stale, the car has its roller back', !fresh('wheelgate.roll') && fresh('wheelgate.menu'));

    /* ---- the car's own list, on request ---- */
    wheelOn.onMenu();
    st.group = 'Quick actions';
    const list = bgm.items();
    st.sels['Quick actions'] = '|carlist';
    ok('gate on: Quick actions has "Car\'s audio list"', list.some((it) => it.key === 'carlist') && cur().key === 'carlist');
    wheelOn.onPress();
    ok('selecting it tells the driver to press the menu button', /Press the menu button for the car's list/.test(st.say) && st.menuOpen);
    await sleep(900);
    ok('and the menu button\'s file is left to go stale, so the next press reaches the car', !fresh('wheelgate.menu'));
    wheelOn.onMenu();
    ok('that press closes our menu', !st.menuOpen);

    /* ---- the switch that turns the menu off ---- */
    values.menu = false;
    wheelOn.onMenu();
    await sleep(900);
    ok('menu switched off: nothing opens and no gate file is kept fresh', !st.menuOpen && !fresh('wheelgate.menu'));

    ok('nothing warned', !logs.some((l) => /^WARN/.test(l)));
    console.log(failed ? 'FAILED: ' + failed : 'all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
