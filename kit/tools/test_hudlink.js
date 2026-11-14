'use strict';
/* node kit/tools/test_hudlink.js   (also on the car's Node: npx -y node@8.16.2 kit/tools/test_hudlink.js)
 * The HUD link in a temp folder: an app publishes its switches and choices, the HUD lists them and asks for changes. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hudlink-'));
process.env.WOODY_SHM = path.join(tmp, 'woody');
const hud = require(path.join(__dirname, '..', 'runtime', 'hudlink.js'));

let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* a stand-in for the kit's Settings: get, set, shown, and a record of what was set */
function fakeSettings(schema) {
    const v = {};
    schema.forEach((s) => { v[s.key] = s.default; });
    return { v: v, sets: [], get(k) { return v[k]; }, set(k, x) { v[k] = x; this.sets.push([k, x]); },
        shown(s) { return !s.hidden && (!s.when || Object.keys(s.when).every((k) => [].concat(s.when[k]).indexOf(v[k]) >= 0)); } };
}

const SCHEMA = [
    { key: 'song', label: 'Song line', type: 'bool', default: true },
    { key: 'style', label: 'Rev bar style', hudLabel: 'Rev bar', type: 'choice', options: [['bar', 'Segments'], ['solid', 'Solid'], ['off', 'Off']], default: 'bar' },
    { key: 'shift', label: 'Shift point', type: 'number', default: 7000 },
    { key: 'testBell', label: 'Test the doorbell now', type: 'bool', default: false, hud: false },
    { key: 'secret', label: 'Hidden', type: 'bool', default: false, hidden: true },
    { key: 'extra', label: 'Only with solid', type: 'bool', default: false, when: { style: 'solid' } },
];

(async () => {
    const st = fakeSettings(SCHEMA);
    const warns = [];
    const served = hud.serve({ id: 'demo_app', title: 'Demo', version: '1.2.3', settings: SCHEMA }, st, { warn: (m) => warns.push(m) });
    ok('serve starts', !!served);

    let list = hud.apps();
    ok('the app is listed with its title and version', list.length === 1 && list[0].id === 'demo_app' && list[0].title === 'Demo' && list[0].version === '1.2.3');
    const keys = list[0].items.map((i) => i.key).join(',');
    ok('only switches and choices are offered; hud:false, hidden, numbers and unmet "when" are left out (' + keys + ')', keys === 'song,style');
    ok('hudLabel is used, with the options and the value', list[0].items[1].label === 'Rev bar' && list[0].items[1].options.length === 3 && list[0].items[1].value === 'bar');
    ok('apps(except) leaves the HUD itself out', hud.apps('demo_app').length === 0);

    ok('next: a switch flips, a choice steps and wraps', hud.next(list[0].items[0]) === false && hud.next(list[0].items[1]) === 'solid'
        && hud.next({ type: 'choice', value: 'off', options: [['bar', 'a'], ['off', 'b']] }) === 'bar');

    hud.request('demo_app', 'song', false);
    await sleep(900);
    ok('a switch request is applied', st.v.song === false && st.sets.length === 1);
    ok('and published', hud.apps()[0].items[0].value === false);

    hud.request('demo_app', 'style', 'solid');
    await sleep(900);
    list = hud.apps();
    ok('a choice request is applied', st.v.style === 'solid');
    ok('a setting whose "when" now holds appears', list[0].items.map((i) => i.key).join(',') === 'song,style,extra');

    const before = st.sets.length;
    hud.request('demo_app', 'style', 'purple');
    await sleep(700);
    hud.request('demo_app', 'testBell', true);
    await sleep(700);
    hud.request('demo_app', 'shift', 9000);
    await sleep(700);
    hud.request('demo_app', 'song', 'yes');
    await sleep(700);
    ok('an unknown option, a hud:false key, a number and a wrong type are all ignored', st.sets.length === before && st.v.testBell === false && st.v.shift === 7000);
    ok('each refusal is logged', warns.length === 4);

    /* an old request file must never be applied */
    fs.writeFileSync(path.join(hud.DIR, 'demo_app.req.json'), JSON.stringify({ n: 'old', key: 'song', value: true, at: Date.now() - 60000 }));
    await sleep(700);
    ok('a request from a minute ago is ignored', st.v.song === false);

    /* a change made on the centre screen reaches the HUD without a request */
    st.v.song = true;
    await sleep(700);
    ok('a change made elsewhere is published', hud.apps()[0].items[0].value === true);

    ok('an app with "hud": false is not served', hud.serve({ id: 'lab_app', hud: false, settings: SCHEMA }, st, null) === null && hud.apps().length === 1);
    ok('ids that are not plain app ids are refused', hud.request('../x', 'a', true) === false && hud.serve({ id: 'Bad Id', settings: SCHEMA }, st, null) === null);

    /* a stale app drops off the list */
    const f = path.join(hud.DIR, 'demo_app.json');
    served.stop();
    fs.writeFileSync(f, JSON.stringify({ id: 'demo_app', title: 'Demo', at: Date.now() - hud.STALE_MS - 1000, items: [{ key: 'song', label: 'Song', type: 'bool', value: true }] }));
    ok('an app not heard from is not listed', hud.apps().length === 0);
    fs.writeFileSync(path.join(hud.DIR, 'other.json'), 'not json');
    fs.writeFileSync(path.join(hud.DIR, 'liar.json'), JSON.stringify({ id: 'someone_else', at: Date.now(), items: [{ key: 'a', type: 'bool', value: true }] }));
    ok('a broken file and a file under another app\'s name are skipped', hud.apps().length === 0);

    /* a hostile file: huge texts, too many items and options, odd values. Listed cut to size, or not at all. */
    const big = 'x'.repeat(200000);
    fs.writeFileSync(path.join(hud.DIR, 'evil.json'), JSON.stringify({ id: 'evil', title: big.slice(0, 500), at: Date.now(), items: [
        { key: 'a', label: big.slice(0, 5000), type: 'bool', value: 'yes' },
        { key: 'b', label: 'B', type: 'choice', value: { x: 1 }, options: Array.from({ length: 300 }, (_, i) => [i, big.slice(0, 900)]) },
        { key: big.slice(0, 900), label: 'k', type: 'bool', value: true }, { key: 'c', type: 'choice', options: [{ a: 1 }] },
    ].concat(Array.from({ length: 500 }, (_, i) => ({ key: 'n' + i, label: 'n', type: 'bool', value: true }))) }));
    const evil = hud.apps().filter((a) => a.id === 'evil')[0];
    ok('a hostile file is cut to size', !!evil && evil.title.length === 40 && evil.items.length <= 40 && evil.items[0].label.length === 48 && evil.items[0].value === false
        && evil.items[1].options.length === 12 && evil.items[1].options[0][1].length === 32 && evil.items[1].value === null && !evil.items.some((i) => i.key.length > 64 || i.key === 'c'));
    fs.writeFileSync(path.join(hud.DIR, 'huge.json'), JSON.stringify({ id: 'huge', at: Date.now(), items: [{ key: 'a', label: big, type: 'bool', value: true }] }));
    ok('a file over the size limit is not read', !hud.apps().some((a) => a.id === 'huge'));
    console.log(failed ? 'FAILED: ' + failed : 'all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
