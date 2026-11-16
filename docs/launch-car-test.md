# Launch 0.3.0: testing in the car

A checklist for whoever installs the app and for the driver. Work through it in order and stop
at the first thing that is not as described: write down what happened, pull the log, and go no further.

Launch only reads the car (speed, engine speed, gear, one steering wheel button) and draws. It arms, changes and
triggers nothing on the car. None of the tests below need any car setting changed by the app.

## Ground rules

- Installs, restarts, removals and settings changes happen parked, with the car in P. Never while the owner is
  driving on a public road.
- Sections 1 to 3 are parked or walking pace. Section 4 (a real pass) is for private land or a track only.
- The driver does not photograph anything while the car moves. A passenger does, or a phone on a mount records
  video and stills are taken from it afterwards.
- No part of this needs the location. Do not add it to notes or file names.

## 0. Before the install (laptop, no car needed)

1. `node tools/test_launch.js` in this repository: the last line must read `launch: all 51 ok` (the count may
   grow, the word FAILED must not appear).
2. `sh tools/link.sh`, then build `woodr_launch` with the kit as the other closed apps are built.
3. `tools/manifest-check.sh woodr_launch`: every signal marked `rs` must exist on the car, or the install is
   refused. The app asks for:

   | Interface | Field | Flag | Needed |
   |---|---|---|---|
   | `de.bmw.infotainment.vehicle.Vehicle2` | `statusCarSpeed2` | `rs` | yes |
   | `de.bmw.infotainment.vehicle.CDS` | `statusEngineSpeed2` | `rs` | yes |
   | `de.bmw.infrastructure.VehicleInformation` | `statusGearboxDrive`, `DataPowerTrain2` | `s` | optional block |
   | `de.bmw.infotainment.controlelements.SteeringWheelPushButton` | `statusRotaryPress` | `rs` | optional block |

   If the check objects to `statusRotaryPress`, delete that whole block from `app.json` and rebuild: the app
   then arms from the centre screen only. Do not change a flag to make the check pass.
4. Confirm the logging id `OAB4` is not used by any app already on the car.
5. Confirm the cluster-render service is on the car (the other apps that draw on the cluster and head-up
   display need it too). Without it Launch still works on the centre screen.
6. If this is a second install of a changed build, the version in `app.json` must have gone up.

## 1. Parked, engine running, car in P

Open Launch from the app menu.

- [ ] A notice shows once ("THIS APP ONLY MEASURES", "CLOSED COURSES AND PRIVATE LAND ONLY"). The Arm / Reset
      button accepts it. It must not show again after the app is closed and opened.
- [ ] The staging page shows. Top right reads SPORTSMAN TREE, ROLLOUT OFF, MPH. There is no DEMO DATA label.
- [ ] STOPPED has a white box and `0 MPH`.
- [ ] ENGINE RUNNING has a white box and the idle revs.
- [ ] IN GEAR is red and shows `P`. The headline reads NOT READY.
- [ ] Pressing Arm / Reset now gives a red line "NOT ARMED: SELECT DRIVE" and nothing else happens.
- [ ] The History button opens an empty table ("NO RUNS SAVED YET") and goes back.
- [ ] The Settings button opens the settings: Tree, 1 ft rollout, Speed unit, Rev bar blinks from, Rev bar on
      the head-up display, Show the tree and the run on, Arm with the steering wheel roller, Demo data. Change Speed unit to km/h and back: the staging page follows.
- [ ] Switch the engine off with the ignition still on: ENGINE RUNNING turns red.

If IN GEAR shows a dash and the small line "THE CAR DOES NOT REPORT THE GEAR", the optional gear signal is
missing. The app still arms. Note it.

### 1a. The other two screens, with the demo car (still in P)

This is the safe way to see the cluster and head-up display pictures: nothing moves.

1. Settings, Demo data: On. The page shows DEMO DATA in red, and READY TO STAGE.
2. Press Arm / Reset. Watch all three screens.

- [ ] Centre screen: the tree counts down (after 1 to 2.5 s: three ambers half a second apart, then green),
      then the big clock runs for about 12 s, then a timeslip marked DEMO RUN shows about 2 s after the
      simulated car lifts.
- [ ] Head-up display: four lamps in a row with "WAIT FOR GREEN", then "GO", then the clock (left), the speed
      (right), a rev bar along the top that blinks red at the shift point, and the newest split in red. After
      the run: the headline time for 10 s, then it clears.
- [ ] Instrument cluster: a black box with red corner brackets in the middle, between the dials, showing the same,
      about 600 wide of the cluster's 1920. As the simulated car passes each split (60 ft, 0-30, 0-60, 1/8 mile
      and so on) a strip comes up under the box for three seconds with that split's time, and the speed there
      for the 1/8 and 1/4 mile. It is white in a demo run; in a real run it is green when it beats the best on
      file.
- [ ] The car's own speed, revs, gear letter and warning lamps stay visible and whole the entire time. If the
      car's cluster picture disappears or changes while ours is up, stop: set "Show the tree and the run on" to
      Centre screen only and note it.
- [ ] After the 10 s result the box and the strip are gone and nothing is left behind where they were (no black
      patch on the map, no stale strip).
- [ ] On the head-up display nothing of the car's own is covered: speed, speed limit, navigation arrows, and
      in the sport view the rev band along the top, all stay readable. Try each cluster view the car offers.
- [ ] On the cluster nothing outside the middle area is touched: both dials, warning lamps and the bottom line
      stay as they were.
- [ ] The pictures are whole: no edge cut off, nothing off-centre by more than a finger's width.
- [ ] A demo run is not in the saved history: after Demo data is Off again, History has no DEMO rows.

Since 0.2.0 the cluster picture is two small layers on cluster-render's `panel` target (the whole 1920 x 720
cluster), at 730,150 600x357 and 730,512 600x86, class overlay, never exclusive. It no longer uses the map slot,
so it does not depend on a map app. If the cluster shows nothing but the head-up display does, look in the log
for `screens: map layer` and `screens: pop-up layer` lines and for `refused`, and note what they say. With the
Waze map running, also note how many budget holds cluster-render reports during one demo run: the two share
the cluster's upload budget, and a clock that visibly lags is the sign.

3. Repeat with Tree set to Pro: all three ambers together, green 0.4 s later.
4. Set "Show the tree and the run on" to Centre screen only and repeat: the other two screens stay untouched.
   Put it back to all three.
5. Demo data: Off. The DEMO DATA label goes.

### 1b. The whole cluster (0.3.0, still in P, Demo data on)

Setting "On the cluster" = "Whole cluster". Off by default. It adds one layer under the run's two: panel,
overlay, z 49, shown 0,0 1920x646 from a 400x135 picture (211 KB), up to 8 a second in a run, 5 on the tree,
3 on the result. It ends at y 646 so that it never covers the gear strip. The car is expected to take its own
dials away while it is up (slot 0x200 unmapped) and to put them back within a second of the result clearing.

- [ ] Arm: the tunnel fills the glass, the tree and then the run sit sharp in the middle of it
- [ ] The rings move outwards, faster as the demo car speeds up, and turn red at the shift point
- [ ] Gear, PARK and belt lamps are still shown by the car; no black boxes over our picture
- [ ] After the result clears: the car's own cluster is back, whole, with no black boxes. If boxes stay: do
      they go at the next gear change or only with a door opened?
- [ ] Log: `screens: whole-cluster backdrop up` and `taken down`; budget holds a minute for Launch's layers and
      for the Waze map while it runs (the map is hidden under the backdrop but still uploads)
- [ ] Switch back to "In the middle" and run once more: as 1a

With the whole cluster on there is no speedometer or rev counter of the car's own during a run: speed is in
the middle picture and on the head-up display, revs on the head-up display's bar. Private ground only.

## 2. Parked on private ground, engine running, foot firmly on the brake, D selected

Clear space ahead of the car. Nobody in front of it.

- [ ] In D the page reads READY TO STAGE, IN GEAR shows `D1` (or `D`).
- [ ] Press Arm / Reset, keep the brake on. The tree runs on all three screens. Green shows. Nothing else
      happens (the car has not moved). Press Arm / Reset: "CANCELLED", back to staging.
- [ ] Arm again and wait: 30 s after green the app disarms by itself ("NO LAUNCH WITHIN 30 S OF GREEN").
- [ ] Wheel input: with the staging page open, press the right-hand roller on the steering wheel. The tree
      arms. Press it again: cancelled. Write down what else the car did with that press (a list popping up on
      the cluster or head-up display, a radio station change). If it is a nuisance, turn "Arm with the steering
      wheel roller" off.
- [ ] With the app closed (another screen showing), the roller press does not arm anything.
- [ ] Open the app with the car rolling at walking pace: pressing Arm / Reset gives "NOT ARMED: THE CAR IS NOT
      STOPPED".

## 3. Low-speed roll test (empty private lot)

Each of these is at walking to jogging pace. No hard acceleration is needed.

**3a. A gentle run.** Arm. On green, release the brake and roll gently up to about 10 mph for at least 25 m
(80 ft), then brake to a stop.

- [ ] The run page appears the moment the car moves, with the clock counting.
- [ ] 60 FT fills in on the right while rolling.
- [ ] After the stop (or 2 s after you stop gaining speed) the timeslip shows: REACTION and 60 FT have values,
      the splits that were not reached are dashes, the bottom lines read "SPEED-SENSOR TIMING, NOT GPS VERIFIED" and "ROLLOUT OFF: THE
      CLOCK STARTS AT FIRST MOVEMENT". The small line under the reaction reads ENDED: STOPPED or ENDED: LIFTED.
- [ ] History now has one row.

**3b. A jump start.** Arm, and let the car roll before green.

- [ ] The tree turns red on all three screens at once, the timeslip is marked "RED LIGHT: MOVED BEFORE GREEN".

**3c. A creep.** Arm, on green let the car move a hand's width and stop.

- [ ] The page reads NO TIME / NO SPLIT REACHED and nothing is added to History.

**3d. Rollout.** Settings, 1 ft rollout: On. Repeat 3a.

- [ ] Top right reads 1 FT ROLLOUT ON in red, the timeslip says so too, and the 60 FT time is shorter than in
      3a by roughly the time the first foot took (clearly visible at this pace, a few tenths in a real launch).

Put rollout back to Off (the default) unless the owner wants it.

## 4. A real pass (private land or a track only)

Do sections 1 to 3 first, on an earlier day if need be.

- Use whatever launch procedure the owner normally uses. The app has no part in it.
- A passenger watches the screens, or a mounted phone records them.
- If the venue gives a timeslip, or a GPS timing box is in the car, keep its numbers next to the app's.

What to expect when comparing:

- A strip's clock starts after about one foot of rollout. With rollout Off the app's times are longer than a
  strip's by a few tenths. Turn rollout On for a like-for-like comparison.
- The app's 1/8 and 1/4 mile speeds are the average over the last 66 ft before the line, as a strip's speed
  trap gives.
- Distance comes from the car's speed signal. If that signal reads high while the driven wheels spin, distance
  runs ahead and times read short. A launch with a lot of wheelspin is the case to compare most carefully.
- Reaction time includes the delay between the app deciding "green" and the screen showing it. The head-up
  display and cluster are the screens to watch for the tree.

## What to photograph

1. The staging page in P (NOT READY) and in D (READY TO STAGE).
2. The tree on the head-up display and on the cluster, from the driver's eye position, in each cluster view,
   once with an amber lit and once on green. These show whether the pictures sit inside the visible areas.
3. The run readout on the head-up display and cluster (demo car is fine).
4. The centre screen's timeslip after 3a, 3b and after any real pass.
5. The History page.
6. Anything that looks cut off, overlapped or misplaced, with a note of which screen and which view.

## Log lines to pull

The app's log is `woodr_launch.log` in the app's data folder (an older part may be in `woodr_launch.log.1`).
Pull it together with `runs.jsonl` and `settings.json` from the same folder. Lines worth reading:

| Line starts with | What it tells |
|---|---|
| `starting woodr_launch 0.1.0` | the app started |
| `this unit has no ...` | an optional interface the car lacks (gear, or the wheel roller) |
| `signal Vehicle2 subscribed`, `signal CDS subscribed`, `signal VehicleInformation subscribed` | the signals are there; `error:` in their place is a finding |
| `wheel:` followed by an error | the roller press is not available |
| `gear selection:` | the raw gear values the car sends, the first few |
| `screens: cluster-render up` | the cluster and head-up display service answered |
| `screens: hud layer ...`, `screens: map layer ...` | `shown`, or `waiting` with the reason |
| `screens: refused`, `screens: ... pixels refused`, `target ... disabled` | a finding: copy the whole line |
| `launch: armed by ...` | tree type, the pre-stage delay, rollout, and how many speed samples a second were arriving |
| `launch: green`, `launch: moved, reaction ...`, `launch: RED LIGHT ...` | the start |
| `launch: first speeds ...` | the first ten speed values of the launch with their times: how the signal leaves zero |
| `launch: run ended (...)` | why it ended, the headline, samples a second (48 to 70 expected), the longest gap between samples (about 20 ms expected), bad samples |
| `launch: splits ...` | every split of the run |
| `launch: saved run ...` or `launch: history write failed` | the history file |
| `tick:`, `draw:`, `speed:`, `rpm:`, `wheel:`, `screens ...:` followed by an error | a caught error: copy the whole line |
| `FATAL` | the app ended badly: stop testing and send the whole log |

## If it misbehaves

In this order, parked:

1. Something wrong on the cluster or head-up display: Settings, "Show the tree and the run on": Centre screen
   only. The app then draws nothing there. Press Arm / Reset if a tree is running (it cancels).
2. Close the app (leave its screen). Nothing of it shows anywhere 10 s after a run ends, and nothing at all
   when no tree or run is going.
3. If a picture is stuck on the cluster or head-up display after the app is closed, restart the app once; if it
   is still there, remove the app.
4. Remove the app the same way the other custom apps are removed, with the car parked, then confirm the
   cluster and head-up display are back to normal. Pull the log before removing if you can: removal deletes the
   data folder, the saved runs with it.
5. If the log shows `target map disabled by the mapping guard`, the cluster service has switched that target
   off for safety: it needs its guard reset (as for the other cluster apps) before anything draws there again.

The head unit wipes an app's data the first time the app crashes and uninstalls it the second time. If the app
or its history disappears, that is what happened: send the log, do not just reinstall.

## Not yet proven (the car has to answer these)

| Assumption | Why it matters | How this test settles it |
|---|---|---|
| The speed signal is `Vehicle2.statusCarSpeed2`, field `speedVehicleCentreOfGravity`, in 1/64 km/h, 65535 for no value | every time on the slip | 0 MPH standing, the same reading as the speedometer (within its usual lead) while rolling |
| It arrives 48 to 70 times a second from the first movement on, and a standing car sends an exact 0 | start time and split precision | `launch: first speeds`, `samples at`, `longest gap` |
| "Moving" is the signal passing 0.5 km/h | the start of the clock; a signal with a dead band near zero would start it late | `launch: first speeds`: the first values should be small and rising |
| The speed is the car's own speed, not a spinning wheel's | times under wheelspin | section 4, against a strip slip or GPS box |
| Engine speed is `CDS.statusEngineSpeed2`, 0.25 rpm a count, 9 to 14 a second | peak revs, the rev bar | idle revs on the staging page |
| The gear comes as `statusGearboxDrive` or `DataPowerTrain2`; D shows as stage D, P/R/N block arming | staging | section 1 and 2 |
| The roller press is `statusRotaryPress`, value 1 or `RAENDELRAD_GEDRUECKT` while pressed, and the car's own reaction to it is harmless here | arming from the wheel | section 2 |
| Cluster `map` target 1088x480, safe area 286,72 504x368; the app's box is 336x200 at 370,156 | nothing of the car's covered | photographs |
| Head-up display target 800x480, visible window 120,100 570x278, clear slot 220,185 470x133; the app's box is 440x124 at 235,189, the shift flash 424x16 at 243,193 | the same | photographs, each view |
| Layer options copied from the other apps (`yield: 0` on the head-up display, `guide_hold: 1` and `contend: 0` on the cluster) behave here as they do there | whether the pictures show, and what they displace | section 1a |
| About 1.9 MB/s of pictures at most (5 a second on the head-up display, 3 on the cluster) fits the shared budget next to whatever else is drawing | choppy or missing pictures | `screens:` lines, and by eye |
| Outside temperature: not read. No signal name for it could be checked without the car, and a wrong name can block the install. The saved runs carry `tempC: null` until one is confirmed | history | name a confirmed signal and it can be added |

## What to send back

The log, `runs.jsonl`, the photographs, which boxes above could not be ticked, and for a real pass any strip or
GPS numbers to compare with.

## The data log and dashcam highlights (0.4.0)

Every real run (not a demo run, not one that reached no split) leaves a file in Launch's data folder:
`runs/run-<date>-<time>.json`, the last 20 kept. Rows are `[ms since armed, km/h, rpm, gear, g forward,
g sideways, Nm]`, one every 40 ms; `at` is the wall-clock time of the green light, so a run can be lined up with
the dashcam clip that holds it. `summary` has the peak pull, the revs it left at, each shift with its revs, and
an ESTIMATE of wheelspin: how far the speed signal ran ahead of the speed the acceleration sensor adds up to,
in the first 4 s. It is not a per-wheel measurement; the app has no such signal. One line of it shows under the
reaction time on the timeslip.

At the moment a real run starts, Launch writes `/dev/shm/woody/dashcam.highlight.launch.json`; Dashcam 0.4.2
marks the clip that holds that moment and the next one. Setting "Mark every launch as a highlight on the
dashcam", on by default.

- [ ] Log after a real run: `launch: dashcam highlight asked`, `launch: data log run-....json {...}`; Dashcam's
      log: `highlight asked (launch)` and `highlight: <clip>`
- [ ] Copy one run file off the car and send it back: is `gLong` there (not null), how many rows a second
- [ ] New signals, both optional: CDS2 acceleration (forward, sideways) and FES engine torque. If the app does
      not start or logs a refused watch, say so: 0.3.1 is the version without them

## 0.7.0: a slower tree, arming from the head-up display, bumps before green

- **Tree pace.** Setting "Time between the tree's lights": 1 s by default (a strip's is 0.5 s, still a choice).
  - [ ] The ambers come one second apart, green one second after the last
- **Arming from the head-up display.** While Launch is running, HUD's menu has "Launch" under Quick actions:
  "Arm the tree" when idle, "Cancel" while the tree runs. It does what Arm / Reset does, whatever the centre
  screen shows, and HUD's menu closes so the tree can be seen. Needs HUD 0.9.2. Launch has to have been opened
  once since the head unit started, and its first-run notice accepted.
  - [ ] With Launch open: HUD menu, Quick actions, Launch: the tree starts; again: "CANCELLED"
  - [ ] With another screen showing (Launch opened earlier): the same
  - [ ] Launch never opened since the restart: the row is not in the menu
  - [ ] Log: `launch: asked from the head-up display menu`, then `launch: armed by hud`
- **A bump is not a red light.** Before green, movement is a start only once the car has gone a foot or reached
  5 km/h. Less than that, and coming to rest again, is forgotten; the run's log line says how many bumps.
  - [ ] Held on the brake against the engine, a lurch that the brakes catch: the tree stays as it was, no red
  - [ ] Leave on green afterwards: a normal reaction time; log `... 1 bump(s) before green ignored`
  - [ ] Roll away properly before green: still a red light, reported from where the car first moved
