# Link service: Tailscale on the car, locked down

The system half of the Link app (`apps/woodr_link`). Written for this repository from Tailscale's own
published interfaces. It contains no code from any other car app, and no Tailscale binary.

Status: **not yet run on a car.** The helper has been run against a real Tailscale daemon (1.104.6, Linux) and
the app against a stand-in for the helper. See "Checks to make on the car" before installing.

## What is here

| File | What it is |
|---|---|
| `fetch-tailscale.sh` | Downloads the pinned Tailscale release from `pkgs.tailscale.com`, checks its SHA-256 against `tailscale.pin`, installs it to `/var/opt/woodr-link/bin`. A mismatch installs nothing. |
| `tailscale.pin` | The version, architecture and checksum that are allowed. |
| `woodr-link.service` | Runs Tailscale's daemon in userspace-networking mode, with no proxy. |
| `helper.js`, `woodr-link-helper.service` | The only thing apps can talk to. Four requests: status, connect, disconnect, logout. |
| `component.json` | The Store's description of all of the above. |

Tailscale itself is BSD-3-Clause and comes from Tailscale's own server at install time.

## The car policy

The helper checks the daemon's settings every few seconds and puts them back if they differ:

- **Shields up.** Nothing on the tailnet can open a connection to the head unit.
- **No exit node.** The car's traffic never goes through another machine, and the car never offers to be one.
- **No routes.** None advertised, none accepted.
- **No Tailscale DNS.** The head unit's name lookups stay as BMW set them.
- **No Tailscale SSH.**

On top of that, userspace mode with no proxy means the head unit's own routes, firewall and DNS are never
changed, and no program on the head unit can reach the tailnet through the daemon. A connected car is present
on your tailnet and can do nothing there until a later feature opens something on purpose.

No app can change this policy: the helper has no request for it.

## What you should do on the Tailscale side

The car's login is a credential for your tailnet, kept in `/var/opt/woodr-link/state` (root only). Treat the car
as a device that could be stolen:

1. In the Tailscale admin console, give the car a tag (for example `tag:car`).
2. In your access rules, allow that tag to reach nothing, or only the one thing you want it to reach.
3. Turn on device approval, so a new login has to be approved by you.
4. If the car is sold or stolen, remove the device in the admin console. That ends its access at once.

## Checks to make on the car (read-only first)

- `uname -m` is `x86_64`, and `sha256sum`, `tar`, `curl` or `wget`, and `node` exist for root.
- The head unit can reach `pkgs.tailscale.com` and `controlplane.tailscale.com` over its phone or Wi-Fi uplink.
- `/var/opt` is writable and survives a restart.
- The Store accepts a `kind: tool` component from this repository, and in which order it runs `postInstall`
  and starts the units (the daemon unit skips itself until the binary is in place).
- Memory and CPU of `tailscaled` at idle on the head unit.
- An app can open `/run/woodr-link/link.sock` (group `tm_oap_app`, as with the renderer's socket).

## Undo

Stop and disable both units, delete `/var/opt/woodr-link`, and remove the device in the Tailscale admin console.

## Testing on a PC

```
node tools/test_link_helper.js                      # the policy functions
node tools/mock_link.js //./pipe/link on            # a stand-in helper: off | login | on | down
WOODR_LINK_SOCK=//./pipe/link node kit/tools/preview.js dist/woodr_link out wait=2 render
```
