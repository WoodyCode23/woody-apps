'use strict';
/* npx -y node@8.16.2 tools/test_hud_song.js <a .jpg file>
 * HUD's song reader off the car: the metadata list, the player state names, the time left, and the album cover
 * (decoded and shrunk from a real JPEG, and every way it can be missing). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Song, read, shrink } = require(path.join(__dirname, '..', 'apps', 'woodr_hud', 'song.js'));

let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpg = process.argv[2];
const lines = [];
const handlers = {};
const ctx = { log: { info: (m) => lines.push(m), warn: (m) => lines.push('WARN ' + m) },
    signals: { watch: (iface, inst, h) => { Object.assign(handlers, h); return Promise.resolve({}); } } };
const meta = (title, artist, cover) => [{ key: 'TITLE', value: { stringValue: title } }, { key: 'ARTIST', value: { stringValue: artist } }]
    .concat(cover ? [{ key: 'COVER_FILE', value: { stringValue: cover } }] : []);

(async () => {
    ok('read: the list form gives title, artist and the cover path', JSON.stringify(read(meta('T', 'A', '/x/c.jpg'))) === JSON.stringify({ title: 'T', artist: 'A', cover: '/x/c.jpg' }));
    ok('read: no title, no song', read([{ key: 'ARTIST', value: { stringValue: 'A' } }]) === null);

    let changes = 0;
    const song = new Song(ctx, () => { changes++; });
    await song.start();
    handlers.currentItemMetadata(meta('One', 'Artist'));
    ok('a track is taken', song.now && song.now.title === 'One' && changes === 1);
    ok('no times yet: no progress', song.progress() === null);
    handlers.currentItemTime({ elapsed: 122072, total: 188990 });
    let p = song.progress();
    ok('milliseconds from the car: 67 s left of a 3:09 track', p && Math.abs(p.left - 66.9) < 1 && Math.abs(p.frac - 0.646) < 0.01);
    handlers.playerState('PLAYER_STATE_PAUSE');
    const leftAtPause = song.progress().left;
    await sleep(1100);
    ok('paused: the time left stands still', Math.abs(song.progress().left - leftAtPause) < 0.05);
    handlers.playerState('PLAYER_STATE_PLAY');
    await sleep(1100);
    ok('playing: it counts down by itself', leftAtPause - song.progress().left > 0.9);
    handlers.currentItemTime({ elapsed: 30, total: 200 });
    ok('a total too small for milliseconds is read as seconds', Math.abs(song.progress().left - 170) < 1);

    handlers.currentItemTime({ elapsed: 0, total: 4294967295 });
    ok('a track still loading (total all bits set) has no progress', song.progress() === null);
    handlers.currentItemTime({ elapsed: 0, total: 0 });
    ok('no CarPlay (0 of 0) has no progress', song.progress() === null);
    handlers.currentItemTime({ elapsed: 50000, total: 40000 });
    ok('an elapsed time past the total is not believed', song.progress() === null);
    handlers.playerState('PLAYER_STATE_UNKNOWN');
    handlers.currentItemTime({ elapsed: 30000, total: 200000 });
    const frozen = song.progress().left;
    await sleep(600);
    ok('player state UNKNOWN does not run the clock', Math.abs(song.progress().left - frozen) < 0.05);
    handlers.playerState('PLAYER_STATE_PLAY');

    /* covers */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hudsong-'));
    handlers.currentItemMetadata(meta('One', 'Artist', path.join(tmp, 'missing.jpg')));
    await sleep(300);
    ok('a missing cover file: no cover, said once', song.cover === null && lines.some((l) => /cover not readable \(ENOENT\), \.jpg/.test(l)));
    ok('a cover arriving for the same track keeps its times', song.progress() !== null);
    fs.writeFileSync(path.join(tmp, 'c.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
    handlers.currentItemMetadata(meta('One', 'Artist', path.join(tmp, 'c.png')));
    await sleep(300);
    ok('a cover that is not a JPEG: no cover, its first bytes logged', song.cover === null && lines.some((l) => /cover not a JPEG \(starts 89504e47\), \.png/.test(l)));
    fs.writeFileSync(path.join(tmp, 'big.jpg'), Buffer.alloc(500 * 1024, 1));
    handlers.currentItemMetadata(meta('One', 'Artist', path.join(tmp, 'big.jpg')));
    await sleep(300);
    ok('a cover over the size limit is not decoded', song.cover === null && lines.some((l) => /cover too large to decode \(500 KB\)/.test(l)));
    ok('no log line names a file', !lines.some((l) => /missing|c\.png|big\.jpg|hudsong/.test(l)));

    if (jpg && fs.existsSync(jpg)) {
        const before = song.coverId;
        handlers.currentItemMetadata(meta('Two', 'Artist', jpg));
        ok('a new track drops the old times', song.progress() === null);
        await sleep(2500);
        const c = song.cover;
        ok('a real JPEG becomes a 52 x 52 cover', !!c && c.w === 52 && c.h === 52 && c.d.length === 52 * 52 * 4 && song.coverId > before);
        let alpha = true, sum = 0;
        if (c) for (let i = 0; i < c.d.length; i += 4) { if (c.d[i + 3] !== 255) alpha = false; sum += c.d[i] + c.d[i + 1] + c.d[i + 2]; }
        ok('it is opaque and not blank', alpha && sum > 0);
        console.log('     ' + (lines.filter((l) => /cover shown/.test(l))[0] || 'no "shown" line'));
        handlers.currentItemMetadata(meta('Three', 'Artist'));
        ok('a track without a cover clears it', song.cover === null);
    } else console.log('skip the real JPEG (no file given)');

    const sq = shrink(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]), 2, 2, 1);
    ok('shrink averages the pixels it covers', sq[0] === 128 && sq[1] === 0 && sq[2] === 128 && sq[3] === 255);
    ok('nothing warned', !lines.some((l) => /^WARN/.test(l)));

    console.log(failed ? 'FAILED: ' + failed : 'all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
