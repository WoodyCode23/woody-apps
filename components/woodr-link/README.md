# Link service: Tailscale on the car, locked down

The system half of the Link app (`apps/woodr_link`). Written for this repository from Tailscale's own
published interfaces. It contains no code from any other car app; the Tailscale daemon it ships is Tailscale's own release, unchanged.

Status: **not yet run on a car.** The helper has been run against a real Tailscale daemon (1.104.6, Linux) and
the app against a stand-in for the helper. See "Checks to make on the car" before installing.

## What is here

| File | What it is |
|---|---|
| `bin/tailscaled`, `bin/LICENSE-tailscale` | Tailscale's own daemon as Tailscale publishes it (1.104.7, linux amd64, BSD-3-Clause), unchanged. |
| `update-tailscale.sh`, `tailscale.pin` | Run on a computer to replace `bin/tailscaled`: downloads the pinned release from `pkgs.tailscale.com` and puts it in place only if it matches both the pin and Tailscale's published checksum. |
| `woodr-link.service` | Runs the daemon in userspace-networking mode, as its own user (uid 3921), with no proxy. |
| `helper.js`, `woodr-link-helper.service` | The only thing apps can talk to: status, connect, disconnect, log out, SSH on, SSH off. |
| `component.json` | The Store's description of all of the above (listed in `mgu-repo.json` as the tool "Woody Link service"). |

Why the daemon is in the repository (0.1.0 downloaded it at install): the head unit cannot fetch it. mgu-uplink
gives the internet only to the uids a component lists, never to root, and the head unit's own resolver does not
reach the internet. The daemon runs as uid 3921, which `component.json` lists for the uplink; Tailscale finds its
servers without the head unit's resolver.

## The car policy

The helper checks the daemon's settings every few seconds and puts them back if they differ:

- **Shields up**, unless SSH is on and allowed (below).
- **No exit node.** The car's traffic never goes through another machine, and the car never offers to be one.
- **No routes.** None advertised, none accepted.
- **No Tailscale DNS.** The head unit's name lookups stay as BMW set them.
- **No Tailscale SSH.** SSH, when on, is the head unit's own sshd with its own keys.

Userspace mode with no proxy means the head unit's own routes, firewall and DNS are never changed, and no program
on the head unit can reach the tailnet through the daemon. The daemon's control socket is in a folder only its own
user and root can open (checked: another user is refused), so apps reach Tailscale only through the helper.

## SSH from your own devices

Off until you turn it on in the Link app (two presses). Then the helper lowers the shields only while **every**
opening your tailnet's access rules make toward the car is port 22, and nothing else. A connection from your tailnet
to the car's Tailscale address goes to the same port on the head unit's 127.0.0.1, so the head unit's own sshd
answers, with the keys it already has: nothing about who may log in to the head unit changes.

Why the rule check: with the shields down, Tailscale would hand over every port on the head unit's 127.0.0.1 that
your rules allow, and Tailscale's default rules allow everything. So a tailnet that was never set up keeps SSH shut,
and the app says why ("the access rules open every port to *"). Rules that cannot be read count as too wide. If the
rules widen later, the next check (every 2 s while SSH is on) puts the shields back up.

## What you should do on the Tailscale side

The car's login is a credential for your tailnet, kept in `/var/opt/woodr-link/state` (the daemon's user only).
Treat the car as a device that could be stolen:

1. Turn on device approval, so a new login has to be approved by you.
2. Give the car a tag (for example `tag:car`), and turn off key expiry for it if you do not want to log in again
   every few months.
3. In your access rules, let your own devices reach the car on port 22 and nothing else, and let the car reach
   nothing. For example (replace the address with your own login):

   ```json
   "tagOwners": { "tag:car": ["you@example.com"] },
   "grants": [
     { "src": ["you@example.com"], "dst": ["tag:car"], "ip": ["tcp:22"] }
   ]
   ```

   Keep whatever other rules your tailnet needs, but no rule may open any other port toward `tag:car`, or SSH stays
   shut. The default "allow everything" rule counts as one.
4. If the car is sold or stolen, remove the device in the admin console. That ends its access at once.

## Checks to make on the car (read-only first)

- uid 3921 is not taken (`getent passwd 3921` and `ps -o uid= -e | grep -x 3921` say nothing).
- The Store accepts the tool from this repository, writes `/var/opt/mgu-uplink/uids.d/woodr-link` with 3921, and
  starts the units at the next head-unit start.
- The daemon reaches Tailscale over the phone or Wi-Fi uplink (the app shows a login code).
- The head unit's sshd answers on 127.0.0.1 port 22 (`ssh root@127.0.0.1` from the head unit itself).
- Memory and CPU of `tailscaled` at idle on the head unit (the unit caps it at 160 MB).
- An app can open `/run/woodr-link/link.sock` (group `tm_oap_app`).

Checked on a computer (2026-11-28, Tailscale 1.104.7 in a throwaway container): the daemon runs as uid 3921 with the
unit's flags; its socket folder refuses another user; the helper holds the policy; connect gives a login link; SSH
asked for before the car is connected stays shut ("Tailscale is not connected") with the shields up; SSH off removes
the setting; log out works. Not yet run on a car, and the SSH rule check has been tested against example rules, not a
live tailnet.

## Undo

Remove "Woody Link service" in the Store (or stop and disable both units and delete `/var/opt/woodr-link`), and
remove the device in the Tailscale admin console.

## Testing on a PC

```
node tools/test_link_helper.js                      # the policy functions
node tools/mock_link.js //./pipe/link on            # a stand-in helper: off | login | on | down
WOODR_LINK_SOCK=//./pipe/link node kit/tools/preview.js dist/woodr_link out wait=2 render
```
