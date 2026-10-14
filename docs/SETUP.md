# Setup

Three steps: get a Beeper endpoint + token, point Claude Messenger at it, connect Claude.

## 1. Beeper endpoint + access token

### Option A — Beeper Desktop on your machine (5 minutes, start here)

1. Open Beeper Desktop → **Settings → Integrations** → enable **Beeper Desktop API**.
   (Older builds: **Settings → Developers** hosts the same controls.)
2. The API is now at `http://localhost:23373` while the app runs.
3. Get the token in step 2 below, with `claude-messenger connect`: Beeper asks you to approve, and the token goes straight into `.env`.

### Option B — Headless Beeper Server on a VPS — ⚠️ DO NOT USE FOR YOUR ACCOUNT

> **`beeper setup --server --install` can destroy your account's bridge
> connections.** [beeper/cli#21](https://github.com/beeper/cli/issues/21) is
> **open**: running it on a legacy cloud-bridge account deleted every bridge
> connection — WhatsApp, Telegram, Google Messages — **across all devices,
> including the phone.** Its maintainer traced the nightly build it installed
> to the CLI, whose latest release (**0.6.2, 2026-05-18**) still installs
> Server's nightly channel whatever is asked, and suspects a recovery-key
> reset for the loss; the cause is unconfirmed. (The empty chats it also
> reported were fixed in Server 4.3.121, per the maintainer.)
>
> This option is kept documented only so nobody rediscovers it and assumes it
> was an oversight. Use Option C, which serves the identical Client API.
> Nothing in Claude Messenger changes between them — the endpoint's location
> is pure configuration (`BEEPER_BASE_URL`, see `ARCHITECTURE.md`). Server
> runs only the @Claude assistant's own, new account, installed without the
> CLI ("The assistant's own account" in `ARCHITECTURE.md`).

### Option C — Beeper Desktop on an always-on machine (24/7, GA path, recommended)

The officially supported route since Sept 2025, and what `deploy/cloud-init.yaml` and `deploy/bootstrap.sh` now provision. Run regular Beeper Desktop on any machine that stays awake (spare desktop, Mac mini, home server, or a VPS running it headless under Xvfb), then reach it through a tunnel. Same API, boring and stable.

For a headless Linux host, the deploy scripts handle this for you: they install the Beeper Desktop AppImage matched to the host architecture, run it under Xvfb as a systemd user service, and expose noVNC over your tailnet just long enough for the one-time sign-in — so the emailed login code and your recovery key are typed straight into the app rather than relayed through a terminal or a chat transcript. Size for **4 GB RAM**: Electron plus Xvfb measured about 0.66 GB once synced with 9 networks, peaking near 1.07 GB during the first sync (many accounts push it higher).

Treat `http://127.0.0.1:23373` on that machine as your endpoint; the deploy scripts get the token for you with `claude-messenger connect`. Note: iMessage bridging requires macOS, so an iMessage-heavy setup may prefer a Mac mini as the always-on host.

### Making either reachable from elsewhere (tunnels)

The API has bearer-token auth but **no TLS** — never expose the raw port to the internet. Use one of:

- **Tailscale** (recommended): join your desktop/VPS and the machine running Claude Messenger to the same tailnet; use `http://<tailscale-ip>:23373`.
- **Cloudflare Quick Tunnel**: `cloudflared tunnel --url http://localhost:23373` → gives an HTTPS URL.

If connecting from another device to Beeper *Desktop*, also enable **Settings → Integrations → Advanced → Remote Access** (binds beyond localhost, tunnel-aware).

## 2. Configure and verify Claude Messenger

```sh
npm install && npm run build
cp .env.example .env              # if Beeper isn't local, set BEEPER_BASE_URL
npx claude-messenger connect      # approve in Beeper; saves BEEPER_ACCESS_TOKEN to .env
npx claude-messenger doctor
```

`connect` opens Beeper's own **Approve connection** box and waits for you (15 minutes by default; `--timeout <minutes>`). In the box:

- **Expires in**: choose **Never**. Nothing renews a token that expires.
- **Allow sensitive actions**: leave it off. It grants write access (sending, marking read); ask for that with `connect --allow-send`, and the policy still decides where it applies.
- Press **Approve**.

The token is written to `.env` (owner-only) and never displayed. A token approved on other terms is revoked instead of saved, and `connect` says what to choose next time. If Beeper is signed out, `connect` waits for you to sign in first. To mint a token by hand instead: **Settings → Integrations → Approved connections → +**, then set `BEEPER_ACCESS_TOKEN` in `.env`.

`doctor` walks the whole chain — config → connectivity → token → accounts → policy — and tells you exactly which link is broken if any.

Then set up permissions:

```sh
npx claude-messenger policy-init   # writes read-only policy.json
npx claude-messenger chats         # find chat IDs
```

To allow sending to a specific chat, edit `policy.json` (the `version` field is required):

```json
{
  "version": 1,
  "capabilities": { "read": true, "send": true, "markRead": false },
  "send": { "chatAllowlist": ["<chat-id-from-chats-command>"], "maxMessagesPerHour": 10 }
}
```

`policy.json` is gitignored on purpose — it contains your private chat IDs. The audit log keeps every action (including full text of anything sent as you) indefinitely; prune old `audit/audit-*.jsonl` files whenever you like, they're one file per day.

Test the guardrails: `claude-messenger send <allowed-chat> "test"` should work; sending anywhere else must be denied. Check `audit/` for the trail.

## 3. Connect Claude

**Claude Code** (machine that can reach the endpoint). The server reads `.env` from its working directory, so start it from the checkout. That keeps the token in the owner-only `.env`, rather than on a command line that every local user can read, or in Claude's config:

```sh
claude mcp add claude-messenger -s user -- \
  sh -c 'cd /path/to/Claude-Messenger && exec node dist/cli/main.js serve'
```

**Claude Desktop**: add to MCP settings, with node's absolute path (`command -v node`), since Claude Desktop may not start with your shell's `PATH`:

```json
{
  "mcpServers": {
    "claude-messenger": {
      "command": "sh",
      "args": ["-c", "cd /path/to/Claude-Messenger && exec /path/to/node dist/cli/main.js serve"]
    }
  }
}
```

Ask Claude: *"Use check_connection then search_chats to show my unread chats."*

**Hosted / remote clients**: run `claude-messenger serve --http` (requires `CLAUDE_MESSENGER_MCP_TOKEN`) and connect with `claude mcp add claude-messenger --transport http https://<host>/mcp --header "Authorization: Bearer <mcp-token>"`. The full 24/7 host recipe is **[DEPLOY.md](DEPLOY.md)**.

### Token hygiene

- Revoke any token instantly: Beeper → Settings → Integrations → Approved connections.
- One token per consumer (one for this project, one per experiment) so revocation is surgical.
- Rotate a token you've ever pasted into a chat or shared screen. `connect` never shows its token, so there is nothing to paste.

## 4. Follow your @Claude mentions

```sh
npx claude-messenger mentions                                  # from now on
npx claude-messenger mentions --since 2026-10-13T09:00:00Z     # catch up first (a time with its zone)
```

It prints each message you send that mentions `@Claude` as one JSON line (`id`, `chatId`, `accountId`, `timestamp`, `text` as the chat shows it, and `replyToMessageId` for a reply), until Ctrl-C or SIGTERM. This is the first step of the @Claude assistant: nothing answers yet.

- **Only your own words count, as far as the text shows.** It reads only messages you send, in chats the policy shows. A mention doesn't count inside a quote (a quoted block, a line starting with ">", or anything between double quote marks, straight or curly, as an English tapback quotes the message it reacts to), in a reply's copy of the message it answers, in a reaction, or in a pill naming a person in the chat. A mention that sits between two quote marks, like `my 27" screen, @Claude, or a 32"?`, is missed with them, and a quote mark in a quote or in a contact's name can pair with one of yours the same way. A message you forward, or one an app sends as you, can't be told apart from one you typed, so it does count.
- **Timing.** It asks Beeper every 5 seconds (`BEEPER_POLL_INTERVAL_MS`, 1000 to 60000). A message that reaches Beeper late, as when a bridge reconnects, is still caught up to 10 minutes late, and missed after that. It catches up on at most 1,000 of your messages at once; past that it stops and says to watch from a later time.
- **What it misses.** It sees a message once, as it first arrives, so a later edit or deletion isn't seen. Mentions sent while it isn't running are missed unless the next run starts with a `--since` before them.
- **Failures.** If Beeper fails or stops accepting the token, it exits 1 with the error. It doesn't retry.
- **Audit.** Each message of yours it reads is in the audit log by chat and message ID, never its text.

## 5. Have Claude answer, from its own account

Claude answers from a Beeper account of its own, in a private chat with you, so nothing it writes is ever sent as you. That account runs on Beeper Server beside your Beeper and has a directory of its own, `~/.config/claude-messenger/assistant` on the VPS, whose `.env` signs in to it ("The assistant's own account" in [ARCHITECTURE.md](ARCHITECTURE.md) covers installing and signing it up). Then, once:

1. In that directory's `policy.json`, let it open a chat with you: `"capabilities": { "startChat": true }` and `"startChat": { "userAllowlist": ["<your Beeper user ID>"] }`. Your user ID is the `user.id` of your Beeper account in `claude-messenger accounts`.
2. From that directory, run `claude-messenger start-chat --with '<your Beeper user ID>'`. It prints the chat's ID, and you accept its invite in Beeper.
3. Let it send there, and only there: `"capabilities": { "send": true }` and `"send": { "chatAllowlist": ["<that chat ID>"], "maxMessagesPerHour": 30 }`. It sends one message per request.

Then, from this install, whose `.env` and policy are yours and read-only:

```sh
npx claude-messenger respond --assistant ~/.config/claude-messenger/assistant
```

It answers each `@Claude` in a message you send, in any chat, and anything you write in its chat, there and only there, until Ctrl-C or SIGTERM. It writes with Claude Code signed in here, on your subscription, as `digest` does (`--model`, default `sonnet`; `--time-zone`, default this machine's).

- **What it reads.** Through your configuration, for each request: the message again (an edited one is answered as it stands; a deleted one, or one that no longer asks anything, is skipped), its chat, and up to 30 of that chat's latest messages before it. The model has no tools: it can't read your other chats, email or links, or send anything.
- **What it sends.** One message per request, in its chat with you: the answer, made safe to show as the digest is (links, codes and long numbers replaced), with where and when you asked first when you asked in another chat; or, when it couldn't answer, a line saying so, with the time you asked.
- **Restarts.** It answers each request once at most. It keeps where it got to in `state/responder.json` in Claude's directory, and when it starts again answers what you asked while it was stopped, up to six hours back; its first run starts from now. A request it was stopped while answering is answered by the next run.
- **Failures.** A failure about one request is told to you, when it can send at all, and it goes on. Any other (Beeper unreachable, a token rejected, a file it can't read or write) ends it with exit 1. Its output says what it did by IDs and kinds of failure, never what anyone wrote.
- **Audit.** Your audit log records what it read, by IDs; Claude's records what it sent, by length, not its words.
