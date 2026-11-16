# Diagnostics app: what we can read today

Scope for `apps/woodr_diag` ("Diagnostics"), written 2026-11-11 from the code in `kit/runtime/` and the
apps in this repo. Nothing in this document was newly tried on the car.

**Everything so far has been tested on exactly one car: a 2022 M3 Competition (G80) with iDrive 7.** Anything
below may be different, or missing, on another model, year or software version.

## The short version

- The app is **read-only**. It never clears a fault, codes, flashes, actuates, resets an adaptation or a
  service, or writes anything to a control unit.
- **Readable today with the kit, no new low-level work:** which control units answer (and what type each
  is), the 12 V battery's state of charge, tyre pressures / temperatures / targets, engine speed, road speed,
  coolant, engine oil, gear, and the gearbox oil temperature.
- **Readable, but not understood yet:** the instrument cluster's service records. We can fetch them; the kit
  only tells us which service item each record is, not the remaining distance or date.
- **Not readable through the read-only path today: fault codes.** This is the big finding. The kit's
  read-only link refuses the fault-memory read. The kit's unrestricted link can do it, but that same link can
  also clear and write, so this app does not use it. See "Fault codes" below for the small kit change that
  would fix this properly.
- **Fault texts** do not exist on the head unit. They have to be built on the PC from BMW's data, and BMW's
  texts must stay out of this public repo.
- Diagnostics are read **when a button is pressed**, never on a timer.

## What the app shows in version 0.1.0

| Page | Shows | Source |
|---|---|---|
| Overview | Faults, 12 V battery, tyres, service: headline and OK / attention | the pages below |
| Faults | Control units that answer, with their type code. Fault count and codes only in demo. No clear button. | on demand, `ReadOnlyDiag.discover()` |
| Live | Engine speed, road speed, gear, battery %, coolant, engine oil, four tyres; gearbox oil on demand | signals; `DidReader.value()` on demand |
| Service | The cluster's service records: item names, raw bytes | on demand, `ReadOnlyDiag.read(0x60, 0x1001)` |

With no car (PC preview) every page is filled with made-up values and says DEMO DATA. The demo fault codes
and texts are invented (`D00xxx`, "Demo fault: ...") and are not BMW codes.

## Technical detail

### The two diagnostic links in the kit

- `kit/runtime/diag.js`, class `Diag`: the head unit's own diagnostic transport (UDS over TASU, tester address
  0xF2). **It sends any service to any unit.** It is the write-capable link.
- `kit/runtime/readonly-diag.js`, class `ReadOnlyDiag`: wraps a private `Diag` and checks every request
  before it leaves. Allowed: UDS `22` (ReadDataByIdentifier, 1 to 8 identifiers, one unit), `22 F1 50` to
  all units at once, and OBD `01` / `09` with one PID. Everything else throws before it is sent: sessions
  (10), resets (11), **clearing faults (14)**, security access (27), communication control (28), dynamic
  identifiers (2C), writes (2E), I/O control (2F), routines (31), downloads (34 to 37), tester present (3E),
  DTC settings (85). Note that this also refuses the two harmless reads `19` (fault memory) and OBD `06`
  (on-board monitor results).

HANDOFF.md already has the rule: diagnostic reads only through the read-only path. This app follows it.

### Safe functions (the only ones `woodr_diag` calls)

| Function | What it returns | How slow | Limits in the code |
|---|---|---|---|
| `new ReadOnlyDiag(ctx.signals, log)`, `.init()` | the link; `.ready`, `.available`, `.error`, `.busy`, `.stats` | instant | `init()` never throws; with no transport `.ready` stays false |
| `.discover()` | `Map(address -> SGBD index)`, 6 hex digits or `''` when a unit refused | waits until no reply came for 3 s (5 s for the first), 15 s at most | the transport turns a second all-units request away for a few seconds |
| `.read(addr, did)` / `.readMany(addr, [dids])` | the unit's reply bytes (`62 ...` or a refusal `7F 22 xx`), `null` when it did not answer, `undefined` when cancelled | 1.5 s timeout by default; at least 25 ms between two requests | 8 identifiers per request; a unit that answers "busy" gets a 1 s pause |
| `.wake(addr)`, `.silent(addr)`, `.cancel()` | bookkeeping only, nothing is sent | instant | a unit that missed 5 requests in a row is skipped until `wake()` |
| `new DidReader(link, { ecu })`, `.read(c)`, `.value(name, candidates)` (`kit/runtime/dids.js`) | a scaled number or `null`, the reason in `.raws` | up to 4 s per candidate | goes through `link.physical()`, so the same check applies |
| `sgbd.decode / field / format / split` (`kit/runtime/sgbd.js`) | pure decoding of a reply with a catalog entry | instant | needs a catalog (below) |
| `ecus.ECU` (`kit/runtime/ecus.js`) | unit names by address | instant | the table is from a G20 330e and F-series cars, not from a G80 |
| `diag.parseDtcReply`, `diag.statusInfo`, `diag.hex`, `diag.NRC` | pure helpers (parse a fault reply, label a status byte) | instant | importing them does not open a link |
| `signals.watch(iface, '1', handlers, log, { pollMs })` | subscribed values | as the car sends them | each interface must be declared in `app.json` |
| `Car` (`kit/runtime/car.js`) | rpm, speed, coolant, oil, gear, with the demo drive | 20 a second in demo | |

Nothing in the kit code says whether the engine must be running or the ignition on for any of these. That is
an unknown (below).

**Another tool blocks diagnostics.** HANDOFF.md: while the laptop's `m3cc volts` runs, on-car apps get
`APP_REQUEST_TEMPORARILY_NOT_ACCEPTED`. The read-only link retries after 100, 200, 300 and 400 ms and then
gives up; the app shows "No answer". Also from HANDOFF.md: never run diagnostics during an E-Sys or bootmod3
flash. Every app on the head unit sees every diagnostic reply, so another app polling a unit does not break
ours, but two apps asking the same unit share its time.

### Control units

`ReadOnlyDiag.discover()` lists every unit that answers, with its SGBD index (the type code BMW's tools
identify a unit by). Names come from `ecus.ECU`; an address the table does not know shows as "ECU 0x..".
On demand only. It is a broadcast to the whole car, DME included, and it is a pure read of one identifier.

### Fault codes

- **What exists in the kit:** `Diag.functional(0x19, [0x02, mask])` asks every unit for its faults in one go
  (waits until no reply came for 4 s, 25 s at most); `parseDtcReply(uds, params)` turns each reply into
  `[{ code: '21F026', status }]`; `statusInfo(status)` gives ACTIVE / WARNING LAMP / PENDING / STORED /
  HISTORY. This is how the upstream Fault Scanner works.
- **Why the app does not do it:** `19` is not on the read-only link's list, so the only way to send it is the
  raw `Diag`, which can equally send `14` (clear). One wrong byte away from a write is not a place for an app
  that promises read-only.
- **The proper fix (needs a go-ahead, it is a kit change):** add `19 02 <mask>` (and nothing else from `19`)
  to `check()` in `readonly-diag.js`, plus a `faults()` method, with a test next to
  `kit/tools/test_live_data.js` proving `14` still throws. Then `woodr_diag` fills in real counts and codes;
  the screens are already built for it (`unit.faults` goes from `null` to a list).
- **Texts:** the head unit has no fault text database. The kit's PC tools build one: `kit/tools/dtc_texts.py`
  (from a coding tool's export, or `--db` from an oap-dtcscan package, or `--codes` from a CSV),
  `kit/tools/dtc_tables.py` and `kit/tools/dtc_csv.py`, packed by the build and read with
  `kit/runtime/pack.js` (`open(dir).get(table, code)`). Lookup is by unit type (SGBD index from
  `discover()`), then by address, then by code alone. Those tools write into `apps/dtc_scanner/`, an upstream
  app that is not in this repo, so they need an output folder argument for us. The texts are BMW's and are
  git-ignored upstream: **they must not be committed here** (this repo is public). Without a database, codes
  show without text.

### Live values

- **Cheap (signals, no diagnostics):** engine speed, road speed, coolant, engine oil, gear / selector
  (`Car`), 12 V state of charge, tyres. Also available but not used by this app: g-forces, torque, vehicle
  condition (`Car.SIGNALS`).
- **By diagnostics, known to answer on this car:** gearbox oil temperature, `22 6000` to the gearbox unit
  0x18 (value minus 40 = deg C; 42 C was seen). Warm-Up HUD polls it every 5 s; this app reads it only on a
  press and never more often than every 5 s.
- **By diagnostics, possible in principle:** anything a unit answers to `22`, decoded with a catalog made by
  `kit/tools/sgbd_catalog.py` from the unit's SGBD (`sgbd.decode`). No catalog is in this repo (the tables
  are BMW's and git-ignored), so none of this is in version 0.1.0. HANDOFF.md also says: anything new against
  the engine unit (DME), ask first.
- **Not through the read-only path:** misfire counts and other on-board monitor results
  (`DidReader.monitor / supported / ask06` use OBD service `06`, which the read-only link refuses; the
  `did: true` form asks `22 F6xx` instead and would pass, untested here).

### Service (condition based service)

- `ReadOnlyDiag.read(0x60, 0x1001)` asks the instrument cluster for its service records; the kit's
  `test_service.js` shows 12-byte records and that the engine unit (0x12) and the brakes unit answer the same
  identifier. The app asks the cluster only.
- The kit names the first byte of a record (the item id: 1 engine oil, 3 brake fluid, 33 exhaust emissions
  test, 100 vehicle check) and nothing else. The decoder lived in the upstream Service app, which is not in
  this repo. So today: item names and raw bytes, **no remaining distance, no date**. The app logs the raw
  records so they can be worked out against what the car's own service menu shows.
- A lead for that work: the same test has one worked example. Record `01 0A BF 01 03 53 21 36 1C 18 00 00`
  is expected to read "Engine oil, remaining 27510 km, due 06/2028, status OK, counter 3, availability 83 %,
  interval 33000 km / 24 months". That fits bytes 1 to 2 as remaining distance in 10 km steps, byte 4 the
  counter, byte 5 the percentage, byte 6 the interval in 1000 km, byte 8 the year, byte 9 the interval in
  months. One example is not proof, and upstream itself labels these records "unverified for the car", so
  the app does not show numbers from it yet.
- The upstream Service app also read the cluster's own service list as text (item, distance, date, colour)
  from a signal interface. Its name and declaration are not in this repo, so it is not declared here.

### Battery and charging

- State of charge in percent: signal `CDS.statusBattery2.conditionBatteryChargingCondition` (0 to 100, 151
  means no value). This is the same value Live shows. The app flags below 50 %.
- Voltage, current, charging state, battery age: **nothing in the kit reads them.** The laptop tool reads a
  voltage from identifier F442 on the gateway / gearbox unit; that read would pass the read-only link, but
  its unit address and scaling are not in this repo.

### Tyres

Signals, not diagnostics: `TPMS.statusTyrePressure`, `statusTyreTemperature`, `statusTargetTyrePressure`,
re-read every 10 s (BMW's own apps read TPMS rather than subscribe), values older than 60 s are dropped. They
arrive in the car's display units, so `Vehicle.statusNewCurrentUnitsStatusExt` is read as well. `tyres.js` is
copied from Warm-Up HUD. The app flags a tyre 0.2 bar (3 psi) or more under the car's own target.

### app.json declarations: must be verified with tools/manifest-check.sh on the laptop

A signal declared with a getter the car lacks stops the install. Copied character for character:

- From `apps/woodr_live/app.json` (known good on the car): `CDS` (`statusEngineTemperature`,
  `statusEngineSpeed2`, `statusBattery2`), `Vehicle2.statusCarSpeed2`, `VehicleInformation`
  (`statusGearboxDrive`, `DataPowerTrain2`, optional).
- From `apps/woodr_warmhud/app.json` (version 0.6.8 is installed on the car with these): the diagnostic
  transport `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu` (instance, `sendTasuRequest`,
  `sendTasuResponse`), `TPMS` (three fields, `rs`) and `Vehicle.statusNewCurrentUnitsStatusExt` (`rs`). All
  three are marked `_optional`.

**Run `tools/manifest-check.sh woodr_diag` on the laptop before the first install.** If the TPMS or Vehicle
block is a problem, delete those two blocks: the tyre tiles then show "No value" and nothing else changes.

## Writes: out of scope, do not call

Nobody should call these from a read-only app, by accident or otherwise:

- `new Diag(...)` from `kit/runtime/diag.js`, and its `send()`, `physical()` and `functional()`: unrestricted.
  They can send 14 (clear faults), 2E (write / code), 2F (actuate), 31 (routines, adaptation resets), 11
  (reset a unit), 27, 28, 34 to 37 (flash). `woodr_diag` imports only `statusInfo` from this file.
- `replyTo()` in `diag.js`: harmless by itself, but it exists for the 2E / 2F / 31 requests of upstream's
  Live Adjustments.
- `signals.set(proxy, field, value)` in `kit/runtime/signals.js`: writes a field that has a setter. The
  kit's own example is `ConditionBasedServicesLegacy.cBSReset`, which **resets a service item**.
- `signals.call(proxy, method, params)` on anything but the read-only link's own transport: a method call
  can do anything the interface offers (`sendTasuRequest` itself is the raw diagnostic door).
- A `"w"` flag on any field in `app.json` signals: that is what makes a setter reachable. This app has none.
- `DidReader` handed a raw `Diag` instead of a `ReadOnlyDiag`: then `monitor()`, `supported()` and `ask06()`
  go out unchecked. Reads, but outside the read-only path.

## Unknowns that need the car

1. Does `discover()` list every unit on a G80, and how long does it take? Are the names in `ecus.ECU` right
   for this car (the table comes from a G20 and F-series cars)?
2. Does the cluster answer `22 1001`, and what do the 12 bytes of a record mean (distance, date, state)?
3. Do reads work with the ignition on and the engine off? With the engine running? While driving? The code
   does not say. Until known: read parked.
4. Does a scan disturb anything visible (a warning, a flicker, a logged entry)? It should not, it is a read.
5. Once the kit allows it: does `19 02` to all units answer as upstream's scanner expects, and which status
   mask gives a list that matches a dealer tool?
6. Battery voltage: which unit and identifier, and what scaling.
7. Whether the TPMS and unit declarations pass the manifest check for a fresh app id (they do for Warm-Up
   HUD).
8. Where fault texts for this car's unit types would come from, and whether we may ship them at all.

## Staged plan

**Stage 1, read-only (this app).** What is described above. Next steps inside stage 1, in order: verify the
manifest and install; check units and service records on the car; get the go-ahead for the fault-memory read
in the read-only link and wire it in; decode the service records; add a local fault text database that stays
out of git; add battery voltage once its identifier is known.

**Stage 2, low-risk actions with warnings. NOT to be built now.** Things like clearing stored faults or
resetting a service item, each behind a plain warning and a second press, each one allow-listed by exact
request in the kit the way reads are today, parked and engine off only. Needs its own design, a per-action
go-ahead, and a way to show exactly what will be sent before it is sent.

**Stage 3, coding. NOT to be built now.** Changing how a control unit is configured can leave a car with
warnings, without a function, or not starting, and it differs per model and software version. It needs
testers on several cars, a backup of every unit's coding before any change with a proven way to restore it,
and a legal review (warranty, liability, road rules, BMW's data) before a line is written.


## Update, 2026-11-11: fault codes

Diagnostics 0.2.0 reads fault codes. The kit's read-only link is unchanged. The app has its own small
module, `apps/woodr_diag/dtc.js`, which holds the plain diagnostic link privately and can send exactly one
request with it: `19 02 0C` (report stored faults that are pending or confirmed) to one control unit at a time.
That request only reads. Nothing in the app can send a clear (service 14) or any other request through it.
Codes show as numbers: there are no fault texts on the head unit. Not yet run on the car: whether every unit
answers `19 02 0C`, how long a full pass takes, and whether a second diagnostic link in one app is accepted.
