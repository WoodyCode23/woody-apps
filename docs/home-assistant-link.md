# Home Assistant link: how it connects, and the optional lock

This page is for people who run Home Assistant and want to know how the car app (`apps/woodr_hass`) reaches
the house, and how the lock works. None of this applies to the other apps.

Tested on one car: a 2022 M3 Competition (G80) with iDrive 7.

## The pieces

| Piece | Where it runs | What it does |
|---|---|---|
| The car app | The head unit | Shows tiles and camera pictures. Holds one pairing token, nothing else. |
| The go-between ("Car Relay") | Home Assistant, as a custom component | Decides which entities the car may see and which actions it may ask for. |
| Home Assistant | Your house | Does the actual work. |

The car never holds a Home Assistant token or password. It only knows the address of the go-between and its own
pairing token, and the go-between only exposes the tiles you list in its configuration.

## Setting it up

1. Install [Car Relay](https://github.com/WoodyCode23/car-relay) in Home Assistant (HACS custom repository, or by hand)
   and add its configuration. Its README has the details.
2. Install the Home Assistant app on the car from this repository.
3. Tell the car where your house is. With your phone connected by wireless CarPlay, the app shows a QR code: scan
   it and paste your Home Assistant address into the page that opens. Otherwise type it on the app's on-screen
   keyboard. (Why CarPlay: a phone can only reach the car over the car's own Wi-Fi, the one wireless CarPlay
   uses. On a home Wi-Fi or the phone's hotspot the head unit lets apps connect out and nothing connect in, so
   no page is offered there. Tested on one car with an iPhone, 2026-11-17; wired CarPlay and Android Auto are
   untried. Pairing and unlocking by QR do not depend on this: there the phone talks to Home Assistant.)

## Pairing

1. The car app shows a QR code.
2. You scan it with your phone and approve it, signed in to your own Home Assistant.
3. The car receives a token that works only against the go-between.

Un-pairing is done from Home Assistant and takes effect at once.

## What the car can ask for

You decide this in the go-between's configuration, tile by tile. The car's screens are another dashboard for
your house: what is on them and what they may do is yours to set.

- **Built-in kinds:** cover (open, close, stop), lock (lock; unlock only if you allow it, below), light, switch,
  fan and input_boolean (on, off), button and input_button (press), scene, script, sensor, camera.
- **Your own actions:** any tile can carry actions of its own: a name, any Home Assistant service and its data.
  The car shows the first one as the tile's button.
- **Unlocking and disarming** are off unless you set `allow_unlock: true`. With it, a lock tile offers Unlock,
  and your own actions may release a lock or disarm an alarm. Think about who sits in your car before you turn
  it on: the lock screen (below) is then what stands between the car and your front door.
- Doors, locks and your own actions take two presses on the screen, unless you say `confirm: false` on an
  action of your own.

The go-between's README has the configuration for all of this.

Our own car keeps the defaults: no unlock, no position.

## The lock

The lock hides the house from whoever is sitting in the car. It lives in the go-between, not in the car, and
how convenient it is depends on how you set up Home Assistant:

- **Locked by default.** A paired car shows a lock screen until an approved phone says it is there.
- **Scan to show the tiles.** Scanning the QR code on the lock screen with an approved phone opens the tiles. This
  always works and needs no extra setup.
- **Automatic (optional).** Two phone automations (on iPhone: Shortcuts that run when CarPlay connects
  and disconnects) tell the go-between when your phone joins and leaves the car. With those in place the tiles
  appear when you get in and hide when you leave, with no scanning.
- **The Lock button.** Pressing Lock in the car hides the house until the next QR scan, whether or not the
  phone is present.

Only Home Assistant users you list as allowed can show the tiles. A Home Assistant automation cannot do it, because
the go-between checks which user the request came from.

## Camera pictures

Pictures and live views show on the instrument cluster, the head-up display or both. They are shown only while
the car is parked.

## Status

The car app is in this repository; Car Relay is at https://github.com/WoodyCode23/car-relay. Both are in use on one
car (a 2022 G80 M3). The phone set-up and the car's readings as sensors are new and have not been checked on that
car yet.
