# Wheel gate: the steering wheel's menu button and roller, kept from the car's own interface

A build of the kit's controller gate (`mgu-inputgate.so`, MIT, from `woody-apps/kit/renderd/inputgate/`) with one
addition. The controller gate is unchanged. The addition lets an app's menu on the head-up display use the wheel's
menu button and right roller without the car opening its own list, scrolling it or picking in it.

**Status: in use on one car (a 2022 G80 M3, iDrive 7). It runs inside the car's interface program (HmiMain3D),
so it is not something the Store installs: putting it on a car needs a root shell and the steps below, with the
car parked.** Without it HUD still works; the car's own list then opens alongside HUD's menu.

## What it does

The library is preloaded into HmiMain3D and sees every notification on its way to the interface. For the
SteeringWheelPushButton service (0xb505), three one-byte events can be rewritten for the interface only:

| Event | Meaning | While its gate file is fresh, the interface sees |
|---|---|---|
| 0x8005 | menu button (three lines) | 0, never pressed |
| 0x8007 | roller steps (rests at 127) | 127, at rest |
| 0x8008 | roller press | 0, not pressed |

- `/dev/shm/woody/wheelgate.menu` fresh: the menu button is hidden.
- `/dev/shm/woody/wheelgate.roll` fresh: the roller and its press are hidden.

**Who may close the gate.** `/dev/shm/woody` is a folder every app on the unit can write to, so a gate file counts
only when all of this holds:

- its owner's user id is listed in `/var/opt/woody/wheelgate.conf` (one number per line, `#` comments);
- that list is a regular file owned by root that nobody else can write (checked on the opened file);
- the gate file is a regular file that only its owner can write.

No list, a list that is not root's, a gate file from another app or one others can write: the gate stays open.
Root is never accepted as an owner. The list is read again every 5 s. So the list holds one number, HUD's user id,
written by root when HUD is installed, and it has to be written again if HUD is re-registered under a new id
(a tools update did that once): until then the gate simply stays open and the car has its buttons.

"Fresh" means a regular file touched within 0.7 s (a link, a pipe or a folder never counts). HUD 0.7.0 touches
the menu file five times a second while its setting "Keep the wheel's menu button and roller for the HUD menu"
is on, and the roller file only while its menu is open. HUD stopped, crashed or the setting off: the files go
stale and the car has its buttons back within 0.7 s. Apps read the wheel over their own connection and still
get the real values. A payload that is not exactly one byte is never changed. Phone, volume, skip and voice
buttons are never touched.

What is not known until it is on the car: whether hiding 0x8005 from HmiMain3D is enough to stop the list (the
laptop's report, 2026-11-14 section 15: the list is content 0x1000351 mapped into slot 0x202 about 0.2 s after
the press; if the instrument cluster maps it by itself, this gate cannot stop it).

## Files

| File | What |
|---|---|
| `mgu-inputgate.cpp` | the source: the kit's file plus the parts marked "wheel gate" |
| `prebuilt/mgu-inputgate.so` | built from it; sha256 `ff235729355f367493768a0cb505303ec0e86cd2b6048019c132d2fc5efaf9b6`, 19088 bytes |
| `test/` | a harness that runs the library the way the interface would |

## Build and test (Ubuntu 18.04, the unit's glibc)

```sh
docker run --rm -v "$PWD":/src ubuntu:18.04 bash -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends g++ libc6-dev && cd /src &&
  I=-I<woody-apps>/kit/renderd/inputgate/vsomeip-include/interface/compat &&
  g++ -std=c++14 -O2 -g0 -Wall -shared -fPIC $I -o mgu-inputgate.so mgu-inputgate.cpp -ldl &&
  g++ -std=c++14 -O1 -shared -fPIC $I -o libreal.so test/real.cpp &&
  g++ -std=c++14 -O1 $I -o gate_test test/test.cpp -L. -lreal &&
  LD_PRELOAD=./mgu-inputgate.so LD_LIBRARY_PATH=. ./gate_test'
```

Checked on 2026-11-14 with g++ 7.5.0:
- The kit's unchanged source built with the same command gives sha256 `64efa96f...83efc4`, byte for byte the
  file that is on the car now. So the toolchain is the right one.
- The new library needs the same libraries as the one on the car plus `libgcc_s.so.1` (every C++ program on the
  unit already loads it; confirm it is in HmiMain3D's maps before installing), and no newer glibc symbols.
- `gate_test` (run as root: it sets file owners): 22 checks pass, six of them on who may close the gate. Run
  against the original library, the four wheel checks fail, as they should.
- An earlier build of 2026-11-14 (sha256 `7a032c0c...`) had no owner check: any app could have closed the gate.
  It was never installed and must not be.

## Putting it on a car (by hand, as root, parked)

The gate on the car is `/var/opt/mgu-inputgate/current/mgu-inputgate.so` (1.1.0), loaded by a drop-in for the
interface's service, with a boot guard that leaves the gate out after two starts in a row where the interface
did not stay up for a minute.

1. Check `sha256sum` of the file here against the value above, and of the one on the car against `64efa96f...`.
2. Keep the car's current file (its version folder stays as it is). Put this one in a new version folder beside
   it and point `current` at it, the way the installer does. Do not restart the interface or any unit by hand.
3. It loads at the next head-unit start. Confirm the library in HmiMain3D's maps has the new sha256.
4. Install HUD 0.7.0. As root, write its user id into the list:
   `id -u <HUD's user> > /var/opt/woody/wheelgate.conf; chown root:root /var/opt/woody/wheelgate.conf; chmod 644 /var/opt/woody/wheelgate.conf`
   (the folder must be root's too). Then switch on HUD's setting "Keep the wheel's menu button and roller for
   the HUD menu", and check `/dev/shm/woody/wheelgate.menu` is owned by that user with mode 644.
5. Test, parked: menu button with the setting on (does the car's list stay away), roller and its press with our
   menu open (does anything in the car react), the phone / volume / skip / voice buttons (must work as before),
   the setting off (the car's list is back within a second), "Car's audio list" in Quick actions (one press
   through to the car). And the owner check: with the list removed, or with a gate file made by root or another
   user, the car must react to the button as if there were no gate.
6. Back out: point `current` at the 1.1.0 folder again; it is gone at the next head-unit start. The Hub
   updating the gate tool would also replace it with the stock build.
