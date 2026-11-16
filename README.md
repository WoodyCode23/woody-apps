# woody-apps

Apps for a 2022 BMW G80 M3 (iDrive 7 / MGU), installed over Wi-Fi from the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | What it does |
|---|---|
| `woodr_launch` | Launch: a drag-strip style timer with a countdown tree, a full timeslip, a history, and a data log of every run (speed, revs, gear, pull, an estimate of wheelspin). Shows on the centre screen, the head-up display and the instrument cluster, with a whole-cluster view. Read-only. Closed courses and private land only |
| `woodr_dashcam` | Dashcam: the car's own drive recorder as a loop dash cam, clips kept on the car and copied to a USB stick, highlights that are never removed to make room |
| `woodr_hud` | HUD: a menu on the head-up display worked from the steering wheel, a rev bar with a shift point, and the song that is playing |
| `woodr_diag` | Diagnostics: fault memory and live values, read-only |
| `woodr_link` | Link: the car on your own Tailscale network, locked down |
| `woodr_warmhud` | Warm-up on the head-up display: oil, then the gearbox, then it turns itself off |
| `woodr_screenlab` | Calibration grids for the HUD and instrument cluster, with BMW's keep-out areas |
| `woodr_hass` | Home Assistant, both ways, through [Car Relay](https://github.com/WoodyCode23/car-relay): your own tiles on the centre screen (doors, locks, lights, scenes, any service you choose), the doorbell camera on the cluster, and the car's readings as sensors in Home Assistant. Set up by scanning a QR with your phone; no Home Assistant token on the car |
| `woodr_vitals` | Small warm-up / drivetrain readout (the first app; mostly superseded) |

## Install
MGU Store → Settings → Add source → `WoodyCode23/woody-apps` → channel `branch:main` → Check now.

The apps need the GPU renderer (`idrive7-renderd`) and controller gate (`mgu-inputgate`). Those
are not shipped here: install anything from `cauliflowermossgrape/idrive7-apps` first, which
brings them.

## Helper components
Three of the apps lean on a small service or library that runs outside the app sandbox. These are in
`components/` with their source. The Store does not install them: they are a root step, by hand, with the car
parked, for people who are comfortable with a shell on the head unit. `node tools/pack_component.js components/<id>`
makes the package.

| Component | For | Without it |
|---|---|---|
| `woodr-dashkeep` | Dashcam: keeps clips on the car and clears the oldest when its space is used | Dashcam still saves clips and copies them to a stick |
| `woodr-link` | Link: holds Tailscale to the car policy | Link shows that its service is missing |
| `woodr-wheelgate` | HUD: keeps the wheel's menu button and roller from opening the car's own list while HUD's menu is up | HUD works; the car's list opens alongside it |

Installing one (done this way for `woodr-dashkeep` on one car; the other two have only been placed by hand):

1. On a computer: `node tools/pack_component.js components/woodr-dashkeep` makes a `.tgz` holding the component's
   description (each file with its checksum), its files and its service units.
2. Copy the `.tgz` to the head unit, into any writable folder under `/var/opt`.
3. As root on the head unit, with the car parked: `sh /var/opt/mgu-deploy/mgu-deploy.sh check --artifact <path>.tgz`
   shows what it would touch; then the same with `install --artifact <path>.tgz --yes`. This needs the MGU Store's
   deploy tool on the unit.
4. Do not start, stop or restart the new service by hand afterwards. The deploy tool hands it to the head unit's
   recovery manager, which reads its list only at boot; starting a listed service by hand reset the head unit once.
   It runs from the next head-unit start.

The wheel gate is not installed this way: its own README has the steps.

Everything here has been developed and tested on a single vehicle. Read the code before you run it on yours.

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

Licences: our own apps, components, tools and docs are open source under the GNU General Public License, version 3
or later (GPL-3.0-or-later): use, study, change and share them, and share what you build on them the same way. `kit/` and
anything copied from other projects keep their original licences. See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
