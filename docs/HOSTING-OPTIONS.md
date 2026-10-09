# Hosting Claude Messenger: options analysis (October 2026)

Verified research pass, **2026-10-08**: eight parallel research lanes, primary
sources first, with the decisive figures re-checked first-hand against the
providers' own public price APIs. It **supersedes the July 2026 analysis**.
Both of that version's headline answers stopped holding: Oracle Always Free
was capacity-walled in our home region, and Hetzner's prices moved several-fold.
Prices in this market now move within months. Before buying, re-verify with
the public endpoints listed under [Re-verifying](#re-verifying).

## What the workload needs

- **8 GB for the shared host; ≥4 GB for Claude Messenger alone.**
  - The host also runs the automation agent (Chrome plus Claude sessions;
    `SHARED-HOST.md`), which brings it to ~4–5 GB.
  - Beeper Desktop's own footprint is **not measured yet**. ~0.5–0.8 GB is a
    generic Electron estimate; with ~10 accounts, 1–2 GB is plausible.
  - 2 GB plans are out.
  - Measure after Beeper's first sync, and add swap so a spike degrades
    instead of getting OOM-killed.
- **A public IPv4 address.** `api.beeper.com` and `github.com` publish no AAAA
  records (checked 2026-10-08), so IPv6-only plans cannot reach them.
- **A persistent disk, backed up off-box.** It holds the Matrix E2EE device
  keys; losing them means re-verifying the device.
- **A provider you trust with plaintext.** Beeper Desktop keeps message
  history on that disk, along with the E2EE keys that decrypt it. The
  provider's own security, including its control panel, is part of the
  threat model, not just its price.
- **Outbound-only networking.** Inbound access rides Tailscale.
- **arm64 or x86_64.** Beeper ships official AppImages for both.
- **Never Beeper Server.** [beeper/cli#21](https://github.com/beeper/cli/issues/21)
  deleted a legacy account's bridge connections across every device. See
  `DEPLOY.md`.
- **iMessage needs a Mac.** Beeper's help center says "only offered for Mac",
  and chats live only on the Mac where the connection was made. No Linux host
  of any kind provides it.

## Where Beeper's backend runs (this decides the region)

Passive lookups on 2026-10-08 used dns.google, RIPE/ARIN RDAP, and AWS's
published IP ranges:

| Hostname | Resolves to | Operator / location |
|---|---|---|
| `matrix.beeper.com` | `edgeserv-lb.beeper-tools.com` → 6 IPs | Hetzner (AS24940): Falkenstein, Nuremberg, Helsinki |
| `api.beeper.com` (also auth, synapse) | `lb.aws.beeper.com` → ELB | AWS `eu-central-1` (Frankfurt) |
| per-user homeservers | `user.eu-*.edge.beeper.com` | Hetzner FSN/HEL; all 23 edge clusters in CT logs since 2023 are `eu-` |

Two first-hand checks on 2026-10-09 rule out registry artifacts and
geo-routing:

- **No geo-DNS.** Queries carrying US client subnets (EDNS client subnet
  73.162.0.0/16 and 24.4.0.0/16) got the identical EU answers. Beeper has no
  US servers to route US users to.
- **Physics.** Round-trip times were measured from Anthropic's US cloud, as
  the minimum time-to-first-byte over 7 requests:

  | Target | ms |
  |---|---|
  | Hetzner Ashburn / Hillsboro | 33 / 90 |
  | AWS us-east-1 / us-west-2 | 33 / 84 |
  | Hetzner Falkenstein / Nuremberg / Helsinki | 123 / 122 / 135 |
  | AWS eu-central-1 | 120 |
  | **`matrix.beeper.com`** | **133** |
  | **`api.beeper.com`** | **119** |

  The two Beeper endpoints are physically in Europe, not just registered
  there.

Still unknown: which homeserver cluster the user's own account is on. Every
cluster found is `eu-`-named.

**Every message the host sends or syncs crosses the Atlantic, wherever the
host is.** Round-trip times to Frankfurt are ~81 ms from Ashburn and ~133–142 ms
from Seattle or Los Angeles (secondary source: hatsnet.io, Aug 2026).

The user's own distance to the host only affects Claude's MCP tool calls. That
is ~50 ms per call, which is noise next to model latency.

→ **Prefer US East (Virginia).** EU would sit closest to Beeper, but it moves
every Claude tool call across the ocean instead. The user also ruled EU out.

Caveat: chats connected "on-device" talk to their network directly (WhatsApp,
etc.), not through Beeper's servers.

## Verified options (USD/mo, ≥4 GB, US, all-in incl. IPv4)

Tags: **[V]** read first-hand from the provider's own pages or APIs.
**[Va]** provider pages read via Wayback snapshots from 2026-10-03/07, because
the live site blocks automated fetches. **[S]** secondary source.
**[?]** unverified.

| Option | vCPU / RAM / disk | US location | $/mo | Provisioning | Verdict |
|---|---|---|---|---|---|
| **OVHcloud US VPS-1** | 2 / 4 GB / 40 GB NVMe | Vint Hill VA, Hillsboro OR (both in stock) | **5.35** monthly · 5.08 (6-mo) · **4.54** (12-mo prepaid) [V] | REST API orders (VPS routes marked beta). No user-data field: `rebuild` takes `postInstallScript` + SSH key | Too small once the host is shared |
| OVHcloud US VPS-2 | 4 / 8 GB / 75 GB NVMe | same | 10.00 · 9.50 · 8.50 [V] | same | **Pick** (shared host) |
| Contabo Cloud VPS 4 | 4 / 8 GB / 100 GB SSD | Seattle, St. Louis, NY | **8.20** in Seattle, incl. a $1.60 location fee · 7.21 (12-mo) [Va] | API + cloud-init `userData` | Fallback; reputation is poor |
| netcup VPS 500 G12.5 | 2 / 4 GB / 64 GB | Manassas VA | ~7.59 (24-mo, ~$182 upfront) · ~9.91 monthly [V calc / ?] | No API to order servers | Long lock-in, manual ordering |
| Hostinger KVM 1 | 1 / 4 GB / 50 GB NVMe | Phoenix, Boston | 6.49 (24-mo prepaid promo), **renews at 11.99** · 9.99 → 19.49 monthly [V] | API purchase/rebuild + post-install script | Promo cliff; 1 vCPU |
| IONOS VPS M+ | 2 / 4 GB / 120 GB NVMe | Kansas City area | 5 for 3 months on a 12-mo term, **then 14** [V] | No API to create a VPS | Promo cliff |
| RackNerd 4 GB KVM | 3 / 4 GB / 60 GB | San Jose, LA, Seattle | 5.00 ($59.99/yr prepaid) [V] | No API | Budget-host risk (see below) |
| HostHatch / Hostodo | 2 / 4 GB / 20 or 64 GB | LA / Las Vegas | 6 / 7 [V] | Limited | Budget-host risk |
| UpCloud Starter | 1 / 4 GB / 30 GB | San Jose | 12.00 [V] | API + cloud-init | Over budget; 1 vCPU |
| Kamatera Type A | 1 / 4 GB / 20 GB | Santa Clara, LA, Seattle | 12 [V] | API (startup script) | Over budget; 1 vCPU |
| Vultr `vc2-2c-4gb` | 2 / 4 GB / 80 GB | San Jose, LA, Seattle | 20 [V] | API + cloud-init | Over budget |
| DigitalOcean / Linode / Lightsail | 2 / 4 GB / 80 GB | SF / Fremont / Oregon | 24 [V] | API + cloud-init | Over budget |
| GCP e2-medium / EC2 t4g.medium (3-yr commit) | 2 / 4 GB | Oregon | ~15.06 / ~14.47 incl. IPv4 + disk [V] | Full | Over budget even with a 3-year lock |
| Hetzner CPX21 (US) | 3 / 4 GB / 80 GB | Ashburn, Hillsboro | **38.09** [V] | API + cloud-init | Out: two 2026 price rises |
| Hetzner CX23 / CAX11 (EU) | 2 / 4 GB / 40 GB | Germany, Finland | 7.09 / 7.59 [V] | API + cloud-init | Out: "currently unavailable" + EU |
| Used Mac mini M1 8 GB (home) | 8 / 8 GB | the user's home | ~$390 once + ~$2/mo power [V] | — | Only if iMessage matters |

### What changed since July 2026

- **Hetzner.** It raised prices for new *and existing* servers on 2026-04-01.
  It raised them again for new orders on 2026-06-15: US CPX21 went from $9.99
  to $13.99 to $37.49 [V].
  - CX and CAX (the ~€4 4 GB plans this doc used to recommend) were always
    EU-only. Every one now shows "This product is currently unavailable" [V].
  - US locations sell only CPX (shared AMD) and CCX (dedicated AMD) [V].
- **OVHcloud US.** It sells "2027"-generation VPS models (plan codes
  `vps-2027-model*`). VPS-1 is 2 vCore / 4 GB / 40 GB NVMe, unlimited
  traffic at 500 Mbps, with no setup fee [V].
- **Raspberry Pi 5 8 GB.** It rose to ~$175 for the bare board after
  RAM-driven price hikes (+$50 in April 2026) [V].

## Recommendation

1. **OVHcloud US VPS-2 in Vint Hill, VA** (revised 2026-10-09 for the shared
   host; see `SHARED-HOST.md`).
   - Start **month-to-month ($10.00)**.
   - Move to the 12-month rate ($8.50) once the host has run stably for a few
     weeks.
   - Commitments auto-renew for the same term, and an early exit owes the
     remainder.
   - VPS-1 ($5.35, 4 GB) fits Claude Messenger alone, but not Chrome and
     Claude sessions alongside it.
   - [OVH docs](https://support.us.ovhcloud.com/hc/en-us/articles/38299056076947)
     say a US VPS upgrade keeps your data and IP, so moving up a tier later
     doesn't mean rebuilding. Downgrades are unverified.
   - OVH is a large incumbent, so collapse risk is negligible. IPv4 and
     traffic are included.
2. **Fallback: Contabo Cloud VPS 4 (US Central or West).** Use it only if
   OVH's order verification blocks the user.
   - The same 8 GB as VPS-2 for $7–8.
   - Independent benchmarks grade its stability F and disk E [S].
   - There is a long-running "US West ~30 downtimes in 6 months" thread [S].
   - The location fee never gets the term discount [Va].
3. **Avoid budget/indie hosts for this workload,** even at $5. This box holds
   a logged-in messaging session with decrypted history.
   - In January 2026, attackers abused a third-party control panel that many
     budget hosts share to wipe customer VMs. CloudCone confirmed it was hit
     [V]; the panel was reportedly Virtualizor [S].
   - Providers in this segment also vanish abruptly. DediPath gave under 24 h
     notice in 2023, and HostDare went dark the same year [S].
4. **Home hardware** remains the $0/low-cost alternative:
   - A spare laptop costs nothing. Set `HandleLidSwitch=ignore` in
     `/etc/systemd/logind.conf`, then run `deploy/bootstrap.sh`. Its battery
     doubles as a UPS.
   - A used 1-liter business mini PC (ThinkCentre M720q class, 8–16 GB) was
     ~$80–110 in July 2026 [? not re-checked].
   - A used M1 Mac mini runs ~$390 once plus ~$2/mo at ~$0.40/kWh. It is the
     only route to iMessage.
   - Costs: home power and ISP outages (including utility fire-safety
     shutoffs), and physical theft exposes decrypted chats unless the disk is
     encrypted.

### Disqualified (don't re-research)

- **Oracle Cloud Always Free.**
  - The home region `us-sanjose-1` returns `OUT_OF_HOST_CAPACITY` for every
    free shape. Both the Compute Capacity Report API and real launches
    confirmed it.
  - Always Free exists only in the home region, and the home region is
    permanent.
  - Pay-as-you-go has no hard spending cap; its budgets only alert.
- **GCP e2-micro (free).** It has 1 GB RAM, below the 4 GB floor.
- **Container PaaS** (Fly.io, Railway, Render, Koyeb, Northflank).
  - As of July 2026, none offered a free always-on container with a
    persistent volume.
  - A headless Electron GUI app under Xvfb is also the worst-case container
    workload.
- **IPv6-only plans.** These include Lightsail's cheaper IPv6 bundles. They
  can't reach `api.beeper.com` or `github.com`.

## Provider operational notes

- **OVHcloud US.**
  - New orders can be held for manual verification: government ID, a card
    photo and a selfie within 48 h [V].
  - Deleting a VPS through the API requires a token emailed to the account
    [V].
  - The Terraform `ovh_vps` resource has no script argument, so first-boot
    setup needs a follow-up `rebuild` with `postInstallScript`.
  - Support hours are 9:00–17:30 ET [V].
  - Prices exclude tax; US sales-tax treatment is unverified [?].
- **Contabo.**
  - `POST /v1/compute/instances` takes `productId` V153, `region` and
    `userData` (cloud-init).
  - The API's default image is Ubuntu 22.04; look up the 24.04 image ID [V].
  - Orders can sit in "Verification Needed". "Rapid Provisioning" skips the
    ID check for one standard order [Va].
  - Customers outside Germany prepay the whole term [Va].
- **Hetzner.**
  - Its fraud check may demand ID or prepayment [V].
  - Default limits rise only after a month and a paid first invoice [V].

## Re-verifying

All of these are public and need no authentication:

- **OVHcloud US catalog:** `https://api.us.ovhcloud.com/1.0/order/catalog/public/vps?ovhSubsidiary=US`
  - It is ~12 MB; fetch with `--compressed` and a long timeout.
  - Plan codes are `vps-2027-model{1,2,3,4}`.
  - `pricings[].price` is in 1e-8 USD; the `renew` capacity is the
    recurring price.
- **OVHcloud US stock:** `https://api.us.ovhcloud.com/1.0/vps/order/rule/datacenter?ovhSubsidiary=US&planCode=vps-2027-model1`
- **Hetzner:** `https://website-price-api.hetzner.com/api/v1/products/CLOUD_<id>`
  - IDs: 123 = CPX21, 121 = CPX11, 124 = CPX22, 132 = CX23, 111 = CAX11,
    21 = primary IPv4.
  - Stock state is only on the hetzner.com/cloud pages ("not available").
- **Vultr:** `https://api.vultr.com/v2/plans?type=vc2`
- **Beeper backend:** `https://dns.google/resolve?name=matrix.beeper.com&type=A`,
  then RDAP the addresses.
