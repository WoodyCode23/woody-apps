# Licence notice

Required Notice: Copyright (c) 2026 BimmerApps (https://bimmerapps.com)

## Our own work

Everything in this repository that we wrote is licensed under the
[PolyForm Strict License 1.0.0](LICENSE.md): the apps under `apps/woodr_*`, `tools/`, `docs/`, and the
notes in the top folder. In plain words, which do not replace the licence text:

- You may read it and use it on your own car, for noncommercial purposes.
- You may not sell it, redistribute it, or make and share changed versions of it.

This is source-available, not open source. For anything the licence does not allow, ask:
hello@bimmerapps.com.

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
| `jpeg_decoder.js` | the jpeg-js authors, from Mozilla's pdf.js | Apache-2.0 / BSD-3-Clause (see the file's header) |

A file that carries its own licence header keeps that licence, whatever folder it is in.

## Not in this repository

BMW's app SDK is BMW's copyrighted code. It is never committed here; each head unit supplies its own
copy when an app is built on it. Built app packages contain it, so keep them to your own car.

This project is not affiliated with, endorsed by or supported by BMW.
