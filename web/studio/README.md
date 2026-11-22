# Dashcam Studio, web app

Dashcam Studio in a browser: open a folder of clips,
play them (the car's own `.ts` clips are rewrapped in the page), cut an edit, save it as a recipe the PC Studio
opens. No server: `index.html`, `app.js` and `core.js` are the whole thing, and the page may connect to nothing.

- `core.js` is packed from `components/studio-core` by `node tools/build_studio_web.js`. Do not edit it.
- Try it: `tools\serve_studio_web.cmd` (serves this folder on 127.0.0.1:8765, this PC only).
- Tests: `node tools/test_studio_web.js`, `npx -y node@8.16.2 tools/test_studio_core.js`,
  `npx -y node@8.16.2 tools/test_studio_ts.js` (needs ffmpeg).

The finished video is made in the page: the edit is played through once and filmed by the browser's own recorder (MP4 where the browser can, WebM otherwise), with a small BimmerApps mark. No sound yet. Not here yet: the phone layout and install to the home screen (step 3), and the Launch data overlay. `py tools/test_studio_export_e2e.py` runs the whole thing in headless Edge with a made-up clip (needs ffmpeg).
Open source since 2026-11-21 (GPL-3.0-or-later, like the rest of this repository). `vendor/mp4-muxer.js` is someone else's work under the MIT licence; see NOTICE.md.

Launch data on the picture: when the folder also holds Launch's run logs (`run-<date>-<time>.json`, copied off the car), each run is found in the drive by matching its speed against the speed the clips recorded, and its clock, speed, revs, gear, pull and splits are drawn over the clip and into the finished video. "Earlier" / "Later" move it a tenth of a second. A drive whose clips carry no speed data cannot be matched. `py tools/test_studio_overlay_e2e.py` checks the whole path with made-up files.

Since 2026-11-16 the finished video is made frame by frame with the browser's own encoders (`encode.js`, WebCodecs; the MP4 is written in the page by `vendor/mp4-muxer.js`, MIT): exact to the frame, faster than playing it through, and with sound. Music is the owner's own file, faded in and out (`components/studio-core/audio.js`). "Moment" is the first social clip template (`compose.js`, `looks.js`, drawn by `social.js`): one piece, up to 15 s, vertical by default, a slow push-in, a title, a caption and a look. Browsers without WebCodecs keep the older silent export. `py tools/test_studio_export_e2e.py [video|music|badmusic|moment]` checks each in headless Edge (needs ffmpeg).

"Launch" is the second template (`compose.launch`, drawn by `social.js`): one run from the Launch app's data log found in the drive, as the lights counting down, the launch in slow motion, the run with its clock, speed, revs, gear and splits, a hold on the finish, and a timeslip of the log's own figures. The lamps are a picture of a countdown ending on the green the log recorded; the log does not hold how the tree was set. `py tools/test_studio_overlay_e2e.py launch` makes one in headless Edge.

"Montage" is the third template (`compose.montage`, drawn by `social.js`): up to eight of the edit's pieces, about two and a half seconds from the middle of each, a flash at every cut and the title over the start. With music, the page first listens for its beat (`components/studio-core/beats.js`, through `StudioEncode.findBeat`) and every cut after the first falls on one; music without a clear pulse, or no music, gives evenly spaced cuts, and the note under the button says which happened. The beat finder is a simple one (how sharply the loudness rises, and at what spacing between 60 and 180 a minute that repeats): tested on made-up drum tracks only, so real songs are the thing to try. `py tools/test_studio_export_e2e.py montage` makes one in headless Edge.
