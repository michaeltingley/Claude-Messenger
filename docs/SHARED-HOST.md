# Shared host: Claude Messenger + the personal automation agent

_Decided 2026-10-09. The user wants one server, not two. This doc is the
contract between the two things that share it._

The always-on host runs two independent stacks:

1. **Claude Messenger** (this repo): Beeper Desktop headless under Xvfb, and
   the policy-guarded MCP service. Unchanged in purpose.
2. **The automation agent** (`michaeltingley/ai-tools`, `automation-host/`):
   - Claude Code with Remote Control, so the user drives it from phone or
     laptop.
   - A headful Chrome with the user's sign-ins, on its own virtual display.
   - An on-demand screen view for the few steps only a human can do.

   Why it's built this way, and which human-in-the-loop gates it clears by
   itself, is in `automation-host/GATES.md` there.

They share a box because they need the same things: an always-on Linux host,
Xvfb, Tailscale, and a tailnet-only noVNC surface.

## Sizing: VPS-2, not VPS-1

| Process | Typical RAM |
|---|---|
| Beeper Desktop + Xvfb | 0.5–0.8 GB (estimate, not measured; ~10 accounts may push it to 1–2 GB) |
| Chrome with a few tabs | 1–2 GB |
| Claude Code, per active session | ~0.5 GB |
| Claude Messenger MCP service | ≤0.5 GB (capped by its unit) |
| OS | ~0.5 GB |

With two Claude sessions that is ~4–5 GB, or ~5–6 GB if Beeper lands at the high end, so VPS-1 (4 GB) would swap. Order
**OVHcloud US VPS-2** instead: 4 vCPU / 8 GB / 75 GB NVMe, Vint Hill VA,
**$10.00/mo** month to month, or $8.50 on a 12-month term (`HOSTING-OPTIONS.md`).
It is also the upgrade path the context engine was going to need.

## Isolation contract

The agent is exactly the "confused or overreaching agent" that the policy layer
exists for (`CLAUDE.md`, Safety posture). On a shared box, any path the agent
has to the raw Beeper token, or to the signed-in Beeper UI, bypasses
`GuardedMessenger` entirely. Architecture rule 2 then holds in name only. So:

1. **Separate Unix users.**
   - The Claude Messenger stack stays under the deploy user.
   - The agent gets its own user. It is not in the deploy user's group, and the
     deploy user's home is not group- or world-readable. `.env` and Beeper's
     data directory are therefore unreadable to it.
2. **No general sudo for the agent.**
   - Root reads everything, so a sudo-capable agent defeats rule 1.
   - Scoped sudoers entries are added only alongside their first real
     consumer.
3. **X displays require authorization.**
   - Verified 2026-10-09: an Xvfb started without `-auth` (as `xvfb.service`
     does today) accepted an X connection from a different local user
     (`nobody`).
   - On a shared host, the agent could therefore screenshot and drive the
     signed-in Beeper on `:99`.
   - Each display must take an `-auth` cookie readable only by its owner.
   - The same goes for the VNC hops behind the sign-in surface. x11vnc runs
     `-nopw` on `127.0.0.1:5900` and websockify on `127.0.0.1:6080`, both
     reachable by any local user while the surface is up.
   - **Done in `deploy/`:**
     - `xvfb.service` mints a fresh cookie into `%t/claude-messenger/xauth`
       (owner-only) on every start and runs Xvfb with `-auth`.
     - x11vnc demands a password from `-passwdfile`, which
       `signin-surface.sh` mints on every `up` and deletes on `down`. With no
       file, x11vnc won't start.
     - `test/display-isolation.integration.test.ts` proves both against the
       real binaries.
     - Unix sockets weren't an option for the noVNC hop: `tailscale serve`
       proxies only to `http://127.0.0.1`.
4. **The agent reaches messages only through the MCP endpoint**, with a
   bearer token, so policy and audit apply. Beeper's own API on
   `127.0.0.1:23373` is reachable from loopback, but useless without the
   Beeper token (rule 1).
5. **Chrome's control channel is not an open port.**
   - A CDP port on loopback hands every local user all of the user's browser
     sessions.
   - Use pipe transport, or a socket only the agent user can open.
6. **Two sign-in surfaces, both down by default, both tailnet-only.**
   - Beeper's: the existing one, `:8443`, opened and closed only by
     `deploy/signin-surface.sh`.
   - The agent's: new, for CAPTCHAs, passkeys and one-time sign-ins, on its
     own display and port.
   - The agent may open its own surface, never Beeper's.
7. **Claude Messenger code reaches the host through git.** The agent does not
   edit the running install. Changes go through reviewed PRs like any other.

| | Claude Messenger | Agent |
|---|---|---|
| Unix user | deploy user | `agent` |
| X display | `:99` | `:100` |
| VNC / noVNC (loopback, authenticated) | 5900 / 6080 | 5901 / 6081 |
| Tailnet surface (down by default) | 8443 | 8444 |
| Service | MCP on `127.0.0.1:$MCP_PORT`, tailnet via `tailscale serve` | Claude Code Remote Control (outbound only) |

**Residual risk is concentration.** One box holds Beeper's history and E2EE
keys, the user's browser sessions, and their Claude login. That is why the
provider-trust bar in `HOSTING-OPTIONS.md` (an incumbent, not a budget host)
and off-box backups of the Beeper keys matter more now, not less.

## Effect on other plans

- **Session channel** (`SESSION-CHANNEL.md`). Its job was letting the cloud
  orchestrator coordinate with the workhorse session on the user's Mac. With
  the agent on the host and reachable through Remote Control, the host *is*
  the workhorse. Re-evaluate whether the Phase 1 relay is still needed before
  building it.
- **iMessage** still needs a Mac. Unchanged.

## Provisioning sequence

1. **Claude:** land the isolation prerequisites in `deploy/` (rule 3), with
   tests. **Done.**
2. **User:**
   - Order OVHcloud US VPS-2: Vint Hill, Ubuntu 24.04, monthly.
   - Install the Tailscale app on their phone.
3. **Claude Messenger bootstrap**, as in `STATUS.md`. The user clicks the
   Tailscale link and types Beeper's emailed code and recovery key into the
   surface.
4. **Agent layer**, via a separate installer in `ai-tools/automation-host`:
   - the agent user, `:100` + Chrome, and the browser tool;
   - Claude Code + Remote Control as a service (the user approves the Claude
     login link once);
   - the agent's surface and its standing-permissions file.
5. **User:** signs in once, through the agent's surface, to Google, Hims and
   the other sites the agent should use.
6. **Server-day test:** the checklist in `automation-host/GATES.md`.
