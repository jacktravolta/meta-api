# meta-api — Meta AI behind an OpenAI-compatible API

Exposes Meta AI as an OpenAI-compatible endpoint. There is no Meta API: the
"model" is a real Chrome instance driven through the DevTools Protocol (CDP), so
requests are serialized and latency is browser latency.

```
POST /v1/chat/completions        OpenAI-compatible (sync)
POST /v1/chat/completions/async  returns {job_id} immediately
POST /v1/agent                   shell-tool agent mission (see Agent below)
GET  /v1/jobs/{job_id}           {status, content?, error?, agent?}
GET  /v1/models · GET /health
```

## Requirements

- **Node >= 22.** The global `WebSocket` does not exist before Node 21. The
  server refuses to boot on anything older. Note that `/usr/bin/node` on this
  machine is 18.x — use nvm's: `/home/test/.nvm/versions/node/v22.23.3/bin/node`.
- **Chrome Beta** at `/usr/bin/google-chrome-beta`.
- **A Chrome profile with a live Meta AI session** (see *Login* below).

## Install

```bash
./relay/operar.sh install
./relay/operar.sh start
```

The installer copies the broker and watcher units plus tracked drop-ins, but does
**not** enable or start them. `start` enables and starts the broker, opens the
logged-in Meta tab, and starts the watcher. `watch` attaches the current terminal
to watcher logs. `stop` disables autostart and runtime-masks both units so another
unit cannot indirectly restart scraping; a later `start` removes the masks and
starts the stack again.
The unit expects this checkout at `/home/test/test/meta-api` and Node 22 at the path in the
unit; adjust those two paths in `systemd/meta-api.service` if you relocate it.

## Login

Meta AI will not render a composer without a session. The profile ships a stale
cookie set, so log in once, by hand:

```bash
systemctl --user stop meta-api
google-chrome-beta --user-data-dir=/home/test/.config/google-chrome-beta-debug \
  --no-first-run https://www.meta.ai
```

Sign in, close Chrome, then run `./relay/operar.sh start` and
`./relay/operar.sh warmup`. The session lives in the profile, so this is a one-time
action.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `META_API_HOST` / `META_API_PORT` | `127.0.0.1` / `8055` | listen address |
| `META_MIN_WORKERS` | `1` | tabs opened up front. Each tab is an independent conversation |
| `META_MAX_WORKERS` | `10` | hard cap on the pool. Requests beyond it queue on the least loaded worker |
| `META_MODE` | `normal` | `speed` pastes with `Input.insertText`. `normal` types per character over CDP |
| `META_IDLE_CLOSE_MS` | `600000` | close the browser after N ms with no activity. `0` disables. "Activity" means broker jobs **and** human interaction in the visible window (typing, clicking, scrolling), so the timer is postponed while you are typing |
| `META_COOLDOWN_MS` | `480000` | refuse requests for N ms after Meta returns an empty generation |
| `META_VISIBLE` | — | `1` shows the Chrome window on `DISPLAY` |
| `META_PROFILE` | `~/.config/google-chrome-beta-debug` | Chrome profile (holds the session) |
| `META_CDP_PORT` | `9233` | Chrome debug port |
| `META_IMAGES_DIR` | `~/.local/state/meta-api/images` | Persistent storage for image attachments during a job |
| `META_RESET_TURNS` | `60` | backstop: rotate after N turns on a worker. Same rotation, not a separate reset |
| `META_CONTEXT_SOFT_PCT` | `70` | rotate the thread when estimated context reaches this % |
| `META_CONTEXT_BUDGET_CHARS` | `150000` | character budget the % is measured against |
| `META_CONTEXT_SEED_CHARS` | `25000` | starting estimate for a thread we resume but never watched being built |
| `META_RECOVERY_MAX_AGE_MS` | `1800000` | ignore persisted jobs older than this on boot; their caller has given up |
| `META_AGENT_BUDGET_MS` | `900000` | default wall-clock budget of an agent job; the per-request `budgetMs` is clamped to 30s..1h |
| `META_SANDBOX_WORKDIR_ROOTS` | `/home/test/test` | colon-separated roots; an agent `workdir` must realpath inside one of them or the request is refused |
| `META_SANDBOX_WORKDIR` | `/home/test/test` | workspace mounted at `/workspace` when the request carries no `workdir`; validated against the roots too |
| `META_SANDBOX_BACKEND` | `bwrap` | agent command backend: `bwrap` (user-namespace jail, default) or `docker` (previous container path); any other value fails closed (see *Sandbox backends* below) |
| `META_SANDBOX_IMAGE` | `meta-sandbox:1` | Docker image for agent commands (docker backend only). Build: `docker build -f agent/Dockerfile.sandbox -t meta-sandbox:1 agent/` |

## Session continuity

The current thread URL is written to `state.json` right after every successful
send and reloaded at boot, so a reopen resumes the same conversation instead of
landing on the home screen. Only real `/prompt/<uuid>` URLs are stored.

Relay channel selection and watcher state live under the ignored local
`relay/state/` directory. `relay/operar.sh` seeds the current channel from
`relay/canal.example.json` on first use; channel changes and detector history
remain local and are never committed. Image attachments are kept under the user
state directory instead of ephemeral `/tmp`, so a broker restart cannot break a
queued image job.

## Lista blanca de destinos de WhatsApp

**Regla:** todo script que escribe en WhatsApp solo puede actuar sobre un canal
de la lista blanca (hoy: `BOTEST`). El destino nunca se infiere de "lo que esté
abierto en la pestaña".

- La lista vive en `relay/canal-ok.mjs` (`CANAL_PERMITIDOS`) y se consulta con
  `canalPermitido(nombre)`; el rechazo se explica en español con
  `motivoRechazo(nombre)`.
- **Cada escritor de WhatsApp** — `relay/wsp.mjs` y los scripts de `bridge/` que
  disparan eventos sobre la pestaña — tiene que validar `canalPermitido()` con el
  título real del DOM **antes de cualquier evento `Input.*`**
  (`Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`).
  El chequeo va en cada punto de decisión: antes de escribir, antes de hacer
  click en un resultado de la lista y, si el chat cambió, al reabrirlo.
- Es **fail-closed**: título vacío, desconocido, que parezca un número de
  teléfono o que no coincida exactamente ⇒ nada se escribe, nada se hace click y
  el proceso sale con código distinto de cero.
- El módulo es puro y sin dependencias; su test unitario es
  `node --test relay/canal-ok.test.mjs`.

Verificación de solo lectura (no envía nada, no crea pestañas, no hace click):

```bash
WSP_CDP=http://127.0.0.1:9333 node relay/dryrun-canal.mjs
```

Sale `0` si el guard dejaría pasar, `2` si bloquearía, `3` si CDP o WhatsApp no
están disponibles.

## Concurrency

The pool grows on demand: a request that finds every worker busy opens a new tab,
up to `META_MAX_WORKERS`. Past that, requests queue on the least loaded worker.

Two rules make parallel sessions safe, and both were violated before:

- **Each worker past the first opens its own thread.** Only worker 0 resumes the
  remembered session. Opening `lastThreadUrl` in every tab put two sessions in the
  same conversation, which is how one request ended up sending another's prompt.
- **`askMeta` brings its tab to the foreground first.** With several windows only
  one can be foreground, and a background window measures 0×0, so the composer check
  fails on a worker that is actually fine.

Worker 0 is the "primary": it resumes the remembered thread and is the tab whose
URL gets persisted to `state.json`.

The pool does not shrink back down on its own. It only drops to the idle-close
and rebuilds from `META_MIN_WORKERS` on the next request.

## Context rotation

At or above `META_CONTEXT_SOFT_PCT` the broker asks Meta to summarize the thread,
saves the transcript and the summary to disk, **deletes the old thread from Meta's
own frontend**, opens a fresh one and replays the summary as context. The answer
then continues as if nothing had been cut.

Deleting the thread is best effort: the UI flow can fail without blocking the
rotation, in which case the history keeps one extra thread.

`META_RESET_TURNS` is the second trigger for the **same** rotation, not a competing
mechanism: a backstop for pathological message sizes that never reach the
percentage. Both go through `rotateThread`, so the conversation always continues
with its context. There used to be a separate `resetThread()` that ran first and
opened a fresh thread without replaying any summary, silently dropping the
conversation every 8 requests.

Usage is **estimated**, not measured: Meta exposes no token counter and the thread
is virtualized, so `main` reads ~250 chars on a long thread while `body` is ~190k
of React payload. The broker counts what it sent and received instead. Tune
`META_CONTEXT_BUDGET_CHARS` if Meta degrades before the threshold trips.

Agent jobs never rotate: the loop drives its worker's thread turn by turn, so
the mission transcript is the context. Rotating first would spend a Meta turn
on a summary the loop never reads and delete the thread mid-mission.

## Agent: POST /v1/agent

Meta AI plans, the broker executes. The model is framed to answer with a shell
command in a code block tagged `sh`; the broker runs it inside the active
sandbox backend and feeds the output back, repeating until the model answers in
plain text.

```bash
curl -s -X POST http://127.0.0.1:8055/v1/agent -d '{
  "task": "find every TODO in the project and count them"
}'
# -> {"job_id":"job-...","status":"queued","poll":"/v1/jobs/job-..."}
curl -s http://127.0.0.1:8055/v1/jobs/job-...
```

Request fields:

| Field | Default | Meaning |
|---|---|---|
| `task` | required | the mission. Capped at 8000 chars |
| `verify` | `true` | run the sandbox self-check first; the route answers **503** if the sandbox does not prove it enforces the default posture (write denied, mount visible, network blocked, host invisible) |
| `maxSteps` | `8` | step budget, clamped to 1..32 |
| `budgetMs` | `META_AGENT_BUDGET_MS` (900000) | wall-clock budget, clamped to 30000..3600000 |
| `allowWrite` | `false` | mount the workspace read-write; requires `allowWriteAck:true` as an explicit confirmation |
| `allowNetwork` | `false` | grant network egress (docker: `bridge` instead of `none`; bwrap: the host network namespace) |
| `workdir` | `META_SANDBOX_WORKDIR` | host directory mounted at `/workspace`; must `realpath` inside `META_SANDBOX_WORKDIR_ROOTS` or the route answers **400** |

The poll response carries the mission result:

```json
{
  "job_id": "job-...", "status": "done",
  "content": "hay 14 TODOs",
  "agent": {
    "ok": true, "reason": null, "steps": 3,
    "transcript": [
      { "role": "user", "step": 1, "text": "..." },
      { "role": "assistant", "step": 1, "text": "```sh\nrg -n TODO\n```" },
      { "role": "tool", "step": 1, "command": "rg -n TODO", "output": "..." }
    ]
  }
}
```

`agent.ok:false` means the loop ended without a final answer: `max-steps`,
`budget`, or `meta-error:<msg>` (Meta failed mid-mission — the partial
transcript is still delivered). `text`/`output` are capped at 1200 chars per
turn. Queued agent jobs survive a broker restart with their identity
(`maxSteps`, `budgetMs`, write/network flags, `workdir`), so they replay as
agent jobs, never as raw chat.

Execution is **deny-by-default**: commands are classified against a read-only
whitelist (every pipe segment must pass; substitution, backticks, `find
-exec`/`-delete`, `xargs` and `awk/sed system(...)` all classify as writes),
and the active backend isolates the network by default (`--network none` for
docker, `--unshare-all` for bwrap), exposes the workspace read-only, and caps
memory/CPU/PIDs behind a hard timeout on both sides; the docker container
additionally runs `--read-only`, `--cap-drop=ALL` and
`--security-opt=no-new-privileges`. Writes require the explicit `allowWrite` +
`allowWriteAck` pair.

The agent modules carry their own regression suite (zero dependencies):

```bash
node --test agent/*.test.js   # bare `node --test` also finds them
```

The suite pins the parser, the classifier, the loop and the sandbox
self-check; the self-check test skips itself when the Docker daemon is
unreachable. Note that this Node's runner rejects directory arguments
(`node --test agent/`), so pass files or a glob.

## Sandbox backends: selection, limits and rollback

Agent commands run under the backend selected by `META_SANDBOX_BACKEND`:

| Value | Backend | Posture |
|---|---|---|
| unset or `bwrap` (default) | user-namespace jail | `bwrap` inside a `systemd-run --user --scope` resource envelope, with a persistent root (see below) |
| `docker` | ephemeral container | the previous Docker path: `docker run --rm` with the `meta-sandbox:1` image |
| anything else | — | fails closed: no command runs, and the self-check reports the rejected value plus the accepted set |

Selection is an explicit operator decision with **no silent fallback**: an
invalid value refuses to execute instead of running model-authored text under a
backend the operator never chose. Callers (`agent/loop.js`, `server.mjs`) are
backend-agnostic, so switching backends needs no code change.

**Prerequisites** (bwrap): the `bwrap` binary, a usable systemd user session
for `systemd-run --user --scope`, and the AppArmor profile under *AppArmor
host prerequisite* below. Any missing prerequisite fails the self-check
closed, so `POST /v1/agent` answers **503** — commands never run unconstrained.
The docker backend needs only a reachable Docker daemon and never requires the
bwrap prerequisites.

**Limits** (bwrap): the systemd user scope enforces `MemoryMax=256M`,
`CPUQuota=100%` (one CPU) and `TasksMax=100` — the equivalents of Docker's
`--memory 256m --cpus 1 --pids-limit 100` — plus the same double timeout brake
(inner `timeout` inside the jail, host-side backstop killing the transient
scope). Without `systemd-run` or the user session the run is refused rather
than executed unlimited.

**Rollback**: set `META_SANDBOX_BACKEND=docker` and restart the broker to get
the previous container behavior back — no code or caller change. For a
code-level rollback, `git revert` the bwrap change set; the Docker path was
extracted intact. The AppArmor profile is optional in docker mode (leave it or
remove it) and the global sysctl was never modified.

## bwrap sandbox: persistent root, host prerequisites, installs

### Persistent root

The bwrap backend keeps one persistent sandbox root at `META_BWRAP_ROOT`
(default `~/sandbox`), created on first use with mode `0700` and laid out as:

```
~/sandbox/
├── bin/     # user-prefix binaries; first entry on PATH inside the jail
├── lib/     # pip --target / npm --prefix destination
├── home/    # jail HOME (HOME=/sandbox/home)
└── tmp/     # operator scratch (the jail itself uses a tmpfs /tmp)
```

The root is **operator-managed** and isolated from the workspace: only the
workspace is exposed at `/workspace` (read-only unless writes are enabled),
while the root is bound read-write at `/sandbox` because it is the sandbox's
own directory, never host-sensitive state. The root **survives every
command** — installs and files under it are visible to later commands — and it
is **disposable**: delete stale directories or the whole root to reset it; the
layout is recreated on the next run.

Disk budget: nothing prunes the root automatically. Watch it with
`du -sh ~/sandbox`, and when it outgrows the budget you allow, remove the
stale installs (or the whole root — it comes back intact on the next command).

### AppArmor host prerequisite

On hosts with `kernel.apparmor_restrict_unprivileged_userns=1` (the Ubuntu
24.04 default), an unprivileged `bwrap` cannot create a user namespace until
the host carries the profile `/etc/apparmor.d/bwrap`. Provisioning is a
manual, host-side step — the agent performs **no** automatic installation and
never weakens the global sysctl:

1. Create the root-owned, read-only, host-managed profile
   `/etc/apparmor.d/bwrap` with exactly this text:

   ```text
   abi <abi/4.0>,
   profile bwrap /usr/bin/bwrap flags=(unconfined) {
     userns,
     include if exists <local/bwrap>
   }
   ```

2. Reload it: `sudo apparmor_parser -r /etc/apparmor.d/bwrap`

Until the profile is present, the sandbox self-check fails closed and
`POST /v1/agent` answers **503** with a reason naming the missing `userns,`
prerequisite — the intended posture, not a bug.

### Confined installs (user-prefix only)

The jail runs as your own uid: no root, no capabilities, no escalation path.
Installs must stay inside the sandbox root and use user-prefix modes only:

- `pip --target /sandbox/lib <pkg>`
- `npm --prefix /sandbox/lib <pkg>`
- `pip install --user <pkg>` — the jail's default `HOME` is `/sandbox/home`

`PATH` inside the jail starts with `/sandbox/bin`, so entry points installed
by these commands resolve on later runs. `sudo`, `su`, `apt` and `apt-get`
classify as **writes**: the policy layer denies them without `allowWrite`, and
even with writes enabled they gain nothing — there is no root inside the jail.
Nothing inside the sandbox should ever assume root.

## Recovery

| Failure | Handling |
|---|---|
| Chrome dies | `recycleChrome` rescues queued jobs before wiping the pool. A job rescued twice is marked error, never looped |
| Node dies | queued jobs are mirrored to `pending-jobs.json` and re-dispatched on boot |

A job that had already typed its prompt into Meta before the crash gets replayed,
so the message can appear twice in the thread.

## Known limitation: one shared composer

The broker and a human share a single tab. If you type in the visible window
while a broker request is in flight, they collide on the same composer and the
request fails with `el envio no tomo efecto` or `paste incompleto`. Both recover
on the next request (Chrome is recycled and relaunched), but do not type into the
window while you are also driving it through the API. API-versus-API is safe: each
request gets its own worker and thread.

## Troubleshooting

Read the log first — the browser's own stderr is forwarded there.

```bash
journalctl --user -u meta-api -f
```

| Symptom | Cause |
|---|---|
| `WebSocket is not defined` | Running on Node 18. Check `ExecStart` points at nvm's Node 22 |
| `fetch failed` after ~21s | Chrome never opened the debug port. `killStrays()` must be `await`ed, or a `pkill` is racing the launch |
| `sin composer visible` | Background tab measures 0x0. `Page.bringToFront` is required on every worker tab |
| `no composer` | No Meta session in the profile. See *Login* |
| `envio fallido (button disabled)` | Text reached the DOM but React state did not; needs the native value setter |
| `tipeo incompleto (0/N chars)` | `META_MODE=normal`; switch to `speed` |
| `paste incompleto` | Lexical injects zero-width `U+200B` nodes; comparison must ignore them |
| Answer truncated to "Interpretando..." | Idle detection gave up while Meta was still generating |

## Current configuration

One tab, minimal browser (no NTP/search/crash bubbles, startup tabs closed), visible
window, 30-second idle close.
