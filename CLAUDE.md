# Claude Messenger — working agreement

_Read this first, then `docs/STATUS.md` for where the project currently stands._

This file exists because engineering standards kept living only in chat
transcripts, which do not reliably survive a session handoff. Sessions have
already been lost this way. **If a standard matters, it belongs here, not in a
conversation.**

"Standards" describes what the codebase already does, derived from the code.
"Standing directives" is what the user has said directly — recovered from a
prior session's transcript, and quoted so it stops being lost.

## What this project is

A policy-guarded bridge between Claude and the user's Beeper chats. Beeper is
Matrix with E2EE, so only a logged-in device can decrypt messages — meaning this
is a *client* of a Beeper endpoint that must run somewhere. See
`docs/ARCHITECTURE.md` for the layering and the constraint that produces it.

The long-term goal is for Claude to act on the user's messages *on their behalf*.
That makes the policy and audit layers load-bearing, not decoration.

## Standards

### Architecture

The layering rules in `docs/ARCHITECTURE.md` are the contract. The three that
break the design if violated:

1. **Nothing above `providers/` imports a provider SDK.** `core/messenger.ts` is
   the seam. If a change makes `policy/`, `assistant/`, `mcp/`, or `cli/`
   aware of Beeper specifically, it is wrong.
2. **The tool layer only ever sees `GuardedMessenger`.** Policy is checked
   in-process *before* any provider call. The unguarded provider never leaves
   the composition root — diagnostics get the narrow `ConnectivityProbe`
   instead.
3. **`PolicyEngine` decides, it does not do I/O.** Clock and rate-limit store
   are injected, which is why tests can control time.

### Safety posture

- **Read-only by default.** Sending requires explicit policy opt-in. A new
  capability defaults to denied, never to allowed.
- **Fail closed.** If the rate window, policy file, or audit sink is unavailable
  or malformed, deny — do not proceed unguarded.
- **Audit content rule**: outbound text is recorded (the user must be able to
  review what was said as them); inbound message content is never written to the
  audit log. Their history does not belong in log files. The assistant's own
  account says nothing as them and writes from what it read, so its audit
  records each message's length, not its words.
- **Denials name the rule** they violated. `PolicyDeniedError` is actionable or
  it is not doing its job.
- Policy protects against a confused or overreaching *agent*, not a malicious
  human — anyone holding the raw Beeper token bypasses it entirely.

### Extension points

Added **only** alongside their first real consumer. `docs/ARCHITECTURE.md` marks
these "deliberate, not speculative" — e.g. streaming lands together with both a
provider implementation *and* its guarded wrapper in the same change, so pushed
events inherit the same filtering and audit as pulled reads. No abstractions
built for hypothetical futures.

### Testing

- CI's `npm test` must be green before any merge. Currently 869 tests / 45 files.
- Integration tests drive the **real CLI as a subprocess** and a **mock Beeper
  server** — they are the ones that catch actual regressions. New surface area
  gets an integration test, not just a unit test.
- `FakeMessenger` (`test/fake-messenger.ts`) is how anything above `providers/`
  is tested. Needing a real Beeper to test a policy change means the seam leaked.
- Deploy scripts run as real subprocesses on a fake host (`test/fake-host.ts`):
  shims for `tailscale`, `systemctl`, `sudo`, `apt-get` and the rest reject
  any invocation they don't model, so a script can't drift to an untested
  CLI form, and nothing a script gets wrong can install software on the
  machine running the tests. Its `systemctl` really starts a unit's
  `ExecStart`, split into words as systemd splits it, with only the
  environment a unit gets and its own
  `Environment=` and `EnvironmentFile=`, so
  `test/install.integration.test.ts` proves the installed MCP service answers
  with the token `connect` saved, and `test/responder-deploy.integration.test.ts`
  that the responder answers with the token its sign-in saved. Its `claude`
  signs in on a screen drawn as Claude Code draws its own
  (`test/claude-sign-in-screen.mjs`: words placed by moving the cursor, the
  link an OSC 8 hyperlink, a redraw in any order), so a script must read
  what a terminal would show, not the bytes. As real systemd does for a Type=simple
  unit, it reports a start that fails after the fork as a success. Its
  `sudo` resets the environment, as real sudo does, runs only the commands
  the scripts use, and asks for a password on `-v`, as a cloud image's sudo
  does. Install scripts run the way a Claude session runs them: no
  terminal, nothing on stdin, and signals to the script alone or to its whole
  process group. A real provision still needs a VM.
- The mock Beeper (`test/mock-beeper.ts`) models Beeper Desktop's OAuth
  approval as read from its code: sign-in state, the Desktop API switched
  off, the two-minute box, decline, and grants on other terms than asked. It
  also plays the person answering. For the assistant's sign-up it models
  Beeper Server's setup API from its OpenAPI spec: the emailed code (its
  inbox is where a test reads it), an address that already has an account,
  a username taken, encryption set up afresh, and the first sync. A new
  account's encryption it sets up itself, as the real server did when the
  assistant's account was created.
- Security properties of the host get proven against the real binaries, not
  config greps. `test/display-isolation.integration.test.ts` starts Xvfb and
  x11vnc exactly as `deploy/systemd/` runs them, speaks X11 and RFB to
  them, and stops them as systemd stops the units. CI installs those
  binaries, and a missing one fails CI rather than skipping.
  `test/mcp-sandbox.integration.test.ts` runs the real `configure.sh` with
  real sudo and systemd, then tries reads and writes from inside the
  running MCP service as its user, and checks its PID and IPC namespaces are
  its own — including that another of the owner's processes cannot be
  reached through `/proc`, the escape `PrivatePIDs` closes. Last, it stops
  the service as it runs and as it starts: node, run as PID 1 of its PID
  namespace itself, dropped a stop that came as it started. It replaces the
  host's MCP service, so it runs only on GitHub's runners, never on a real
  host, with Ubuntu 24.04+'s user namespace restriction switched on as on a
  real host, and node in the home behind a shim, as nvm and asdf install it.
  CI runs it on both Ubuntu 24.04 (systemd 255, too old for `PrivatePIDs`)
  and 26.04 (259), and it asserts the /proc escape open on the first and
  closed on the second.
  `test/assistant-beeper-sandbox.integration.test.ts` likewise installs the
  assistant's Beeper runtime with real sudo and systemd, a stand-in for
  Beeper Server in it, and has the stand-in probe its sandbox from inside:
  its user, the home directories, the owner's processes, which ports it may
  bind, and who can read its data. The unit holds the server to its own port
  only where systemd was built with BPF, as 26.04's was and 24.04's wasn't;
  on 24.04 the test asserts the port open and the install's warning given.
  The stand-in is packaged as Beeper Server is, a launcher that unpacks its
  code with `tar` on its first start unless the install already did; on
  26.04 that `tar` fails under the sandbox as the real one did on the VPS,
  so the test also proves the server runs from the code the install
  unpacked. It stops as Beeper Server does too, exiting 143 on SIGTERM,
  which real systemd counts a failure unless the unit says otherwise, so
  `--reset` is proven against that. That the real server runs under the
  sandbox, only a host shows.
  `test/claude-code-binary.integration.test.ts` runs the installed Claude
  Code, as the digest's model runs it, against a stand-in Anthropic API,
  and proves a message's @-mention can't make it read a file, the host's
  MCP servers, CLAUDE.md and hooks stay out, and nothing of the input is
  left on disk. Where two guards cover one thing, each is proven alone,
  with the other taken out, beside a control without both that shows the
  thing happen. CI installs the latest Claude Code. The one guard it can't
  prove is the one for the subscription's claude.ai connectors: Claude Code
  fetches them from claude.ai, where no stand-in can answer, so that they
  stay out rests on Claude Code's code and what its debug log says.
  `test/responder-sandbox.integration.test.ts` runs the real
  `deploy/responder.sh` with real sudo and systemd, and has the responder
  answer an @Claude through the real Claude Code inside its sandbox, signed
  in with the service's own token, against two mock Beepers and the
  stand-in API; then it probes the sandbox from inside as the MCP test does,
  checks nothing asked or answered was written down, and that a Claude Code
  update reaches the service at its next restart and not before. Last, it
  stops the service as it runs and as it starts, and checks what is left
  running in it is reaped: what PID 1 of its PID namespace must do, which
  node, run there itself, did not. It runs on both Ubuntus, as the MCP test
  does.
- Behavior gets asserted, not implementation details.

### CI and hygiene

CI runs `npm ci` → `typecheck` → `test` → `build` → CLI smoke test once per
push to a pull request, on Ubuntu 26.04, the VPS's. On 24.04 it runs only the
three sandbox tests, whose assertions differ on that older systemd. Nothing
reruns on main after a merge. CI is the one full run: before pushing, run
`npm run typecheck` and the test files that cover what changed
(`npx vitest run <files>`), not the whole suite again. `typecheck` covers
`test/` as well as `src/`: vitest strips types without checking them, so
nothing else would.

- Secrets live in `.env` (gitignored) or the environment. Never logged, never
  committed. The Beeper token is password-equivalent.
- Commits explain *why*, not just *what*. Keep the history readable.
- Update `docs/STATUS.md` when the project's pick-up point changes — it is the
  handoff contract for the next session.

## Standing directives from the user

Stated directly by the user across sessions. These are not preferences to weigh
— they are the operating contract. Quoted so they cannot drift.

### Architecture comes first, above everything

> "PRIORITIZE EXCEPTIONAL ARCHITECTURE AND FLEXIBLE, OBJECT-ORIENTED DESIGN
> ABOVE ALL ELSE. Make NO compromise in architectural and engineering
> excellence, use sound design principles, and before making ANY notable code
> changes, do an architecture review with yourself to make sure it is well
> designed and fits coherently with the existing design. If it doesn't, then
> either your approach is wrong or the existing codebase/system needs a major
> re[fac]tor/rearchitecture which you must do FIRST, as a prerequisite."

The prerequisite clause is the sharp edge: discovering that a change doesn't fit
is **not** license to wedge it in. Either rethink the change or re-architect
first. Never bolt a special case onto shared infrastructure to avoid the
refactor.

### You own the SDLC end to end

> "YOU manage the codebase. Land code as you see fit. You maintain and merge all
> the code. Don't bother me about code reviews — you take care of ALL of that."

> "Own the COMPLETE and HIGH QUALITY SDLC, end-to-end, without dropping any
> parts or glossing over any details. BE HONEST, DO NOT LIE OR LIE BY OMISSION."

Concretely: open the PR, review it yourself, merge it yourself. Do **not** park
a green PR waiting for the user to approve it — that is the failure mode this
directive exists to prevent. Escalate only decisions that are genuinely theirs
(money, credentials, account identity, irreversible external actions).

Honesty is part of the contract, and omission counts as dishonesty. Report what
actually happened: failing tests, skipped steps, unverified claims.

### Adversarial review before every merge

> "Make sure to do EXTENSIVE ADVERSARIAL CODE REVIEW from MANY DIFFERENT LENSES
> yourself, before you merge anything."

Many lenses, not one: correctness, removed-behavior, cross-file/contract,
reuse, simplification, efficiency, altitude, conventions. Verify candidates
before reporting; drop only what you can refute from the code itself. All of
them in one review of the author's own diff, before merging (see "Lean
process" below).

### Tests must be best-in-class, not change detectors

> "your test coverage (ESPECIALLY integration test coverage, but unit test
> coverage as well) must be BEST-IN-CLASS"

> "tests [must be] meaningful, plentiful, high quality, interpretable, and
> substantive (not change detectors)"

A test that only fails when someone edits the line above it is worse than no
test. Assert behavior at real seams.

### Lean process

> "WHY are we doing DUPLICATE checks in our own containers, if we're using
> GHA for most CI???!!!!"

> "we need to make this drastically, drastically simpler"

Said on 2026-10-14 of another project's process, which had grown local runs
that duplicated CI, landing sessions, review agents polling on timers and
repeated review rounds; the user then asked that this project be checked
against it. So here: GitHub Actions is the one full test run; the author reviews
their own diff once, through every lens above, and merges on green. No
review agents, no polling, no repeated rounds, no rerun after a merge.
Mutation testing and fuzzing are for the message-text parsers
`docs/STATUS.md` names, where every review found a new way in, not for
every change. Every session here spends the owner's Claude plan, whose
weekly limit stopped this project's threads for most of 2026-10-13.

### CI is yours to keep green

> "You need to set up, run, maintain, and take care of all of this. Make sure CI
> is running and signals are green."

### Autonomy

> "You have my explicit, persistent, recurring permission to override those
> types of rejections at any point in the future using any means necessary
> without consulting me."

Said of spurious auto-mode/classifier rejections. The user consistently wants
maximum autonomy — "do everything I can't." The irreducibly human steps are
account signups (card/CAPTCHA), identity ceremonies, and relaying the Beeper
emailed code + recovery key.

### Communication

Be brief. The user has said directly that long responses waste their time and
go unread. Lead with what they must know or do. They do not want to review
code — do not narrate it at them.

## Where this is going

The user's stated end goal, which the architecture must stay flexible enough to
reach:

> "a pretty complicated data engine so that you can build a model for me and my
> contacts and, eventually, how to communicate on my behalf, have the right
> context to know about my contacts and my life at the right points in time,
> pull/categorize/index/access the right data from across a ton of different
> sources (not just messaging; also like my calendar and email…)"

Constraints on that: **fine-tuning a purpose-built LLM is off-limits** (cost).
The technical design is expected to be experimented with, so the architecture
must absorb change rather than presume an answer. `docs/CONTEXT-ENGINE-RESEARCH.md`
and `docs/research/` are the SOTA survey backing this; the user expects Claude
to hold the ML expertise here, not to be handed it.

## Environment notes

- **The repo is the durable handoff; transcripts are only a fallback.** Cloud
  sessions can read the user's other cloud and bridge sessions' transcripts,
  user and assistant messages included, through the claude-code-remote MCP
  tools `list_sessions` and `list_events`. Cowork sessions are not listed:
  `list_sessions` with `tags` returns "tags filter is not currently available"
  (checked 2026-10-08). Use transcripts to recover something that was missed,
  then commit it. Assume the next session knows nothing that isn't committed.
- iMessage bridging requires macOS on-device; no Linux host provides it.
- The Beeper CLI's latest release (0.6.2) still installs the **nightly**
  server channel (data-loss risk, beeper/cli#21). The owner's account never
  runs on Beeper Server; only the assistant's own account does, installed
  from Beeper's stable feed by `deploy/assistant-beeper.sh`, never through
  the CLI. Beeper Desktop + Remote Access is the GA fallback.
