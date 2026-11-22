# Licence notice

Copyright (C) 2026 BimmerApps (https://bimmerapps.com)

## Our own work

Everything in this repository that we wrote is licensed under the
[GNU General Public License, version 3](LICENSE) or (at your option) any later version (GPL-3.0-or-later): the
apps under `apps/woodr_*`, `components/`, `web/`, `tools/`, `docs/`, and the notes in the top folder. In plain words,
which do not replace the licence text:

- You may use it, study it, change it and share it, including changed versions, for any purpose.
- If you share it, changed or not, you share it under these same terms, with its source.
- It comes with no warranty of any kind.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the licence for details.

Until 2026-11-16 this repository was under the PolyForm Noncommercial License 1.0.0. Copies taken before that
date keep the terms they were taken under; everything from that date on is GPL-3.0-or-later.

## Other people's work, under their own licences

These parts are not ours, and the licence above does not apply to them. Each keeps the licence its
author gave it:

| Part | Author | Licence |
|---|---|---|
| `kit/` (the app kit) | cauliflowermossgrape, [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) | MIT |
| `kit/renderd/` (the screen renderer) | cauliflowermossgrape, IterioDev, display-bridge authors | GPL-3.0-or-later, with MIT parts (see the licence files in that folder) |
| `cluster_render_client.js` in several apps | Robert Nisipeanu, [idrive-apps](https://github.com/robertnisipeanu/idrive-apps) | MPL-2.0 |
| Files derived from the upstream Redline app (they say so in their header) | cauliflowermossgrape | MPL-2.0 |
| `qrcode.js` | Kazuhiko Arase | MIT |
| `web/studio/vendor/mp4-muxer.js` | Vanilagy, [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2, unchanged | MIT |
| `jpeg_decoder.js` | the jpeg-js authors, from Mozilla's pdf.js | Apache-2.0 / BSD-3-Clause (see the file's header) |

A file that carries its own licence header keeps that licence, whatever folder it is in.

## Not in this repository

BMW's app SDK is BMW's copyrighted code. It is never committed here; each head unit supplies its own
copy when an app is built on it. Built app packages contain it, so keep them to your own car.

This project is not affiliated with, endorsed by or supported by BMW.
