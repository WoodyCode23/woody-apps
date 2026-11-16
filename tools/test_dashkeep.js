'use strict';
/* test_dashkeep.js - the clip keeper against plain folders on a PC.  node tools/test_dashkeep.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashkeep-'));
const SRC = path.join(root, 'src'), KEEP = path.join(root, 'keep'), SHM = path.join(root, 'shm');
[SRC, SHM].forEach((d) => fs.mkdirSync(d));
Object.assign(process.env, { DASHKEEP_SRC: SRC, DASHKEEP_DIR: KEEP, WOODY_SHM: SHM, DASHKEEP_FAKE: '1', DASHKEEP_SETTLE_MS: '0' });
const K = require('../components/woodr-dashkeep/keeper.js');

let fails = 0, n = 0;
const ok = (c, what) => { n++; if (!c) { fails++; console.log('FAIL ' + what); } };
const MB = 1048576;
function clip(name, mb, ageS) {
    const d = path.join(SRC, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'a.ts'), Buffer.alloc(mb * MB, 1));
    fs.writeFileSync(path.join(d, 'a.jpg'), 'j');
    fs.writeFileSync(path.join(d, 'a_Metadata.json'), '[]');
    const t = new Date(Date.now() - ageS * 1000);
    fs.readdirSync(d).forEach((f) => fs.utimesSync(path.join(d, f), t, t));
}
const request = (o) => fs.writeFileSync(path.join(SHM, 'dashcam.keep.json'), JSON.stringify(o));
const kept = () => fs.readdirSync(KEEP).filter((n) => n[0] !== '.').sort();
const rmSrc = (name) => { const d = path.join(SRC, name); fs.readdirSync(d).forEach((f) => fs.unlinkSync(path.join(d, f))); fs.rmdirSync(d); };

/* 1. finished clips get a second name; half-written ones (fewer than 3 files) do not */
for (let i = 1; i <= 4; i++) clip('14.11.2026_10_0' + i + '_00_Event', 1, 400 - i * 10);
fs.mkdirSync(path.join(SRC, '14.11.2026_10_09_00_Event')); fs.writeFileSync(path.join(SRC, '14.11.2026_10_09_00_Event', 'a.ts'), 'x');
fs.mkdirSync(path.join(SRC, 'not a clip'));
let out = K.tick();
ok(out.count === 4 && kept().length === 4, 'four finished clips kept, got ' + out.count);
ok(out.bytes > 4 * MB && out.bytes < 5 * MB, 'bytes counted');
ok(fs.statSync(path.join(KEEP, '14.11.2026_10_01_00_Event', 'a.ts')).nlink === 2, 'a hard link, not a copy');

/* 2. the stock app deletes its oldest: ours stays, readable */
rmSrc('14.11.2026_10_01_00_Event');
out = K.tick();
ok(out.count === 4 && fs.readFileSync(path.join(KEEP, '14.11.2026_10_01_00_Event', 'a.jpg'), 'utf8') === 'j', 'the clip outlives the stock copy');

/* 3. the cap: 1 GB is the smallest; use the request's capGb with big sparse-free maths instead: drop by name */
request({ on: true, capGb: 10, drop: ['14.11.2026_10_02_00_Event', '../../etc', 'x'] });
out = K.tick();
ok(out.count === 3 && kept().indexOf('14.11.2026_10_02_00_Event') < 0, 'a named clip is dropped, bad names ignored');
out = K.tick();
ok(out.count === 3, 'a dropped clip the stock app still lists is not kept again');
rmSrc('14.11.2026_10_02_00_Event');

/* 4. clear: everything not newer than the timestamp goes, once */
clip('14.11.2026_10_05_00_Event', 1, 10);
request({ on: true, capGb: 10, clear: Date.now() - 60000 });
out = K.tick();
ok(kept().join() === '14.11.2026_10_05_00_Event', 'clear removes the old ones and keeps the newer clip: ' + kept().join());
ok(out.cleared > 0, 'the clear is reported');
out = K.tick();
ok(kept().length === 1, 'cleared clips the stock app still lists (03, 04) do not come back: ' + kept().join());

/* 5. off: nothing new is kept */
clip('14.11.2026_10_06_00_Event', 1, 100);
request({ on: false, capGb: 10 });
out = K.tick();
ok(out.on === false && kept().length === 1, 'switched off: no new clips kept: ' + kept().join());

/* 5b. a pinned clip survives a clear; an unpinned one does not; a drop still removes it */
request({ on: true, capGb: 10 });
K.tick();                                                    /* 06 is kept now (switched on again) */
ok(kept().length === 2, 'two clips held before the pin test: ' + kept().join());
request({ on: true, capGb: 10, clear: Date.now(), pin: ['14.11.2026_10_06_00_Event'] });
out = K.tick();
ok(kept().join() === '14.11.2026_10_06_00_Event' && out.pinned === 1, 'a clear leaves the pinned clip: ' + kept().join());
request({ on: true, capGb: 10, pin: ['14.11.2026_10_06_00_Event'], drop: ['14.11.2026_10_06_00_Event'] });
out = K.tick();
ok(kept().length === 0, 'a drop removes even a pinned clip');
clip('14.11.2026_10_07_00_Event', 1, 100);
request({ on: true, capGb: 10 });
K.tick();

/* 6. the report file */
const rep = JSON.parse(fs.readFileSync(path.join(SHM, 'dashcam.kept.json'), 'utf8'));
ok(rep.count === 1 && rep.capGb === 10 && typeof rep.at === 'number', 'report written');

console.log(fails ? fails + ' of ' + n + ' FAILED' : 'all ' + n + ' ok');
try { fs.rmSync ? fs.rmSync(root, { recursive: true, force: true }) : null; } catch (e) { /* temp */ }
process.exit(fails ? 1 : 0);
