'use strict';
/* node tools/test_runlogs_usb.js   (Node 8 on the car: npx -y node@8.16.2 tools/test_runlogs_usb.js)
 * Launch's run logs on their way to the USB stick: Launch leaves copies of its newest logs in a shared folder
 * (apps/woodr_launch/runlog.js publish) and Dashcam copies them to the stick (apps/woodr_dashcam/runlogs.js).
 * Folders stand in for the car's; it proves the logic, not what the car does. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RL = require(path.join(__dirname, '..', 'apps', 'woodr_launch', 'runlog.js'));
const D = require(path.join(__dirname, '..', 'apps', 'woodr_dashcam', 'runlogs.js'));

let failed = 0;
const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlogs-usb-'));
const mk = (d) => { try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; } return d; };
const runs = mk(path.join(root, 'runs')), shm = path.join(root, 'launch.runs'), stick = mk(path.join(root, 'stick')), dest = path.join(stick, 'Launch');
const name = (i) => 'run-2026-11-' + (i < 10 ? '0' : '') + i + '-10-00-00.json';
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return null; } };

/* ---- Launch's side */
const rl = new RL.RunLog(runs);
ok('no runs yet: an empty shared folder, not an error', rl.publish(shm, RL.SHARE) === 0 && ls(shm).length === 0);
for (let i = 1; i <= 14; i++) fs.writeFileSync(path.join(runs, name(i)), '{"v":1,"n":' + i + '}');
fs.writeFileSync(path.join(runs, 'notes.txt'), 'x'); fs.writeFileSync(path.join(runs, name(15) + '.tmp'), 'half');
ok('the newest ten are shared, whole, and nothing else', rl.publish(shm, RL.SHARE) === 10 && ls(shm).length === 10 && ls(shm)[0] === name(5) && ls(shm)[9] === name(14)
    && fs.readFileSync(path.join(shm, name(14)), 'utf8') === '{"v":1,"n":14}');
fs.writeFileSync(path.join(runs, name(15)), '{"v":1,"n":15}');
ok('a new run: it is added and the oldest shared one goes', rl.publish(shm, RL.SHARE) === 10 && ls(shm)[0] === name(6) && ls(shm)[9] === name(15) && ls(shm).every((n) => !/\.tmp$/.test(n)));
ok('a shared folder that cannot be made: said, not thrown', new RL.RunLog(runs).publish(path.join(root, 'no', 'such', 'place'), 10) === -1);

/* ---- Dashcam's side */
ok('nothing on the stick yet: all ten are wanted, oldest first', (() => { const p = D.pending(shm, []); return p.length === 10 && p[0] === name(6) && p[9] === name(15); })());
let r = D.copyTo(shm, dest, D.pending(shm, ls(dest) || []));
ok('copied whole into the stick\'s Launch folder', r.copied === 10 && r.failed === 0 && ls(dest).length === 10 && fs.readFileSync(path.join(dest, name(15)), 'utf8') === '{"v":1,"n":15}' && ls(dest).every((n) => !/\.tmp$/.test(n)));
ok('nothing new: nothing wanted', D.pending(shm, ls(dest)).length === 0);
ok('no shared folder (Launch not installed): nothing wanted, no error', D.pending(path.join(root, 'none'), []).length === 0);

/* what is in that folder is not trusted: any app can write there */
const evil = mk(path.join(root, 'evil'));
fs.writeFileSync(path.join(evil, 'run-2026-11-17-10-00-00.json'), '{"ok":1}');
fs.writeFileSync(path.join(evil, 'passwd'), 'x');
fs.writeFileSync(path.join(evil, 'run-2026-11-17-10-00-01.json.sh'), 'x');
fs.writeFileSync(path.join(evil, 'run-2026-11-17-11-00-00.json'), Buffer.alloc(D.MAX_BYTES + 1));
fs.writeFileSync(path.join(evil, 'run-2026-11-17-12-00-00.json'), '');
mk(path.join(evil, 'run-2026-11-17-13-00-00.json'));
let linked = false;
try { fs.symlinkSync(path.join(root, 'runs', 'notes.txt'), path.join(evil, 'run-2026-11-17-14-00-00.json')); linked = true; } catch (e) { /* this PC does not allow links: the car's check is O_NOFOLLOW */ }
const p = D.pending(evil, []);
ok('only a small regular file with a run log\'s name is taken' + (linked ? ' (a link is not)' : ' (link case skipped here)'), p.length === 1 && p[0] === 'run-2026-11-17-10-00-00.json');
const d2 = path.join(stick, 'L2');
r = D.copyTo(evil, d2, ['run-2026-11-17-10-00-00.json', '../escape.json', 'passwd', 'run-2026-11-17-11-00-00.json', 'run-2026-11-17-99-00-00.json']);
ok('copyTo checks again by itself: odd names are ignored, a too-large or missing file fails and the rest go', r.copied === 1 && r.failed === 2 && ls(d2).join() === 'run-2026-11-17-10-00-00.json' && !fs.existsSync(path.join(stick, 'escape.json')));
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(evil, 'run-2026-10-' + (10 + (i % 20)) + '-10-00-' + (i < 10 ? '0' : '') + i + '.json'), '{}');
ok('never more than twenty at a time', D.pending(evil, []).length === D.MAX_FILES);
ok('a stick that cannot be written: said, not thrown', (() => { const x = D.copyTo(shm, path.join(root, 'no', 'such', 'stick'), [name(15)]); return x.copied === 0 && x.failed === 1 && !!x.why; })());

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
