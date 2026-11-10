# woody-apps

Apps for a 2022 BMW G80 M3 (iDrive 7 / MGU), installed over Wi-Fi from the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | What it does |
|---|---|
| `woodr_warmhud` | Warm-up on the head-up display: oil, then the gearbox, then it turns itself off |
| `woodr_screenlab` | Calibration grids for the HUD and instrument cluster, with BMW's keep-out areas |
| `woodr_hass` | Home Assistant dashboard, car-to-HA push, doorbell on the cluster (in progress) |
| `woodr_vitals` | Small warm-up / drivetrain readout (the first app; mostly superseded) |

## Install
MGU Store → Settings → Add source → `WoodyCode23/woody-apps` → channel `branch:main` → Check now.

The apps need the GPU renderer (`idrive7-renderd`) and controller gate (`mgu-inputgate`). Those
are not shipped here: install anything from `cauliflowermossgrape/idrive7-apps` first, which
brings them.

## Develop
```
python kit/tools/build.py <app_id> --preview-only
node kit/tools/preview.js dist/<app_id> out wait=6 render      # PNG frames, no car needed
python kit/tools/build.py <app_id>                             # needs oap-sdk/ from your own car
```
Bump `version` in the app's `app.json` on every change you want the car to pick up.

Apps run on Node 8.16: no `?.`, `??`, object spread or `Array.flat`.

## Kit
`kit/` comes from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
as a git subtree, plus one change: `app.json` `"internet": true` now sets `package.json`
`"mguInternet": true`, which mgu-uplink needs before it lets an app online. To update:
```
git subtree pull --prefix=kit --squash <path-or-url-to-idrive7-apps> <branch-with-kit-split>
```
BMW's oap-sdk is never committed (`oap-sdk/` is ignored); the head unit supplies it at build time.

Licences: `kit/` and anything copied from upstream apps keep their original licences
(Redline-derived files are MPL-2.0).
