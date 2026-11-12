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

## Pairing

1. The car app shows a QR code.
2. You scan it with your phone and approve it, signed in to your own Home Assistant.
3. The car receives a token that works only against the go-between.

Un-pairing is done from Home Assistant and takes effect at once.

## What the car can ask for

You decide this in the go-between's configuration, tile by tile. Each tile has a kind:

- **Cover** (a garage door): the car can ask to close it.
- **Lock**: the car can ask to lock it.
- **Camera**: the car can ask for a picture, or a short live view.
- **Sensor**: read only.

By design the go-between has no action that opens a door or releases a lock, so a car in someone else's hands cannot let anyone
into the house. Closing and locking take two presses on the screen.

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

The car app is in this repository. The go-between component is not published yet.
