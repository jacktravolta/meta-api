#!/usr/bin/env node
/** Meta AI over OpenAI API — the "model" is a browser scrape to Meta AI,
 * driven through CDP, behind a worker-tab broker.
 *
 *   POST /v1/chat/completions        OpenAI-compatible (sync; auto-queues).
 *   POST /v1/chat/completions/async  Deferred, NOT concurrent: returns
 *                                    {job_id} immediately; poll GET /v1/jobs/{id}.
 *                                    With META_WORKERS=1 every job is serialized,
 *                                    because there is exactly one browser tab.
 *   GET  /v1/jobs/{job_id}           {job_id, url, status, content?, error?}
 *   GET  /v1/models · GET /health
 *   POST /v1/browser/close           Closes the chrome process (and clears pool).
 *   Idle lifecycle: after META_IDLE_CLOSE_MS (default 10 min) with no active
 *   job, the browser auto-closes so no window is left open. The next request
 *   reopens the SAME conversation (remembered thread URL + persisted profile),
 *   so the session resumes instead of starting fresh.
 *
 * Broker: one Chrome process with N page tabs (workers). Each tab is an
 * independent Meta conversation; the dispatcher hands requests to the next
 * free worker (round-robin), so concurrency == META_WORKERS. Within a single
 * tab, requests are strictly serialized by that worker's queue. Calling this
 * "async" is about the HTTP contract (job id instead of a held connection),
 * not about parallelism.
 *
 * No dependencies: Node 22 native fetch + WebSocket + http.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.META_API_PORT || 8055);
const HOST = process.env.META_API_HOST || "127.0.0.1";
const CHROME = process.env.META_CHROME || "/usr/bin/google-chrome-beta";
const PROFILE = process.env.META_PROFILE ||
  "/home/test/.config/google-chrome-beta-debug";
const CDP_PORT = Number(process.env.META_CDP_PORT || 9233);
const WORKERS = Math.max(1, Number(process.env.META_WORKERS || 3));
const HOME_URL = "https://www.meta.ai";
// META_START_URL lets a restarted gateway reopen an EXISTING conversation
// (/prompt/<uuid>) instead of starting a fresh thread. Defaults to home.
const START_URL = process.env.META_START_URL || HOME_URL;
// Idle lifecycle: after IDLE_CLOSE_MS with no active job we close Chrome so no
// (visible) window is left open. The next request relaunches Chrome with the
// SAME profile (cookies/login persist) AND the last conversation URL, so the
// thread resumes instead of starting a fresh chat. 0 disables auto-close.
const IDLE_CLOSE_MS = Number(process.env.META_IDLE_CLOSE_MS ?? 10 * 60 * 1000);
// Cooldown: when Meta starts generating and then stops with no output, hammering
// it again only deepens the block. Refuse fast (503 + retry_after) until it expires.
const COOLDOWN_MS = Number(process.env.META_COOLDOWN_MS || 8 * 60 * 1000);
let cooldownUntil = 0;
function setCooldown() {
  cooldownUntil = Date.now() + COOLDOWN_MS;
  log("cooldown activo hasta", new Date(cooldownUntil).toISOString(), "(" + Math.round(COOLDOWN_MS / 1000) + "s)");
}
// META_VISIBLE=1 -> visible Chrome (watch the human-like typing); default hidden.
const VISIBLE = process.env.META_VISIBLE === "1";
// Prompt entry mode, two options:
//   "normal" (default) -> human-like per-character CDP keystrokes, ~294ms/char.
//   "speed"            -> one native paste (Input.insertText), pause 5-10s, then
//                         the send click. Same verification, ~20s instead of minutes.
// Per-request override wins over the env default: {"mode":"speed"} in the body.
const MODE_DEFAULT = String(process.env.META_MODE || "normal").toLowerCase() === "speed" ? "speed" : "normal";
function resolveMode(raw) {
  const m = String(raw || "").toLowerCase();
  if (m === "speed" || m === "normal") return m;
  return MODE_DEFAULT;
}
// META_FRESH=1 -> fresh Chrome per request (defeats Meta's session cooldown).
// DEFAULT=0 -> keep the browser AND the conversation thread alive so you can
// converse with Meta across requests (window stays open; same hilo).
const FRESH = process.env.META_FRESH === "1";
// Context guard against hallucination: Meta drifts when the thread gets too
// much context. META_RESET_TURNS (default 8): after N turns per worker we
// auto-copy the transcript to file and start a fresh thread. META_RESET_CHARS
// (default 8000) also trips the reset when the DOM conversation exceeds chars.
const RESET_TURNS = Number(process.env.META_RESET_TURNS || 8);
const RESET_CHARS = Number(process.env.META_RESET_CHARS || 8000);
const TRANSCRIPTS_DIR = process.env.META_TRANSCRIPTS_DIR || "/home/test/test/transcriptos";

let chromeProc = null;
let workers = [];          // [{id,ws,page,wsUrl,url,conversation,queue,busy}]
let nextWorker = 0;
const jobs = new Map();    // job_id -> {status,content,error,url,created}
let cdpSeq = 0;
let idleTimer = null;    // pending auto-close after inactivity
let idleDeadline = 0;    // epoch ms when that auto-close fires (for /health)
let lastThreadUrl = START_URL; // last conversation to reopen (same session)

function log(...a) { console.log(new Date().toISOString(), ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpCall(ws, id, method, params = {}) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 120000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression) {
  const r = await cdpCall(ws, ++cdpSeq, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : undefined;
}

async function killStrays() {
  // A lingering Chrome with the SAME profile steals every new launch via its
  // singleton lock (headless orphans made the "visible" mode show no window).
  // Kill processes whose cmdline matches the profile; not our node server.
  try {
    await new Promise((resolve) => {
      // NOTE: the "--" separator is REQUIRED: without it pkill parses the
      // pattern itself as an option ("pkill: unrecognized option
      // --user-data-dir=...") and this silently killed nothing, so orphan
      // Chromes holding the profile/port survived every relaunch.
      const p = spawn("pkill", ["-f", "--", "--user-data-dir=" + PROFILE]);
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    await sleep(800);
  } catch { /* best-effort */ }
}

async function workerAlive(w) {
  // A CDP socket can be dead while the handle still looks valid. The only honest
  // test is asking the page something and seeing if it answers.
  if (!w || !w.ws) return false;
  try { await evaluate(w.ws, "1"); return true; } catch { return false; }
}

function activeJobs() {
  return [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running").length;
}
function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  idleDeadline = 0;
}
// Remember the conversation we are currently ON, so an idle close can reopen
// THIS thread (same session) instead of the original START_URL.
async function rememberThreadUrl() {
  const w = workers[0];
  if (!w || !w.ws) return;
  try {
    const href = await evaluate(w.ws, "location.href");
    if (href && /meta\.ai/.test(href)) lastThreadUrl = href;
  } catch { /* best-effort: keep the previous URL */ }
}
// Arm the auto-close. Any real work clears it (see pump/route handlers).
function scheduleIdleClose() {
  clearIdleTimer();
  if (!(IDLE_CLOSE_MS > 0)) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    idleDeadline = 0;
    if (activeJobs() > 0) { scheduleIdleClose(); return; } // work arrived meanwhile
    if (!chromeProc) return;                               // already closed
    await rememberThreadUrl();
    await recycleChrome(`inactivo ${Math.round(IDLE_CLOSE_MS / 1000)}s`);
    log(`idle: browser cerrado tras inactividad; la proxima peticion reabre ${lastThreadUrl}`);
  }, IDLE_CLOSE_MS);
  idleDeadline = Date.now() + IDLE_CLOSE_MS;
  idleTimer.unref?.();
}

let ensuringChrome = null;
// Concurrent HTTP requests (OpenCode fires the chat call AND a title-generation
// call at once) both reached ensureChrome before the first launch finished, so
// Chrome was spawned twice and the thread ended with TWO worker tabs writing to
// the same conversation — the second send then hit a disabled button. A single
// in-flight promise serializes the launch; later callers await the same one.
async function ensureChrome() {
  if (ensuringChrome) return ensuringChrome;
  ensuringChrome = ensureChromeInner().finally(() => { ensuringChrome = null; });
  return ensuringChrome;
}

async function ensureChromeInner() {
  if (chromeProc && workers.length) {
    // Do NOT trust the handles: Chrome can die from a crash, an update, a captcha
    // or a "restore pages" dialog while chromeProc and workers still look fine,
    // leaving a zombie worker that hangs every request. Probe before trusting.
    if (await workerAlive(workers[0])) return;
    log("worker CDP sin respuesta: reciclo Chrome");
    try { chromeProc.kill("SIGTERM"); } catch {}
    chromeProc = null; workers = [];
  }
  killStrays(); // clear the singleton before any visible launch
  if (chromeProc) { try { chromeProc.kill("SIGTERM"); } catch {} chromeProc = null; workers = []; }
  log(`launching Chrome (${VISIBLE ? "VISIBLE on " + (process.env.DISPLAY || "no DISPLAY") : "headless"}) with ${WORKERS} worker tabs…`);
  const args = [
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + CDP_PORT,
    "--no-first-run", "--no-default-browser-check",
    "--disable-component-update", "--disable-background-networking",
    "--disable-gpu", "--no-sandbox", "--disable-sync",
    "--disable-blink-features=AutomationControlled",
  ];
  if (!VISIBLE) args.unshift("--headless=new");
  chromeProc = spawn(CHROME, args, { stdio: "ignore" });

  // Bonus: hide the automation fingerprint on every new document.
  const STEALTH = `(() => {
    const wd = Object.getOwnPropertyDescriptor(Window.prototype, 'webdriver');
    if (wd) Object.defineProperty(window, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    const orig = navigator.plugins;
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  })();`

  // discover browser page or create tabs per worker
  let jsonUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    try { const r = await fetch(jsonUrl); if (r.ok) break; } catch { /* retry */ }
  }
  for (let i = 0; i < WORKERS; i++) {
    let t;
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(lastThreadUrl || START_URL)}`, { method: "PUT" });
      t = await r.json();
    } catch {
      const lst = await (await fetch(jsonUrl)).json();
      t = lst.find((x) => x.type === "page" && (x.url || "").includes("meta.ai")) || lst.find((x) => x.type === "page");
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error worker " + i)); });
    await cdpCall(ws, ++cdpSeq, "Page.enable");
    try { await cdpCall(ws, ++cdpSeq, "Page.addScriptToEvaluateOnNewDocument", { source: STEALTH }); } catch {}
    workers.push({ id: i, ws, pageId: t.id, url: t.url, queue: [], busy: false });
  }
  // wait until every tab has a composer
  for (const w of workers) {
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      const has = await evaluate(w.ws, `!!(document.querySelector('textarea') || document.querySelector('[contenteditable="true"]'))`).catch(() => false);
      if (has) break;
    }
  }
  log(`broker ready: ${workers.length} workers`);
}

// The page has SEVERAL textareas and the FIRST one is NOT the composer (on the home
// screen it is a different field). Every step that touches the input — focus, verify,
// send, cleared-check — MUST resolve the same element, or typing and sending disagree
// about which box holds the prompt, and the request dies with why:'empty'.
const PICK_COMPOSER_JS = `(() => {
  const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 8; };
  return cands.find((e) => visible(e) && !e.disabled && !e.readOnly) || cands.find(visible) || cands[0] || null;
})()`;

function keyCodeOf(ch) {
  if (ch === " ") return "Space";
  if (/^[A-Za-z]$/.test(ch)) return "Key" + ch.toUpperCase();
  return "Unidentified";
}

// One cleared-composer routine for both modes. Non-modifier and verified: the
// old Ctrl+A path leaked a literal control byte and ate the head of the prompt.
async function clearComposer(ws) {
  const clearRes = await evaluate(ws, `(() => {
    const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'));
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 8; };
    const el = cands.find((e) => visible(e) && !e.disabled && !e.readOnly) || cands.find(visible) || cands[0];
    if (!el) return { ok:false, why:'sin composer' };
    const read = () => (el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || ''));
    const before = read().length;
    el.focus();
    if (el.tagName === 'TEXTAREA') el.value = ''; else el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: read().length === 0, before, after: read().length };
  })()`).catch((e) => ({ ok:false, why:String(e) }));
  if (!clearRes || !clearRes.ok) log("aviso: no pude limpiar el composer antes de tipear:", JSON.stringify(clearRes));
  else if (clearRes.before) log(`composer limpiado (${clearRes.before} chars previos descartados)`);
  await sleep(120);
  return clearRes;
}

async function typeReal(ws, content) {
  // Real per-character input through CDP Input domain: the browser processes
  // these as native keystrokes, so the app paints each char (no late burst).
  const FIND_COMPOSER = `(() => {
    // ONE picker for focus, verify, send and cleared-check. Resolving the same
    // element everywhere is what stops typing and sending from disagreeing.
    const pick = ${PICK_COMPOSER_JS};
    if (!pick) return false;
    pick.focus();
    return true;
  })()`;
  const focused = await evaluate(ws, FIND_COMPOSER).catch(() => false);
  if (!focused) log("aviso: no se encontro composer visible para enfocar");

  // Clean slate, WITHOUT synthetic modifier bits. An earlier version sent Ctrl+A
  // through CDP with a literal control byte as its text; a leaked modifier turns
  // later keystrokes into shortcuts, and a mid-typing select-all + replace eats the
  // head of the prompt and keeps the tail. Clear the element directly, then VERIFY.
  await clearComposer(ws);

  const t0 = Date.now();
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const code = keyCodeOf(ch);
    try {
      await cdpCall(ws, ++cdpSeq, "Input.dispatchKeyEvent", {
        type: "keyDown", key: ch, code, text: ch, unmodifiedText: ch,
        windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0,
      });
      await cdpCall(ws, ++cdpSeq, "Input.dispatchKeyEvent", {
        type: "keyUp", key: ch, code,
        windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0,
      });
    } catch { /* one key missed: keep going humanly */ }
    let wait = 90 + Math.random() * 130;
    if (ch === " ") wait += 260 + Math.random() * 260;
    if (/[.,;:!?]/.test(ch)) wait += 350 + Math.random() * 450;
    if (Math.random() < 0.08) wait += 500 + Math.random() * 700;
    if (Math.random() < 0.03) wait = 40;
    await sleep(wait);
    // Liveness while typing: a 1100-char prompt takes ~5 minutes at human speed,
    // and silence here is indistinguishable from a hang. Progress + ETA every 100 chars.
    if ((i + 1) % 100 === 0) {
      const el = (Date.now() - t0) / 1000;
      const left = el / (i + 1) * (content.length - i - 1);
      // Integrity DURING typing: if the composer loses or replaces text mid-stream,
      // find out HERE, at the exact character, instead of discovering it at the end
      // with a corrupt prompt about to be sent.
      const live = await evaluate(ws, `(() => { const c = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')).map(e => (e.tagName === 'TEXTAREA' ? (e.value || '') : (e.textContent || '')) || ''); return Math.max(0, ...c.map(v => v.length)); })()`).catch(() => -1);
      log(`typing ${i + 1}/${content.length} (${el.toFixed(0)}s, ~${left.toFixed(0)}s restantes) integridad=${live}`);
      if (live >= 0 && Math.abs(live - (i + 1)) > 5) {
        log(`INTEGRIDAD ROTA en char ${i + 1}: el composer tiene ${live} (drift ${live - (i + 1)}). Abortando antes de enviar un prompt corrupto.`);
        throw new Error(`tipeo corrupto en char ${i + 1} (composer ${live}/${i + 1})`);
      }
    }
  }
  await sleep(350 + Math.random() * 500);
  // Verify against the element that actually holds the prompt: reading the first
  // textarea reported "len:2" for a 90-char prompt while Meta had the full text.
  const check = await evaluate(ws, `(() => {
    const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'));
    const vis = cands.map(e => (e.tagName === 'TEXTAREA' ? e.value : (e.textContent||'')) || '');
    return { lens: vis.map(v=>v.length), longest: Math.max(0, ...vis.map(v=>v.length)),
             preview: (vis.sort((a,b)=>b.length-a.length)[0]||'').slice(0,40) };
  })()`);
  const got = (check && check.longest) || 0;
  // EXACT length, not ">=": leftover text from an aborted turn makes the check pass
  // while the sent prompt is garbage.
  const ok = Math.abs(got - content.length) <= 2;
  log("typed ->", JSON.stringify(check), "esperado:", content.length, ok ? "OK" : "MISMATCH (texto incompleto)");
  if (!ok) {
    // Do not ship a truncated prompt: fail loudly instead of sending half a question.
    throw new Error("tipeo incompleto (" + got + "/" + content.length + " chars)");
  }
}

async function pasteReal(ws, content) {
  // Speed mode: ONE native paste instead of thousands of keystrokes, then a
  // human-length pause before the send click. Verification is NOT skipped: a
  // paste that lands truncated must never be sent.
  const focused = await evaluate(ws, `(() => { const el = ${PICK_COMPOSER_JS}; if (!el) return false; el.focus(); return true; })()`).catch(() => false);
  if (!focused) log("aviso: no se encontro composer visible para enfocar");
  await clearComposer(ws);

  const t0 = Date.now();
  try {
    await cdpCall(ws, ++cdpSeq, "Input.insertText", { text: content });
  } catch (e) {
    log("aviso: Input.insertText fallo:", String(e.message || e));
  }

  // Whitespace-insensitive check: a rich composer may render newlines as <br>
  // or as separate blocks, and textContent then carries no separators at all.
  // Comparing compacted text (all whitespace removed) verifies the payload
  // survived without depending on how the editor represents line breaks.
  const compact = (s) => String(s || "").replace(/\s+/g, "");
  const readText = async () => await evaluate(ws, `(() => {
    const el = ${PICK_COMPOSER_JS};
    if (!el) return "";
    return el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
  })()`).catch(() => "");

  let got = await readText();
  if (compact(got) !== compact(content)) {
    // Fallback: set the value directly and fire the input event React listens to.
    log(`aviso: paste mismatch (compact ${compact(got).length}/${compact(content).length}), intento set directo`);
    await evaluate(ws, `(() => {
      const el = ${PICK_COMPOSER_JS};
      if (!el) return false;
      el.focus();
      if (el.tagName === 'TEXTAREA') el.value = ${JSON.stringify(content)};
      else el.textContent = ${JSON.stringify(content)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`).catch(() => false);
    got = await readText();
  }

  const ok = compact(got) === compact(content);
  log("pasted ->", JSON.stringify({ compact_got: compact(got).length, compact_esperado: compact(content).length, ms: Date.now() - t0 }), ok ? "OK" : "MISMATCH (texto incompleto)");
  if (!ok) throw new Error("paste incompleto (" + compact(got).length + "/" + compact(content).length + " chars compactos)");

  // The pause the user asked for: 5-10s between the paste and the click, so the
  // submit does not look like a machine dropping text and firing instantly.
  const waitMs = 5000 + Math.floor(Math.random() * 5000);
  log(`pausa pre-envio ${(waitMs / 1000).toFixed(1)}s (modo speed)`);
  await sleep(waitMs);
}

async function typeLike(ws, content, mode = "normal") {
  // "normal": human-like typing via native CDP keystrokes (visible char by char).
  // "speed":  one native paste, 5-10s pause, then the caller clicks send.
  if (mode === "speed") return await pasteReal(ws, content);
  await typeReal(ws, content);
}

async function askMeta(worker, content, progress = null, mode = "normal") {
  const ws = worker.ws;
  // The thread is VIRTUALIZED and Meta renames classes between deploys, so a
  // saved index/count is NOT a stable boundary (slicing from it spliced several
  // OLD answers together). Anchor on OUR OWN prompt instead: find the LAST
  // user-message row whose text contains the prompt, then read the assistant
  // message(s) that follow it. This is immune to virtualization, to old turns,
  // and to a repeated answer text (an older identical "ok" stays where it is).
  const compact = (s) => String(s || "").replace(/\s+/g, "");
  const anchorKey = compact(content).slice(0, 80); // first 80 compacted chars: unique enough and survives UI truncation
  const readAnswerExpr = `(() => {
    const compact = (s) => String(s || "").replace(/\\s+/g, "");
    const key = ${JSON.stringify(anchorKey)};
    const BT = String.fromCharCode(96);
    // Meta renders the model's Markdown to HTML. Reading textContent then DROPPED
    // the structure: "## Objective" arrived as "Objective", ordered-list numbers
    // vanished and inline code lost its backticks. OpenCode's compaction validates
    // the template headings, so a summary that DID follow the template got rejected
    // ("did not fill in the required summary template"). Serialize the rendered DOM
    // back to Markdown so the structure survives.
    const inlineMd = (node) => {
      let s = "";
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { s += n.nodeValue.replace(/\\s+/g, " "); continue; }
        if (n.nodeType !== 1) continue;
        const t = n.tagName.toLowerCase();
        if (t === "br") s += " ";
        else if (t === "code") s += BT + (n.textContent || "").trim() + BT;
        else if (t === "strong" || t === "b") s += "**" + inlineMd(n).trim() + "**";
        else if (t === "em" || t === "i") s += "*" + inlineMd(n).trim() + "*";
        else s += inlineMd(n);
      }
      return s;
    };
    const toMd = (node) => {
      let out = "";
      for (const child of node.children) {
        const t = child.tagName.toLowerCase();
        if (/^h[1-6]$/.test(t)) out += "#".repeat(Number(t[1])) + " " + inlineMd(child).trim() + "\\n\\n";
        else if (t === "p") out += inlineMd(child).trim() + "\\n\\n";
        else if (t === "pre") {
          const c = child.querySelector("code");
          const m = c ? String(c.className || "").match(/language-([\\w-]+)/) : null;
          out += "\\n" + BT + BT + BT + (m ? m[1] : "") + "\\n" + (((c ? c.textContent : child.textContent) || "").replace(/\\n+$/, "")) + "\\n" + BT + BT + BT + "\\n\\n";
        }
        else if (t === "ul" || t === "ol") {
          let i = 1;
          for (const li of child.children) {
            if (li.tagName.toLowerCase() !== "li") continue;
            out += (t === "ol" ? (i++) + ". " : "- ") + inlineMd(li).replace(/\\s+/g, " ").trim() + "\\n";
          }
          out += "\\n";
        }
        else if (t === "blockquote") out += inlineMd(child).trim().split("\\n").map((l) => "> " + l).join("\\n") + "\\n\\n";
        else if (t === "hr") out += "---\\n\\n";
        else if (child.children.length) out += toMd(child);
        else { const x = inlineMd(child).trim(); if (x) out += x + "\\n\\n"; }
      }
      return out;
    };
    const allRows = Array.from(document.querySelectorAll('[class*="group/message-row"]'));
    const rows = allRows.filter(r => !allRows.some(o => o !== r && o.contains(r)));
    // Our answer attaches to the LAST user row ONLY. If our row has not rendered
    // yet, matching an OLDER row would silently return the PREVIOUS turn's answer.
    let idx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].querySelector('[class*="user-message"]')) { idx = i; break; }
    }
    if (idx === -1) return { found: false, rows: rows.length, why: 'sin-user-row' };
    if (!compact(rows[idx].innerText).includes(key)) return { found: false, rows: rows.length, why: 'ultimo-user-row-no-es-nuestro' };
    const parts = [];
    for (let i = idx + 1; i < rows.length; i++) {
      if (rows[i].querySelector('[class*="user-message"]')) break;
      const a = rows[i].querySelector('[data-testid="assistant-message"]');
      if (!a) continue;
      // The bubble wraps the reasoning toggle ("Mostrar razonamiento") and the
      // answer as SEPARATE .markdown-content blocks. Keep the top-level ones (in
      // DOM order) so the toggle is dropped and content is never duplicated.
      const allBlocks = Array.from(a.querySelectorAll('.markdown-content'));
      const blocks = allBlocks.filter(b => !allBlocks.some(o => o !== b && o.contains(b)));
      const texts = blocks
        .map(e => toMd(e).replace(/\\n{3,}/g, "\\n\\n").trim())
        .filter(t => t && !/^(mostrar|show|ocultar|hide)\\s+razonamiento$/i.test(t));
      if (texts.length) parts.push(texts.join("\\n\\n"));
      else {
        const fallback = toMd(a).replace(/\\n{3,}/g, "\\n\\n").replace(/^\\s*(mostrar|show|ocultar|hide)\\s+razonamiento\\s*\\n?/i, "").trim();
        if (fallback) parts.push(fallback);
      }
    }
    return { found: true, text: parts.filter(Boolean).join("\\n\\n"), n: parts.length };
  })()`;
  const readAnswer = async () => await evaluate(ws, readAnswerExpr).catch(() => null);
  // Real completion marker: Meta renders the copy control only on a FINALIZED
  // message. Text stability alone means "paused", not "done".
  const countCopies = async () => await evaluate(ws, `(() => document.querySelectorAll('.msg-copy').length)()`).catch(() => 0);
  const preCopies = (await countCopies()) || 0;
  // Stop/generating control. Checked on EVERY poll: sampling it only every 8th
  // poll missed it entirely for fast answers (it appears and vanishes within 2.5s),
  // which forced every fast answer onto the slow weak-idle fallback.
  const stopGenerating = async () => await evaluate(ws, `(() => !!Array.from(document.querySelectorAll('button')).find(x => /stop|detener|parar/i.test((x.getAttribute('aria-label')||'')+' '+(x.textContent||''))))()`).catch(() => false);

  log(`entrada de prompt: modo=${mode} anchor=${anchorKey.length}chars`);
  await typeLike(ws, content, mode);

  // send: ALWAYS the send button when found (proven path); Enter as fallback.
  const human = await evaluate(ws, `(() => {
    // SAME picker as the typing step. querySelector('textarea') read the FIRST
    // textarea — a different, EMPTY field on the home screen — so the prompt sat
    // verified in the real composer and the send refused with why:'empty'.
    const el = ${PICK_COMPOSER_JS};
    if (!el) return { sent:false, why:'no composer' };
    const text = el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
    if (!text.trim()) return { sent:false, why:'empty', tag: el.tagName, chars: text.length };
    const b = Array.from(document.querySelectorAll('button')).find(x => /enviar|send|submit/i.test((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')));
    if (b) {
      if (b.disabled) return { sent:false, why:'button disabled' };
      b.click();
      return { sent:true, via:'button' };
    }
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return { sent:true, via:'enter-fallback' };
  })()`).catch((e) => ({ sent:false, why: String(e) }));
  log("sent:", JSON.stringify(human), "url:", (await evaluate(ws, "location.href").catch(()=>""))?.slice(0,70));
  await sleep(2500);

  // Prove the submit landed: a cleared composer is the signal that the click sent.
  const cleared = await evaluate(ws, `(() => { const el = ${PICK_COMPOSER_JS}; if (!el) return true; return !(el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '')).trim(); })()`).catch(()=>false);
  if (!human.sent) throw new Error("envio fallido (" + (human.why || "?") + ")");
  if (!cleared) log("aviso: composer no se vacio tras enviar (el envio pudo noaisescribir)");

  let last = "";
  let stable = "";
  let idle = 0;
  let reply = "";
  let sawGenerating = false;
  // High-water mark for the answer: if Meta re-renders it SHORTER (virtualization,
  // streaming rewrite, list recycling) a naive read drops text already on screen.
  // Keep the longest version ever seen.
  const highWater = new Map();
  // Poll cadence: fast enough that a short answer is detected and confirmed in a
  // few seconds. The old fixed 2500ms x 8-idle = 20s of dead waiting on EVERY turn.
  const POLL_MS = Math.max(400, Number(process.env.META_POLL_MS || 900));
  for (let i = 0; i < 260; i++) {
    await sleep(POLL_MS);
    const res = await readAnswer();
    const ans = res && res.found ? (res.text || "") : "";
    // A "stop generating" control present => Meta IS working (long answers need
    // more than the old 120s budget); absent => blocked/dead, fail early.
    const gen = await stopGenerating();
    if (gen) sawGenerating = true;
    if (i % 8 === 0) log("poll", i, "found:", !!(res && res.found), "n:", (res && res.n) || 0, "len:", ans.length, "generando:", gen, "idle:", idle);
    if (!ans) {
      // Started but produced nothing and the stop control vanished => Meta gave up
      // (rate limit / silent block). Fail fast with a typed reason and cool down
      // instead of burning the whole budget on a dead request.
      if (sawGenerating && i >= 8 && !gen) {
        setCooldown();
        throw new Error("Meta detuvo la generacion sin emitir bloques (bloqueo o limite de tasa)");
      }
      continue;
    }
    // High-water mark: virtualization/streaming can re-render the message SHORTER
    // (or empty) for a poll, and a naive read would then report a truncated answer.
    if (ans.length > (highWater.get("answer") || "").length) highWater.set("answer", ans);
    const now = highWater.get("answer") || "";
    // Accept SHORT answers too: the old `> 10` silently dropped legitimate
    // replies like "ok" (the job then spun the whole budget and errored).
    if (now && now.length > 0) { if (now !== last) { reply = now; last = now; idle = 0; if (progress && now.length > (progress.content || "").length) progress.content = now; } else { idle++; } }
    // Completion, in order of trust — and WHICH signal fired is logged, because a
    // weak signal means the answer may be truncated:
    //  1. the message got its copy control (the app itself saying "done")
    //  2. we SAW the stop control and now it is gone, with the text stable
    //  3. nothing changed for N polls (WEAK: could be a mid-answer pause).
    //     N is 3 once generation was observed (we know it finished), else 6: fast
    //     answers never show the stop control, and 6 unchanged polls (~5.4s) is
    //     already a strong hint the turn is over without paying the old 20s.
    if (idle >= 1 && ((await countCopies()) || 0) > preCopies) { log("finalizado por copy-control"); break; }
    if (idle >= 1 && sawGenerating && !gen) { log("finalizado por fin de generacion (stop control ausente)"); break; }
    const idleLimit = sawGenerating ? 3 : 6;
    if (idle >= idleLimit) { log(`finalizado por inactividad (${idle} polls sin cambio) - senal DEBIL, respuesta posiblemente incompleta`); break; }
    stable = now || "";
  }
  if (!reply) {
    // Diagnose instead of dying blind: what does the page actually say?
    const diag = await evaluate(ws, `(() => {
      const main = document.querySelector('main') || document.querySelector('div[role="main"]');
      const mainTxt = (main ? main.innerText : '').replace(/\\s+/g,' ').trim();
      const alerts = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"], .error, .alert'))
        .map(e => (e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 5);
      return { md: document.querySelectorAll('.ur-markdown').length,
               mainChars: mainTxt.length,
               main: mainTxt.slice(0, 500),
               alerts,
               url: location.href.slice(0,90) };
    })()`).catch((e) => ({ err: String(e) }));
    log("DIAG sin respuesta:", JSON.stringify(diag));
    throw new Error("Meta no genero respuesta nueva (envio fallido o hilo degenerado)");
  }
  return reply;
}

function pickWorker() {
  // round-robin, preferring free workers
  for (let k = 0; k < workers.length; k++) {
    const w = workers[(nextWorker + k) % workers.length];
    if (!w.busy) { nextWorker = (nextWorker + 1) % workers.length; return w; }
  }
  const w = workers[nextWorker % workers.length];
  nextWorker = (nextWorker + 1) % workers.length;
  return w; // all busy: queue on this one
}

function submit(content, copy_at = null, mode = MODE_DEFAULT) {
  const jobId = "job-" + randomUUID();
  jobs.set(jobId, { job_id: jobId, status: "queued", _input: content, content: "", copy_at, mode, created: new Date().toISOString() });
  const j = jobs.get(jobId);
  function start() {
    const w = pickWorker();
    j.worker = w.id;
    w.queue.push(jobId);
    pump(w);
  }
  setTimeout(start, 0);
  return jobId;
}

async function recycleChrome(reason = "fresh per request") {
  if (chromeProc) { try { chromeProc.kill("SIGTERM"); } catch {} }
  chromeProc = null;
  for (const w of workers) { try { w.ws.close(); } catch {} }
  workers = [];
  log("chrome recycled (" + reason + ")");
}

async function resetThread(worker) {
  // Context guard: save the transcript and open a fresh thread so the model
  // never drifts into hallucination from an overgrown context.
  try {
    const blocks = await evaluate(worker.ws, `(() => Array.from(document.querySelectorAll('.markdown-content')).map(e => {
      const pre = e.querySelector('pre'); const codeEl = pre && pre.querySelector('code');
      return ((codeEl ? codeEl.textContent : (pre ? pre.textContent : e.textContent)) || '').trim();
    }).filter(t => t && !/^(mostrar|show)\\s+razonamiento$/i.test(t)))()`).catch(() => []);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    try { mkdirSync(TRANSCRIPTS_DIR, { recursive: true }); } catch {}
    writeFileSync(`${TRANSCRIPTS_DIR}/${ts}-transcripto.txt`,
      `TRANSCRIPTO (${blocks.length} bloques) ${new Date().toISOString()}\n\n${blocks.join("\n\n---\n\n")}\n`);
    const ok = await evaluate(worker.ws, `(() => { location.href = "https://www.meta.ai"; return true; })()`).catch(() => false);
    await sleep(3500);
    log("contexto reiniciado: transcripto guardado + navegado a hilo nuevo (ok=" + ok + ")");
  } catch (e) { log("resetThread error:", String(e.message || e)); }
}

async function pump(worker) {
  if (worker.busy) return;
  const jobId = worker.queue.shift();
  if (!jobId) return;
  const j = jobs.get(jobId);
  worker.busy = true;
  j.status = "running";
  clearIdleTimer(); // work is happening: cancel any pending auto-close
  try {
    if ((worker.turns || 0) >= RESET_TURNS) {
      await resetThread(worker);
      worker.turns = 0;
    }
    j.content = await askMeta(worker, j._input, j, j.mode || MODE_DEFAULT);
    worker.turns = (worker.turns || 0) + 1;
    j.status = "done";
    if (j.copy_at) {
      try {
        const len = (j.content || "").length;
        const k = Math.max(0, Math.min(len, Math.floor((len * (Number(j.copy_at) || 0)) / 100)));
        const partial = (j.content || "").slice(0, k);
        writeFileSync("/home/test/test/copia-meta-80.txt", "COPIA " + j.copy_at + "% (len " + len + "):\n\n" + partial);
        await evaluate(worker.ws, `(() => { const b=Array.from(document.querySelectorAll('.msg-copy')); if (b.length) { b[b.length-1].click(); return true; } return false; })()`).catch(() => false);
        log("copia_automatica:", j.copy_at + "% len=" + len);
      } catch (e) { log("copy_at error:", String(e.message || e)); }
    }
  } catch (err) {
    j.status = "error";
    j.error = String(err.message || err);
  } finally {
    worker.busy = false;
    // Keep the browser + thread alive on success so the conversation
    // continues in the same visible window. Recycle only on error (or FRESH).
    if (FRESH || j.status === "error") try { await recycleChrome(); } catch {}
    pump(worker);
    // Browser is idle once the queue drains: arm the auto-close.
    if (activeJobs() === 0) scheduleIdleClose();
    // Prune the finished job: it retains _input (the whole prompt) and finished
    // jobs were never deleted — a slow memory leak on a long-running broker.
    // A TTL keeps /v1/jobs/{id} pollable for late async clients.
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000).unref?.();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj, null, 2)); };

  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, {
      status: "ok",
      workers: workers.map((w) => ({ id: w.id, busy: w.busy, q: w.queue.length })),
      // Count only ACTIVE work. `jobs.size` counted every job ever submitted
      // (finished ones were never pruned), so /health grew without bound and
      // reported "pending" work that did not exist.
      jobs_pending: [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running").length,
      // Honest self-report: /async is a deferred job handle, not parallelism.
      concurrency: workers.length,
      async_semantics: workers.length > 1 ? "parallel-across-tabs" : "serialized-single-tab",
      mode_default: MODE_DEFAULT,
      cooldown_until: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
      // Idle lifecycle visibility: is Chrome open, when will it auto-close, and
      // which conversation will the next request resume.
      browser_open: !!chromeProc,
      idle_close_ms: IDLE_CLOSE_MS,
      idle_closes_at: idleTimer ? new Date(idleDeadline).toISOString() : null,
      resume_url: lastThreadUrl,
    });
  }
  // Warms the browser without sending anything: opens START_URL (home or a
  // reopened /prompt/<uuid>) so an operator can confirm the thread is loaded.
  if (req.method === "GET" && url.pathname === "/warmup") {
    clearIdleTimer();
    try { await ensureChrome(); } catch (err) { return json(502, { error: { message: String(err.message || err) } }); }
    scheduleIdleClose();
    return json(200, { status: "ok", workers: workers.length, url: (workers[0] && workers[0].url) || null });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(200, { object: "list", data: [
      { id: "meta-ai", object: "model", owned_by: "meta-ai-headless", created: 0 },
      { id: "meta-ai-chat", object: "model", owned_by: "meta-ai-headless", created: 0 },
    ]});
  }
  if (req.method === "POST" && url.pathname === "/v1/browser/close") {
    if (chromeProc) { try { chromeProc.kill("SIGTERM"); } catch {} }
    chromeProc = null; workers = [];
    return json(200, { closed: true, workers: 0 });
  }
  if (req.method === "POST" && url.pathname === "/v1/jobs/purge") {
    let purged = 0;
    for (const [k, j] of jobs) {
      if (j.status === "queued") { jobs.delete(k); purged++; }
    }
    for (const w of workers) { w.queue = []; }
    return json(200, { purged });
  }
  if (req.method === "GET" && url.pathname.startsWith("/v1/jobs/")) {
    const j = jobs.get(url.pathname.slice("/v1/jobs/".length));
    if (!j) return json(404, { error: { message: "job not found" } });
    return json(200, { job_id: j.job_id, status: j.status, content: j.content || null, error: j.error || null, worker: j.worker ?? null });
  }

  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/chat/completions/async")) {
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return json(400, { error: { message: "invalid JSON" } }); }
    const msgs = Array.isArray(payload.messages) ? payload.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m && m.role === "user" && String(m.content ?? "").trim());
    if (!lastUser) return json(400, { error: { message: "messages[].role user required" } });
    const content = String(lastUser.content).trim();
    const mode = resolveMode(payload.mode);

    clearIdleTimer();
    try { await ensureChrome(); } catch (err) { return json(502, { error: { message: String(err.message || err) } }); }
    scheduleIdleClose();

    if (Date.now() < cooldownUntil) {
      const wait = Math.ceil((cooldownUntil - Date.now()) / 1000);
      return json(503, { error: { message: `Meta esta en cooldown (bloqueo de tasa). Reintenta en ${wait}s.` }, retry_after: wait });
    }

    if (payload.stream === true) {
      // OpenAI-style SSE. An OpenAI client (and the AI SDK OpenCode uses) decides
      // a stream is complete only when a chunk carries a CHOICE-level
      // `finish_reason`. The old code put it INSIDE `delta`, which nothing reads,
      // so the client failed with "stream ended without finish_reason". Emit real
      // `chat.completion.chunk` objects: roles first, content deltas, then
      // `delta: {}` + `finish_reason: "stop"`, then the `[DONE]` sentinel.
      const jobId = submit(content, Number(payload.copy_at) || null, mode);
      const model = payload.model || "meta-ai";
      const chunkId = "chatcmpl-" + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta, finishReason = null) => ({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      // writeHead alone does NOT flush in Node: without this, a client whose first
      // delta arrives late hits undici's 300s headers timeout and loses the answer.
      res.flushHeaders();
      res.write(": stream abierto\n\n");
      // OpenAI opens with an assistant-role chunk; clients use it to start the message.
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
      let sent = 0;
      let hb = 0;
      const iv = setInterval(() => {
        const j = jobs.get(jobId);
        if (!j) {
          res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
          res.end("data: [DONE]\n\n");
          clearInterval(iv);
          return;
        }
        // heartbeat keeps proxies/clients alive while Meta is still typing
        if (++hb % 5 === 0) res.write(": hb\n\n");
        const cur = j.content || "";
        if (j.status === "done") {
          if (cur.length > sent) res.write(`data: ${JSON.stringify(chunk({ content: cur.slice(sent) }))}\n\n`);
          res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
          res.end("data: [DONE]\n\n");
          clearInterval(iv);
          return;
        }
        if (j.status === "error") {
          // Errors mid-stream are not part of the OpenAI chunk contract; close the
          // stream cleanly so the client never hangs, and keep the reason in the log.
          log("stream job error:", j.error);
          res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
          res.end("data: [DONE]\n\n");
          clearInterval(iv);
          return;
        }
        if (cur.length > sent) {
          res.write(`data: ${JSON.stringify(chunk({ content: cur.slice(sent) }))}\n\n`);
          sent = cur.length;
        }
      }, 700);
      req.on("close", () => clearInterval(iv));
      return;
    }

    if (url.pathname.endsWith("/async")) {
      const jobId = submit(content, Number(payload.copy_at) || null, mode);
      return json(202, { job_id: jobId, status: "queued", poll: `/v1/jobs/${jobId}` });
    }

    // sync OpenAI style: wait for the job to finish
    const jobId = submit(content, Number(payload.copy_at) || null, mode);
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const j = jobs.get(jobId);
      if (j.status === "done" || j.status === "error") {
        if (j.status === "error") return json(502, { error: { message: j.error } });
        return json(200, {
          id: "chatcmpl-" + randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: payload.model || "meta-ai",
          choices: [{ index: 0, message: { role: "assistant", content: j.content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    }
    return json(504, { error: { message: "timeout esperando al worker" } });
  }
  return json(404, { error: { message: "not found" } });
}

process.on("SIGINT", () => { if (chromeProc) try { chromeProc.kill("SIGTERM"); } catch {} process.exit(0); });
http.createServer(route).listen(PORT, HOST, () => {
  log(`meta-ai broker async on http://${HOST}:${PORT} (workers=${WORKERS}, mode=${VISIBLE ? "visible" : "hidden"}, fresh=${FRESH ? "yes" : "no"})`);
});