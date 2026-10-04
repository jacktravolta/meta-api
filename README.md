# meta-api — Meta AI behind an OpenAI-compatible API

Exposes Meta AI as an OpenAI-compatible endpoint. There is no Meta API: the
"model" is a real Chrome instance driven through the DevTools Protocol (CDP), so
requests are serialized and latency is browser latency.

```
POST /v1/chat/completions        OpenAI-compatible (sync)
POST /v1/chat/completions/async  returns {job_id} immediately
GET  /v1/jobs/{job_id}           {status, content?, error?}
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
mkdir -p ~/.config/systemd/user
cp systemd/meta-api.service ~/.config/systemd/user/
cp -r systemd/meta-api.service.d ~/.config/systemd/user/   # optional: visible mode
systemctl --user daemon-reload
systemctl --user enable --now meta-api.service
```

`Linger=no` on this machine, so the user unit starts at login rather than at boot.
For boot-time start without a login you need `loginctl enable-linger test` (requires
root). A `@reboot` crontab fallback with a port guard is installed as a second line
of defence.

## Login

Meta AI will not render a composer without a session. The profile ships a stale
cookie set, so log in once, by hand:

```bash
systemctl --user stop meta-api
google-chrome-beta --user-data-dir=/home/test/.config/google-chrome-beta-debug \
  --no-first-run https://www.meta.ai
```

Sign in, close Chrome, then `systemctl --user start meta-api`. The session lives in
the profile, so this is a one-time action.

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
| `META_RESET_TURNS` | `8` | start a fresh thread after N turns on a worker |
| `META_CONTEXT_SOFT_PCT` | `70` | rotate the thread when estimated context reaches this % |
| `META_CONTEXT_BUDGET_CHARS` | `24000` | character budget the % is measured against |
| `META_CONTEXT_SEED_CHARS` | `8000` | starting estimate for a thread we resume but never watched being built |
| `META_RECOVERY_MAX_AGE_MS` | `1800000` | ignore persisted jobs older than this on boot; their caller has given up |

## Session continuity

The current thread URL is written to `state.json` right after every successful
send and reloaded at boot, so a reopen resumes the same conversation instead of
landing on the home screen. Only real `/prompt/<uuid>` URLs are stored.

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

`META_RESET_TURNS` is a separate, blunter mechanism. Whichever trips first wins,
and the turn counter usually does — raise it if you want the percentage to drive.

Usage is **estimated**, not measured: Meta exposes no token counter and the thread
is virtualized, so `main` reads ~250 chars on a long thread while `body` is ~190k
of React payload. The broker counts what it sent and received instead. Tune
`META_CONTEXT_BUDGET_CHARS` if Meta degrades before the threshold trips.

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