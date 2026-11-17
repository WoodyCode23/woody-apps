'use strict';
/* node tools/test_runlogs_usb_posix.js   (Node 8 on the car: npx -y node@8.16.2 tools/test_runlogs_usb_posix.js)
 * The ownership and permission checks of the run-log hand-over (apps/woodr_launch/runlog.js publish,
 * apps/woodr_dashcam/runlogs.js), which only mean something on a system like the car's. A PC running Windows
 * has no owners or permission bits to test with, so this pretends: the platform is called linux, and what the
 * file system says about owner and mode is replaced, path by path, with what the car would say. It proves the
 * decisions, not the car. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runlogs-posix-')));
const mk = (d) => { try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; } return d; };
const LAUNCH = 1101, DASHCAM = 1102, OTHER = 1199;

/* pretend: who owns what, and with which mode. Anything not listed belongs to `as` (the app running) with 0755/0644. */
const told = {};
let as = LAUNCH;
const say = (p, uid, mode) => { told[path.resolve(p)] = { uid: uid, mode: mode }; };
const dress = (p, s) => {
    const t = told[path.resolve(String(p))];
    s.uid = t ? t.uid : as;
    s.mode = (s.mode & ~0o7777) | (t && t.mode !== undefined ? t.mode : (s.isDirectory() ? 0o755 : 0o644));
    return s;
};
const lstat0 = fs.lstatSync, fstat0 = fs.fstatSync, open0 = fs.openSync;
const fdPath = {};
fs.lstatSync = function (p) { return dress(p, lstat0.apply(fs, arguments)); };
fs.openSync = function (p) { const fd = open0.apply(fs, arguments); fdPath[fd] = p; return fd; };
fs.fstatSync = function (fd) { return dress(fdPath[fd] || '', fstat0.apply(fs, arguments)); };
Object.defineProperty(process, 'platform', { value: 'linux' });
process.getuid = () => as;

const RL = require(path.join(__dirname, '..', 'apps', 'woodr_launch', 'runlog.js'));
const D = require(path.join(__dirname, '..', 'apps', 'woodr_dashcam', 'runlogs.js'));

let failed = 0;
const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name); } };
const name = (i) => 'run-2026-11-1' + i + '-10-00-00.json';
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return null; } };

const runs = mk(path.join(root, 'runs')), shm = mk(path.join(root, 'shm')), out = path.join(shm, 'launch.runs'), stick = mk(path.join(root, 'stick'));
for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(runs, name(i)), '{"v":1,"n":' + i + '}');

/* ---- Launch */
say(shm, 0, 0o1777);                                  /* as on the car: made by whichever app came first, sticky, open */
as = LAUNCH;
const rl = new RL.RunLog(runs);
ok('the usual case: a sticky shared folder, Launch makes its own folder in it and shares its logs', rl.publish(out, RL.SHARE) === 3 && ls(out).length === 3);
say(shm, OTHER, 0o777);
ok('a shared folder that is open but not sticky, and not ours: refused (what is in it could be swapped)', new RL.RunLog(runs).publish(out, RL.SHARE) === -1);
say(shm, LAUNCH, 0o755);
ok('a parent this app owns is fine without the sticky bit', new RL.RunLog(runs).publish(out, RL.SHARE) === 3);
say(shm, 0, 0o1777);
say(out, OTHER, 0o755);
fs.writeFileSync(path.join(runs, name(4)), '{"v":1,"n":4}');
ok('the folder already there but another app\'s: nothing written into it', new RL.RunLog(runs).publish(out, RL.SHARE) === -1 && ls(out).length === 3);
delete told[path.resolve(out)];
fs.writeFileSync(path.join(out, name(9)), 'planted'); say(path.join(out, name(9)), OTHER);
fs.writeFileSync(path.join(out, 'run-2026-11-01-10-00-00.json'), 'old');
ok('inside its own folder: its own stale log goes, a file that is not its own is not removed', new RL.RunLog(runs).publish(out, RL.SHARE) === 4 && ls(out).indexOf('run-2026-11-01-10-00-00.json') < 0 && ls(out).indexOf(name(9)) >= 0 && ls(out).indexOf(name(4)) >= 0);
fs.unlinkSync(path.join(out, name(9))); delete told[path.resolve(path.join(out, name(9)))];

/* ---- Dashcam, reading what Launch left: the folder and files are Launch's, not its own */
as = DASHCAM;
const launchOwns = () => { say(out, LAUNCH, 0o755); ls(out).forEach((f) => say(path.join(out, f), LAUNCH, 0o644)); };
launchOwns();
ok('the usual case: Launch\'s folder, closed to others, Launch\'s files: all are taken', D.pending(out, []).length === 4);
const dest = path.join(stick, 'Launch');
let r = D.copyTo(out, dest, D.pending(out, []));
ok('and copied to the stick whole', r.copied === 4 && r.failed === 0 && fs.readFileSync(path.join(dest, name(4)), 'utf8') === '{"v":1,"n":4}');
say(out, LAUNCH, 0o777);
ok('a folder others can write into: not read', D.pending(out, []).length === 0 && D.copyTo(out, path.join(stick, 'L2'), [name(1)]).copied === 0);
say(out, LAUNCH, 0o775);
ok('group-writable counts too', D.pending(out, []).length === 0);
launchOwns();
fs.writeFileSync(path.join(out, name(8)), 'slipped in'); say(path.join(out, name(8)), OTHER, 0o644);
ok('a file in it that is not the folder owner\'s is passed over', D.pending(out, []).indexOf(name(8)) < 0 && D.pending(out, []).length === 4);
r = D.copyTo(out, path.join(stick, 'L3'), [name(8), name(1)]);
ok('and refused again at the copy itself, by what was opened', r.copied === 1 && r.failed === 1 && ls(path.join(stick, 'L3')).join() === name(1));
say(out, OTHER, 0o755); ls(out).forEach((f) => say(path.join(out, f), OTHER, 0o644));
ok('known gap, on purpose: a folder some other app made first, closed and with its own files, is read like Launch\'s', D.pending(out, []).length === 5);

console.log(failed ? 'FAILED: ' + failed : 'all ok');
process.exit(failed ? 1 : 0);
