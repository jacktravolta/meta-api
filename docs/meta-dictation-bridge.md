# Meta dictation bridge (Don Bot)

Status: operational toolchain is versioned in `relay/`; scraping is **stopped by
default after maintenance** and must be started explicitly.

## Quick start

From any terminal on this machine:

```bash
cd /home/test/test/meta-api
./relay/operar.sh start       # starts the broker, opens Meta and starts the watcher
./relay/operar.sh watch       # follows the watcher logs in this terminal
```

`start` opens the broker's saved Meta channel and starts the systemd watcher;
`watch` tails its journal and may be closed without stopping the service. The
watcher process exits after one unanswered Don Bot invocation or 60 minutes of
silence, and systemd restarts it after five seconds. To inspect pending
invocations without starting the watcher, run
`./relay/operar.sh pending`. To stop all scraping, prevent automatic startup,
and block another unit from indirectly restarting the broker, run
`./relay/operar.sh stop`. A later console can run `start` to remove the runtime
masks and restore the stack without reinstalling anything.

Install or refresh the user services once with `./relay/operar.sh install`. It
copies the broker/watcher units and tracked drop-ins without enabling or starting
them. `start` explicitly enables and starts both. The units require Node 22, Chrome Beta, and a logged-in
profile at `~/.config/google-chrome-beta-debug`. The first login must be completed
manually in that profile. The unit and service commands are documented in
[`README.md`](../README.md).

## Durable state and privacy

- `state.json` remembers the broker's current Meta thread URL across restarts.
- `relay/state/canal.json` remembers the selected transcription channel;
  `relay/canal.example.json` seeds the known channel if local state is missing.
- `relay/state/` is ignored by Git because it contains dictation history,
  duplicate-detection data, and authenticity logs. Do not commit it.
- The Chrome profile contains the Meta login and is outside the repository.
- Image attachments now live under `~/.local/state/meta-api/images` (or the
  configured `META_IMAGES_DIR`), not `/tmp/opencode`.
- Raw thread dumps and screenshots can contain private dictations. The diagnostic
  dump tool writes to stdout only; use a private temporary file and remove it
  immediately if a command needs a file.

## Channel protocol

- The active thread is the most recent transcription chat, currently seeded as
  `dfa0f5b7` (full id: `dfa0f5b7-6a4f-4475-bf6d-fcedca96c994`).
- `./relay/operar.sh channel` rediscovers the newest chat titled for audio/video
  transcription and updates the local channel state.
- The user invokes the console agent only by saying **Don Bot**. Voice variants
  such as `donbot`, `dombot`, and `son bot` are covered by
  [`relay/es-donbot.mjs`](../relay/es-donbot.mjs).
- Agent replies posted to Meta use exactly one `[LALO]` prefix. Meta's trailing
  `ok` and “Mostrar razonamiento” UI text are removed before pending detection.
- The agent replies only to Don Bot invocations, once per batch; never post
  credentials or other secrets into the channel.
- The watcher bootstraps a newly selected channel with
  [`relay/reglas.txt`](../relay/reglas.txt) once. It filters its own `[LALO]`
  messages and stores deduplication state locally.

## Components

| File | Purpose |
|---|---|
| `relay/operar.sh` | Install, start/stop/status, channel discovery, pending check, watcher and sender commands |
| `relay/vigia-v7.mjs` | DOM-event watcher with polling and reload safety nets; exits on an unanswered invocation |
| `relay/canal.mjs` | Finds the newest transcription thread and persists its id locally |
| `relay/read-thread.mjs` | Reads thread rows through CDP and emits JSON including user/assistant role |
| `relay/pendientes.py` | Detects unanswered Don Bot invocations in a thread dump |
| `relay/enviar-hilo.mjs` | Posts one message, adds `[LALO]` when absent, records the sent text locally |
| `relay/tools/dump-rows.mjs` | Prints current DOM rows to stdout for diagnostics; does not save transcripts |
| `relay/tools/verify-signatures.mjs` | Compares `[LALO]` rows with the local send log to detect forged signatures |
| `relay/tools/open-tetris.mjs` | Opens and probes the local Tetris page in the CDP browser |

## Verification and recovery

```bash
./relay/operar.sh status
curl --fail http://127.0.0.1:8055/health
curl --fail http://127.0.0.1:9233/json/version
python3 -m unittest discover -s relay -p 'test_*.py'
```

If the broker is active but the watcher cannot connect, run
`./relay/operar.sh warmup` and then start `watch` again. If Meta has logged out,
stop the service, open the configured Chrome profile manually, sign in, close
that browser, then start the service and warm up. A closed CDP port is expected
while the broker is stopped; it is not an instruction to start scraping
automatically.
