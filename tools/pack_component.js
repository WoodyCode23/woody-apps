'use strict';
/* pack_component.js - make a tool artifact the car's installer takes from a components/<id> folder.
 *   node tools/pack_component.js components/woodr-dashkeep [outDir=dist]
 * Layout of the .tgz: component.json at the root (each file's sha256 filled in), files/<path>, units/<name>. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const src = path.resolve(process.argv[2] || '.'), outDir = path.resolve(process.argv[3] || 'dist');
const c = JSON.parse(fs.readFileSync(path.join(src, 'component.json'), 'utf8'));
const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pack-'));
fs.mkdirSync(path.join(stage, 'files'));
fs.mkdirSync(path.join(stage, 'units'));
(c.files || []).forEach((f) => {
    const data = fs.readFileSync(path.join(src, f.path)).toString('utf8').replace(/\r\n/g, '\n');   /* text files: LF on the car */
    f.sha256 = crypto.createHash('sha256').update(data).digest('hex');
    fs.mkdirSync(path.dirname(path.join(stage, 'files', f.path)), { recursive: true });
    fs.writeFileSync(path.join(stage, 'files', f.path), data);
});
(c.units || []).forEach((u) => fs.writeFileSync(path.join(stage, 'units', u.name), fs.readFileSync(path.join(src, u.name), 'utf8').replace(/\r\n/g, '\n')));
fs.writeFileSync(path.join(stage, 'component.json'), JSON.stringify(c, null, 2) + '\n');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, c.id + '@' + c.version + '.tgz');
execFileSync('tar', ['czf', path.basename(out), '-C', stage, 'component.json', 'files', 'units'], { cwd: outDir, stdio: 'inherit' });
console.log(out + ' (' + fs.statSync(out).size + ' bytes)');
