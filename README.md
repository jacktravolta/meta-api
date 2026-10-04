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
| `META_WORKERS` | `3` | browser tabs. **1** serializes requests; >1 means N independent threads |
| `META_MODE` | `normal` | `speed` pastes with `Input.insertText`. `normal` types per character over CDP |
| `META_IDLE_CLOSE_MS` | `600000` | close the browser after N ms idle. `0` disables |
| `META_COOLDOWN_MS` | `480000` | refuse requests for N ms after Meta returns an empty generation |
| `META_VISIBLE` | — | `1` shows the Chrome window on `DISPLAY` |
| `META_PROFILE` | `~/.config/google-chrome-beta-debug` | Chrome profile (holds the session) |
| `META_CDP_PORT` | `9233` | Chrome debug port |
| `META_RESET_TURNS` / `META_RESET_CHARS` | `8` / `8000` | start a fresh thread after N turns or N chars |

## Session continuity

The current thread URL is written to `state.json` right after every successful
send and reloaded at boot, so a reopen resumes the same conversation instead of
landing on the home screen. Only real `/prompt/<uuid>` URLs are stored.

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