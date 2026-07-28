# Hosting Claude Messenger: options analysis (July 2026)

Research summary for running the always-on host (headless Beeper Server +
Claude Messenger, see `DEPLOY.md`). Four research passes: free cloud VMs,
container PaaS, owned hardware, and Beeper Server's actual requirements.

## What the workload needs (verified)

- **~4 GB RAM** (revised upward 2026-07-28). The earlier ~2 GB figure assumed
  beeper-server's ~240 MB idle; that path is abandoned as unsafe, and Beeper
  Desktop under Xvfb idles ~0.5–0.8 GB instead. This invalidates the 1 GB
  options below — GCP e2-micro and Oracle's E2.1.Micro no longer qualify.
- **arm64 and x86_64 both fine** — arm64 server artifacts are published
- **Outbound-only networking** — no inbound ports, works behind any NAT;
  residential internet is fine
- **Persistent disk is non-negotiable** — the data dir holds Matrix E2EE
  device keys; losing it means re-verifying the device
- ⚠ **Beeper Server is not used at all** — see `DEPLOY.md`.
  [beeper/cli#21](https://github.com/beeper/cli/issues/21) is open and
  unanswered: it deleted a legacy account's bridge connections across every
  device, and its chats API returned empty. The host runs **Beeper Desktop
  headless under Xvfb** instead, which changes the RAM figure below.
- **iMessage bridging requires macOS on-device** — no Linux host of any
  kind provides it ([Beeper help](https://help.beeper.com/en_US/chat-networks/new-imessage-on-macos-getting-started-guide))

## Ranked options

### 1. Spare laptop you already own — best $0 path

$0 upfront, **$6–30/yr in power** (3.5–10 W idle at 2026's ~18¢/kWh).
Built-in battery = free UPS through power blips; outbound-only means ISP
blips just delay sync. Setup is ~15 min: `HandleLidSwitch=ignore` in
`/etc/systemd/logind.conf`, then run `deploy/bootstrap.sh`. Checks: battery
not swollen, post-2015 hardware preferred, don't smother it. Community
consensus: for outbound-only personal services, home + Tailscale ≈ VPS
reliability at a fraction of the cost, with far more RAM.

### 2. Oracle Cloud Always Free — best $0 cloud

**2 ARM OCPU + 12 GB RAM + 200 GB disk at $0** (silently halved from 4/24
in June 2026 — [InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)).
Still 6× our need. Conditions for taking it seriously:

- **Convert to Pay-As-You-Go immediately** (still $0 within limits) —
  exempts the account from the documented idle-reclamation rule
  (95th-pct CPU/net/mem < 20% over 7 days → reclaim) and the chronic ARM
  capacity lottery
- **Automated off-box backups always** — Oracle has documented
  idle-account termination and a track record of abrupt free-account
  purges ([HN](https://news.ycombinator.com/item?id=42901897),
  [Oracle forums](https://community.oracle.com/customerconnect/discussion/875400/free-tier-instance-terminated-without-warning-need-urgent-help-recovering-data))
- Signup needs a real credit card (virtual cards have gotten accounts
  banned); home region choice is permanent — pick one with A1 capacity

### 3. Hetzner CAX11 — best paid, the escape hatch

**~€3.79/mo** for 2 vCPU ARM / 4 GB / 40 GB NVMe
([Hetzner](https://www.hetzner.com/cloud/cost-optimized)). No reclamation
policies, no capacity games, boring reliability. The better *engineering*
choice if ~€45/yr is acceptable; also the fallback if Oracle misbehaves —
the same `bootstrap.sh` runs unchanged on either.

### 4. Used 1-liter tiny PC (~$80–110) — best hardware to buy

ThinkCentre M720q-class: 8–16 GB RAM, enterprise longevity, x86, 10–20 W
($16–32/yr). Beats Raspberry Pi 5 on price/perf in 2026 (DRAM spike pushed
complete Pi 5 kits to $130–150; SD cards are the #1 Pi failure mode — an
NVMe HAT is mandatory for 24/7, erasing the price gap).

### 5. GCP e2-micro — trustworthy but cramped

The most reliable always-free tier in existence (no reclamation history),
but **1 GB RAM** makes it a fallback: zram/swap required, unpleasant ops.

### 6. Mac mini (used M1, ~$300–390) — only if iMessage matters

The mandatory piece for iMessage bridging (macOS on-device requirement).
Run Beeper Desktop + Remote Access behind Tailscale; 6.8 W idle makes it an
excellent general host too. Not otherwise cost-justified.

### Disqualified: container PaaS

**A genuinely free, always-on, persistent-volume container host does not
exist in 2026.** Fly.io's free tier is gone (~$7/mo minimum viable);
Railway free is trial-credits; Render free sleeps; Koyeb free is
512 MB-class; Northflank free requires a card and is ~512 MB. And
beeper-server (proprietary, auto-updating, systemd-assuming, no official
image) is the worst-case containerization target — fragility budget on
every upstream update. Dominated by every option above.

## Recommendation

- **Own a spare laptop?** Use it. $0, better specs than any free cloud,
  15-minute setup.
- **Want it off your hardware?** Oracle Always Free (PAYG-converted,
  backed up, sized 1 OCPU / 3–4 GB) as the free primary; Hetzner CAX11 as
  the ~€4/mo escape hatch. Same bootstrap either way.
- **Either way**: treat the nightly-channel caveat as real until
  beeper-cli ships the stable-channel flip; keep the Beeper Desktop +
  Remote Access fallback in mind.

Full source list: research transcripts, 2026-07-10 (EIA power rates,
Oracle/GCP/AWS/Azure docs, Hetzner pricing, InfoQ/HN/Reddit reliability
reports, Beeper CLI source + live endpoint probes).
