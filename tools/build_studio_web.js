'use strict';
/* node tools/build_studio_web.js [--check]
 * Packs the Studio's shared core (components/studio-core/*.js, written for the car's Node) into one file a browser
 * loads with a script tag: web/studio/core.js, which sets StudioCore. The web app has no other build step.
 * --check writes nothing and fails when the packed file on disk is not what the core gives now. */
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..', 'components', 'studio-core');
const OUT = path.join(__dirname, '..', 'web', 'studio', 'core.js');

function build() {
    const files = fs.readdirSync(CORE).filter((f) => /\.js$/.test(f)).sort();
    let out = '/* Dashcam Studio, shared core. Packed by tools/build_studio_web.js from components/studio-core: change it there. */\n' +
        '(function (root) {\n\'use strict\';\nvar defs = {}, made = {};\n' +
        'function need(name) {\n    name = name.replace(/\\.js$/, \'\');\n    if (made[name]) return made[name].exports;\n' +
        '    if (!defs[name]) throw new Error(\'studio core: no part called \' + name);\n' +
        '    var m = made[name] = { exports: {} };\n    defs[name](m, m.exports, need);\n    return m.exports;\n}\n';
    files.forEach((f) => {
        const src = fs.readFileSync(path.join(CORE, f), 'utf8').replace(/\r\n/g, '\n').replace(/^'use strict';\n/, '');
        out += '\n/* ---- ' + f + ' ---- */\ndefs[\'./' + f.replace(/\.js$/, '') + '\'] = function (module, exports, require) {\n' + src + '};\n';
    });
    return out + '\nroot.StudioCore = need(\'./index\');\n})(typeof self !== \'undefined\' ? self : this);\n';
}

if (require.main !== module) { module.exports = { build: build }; return; }
const text = build();
if (process.argv.indexOf('--check') >= 0) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (have !== text) { console.error('web/studio/core.js is out of date: run node tools/build_studio_web.js'); process.exit(1); }
    console.log('web/studio/core.js is up to date');
} else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    console.log('wrote ' + path.relative(path.join(__dirname, '..'), OUT) + ' (' + Math.round(text.length / 1024) + ' KB)');
}
