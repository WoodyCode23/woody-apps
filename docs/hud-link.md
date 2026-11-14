# Every app's switches in the head-up display's menu

An app built with this kit needs to do nothing. Each `bool` and `choice` setting in its `app.json` is offered to
the HUD's wheel menu under the app's name, with its current value, and one press of the wheel changes it.

## What an app can say in app.json

| Where | Key | Effect |
|---|---|---|
| a setting | `"hud": false` | this setting stays on the centre screen only |
| a setting | `"hudLabel": "Rev bar"` | a shorter name for the display (about 16 characters reads well) |
| top level | `"hud": false` | the whole app stays out of the menu (lab and developer apps) |

A setting that is `hidden`, or whose `when` does not hold, is not offered, the same as on the centre screen.
`number` settings are not offered yet.

## Keep off the display

- Safety gates: any "Allow ..." switch that arms writes or commands.
- One-shot buttons made from a switch ("Test the doorbell now", "Read the file again").
- Technical and developer switches a driver should not flip at a glance.
- The switch that turns the HUD menu itself off.

## What does not travel this way

Actions. Opening a door, showing a camera, saving a clip: these are not settings. The link is a folder any app on
the unit can write to, so it carries settings changes only, and each app checks every request against what it
offers before applying it. Actions in the HUD menu are wired by the HUD app to the one app that owns them.

## How it works

`kit/runtime/hudlink.js`, started by `kit/runtime/mgu.js` for every app.

- The app writes `/dev/shm/woody/hud/<app id>.json`: its title, version and offered settings with their values.
  Again on every change (also one made on the centre screen) and every 10 s, so the menu knows it is running.
- The HUD menu writes `/dev/shm/woody/hud/<app id>.req.json`: `{ n, key, value, at }`.
- The app applies it if the key is one it offers, the value is valid for it and the request is under 5 s old,
  then publishes again. The menu shows the app's published value, never its own guess.
- An app not heard from for 35 s drops out of the menu. The folder is in memory, so it starts empty after a
  head-unit start and fills as apps start.

Test: `npx -y node@8.16.2 kit/tools/test_hudlink.js`
