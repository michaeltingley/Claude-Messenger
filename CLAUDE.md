# Claude Messenger — working agreement

_Read this first, then `docs/STATUS.md` for where the project currently stands._

This file exists because engineering standards kept living only in chat
transcripts, which do not survive a session handoff. Sessions have already been
lost this way. **If a standard matters, it belongs here, not in a conversation.**

Everything in "Standards" below is derived from the code and docs as they exist
today — it describes what the codebase already does. The "Open questions"
section is the part that was never written down; it needs the user's input.

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
   the seam. If a change makes `policy/`, `mcp/`, or `cli/` aware of Beeper
   specifically, it is wrong.
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
  audit log. Their history does not belong in log files.
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

- `npm test` must be green before any push. Currently 79 tests / 11 files.
- Integration tests drive the **real CLI as a subprocess** and a **mock Beeper
  server** — they are the ones that catch actual regressions. New surface area
  gets an integration test, not just a unit test.
- `FakeMessenger` (`test/fake-messenger.ts`) is how anything above `providers/`
  is tested. Needing a real Beeper to test a policy change means the seam leaked.
- Behavior gets asserted, not implementation details.

### CI and hygiene

CI runs `npm ci` → `typecheck` → `test` → `build` → CLI smoke test. Run
`npm run typecheck && npm test` locally before pushing; don't outsource basic
verification to CI.

- Secrets live in `.env` (gitignored) or the environment. Never logged, never
  committed. The Beeper token is password-equivalent.
- Commits explain *why*, not just *what*. Keep the history readable.
- Update `docs/STATUS.md` when the project's pick-up point changes — it is the
  handoff contract for the next session.

## Open questions for the user

Not yet established, and currently guessed at by each session:

- **Review process** — should substantial changes get a self-review pass
  (`/code-review`, `/security-review`) before pushing, or is CI + tests enough?
- **PR granularity** — the history so far is large thematic PRs (#1–#5). Keep
  that, or prefer smaller ones?
- **Dependency policy** — the tree is deliberately thin (4 runtime deps). Should
  adding one require justification?
- **Docs bar** — `docs/` is unusually thorough. Is that the standard to hold, or
  was it a function of the research phase?

## Environment notes

- **Cloud sessions have no access to prior transcripts.** Only the repo carries
  forward. Assume the next session knows nothing that isn't committed.
- iMessage bridging requires macOS on-device; no Linux host provides it.
- The Beeper CLI still installs the **nightly** server channel (data-loss risk,
  beeper/cli#21). Beeper Desktop + Remote Access is the GA fallback.
