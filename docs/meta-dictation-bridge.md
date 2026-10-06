# Meta dictation bridge ("Don Bot")

Status: working as of 2026-10-06.

## Purpose

Turn a Meta AI chat thread into a **bidirectional voice channel**:

1. The user dictates with voice into the thread.
2. Meta AI is instructed to **transcribe only** — it must not answer.
3. The bridge watches the thread DOM, lifts each new user dictation, and wakes the
   console agent.
4. The agent answers (in the console, and/or back into the thread).

## Roles

| Piece | Role |
|---|---|
| Meta AI thread `e04189db-43e4-4a44-84a4-389566e00d0a` | Transcribes voice. Must **not** answer. |
| Broker (`meta-api`, CDP on port `9233`) | Keeps the logged-in Chrome instance that owns the thread tab. |
| Bridge scripts (`/tmp/opencode/*.mjs`) | Watch the thread and post messages. |
| Console agent | Reads dictations, answers, and asks follow-up questions. |

## Protocol

- **Keyword `don bot`** (transcription variants: `donbot`, `son bot`, `Don Bot`) marks
  a dictation as a **direct order for the console agent**; Meta is ignored.
- **Channel**: the Meta thread. Agent messages are prefixed with `[Don Bot]`.
- On every answer, the agent reminds Meta **not to intervene** ("no te metas, solo transcribe").
- The agent answers in the console first, and relays to the thread when the protocol
  (or the user) requires it.

## Bootstrap (primer ingreso al canal)

The first time the watcher enters a channel it posts the **channel rules** to Meta
(`/tmp/opencode/reglas.txt`), automatically and only once:

1. Meta / Doña Meta: **only transcribe** what the user says; do not answer/opine/interrupt unless
   the user explicitly says `meta`. Signature: `[DOÑA META]`.
2. **Single output per turn** — never respond *and* transcribe in the same turn (that duplicated
   the agent's messages).
3. **No signature forgery** — never use the `[DON BOT]` signature; it belongs to the agent only.
4. The agent acts **only** when the user mentions **`Don Bot`** (any form: `donbot`, `Don Bot`,
   `DON BOT`, `[don bot]`). Signature: `[DON BOT]`.
5. Valid channel = the most recent transcription chat.
6. **Persistence** — if the user opens another chat, the agent rediscovers the channel and
   re-declares these rules.
7. **Transcriber mode on entry** — on entering the channel the agent tells Meta to switch to
   transcriber mode.
8. **`[Meta]`** answers **only when named**, and always as `[Meta] + respuesta`.
9. **`[Don Bot]`** answers **when invoked**, and always in the channel that was started.

Items 7-9 are the listening prompt added by the user on 2026-10-06; `reglas.txt` carries them as
`(8)`, `(9)`, `(10)`.

`canal.json` carries `bootstrapped: true|false`; `canal.mjs` resets it to `false` when the
channel id changes, so a **new channel gets the rules again**. The rules are posted by the
watcher at startup, before it starts reading.

## Components

| Script | Role |
|---|---|
| `vigia-v6.mjs` | Watches user message rows: 2 s DOM read + 120 s reload safety net. Ignores `[Don Bot]` rows. Duplicate filter against the log. Exits on detection (one notification per dictation). |
| `enviar-hilo.mjs` | Posts arbitrary text into the thread (composer + send button). |
| `canal.mjs` | Discovers the **valid channel**: the most recent chat whose title matches transcription (`Transcribir audio o video`). Opens the sidebar if needed and writes `/tmp/opencode/canal.json` (`{id,url,title,index,ts}`). Watcher and sender read the id from there — nothing is hardcoded. |
| `recargar-leer.mjs` | Reloads the thread and reads the last rows (manual "lee"). |
| `leer-filas.mjs` / `leer-cola.mjs` | Row dump / last message + composer state. |
| `dictado-log.txt` | Append-only log of every detected dictation, with timestamp. |

## DOM contract

- Message rows: `[class*="group/message-row"]`
- Assistant rows: contain `[data-testid="assistant-message"]`
- **User dictation rows: do NOT contain it**
- Composer (the real, visible one): `[data-testid="composer-input"][contenteditable="true"]`
  - Decoy: a hidden `textarea` shares the same `data-testid="composer-input"`.
- Send button: `[data-testid="composer-send-button"]` (disabled until the composer has text)

## Known quirks and mitigations

1. **Frozen SPA (was the main issue).** In a background/headless tab, Chrome throttled the
   page and the thread stopped receiving live updates, so a plain DOM read returned a
   **stale snapshot**. **Fixed 2026-10-06** by launching Chrome with the anti-throttling
   flags (see quirk 4) and by `Emulation.setFocusEmulationEnabled(true)` +
   `Page.setWebLifecycleState('active')`. Verified: a posted message shows up in the DOM
   within seconds **without reloading**.
2. **Virtualized list.** Only the last ~10 rows live in the DOM, so an old row can
   re-enter the window and look "new". Mitigation: duplicate filter against `dictado-log.txt`.
3. **Self-echo.** The agent posts as the user, so its messages appear as user rows.
   Mitigation: the `[Don Bot]` prefix is filtered out by the watcher.
4. **Anti-throttling flags (APPLIED 2026-10-06).** `server.mjs` now launches Chrome with
   `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`
   and `--disable-renderer-backgrounding`. This removes the SPA freeze entirely, so the
   watcher reads live and reloads are only a 120 s safety net (was 10 s). Detection
   latency ≈ 2 s.

5. **Network capture (evaluated, rejected).** Meta's thread WebSocket carries **binary**
   (protobuf-like) frames — CDP `Network.webSocketFrameReceived` yields opaque payloads.
   Reverse-engineering them is fragile. A JSON alternative exists: the page talks to
   `POST https://www.meta.ai/api/graphql` (not yet wired).

## Operation

```bash
# The broker must be up (headless, long idle close):
curl -s http://127.0.0.1:8055/warmup

# Watch for new dictations (exits with the text when one arrives):
node /tmp/opencode/vigia-v6.mjs

# Post a message into the thread:
node /tmp/opencode/enviar-hilo.mjs /tmp/opencode/msg-meta.txt

# Read what is there right now (with reload):
node /tmp/opencode/recargar-leer.mjs
```
