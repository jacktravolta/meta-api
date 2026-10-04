#!/usr/bin/env node
/** Meta AI over OpenAI API — the "model" is a browser scrape to Meta AI,
 * driven through CDP, behind a worker-tab broker.
 *
 *   POST /v1/chat/completions        OpenAI-compatible (sync; auto-queues).
 *   POST /v1/chat/completions/async  Deferred, NOT concurrent: returns
 *                                    {job_id} immediately; poll GET /v1/jobs/{id}.
 *   GET  /v1/jobs/{job_id}           {job_id, url, status, content?, error?}
 *   GET  /v1/models · GET /health
 *   POST /v1/browser/close           Closes the chrome process (and clears pool).
 *   Idle lifecycle: after META_IDLE_CLOSE_MS with no activity (no jobs AND no
 *   human typing in a visible window) the browser auto-closes. The next request
 *   reopens the SAME conversation (remembered thread URL + persisted profile),
 *   so the session resumes instead of starting fresh.
 *
 * Broker: ONE Chrome process with a dynamic pool of page tabs (workers), between
 * META_MIN_WORKERS and META_MAX_WORKERS. Each tab is an independent Meta
 * conversation and serializes its own queue. A request that finds every worker
 * busy grows the pool; past the cap it queues on the least loaded worker.
 * Worker 0 is the primary and the only one that resumes the remembered thread.
 * Calling "/async" is about the HTTP contract (job id instead of a held
 * connection), not about parallelism.
 *
 * Context: Meta exposes no token counter, so usage is estimated from what this
 * broker sent and received. At META_CONTEXT_SOFT_PCT the thread is rotated:
 * Meta is asked to summarize, the summary is saved, the old thread is deleted
 * from Meta's own UI, a fresh thread opens and the summary is replayed as
 * context so the conversation continues.
 *
 * Recovery: queued jobs are mirrored to pending-jobs.json and re-dispatched on
 * boot. Chrome dying is handled in-memory by recycling the pool and rescuing
 * jobs that had not yet reached the browser.
 *
 * No dependencies: Node 22 native fetch + WebSocket + http.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// HARD GUARD: this file needs the GLOBAL WebSocket, which only exists in Node >= 21.
// The distro node (/usr/bin/node) is 18.x, so anything started OUTSIDE an
// interactive shell (systemd, cron @reboot, a .desktop launcher) silently ran on
// Node 18 and died later with "WebSocket is not defined" — hours after the cause.
// Fail at boot, loudly, instead.
const [NODE_MAJOR] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR < 22) {
  console.error(
    `[meta-api] ABORTANDO: se requiere Node >= 22 (WebSocket global) y este binario es ${process.version} (${process.execPath}).\n` +
    `[meta-api] Usa el Node de nvm: /home/test/.nvm/versions/node/v22.23.3/bin/node`
  );
  process.exit(1);
}

const PORT = Number(process.env.META_API_PORT || 8055);
const HOST = process.env.META_API_HOST || "127.0.0.1";
const CHROME = process.env.META_CHROME || "/usr/bin/google-chrome-beta";
const PROFILE = process.env.META_PROFILE ||
  "/home/test/.config/google-chrome-beta-debug";
const CDP_PORT = Number(process.env.META_CDP_PORT || 9233);
// Worker pool. MIN tabs exist up front; the pool GROWS on demand up to MAX, so two
// concurrent sessions never share a tab (and therefore never share a composer and
// cannot corrupt each other's prompt). Beyond MAX the extra requests queue on the
// least busy worker instead of piling into one conversation.
const MIN_WORKERS = Math.max(1, Number(process.env.META_MIN_WORKERS || process.env.META_WORKERS || 1));
const MAX_WORKERS = Math.max(MIN_WORKERS, Number(process.env.META_MAX_WORKERS || 10));
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
// Context rotation has a single mechanism with two triggers: the estimated
// percentage (META_CONTEXT_SOFT_PCT) and a turn backstop (META_RESET_TURNS).
// Both route through rotateThread, so the conversation always continues with its
// context. Previously a separate resetThread() ran first and started a fresh
// thread WITHOUT replaying a summary, silently dropping the conversation every
// RESET_TURNS requests.
const RESET_TURNS = Number(process.env.META_RESET_TURNS || 60);
// Context rotation. Meta's web UI exposes NO token/context counter, so usage is
// ESTIMATED from the size of the thread against a configurable character budget.
// At or above SOFT_PCT the broker asks Meta to summarize, deletes the old thread
// from Meta's UI, opens a fresh one and replays the summary as context, so the
// conversation continues instead of degrading into truncated answers.
const CONTEXT_BUDGET_CHARS = Number(process.env.META_CONTEXT_BUDGET_CHARS || 150000);
const CONTEXT_SOFT_PCT = Number(process.env.META_CONTEXT_SOFT_PCT || 70);
// Starting estimate for a thread we resume but never saw being built.
const CONTEXT_SEED_CHARS = Number(process.env.META_CONTEXT_SEED_CHARS || 25000);
// ---- Image attachments ------------------------------------------------------
// OpenAI-style multimodal content: content is an ARRAY of parts, not a string.
// Stringifying it yields "[object Object],[object Object]", which is what Meta
// used to receive when a screenshot was pasted into the chat.
const IMAGES_DIR = process.env.META_IMAGES_DIR || "/tmp/opencode/meta-images";
const MAX_IMAGE_BYTES = Number(process.env.META_MAX_IMAGE_BYTES || 20 * 1024 * 1024);

function parseUserContent(raw) {
  if (typeof raw === "string") return { text: raw.trim(), images: [] };
  if (!Array.isArray(raw)) return { text: String(raw ?? "").trim(), images: [] };
  let text = "";
  const images = [];
  for (const part of raw) {
    if (part == null) continue;
    if (typeof part === "string") { text += part; continue; }
    const type = String(part.type || "");
    if (type === "text" || type === "input_text") { text += part.text || ""; continue; }
    if (type === "image_url" || type === "input_image" || type === "image" || type === "image_file") {
      const url = typeof part.image_url === "string" ? part.image_url
        : part.image_url?.url || part.image || part.url || part.file_url;
      if (url) images.push(String(url));
      continue;
    }
    if (part.text) text += part.text;   // unknown part: keep any text it carries
  }
  return { text: text.trim(), images };
}

// Turn any supported image reference into a real file on disk, because CDP's
// DOM.setFileInputFiles needs a path.
async function saveImageToFile(url, idx) {
  let buf, ext = ".png";
  const dataUrl = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(url);
  if (dataUrl) {
    ext = "." + (dataUrl[1] === "jpeg" ? "jpg" : dataUrl[1].replace("+xml", ""));
    buf = Buffer.from(dataUrl[2], "base64");
  } else if (/^https?:\/\//i.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`descarga de imagen HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    const ct = String(r.headers.get("content-type") || "").split("/")[1] || "";
    if (ct) ext = "." + ct.replace("+xml", "").split(";")[0];
  } else if (/^file:\/\//i.test(url)) {
    buf = readFileSync(fileURLToPath(url));
    ext = "." + (url.split(".").pop() || "png").split(/[?#]/)[0];
  } else {
    throw new Error("formato de imagen no soportado (data:, http(s): o file://)");
  }
  if (!buf || !buf.length) throw new Error("imagen vacia");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`imagen de ${Math.round(buf.length / 1048576)}MB supera el maximo`);
  mkdirSync(IMAGES_DIR, { recursive: true });
  const path = `${IMAGES_DIR}/${Date.now()}-${idx}${ext}`;
  writeFileSync(path, buf);
  return path;
}

// Hand the files to Meta's real <input type="file"> and wait until the previews
// render. Sending the text before the upload lands makes Meta dispatch the prompt
// with the image missing, so this wait is load-bearing, not cosmetic.
async function attachImages(ws, imageUrls) {
  if (!imageUrls || !imageUrls.length) return { ok: true, attached: 0 };
  // Remove leftover chips FIRST. clearComposer() clears text but not attachments,
  // so every failed run left its image stuck in the composer and the next run
  // started with a polluted one (a stale chip was what "chip de imagen visible"
  // was reporting). Each chip carries a remove control (button, 16x16, absolute
  // end-0.5). Clean, then attach.
  const removed = await evaluate(ws, `(() => {
    const chips = Array.from(document.querySelectorAll('span.inline-image-node'));
    let n = 0;
    for (const chip of chips) {
      const btn = chip.parentElement?.querySelector('button');
      if (btn) { btn.click(); n++; }
    }
    return n;
  })()`).catch(() => 0);
  if (removed) { log(`limpiados ${removed} chip(s) de imagen del intento anterior`); await sleep(1200); }
  const files = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try { files.push(await saveImageToFile(imageUrls[i], i)); }
    catch (e) { log(`imagen ${i + 1} descartada:`, String(e.message || e)); }
  }
  if (!files.length) return { ok: false, attached: 0, why: "ninguna imagen se pudo preparar" };

  try {
    // DOM.enable is required: Page.enable does not turn the DOM domain on, and
    // DOM.getDocument without it errors instead of returning a tree.
    await cdpCall(ws, ++cdpSeq, "DOM.enable").catch(() => {});
    // cdpCall resolves with m.result (not the whole CDP message), so the shapes
    // here are {root:{nodeId}} and {nodeId}.
    const doc = await cdpCall(ws, ++cdpSeq, "DOM.getDocument", { depth: -1 });
    const rootId = doc?.root?.nodeId;
    if (!rootId) throw new Error("DOM.getDocument no devolvio root");
    const q = await cdpCall(ws, ++cdpSeq, "DOM.querySelector", { nodeId: rootId, selector: 'input[type="file"]' });
    const inputNodeId = q?.nodeId;
    if (!inputNodeId) throw new Error("Meta no expone input[type=file] en esta pagina");
    await cdpCall(ws, ++cdpSeq, "DOM.setFileInputFiles", { files, nodeId: inputNodeId });
    log(`imagenes adjuntas: ${files.length} archivo(s) -> input[type=file]`);
  } catch (e) {
    for (const f of files) { try { unlinkSync(f); } catch {} }
    return { ok: false, attached: 0, why: String(e.message || e) };
  }

  // Readiness signal, measured from the live DOM: attaching a file renders
  // SPAN.inline-image-node containing an IMG with a blob: src, and Meta raises a
  // busy indicator while uploading. The previous selectors ([data-testid*=attachment]
  // and a document-wide blob count) never matched: the chip carries a CLASS, not
  // a testid, and the profile avatar already contributed a blob so the delta never
  // grew. Wait for the chip scoped to the composer, then for progress to clear.
  const probe = `(() => ({
     chip: document.querySelectorAll('span.inline-image-node').length,
     imgs: document.querySelectorAll('span.inline-image-node img[src^="blob:"]').length,
     busy: document.querySelectorAll('[role="progressbar"], [aria-busy="true"], progress').length,
  }))()`;
  // Attachment works without any chip being observable on a thread page: the chip
  // only renders on the home composer, so waiting for span.inline-image-node cost
  // 90s per image request and then reported a failure that was never real. Meta
  // attaches from setFileInputFiles regardless. Give the upload a short settle
  // window and move on.
  let sawChip = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const now = await evaluate(ws, probe).catch(() => null);
    if (now && now.chip > 0) { sawChip = true; break; }
  }
  if (sawChip) log("chip de imagen visible");
  else log("sin chip observable (normal en un hilo): el adjunto se confirmo igual");
  return { ok: true, attached: files.length, chip: sawChip };
}

function cleanupImages(files) {
  for (const f of files || []) { try { unlinkSync(f); } catch {} }
}

const TRANSCRIPTS_DIR = process.env.META_TRANSCRIPTS_DIR || "/home/test/test/transcriptos";

let chromeProc = null;
let workers = [];          // [{id,ws,page,wsUrl,url,conversation,queue,busy}]
let nextWorker = 0;
const jobs = new Map();    // job_id -> {status,content,error,url,created}
let cdpSeq = 0;
let idleTimer = null;    // pending auto-close after inactivity
let idleDeadline = 0;    // epoch ms when that auto-close fires (for /health)
// Session memory must survive a service restart or a reboot, not just the browser
// going idle: lastThreadUrl used to be a module variable, so every restart dropped
// the conversation and the next request reopened the bare home screen.
const STATE_FILE = process.env.META_STATE_FILE ||
  "/home/test/test/meta-api/state.json";
const isThreadUrl = (u) => typeof u === "string" &&
  /^https:\/\/(www\.)?meta\.ai\/prompt\/[0-9a-f-]{8,}/i.test(u);

function loadThreadUrl() {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const url = JSON.parse(raw)?.lastThreadUrl;
    if (isThreadUrl(url)) return url;
  } catch { /* first run, or unreadable: start from home */ }
  return null;
}
function saveThreadUrl(url) {
  try { writeFileSync(STATE_FILE, JSON.stringify({ ...loadStateRaw(), lastThreadUrl: url, savedAt: new Date().toISOString() }, null, 2) + "\n"); }
  catch (e) { log("aviso: no pude guardar la sesion:", String(e.message || e)); }
}
function loadStateRaw() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch { return {}; }
}
// The summary that seeds the fresh thread, kept so a crash between the summary and
// the new tab does not lose it.
function saveSummary(summary, pct) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      ...loadStateRaw(), lastSummary: summary, summaryAt: new Date().toISOString(), summaryPct: pct,
    }, null, 2) + "\n");
  } catch (e) { log("aviso: no pude guardar el resumen:", String(e.message || e)); }
}

const RESUMED_URL = loadThreadUrl();
let lastThreadUrl = RESUMED_URL || START_URL; // last conversation to reopen (same session)

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
    // Persist only REAL thread URLs; the bare home screen is not worth storing.
    if (isThreadUrl(href)) {
      if (href !== lastThreadUrl) { lastThreadUrl = href; saveThreadUrl(href); log("sesion guardada:", href.slice(0, 80)); }
    } else if (href && /meta\.ai/.test(href)) {
      lastThreadUrl = href;
    }
  } catch { /* best-effort: keep the previous URL */ }
}
// Measured context usage of a worker's thread, as a percentage of the assumed
// budget. textContent is used on purpose: innerText returns "" for a window Chrome
// is not compositing, which would report a busy thread as empty.
async function threadChars(ws) {
  const r = await evaluate(ws, `(() => {
    const strip = (e) => ((e && e.textContent) || '').length;
    const md = document.querySelectorAll('.ur-markdown');
    let mdChars = 0; for (const e of md) mdChars += strip(e);
    const main = document.querySelector('main') || document.querySelector('div[role="main"]');
    return {
      url: location.href,
      mdBlocks: md.length, mdChars,
      mainChars: strip(main), bodyChars: strip(document.body),
      mainTag: main ? main.tagName + (main.className ? '.' + String(main.className).split(' ')[0] : '') : null,
    };
  })()`).catch(() => null);
  if (!r) return 0;
  if (!ws.__ctxProbed) {
    ws.__ctxProbed = true;
    log("contexto: sonda inicial " + JSON.stringify(r));
  }
  // Prefer the assistant markdown blocks; fall back to the main region, then the
  // whole body. The thread is VIRTUALIZED, so only part of it is ever in the DOM —
  // which is exactly why this can only ever be an estimate.
  if (r.mdChars > 200) return r.mdChars;
  if (r.mainChars > 200) return r.mainChars;
  return r.bodyChars || 0;
}

// ESTIMATED context usage, counted from what this broker itself sent and received
// on that worker. The page cannot be used for this: the thread is VIRTUALIZED, so
// `main` is nearly empty (250 chars on a long thread) while `body` is ~190k chars of
// React/JSON payload. Measured evidence: mdBlocks 5 with 10 chars of actual text.
// Meta exposes no token counter, so this is a proxy — tune the budget, do not trust
// it as an exact percentage.
async function contextUsage(worker, incoming) {
  const prior = worker.ctxChars || 0;
  const chars = prior + String(incoming || "").length;
  const pct = Math.round((chars / Math.max(1, CONTEXT_BUDGET_CHARS)) * 100);
  return { chars, pct };
}

const MOUSE = (type, x, y, clickCount = 0, buttons = 0) =>
  cdpCall(ws => ws, ++cdpSeq, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount, buttons, pointerType: "mouse" });
// Delete a conversation through Meta's OWN frontend: hover the item, open its
// "Más opciones" dropdown, click "Eliminar", confirm. Verified end to end in
// visible mode (40 -> 39 threads, active thread untouched).
//
// Headless caveat: the dropdown is a Radix popover that did not materialise in
// headless runs during development. A failure here is NEVER fatal: rotation
// continues, we only keep the extra thread around.
async function deleteThreadInMeta(ws, url) {
  const uuid = (String(url || "").match(/prompt\/([0-9a-f-]{8,})/) || [])[1];
  if (!uuid) return { ok: false, why: "sin uuid en la url" };
  const mouse = (type, x, y, clickCount = 0, buttons = 0) =>
    cdpCall(ws, ++cdpSeq, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount, buttons, pointerType: "mouse" });
  try {
    await cdpCall(ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
    // The dropdown only opens on a tab Chrome is actually compositing.
    await evaluate(ws, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /barra lateral/i.test(x.getAttribute('aria-label')||''));
      const nav = document.querySelector('nav');
      if (b && nav && nav.getBoundingClientRect().width <= 50) b.click();
      return true;
    })()`).catch(() => {});
    await sleep(1200);

    const count = async () => await evaluate(ws, `document.querySelectorAll('[data-testid="conversation-item"]').length`).catch(() => 0);
    const before = await count();

    const geo = await evaluate(ws, `(() => {
      const li = Array.from(document.querySelectorAll('[data-testid="conversation-item"]'))
        .find(x => (x.innerHTML||'').includes(${JSON.stringify(uuid)}));
      if (!li) return null;
      li.scrollIntoView({ block: 'center' });
      const r = li.getBoundingClientRect();
      return { ix: r.left + r.width/2, iy: r.top + r.height/2 };
    })()`);
    if (!geo) return { ok: false, why: "el hilo no aparece en el historial", before, after: before };
    await sleep(500);

    // Hover first: the trigger is a group-hover control.
    await mouse("mouseMoved", geo.ix, geo.iy); await sleep(700);
    const trig = await evaluate(ws, `(() => {
      const li = Array.from(document.querySelectorAll('[data-testid="conversation-item"]'))
        .find(x => (x.innerHTML||'').includes(${JSON.stringify(uuid)}));
      if (!li) return null;
      const t = li.querySelector('[data-slot="dropdown-menu-trigger"]') ||
                Array.from(li.querySelectorAll('button,[role="button"]')).find(x => /m.s opciones|more options/i.test(x.getAttribute('aria-label')||''));
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);
    if (!trig) return { ok: false, why: "sin boton 'Mas opciones'", before, after: before };

    await mouse("mouseMoved", trig.x, trig.y); await sleep(500);
    await mouse("mousePressed", trig.x, trig.y, 1, 1); await sleep(70);
    await mouse("mouseReleased", trig.x, trig.y, 1, 0);

    let del = null;
    for (let i = 0; i < 12 && !del; i++) {
      await sleep(400);
      del = await evaluate(ws, `(() => {
        const c = document.querySelector('[data-slot="dropdown-menu-content"]');
        if (!c) return null;
        const it = Array.from(c.querySelectorAll('[data-slot="dropdown-menu-item"]'))
          .find(e => /eliminar|delete/i.test((e.innerText||e.textContent||'').trim()));
        if (!it) return null;
        const r = it.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
    }
    if (!del) return { ok: false, why: "el menu no abrio o no tiene 'Eliminar'", before, after: before };
    await mouse("mousePressed", del.x, del.y, 1, 1); await sleep(70);
    await mouse("mouseReleased", del.x, del.y, 1, 0);
    await sleep(1800);

    // Meta asks for confirmation.
    const yes = await evaluate(ws, `(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
      const b = Array.from(document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button'))
        .filter(vis).find(x => /eliminar|delete/i.test((x.innerText||x.textContent||'').trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);
    if (yes) {
      await mouse("mousePressed", yes.x, yes.y, 1, 1); await sleep(70);
      await mouse("mouseReleased", yes.x, yes.y, 1, 0);
      await sleep(2500);
    }

    const after = await count();
    const gone = after < before;
    return { ok: gone, before, after, why: gone ? "" : "el hilo sigue en el historial" };
  } catch (e) {
    return { ok: false, why: String(e.message || e) };
  }
}

const SUMMARY_PROMPT = `Necesito que resumas esta conversación para poder continuar en un hilo nuevo sin perder nada. Escribí un resumen autocontenido que incluya: (1) el objetivo del trabajo, (2) las decisiones tomadas y sus motivos, (3) el estado actual exacto, (4) archivos, funciones o comandos concretos mencionados con sus nombres exactos, (5) lo que falta hacer y el siguiente paso. No me pidas confirmaciones ni hagas preguntas: solo el resumen, en texto plano, sin listas de tareas pendientes sin contexto.`;

async function rotateThread(worker, pct, reason = "limite de contexto") {
  log(`rotando el hilo (${reason}, ${pct}% del presupuesto de ${CONTEXT_BUDGET_CHARS} chars): pidiendo resumen`);
  let summary = "";
  try {
    summary = (await askMeta(worker, SUMMARY_PROMPT, null, MODE_DEFAULT)) || "";
  } catch (e) {
    log("no pude resumir el hilo:", String(e.message || e));
  }
  if (!summary.trim()) {
    log("resumen vacio: NO roto el hilo (seguir en el actual es mas seguro)");
    return null;
  }
  // Keep the outgoing thread and the summary on disk before touching the tab.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    writeFileSync(`${TRANSCRIPTS_DIR}/${ts}-resumen-rotacion.txt`,
      `RESUMEN POR ROTACION DE CONTEXTO (${pct}%)\n\n${summary}\n`);
  } catch { /* best-effort */ }
  saveSummary(summary, pct);

  // Discard the outgoing thread so the history does not fill up. Best effort: if
  // the UI flow fails we still rotate, we just keep one extra thread around.
  const oldUrl = lastThreadUrl;
  if (isThreadUrl(oldUrl)) {
    // Hard isolation: deleting the old thread is a nicety, rotating is the job.
    // A throw here (as a ReferenceError once did) must not fail the request.
    let del = { ok: false, why: "excepcion inesperada" };
    try { del = await deleteThreadInMeta(worker.ws, oldUrl); }
    catch (e) { log("borrado lanzo excepcion:", String(e.message || e)); }
    log(del.ok
      ? `hilo anterior eliminado del historial (${del.before} -> ${del.after} hilos)`
      : `no pude eliminar el hilo anterior (${del.why}); roto igual`);
  }

  // Fresh thread, then replay the summary as the context the user never saw.
  const opened = await evaluate(worker.ws, `(() => { location.href = ${JSON.stringify(START_URL)}; return true; })()`).catch(() => false);
  if (!opened) { log("no pude abrir el hilo nuevo: sigo en el actual"); return null; }
  await sleep(4000);
  worker.turns = 0;
  await attachComposer(worker);
  log(`hilo rotado. resumen de ${summary.length} chars inyectado como contexto`);
  return summary;
}

// Wrap the user's message with the recovered summary so the new thread continues
// as if nothing had been cut.
function withRecoveredContext(summary, userContent) {
  return `Contexto recuperado de una conversación anterior (resumen automatico por limite de contexto):\n\n${summary}\n\n---\n\nContinuá la conversación desde ese punto. Este es el nuevo mensaje del usuario:\n\n${userContent}`;
}

// How long ago did a HUMAN last touch the page (typing, clicking, scrolling)?
// The broker only knows about its own jobs, so without this the idle timer would
// close the window while the user was typing in it. Returns Infinity when the
// tracker is missing or there is no page to ask.
async function msSincePageInteraction() {
  const w = workers[0];
  if (!w || !w.ws) return Infinity;
  const r = await evaluate(w.ws, `(() => {
    if (typeof window.__metaLastInteract !== "number") return -1;
    return Date.now() - window.__metaLastInteract;
  })()`).catch(() => -1);
  const ms = typeof r === "number" ? r : -1;
  return ms < 0 ? Infinity : ms; // tracker absent: do not block the close
}

// Arm the auto-close. Real broker work clears it (see pump/route handlers);
// `delay` lets us re-arm for only the time actually left.
function scheduleIdleClose(delay = IDLE_CLOSE_MS) {
  clearIdleTimer();
  if (!(IDLE_CLOSE_MS > 0)) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    idleDeadline = 0;
    if (activeJobs() > 0) { scheduleIdleClose(); return; } // we are answering: never close
    if (!chromeProc) return;                               // already closed
    // The user typing/scrolling in the visible window counts as activity too.
    const sinceUser = await msSincePageInteraction();
    if (sinceUser < IDLE_CLOSE_MS) {
      const left = Math.max(1000, Math.round(IDLE_CLOSE_MS - sinceUser));
      log(`idle postergado ${left}ms: el usuario interactuo hace ${Math.round(sinceUser / 1000)}s`);
      scheduleIdleClose(left);
      return;
    }
    await rememberThreadUrl();
    await recycleChrome(`inactivo ${Math.round(IDLE_CLOSE_MS / 1000)}s`);
    log(`idle: browser cerrado tras inactividad; la proxima peticion reabre ${lastThreadUrl}`);
  }, delay);
  idleDeadline = Date.now() + delay;
  idleTimer.unref?.();
}

let ensuringChrome = null;

// Bonus: hide the automation fingerprint on every new document, and record human
// interaction so the idle timer can tell that someone is typing in a visible tab.
const STEALTH = `(() => {
    const wd = Object.getOwnPropertyDescriptor(Window.prototype, 'webdriver');
    if (wd) Object.defineProperty(window, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });

    window.__metaLastInteract = Date.now();
    const markInteract = () => { window.__metaLastInteract = Date.now(); };
    for (const ev of ['input','keydown','keyup','paste','click','mousedown','wheel','scroll']) {
      window.addEventListener(ev, markInteract, true);
    }
  })();`;

// Wait until this tab has a VISIBLE composer. Requires bringToFront first: a
// background tab measures 0x0 forever and the visibility check would reject the
// real composer even though it is there.
async function attachComposer(w) {
  await cdpCall(w.ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const has = await evaluate(w.ws, `!!(${PICK_COMPOSER_JS})`).catch(() => false);
    if (has) return true;
  }
  log(`worker ${w.id}: sin composer visible tras 18s (pestaña ${(w.url || "").slice(0, 70)})`);
  return false;
}

// One independent conversation. `url` decides which thread it opens: worker 0
// resumes the remembered session, extra workers start their OWN thread so parallel
// sessions cannot interleave into the same conversation.
async function createWorkerTab(url) {
  const jsonUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
  let t;
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    t = await r.json();
  } catch {
    const lst = await (await fetch(jsonUrl)).json();
    t = lst.find((x) => x.type === "page" && (x.url || "").includes("meta.ai")) || lst.find((x) => x.type === "page");
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error worker")); });
  await cdpCall(ws, ++cdpSeq, "Page.enable");
  await cdpCall(ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
  try { await cdpCall(ws, ++cdpSeq, "Page.addScriptToEvaluateOnNewDocument", { source: STEALTH }); } catch {}
  return { id: workers.length, ws, pageId: t.id, url: t.url, queue: [], busy: false, turns: 0,
           // A resumed thread already carries history this broker never saw. Seed it
           // so the first measured percentage is not a lie of omission.
           ctxChars: url === lastThreadUrl ? CONTEXT_SEED_CHARS : 0 };
}

// Close every page target that is NOT one of our workers (Chrome's startup tab).
async function closeStrayTabs() {
  try {
    const jsonUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
    const list = await (await fetch(jsonUrl)).json();
    const keep = new Set(workers.map((w) => w.pageId));
    let closed = 0;
    for (const target of list) {
      if (target.type !== "page" || keep.has(target.id)) continue;
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`).catch(() => {});
      closed++;
    }
    if (closed) log(`pestanas sobrantes cerradas: ${closed}`);
  } catch { /* best-effort cleanup */ }
}

let growingPool = null;
// Grow the pool by one, up to MAX. Serialized so N concurrent requests do not all
// try to create a tab at the same instant.
async function growPool() {
  if (growingPool) return growingPool;
  growingPool = (async () => {
    try {
      log(`growPool: llamado (pool=${workers.length}/${MAX_WORKERS}, ocupados=${workers.filter((w) => w.busy).length})`);
      if (workers.length >= MAX_WORKERS) { log("growPool: pool al maximo, no crezco"); return null; }
      // Throws (with the real reason already logged) if the browser is dead.
      await ensureChrome();
      log(`growPool: tras ensureChrome pool=${workers.length}`);
      if (workers.length >= MAX_WORKERS) return null;    // someone else won the race
      // A new worker always opens its OWN thread. Reusing the remembered URL would
      // put two sessions in the same conversation.
      const w = await createWorkerTab(START_URL);
      workers.push(w);
      await attachComposer(w);
      log(`pool crecido: ${workers.length}/${MAX_WORKERS} workers (hilo propio para el worker ${w.id})`);
      return w;
    } catch (e) {
      log("no pude hacer crecer el pool:", String(e.message || e));
      return null;
    } finally { growingPool = null; }
  })();
  return growingPool;
}
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
  // AWAIT IT. killStrays spawns `pkill -f -- --user-data-dir=<PROFILE>`; called
  // without await it runs CONCURRENTLY with the spawn below, so pkill can reach
  // /proc after Chrome already appeared and SIGTERM the instance we just created.
  // Chrome then never opens the debug port and every request dies 21s later with
  // a bare "fetch failed". Intermittent by nature: it depends on who wins the race.
  await killStrays();
  if (chromeProc) { try { chromeProc.kill("SIGTERM"); } catch {} chromeProc = null; workers = []; }
  log(`launching Chrome (${VISIBLE ? "VISIBLE on " + (process.env.DISPLAY || "no DISPLAY") : "headless"}) with ${MIN_WORKERS}+ workers (max ${MAX_WORKERS})…`);
  const args = [
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + CDP_PORT,
    "--no-first-run", "--no-default-browser-check",
    "--disable-component-update", "--disable-background-networking",
    "--disable-gpu", "--no-sandbox", "--disable-sync",
    "--disable-blink-features=AutomationControlled",
    // Minimal chrome: no restore/crash bubbles, no infobar, no "choose your
    // search engine" screen, no background apps. Without these Chrome opens its
    // default New Tab Page (Qwant on this machine) plus a crash-restore prompt.
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-infobars",
    "--disable-search-engine-choice-screen",
    "--no-service-autorun",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    // Launch into a blank page, NOT the NTP, so no search tab is ever created.
    "about:blank",
  ];
  if (!VISIBLE) args.unshift("--headless=new");
  // Do NOT use stdio:"ignore" for stderr: a failed launch used to log nothing at
  // all, which turned every browser problem into guesswork.
  chromeProc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  chromeProc.stderr.on("data", (b) => {
    for (const line of b.toString().split("\n")) {
      const s = line.trim();
      if (!s) continue;
      if (/DevTools listening|TensorFlow|XNNPACK/i.test(s)) continue;      // normal boot noise
      if (/crashpad.*\.lock: File exists/i.test(s)) continue;              // benign: stale crashpad lock
      log("chrome:", s);
    }
  });
  chromeProc.on("exit", (code, signal) => log(`chrome exit code=${code} signal=${signal}`));

  // discover browser page, then open the MINIMUM number of independent workers
  let jsonUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
  let cdpUp = false;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    try { const r = await fetch(jsonUrl); if (r.ok) { cdpUp = true; break; } } catch { /* retry */ }
  }
  // Fail loudly and specifically. Falling through to tab creation just converts a
  // dead browser into an opaque "fetch failed" 21 seconds later.
  if (!cdpUp) {
    try { chromeProc.kill("SIGTERM"); } catch {}
    chromeProc = null; workers = [];
    throw new Error(
      `Chrome no abrio CDP en ${CDP_PORT} tras 21s. Perfil: ${PROFILE}. ` +
      `Revisa las lineas "chrome:" de este log para la causa real.`
    );
  }
  // Worker 0 resumes the remembered thread; any other minimum worker opens its own
  // thread, so sessions never interleave into one conversation.
  for (let i = 0; i < MIN_WORKERS; i++) {
    workers.push(await createWorkerTab(i === 0 ? (lastThreadUrl || START_URL) : START_URL));
  }
  await closeStrayTabs();
  for (const w of workers) await attachComposer(w);
  log(`broker ready: ${workers.length}/${MAX_WORKERS} workers`);
  return true;   // growPool() branches on this: a falsy value silently skipped growth
}

// The page has SEVERAL textareas and the FIRST one is NOT the composer (on the home
// screen it is a different field). Every step that touches the input — focus, verify,
// send, cleared-check — MUST resolve the same element, or typing and sending disagree
// about which box holds the prompt, and the request dies with why:'empty'.
// MUST return null instead of cands[0]: a 0x0 hidden textarea is NOT the composer,
// and returning it made every later step fail silently (CDP clicked at (0,0),
// Input.insertText was swallowed, and the send button stayed disabled).
const PICK_COMPOSER_JS = `(() => {
  // Meta's composer is a Lexical editor. When an image is attached, the
  // <textarea> collapses to 0x0 and the live editable becomes a DIV that shares
  // the same data-testid="composer-input" (measured: textarea 0x0, div 728x50).
  // The old size filter therefore returned null the moment an image was present,
  // and clear/paste/send all silently stopped finding the composer. Prefer the
  // live editor; only then fall back to any visible textarea.
  const live = document.querySelector('div[data-testid="composer-input"][contenteditable="true"], div[data-testid="composer-input"][contenteditable="plaintext-only"]');
  if (live) {
    const r = live.getBoundingClientRect();
    if (r.width > 20 && r.height > 8 && !live.disabled && !live.readOnly) return live;
  }
  const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'));
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 20 || r.height <= 8) return false;
    if (e.disabled || e.readOnly) return false;
    if (e.closest('[aria-hidden="true"]')) return false;
    const st = getComputedStyle(e);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  return cands.find(visible) || null;
})()`;

function keyCodeOf(ch) {
  if (ch === " ") return "Space";
  if (/^[A-Za-z]$/.test(ch)) return "Key" + ch.toUpperCase();
  return "Unidentified";
}

// One cleared-composer routine for both modes. Non-modifier and verified: the
// old Ctrl+A path leaked a literal control byte and ate the head of the prompt.
async function clearComposer(ws) {
  // Use the SAME picker as the paste step. This function used to carry its own
  // copy of the selector (with the old "|| cands[0]" fallback), so it could clear a
  // DIFFERENT element than the one we then type into.
  const STRIP_JS = `s => String(s||'').replace(/[\\s\\u200B-\\u200D\\u2060\\uFEFF\\u00A0]+/g,'')`;
  const clearRes = await evaluate(ws, `(() => {
    const strip = ${STRIP_JS};
    const el = ${PICK_COMPOSER_JS};
    if (!el) return { ok:false, why:'sin composer visible' };
    const read = () => (el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || ''));
    // Strip zero-width chars: Meta/Lexical leaves phantom U+200B nodes, so a fresh
    // composer reads as 1 char and every "did it clear?" check failed for nothing.
    const before = strip(read()).length;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok:true, before, tag: el.tagName, needsKeys: el.tagName !== 'TEXTAREA' };
  })()`).catch((e) => ({ ok:false, why:String(e) }));

  // A Lexical editor keeps its own model: assigning textContent leaves the phantom
  // nodes behind. Clear it with REAL key events (Ctrl+A, Backspace), which is the
  // only thing Lexical honours.
  if (clearRes && clearRes.needsKeys) {
    for (const k of [
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
      { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
      { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    ]) await cdpCall(ws, ++cdpSeq, "Input.dispatchKeyEvent", k).catch(() => {});
  }

  const after = await evaluate(ws, `(() => {
    const strip = ${STRIP_JS};
    const el = ${PICK_COMPOSER_JS};
    if (!el) return 0;
    return strip(el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '')).length;
  })()`).catch(() => -1);

  const res = { ...clearRes, after };
  res.ok = res.ok && after === 0;
  if (!res.ok) log("aviso: no pude limpiar el composer antes de tipear:", JSON.stringify(res));
  else if (res.before) log(`composer limpiado (${res.before} chars previos descartados)`);
  await sleep(120);
  return res;
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

async function pasteReal(ws, content, opts = {}) {
  // opts.skipClear: the caller already cleared, and clearing AFTER attaching
  // wipes the image chip (Ctrl+A + Backspace over contenteditable).
  const SKIP_CLEAR = !!opts.skipClear;
  // Speed mode: ONE native paste instead of thousands of keystrokes, then a
  // human-length pause before the send click. Verification is NOT skipped: a
  // paste that lands truncated must never be sent.
  // Focus with a REAL CDP mouse click, NOT el.focus(). meta.ai's composer is a
  // rich editor that only accepts Input.insertText when the element is genuinely
  // focused at the browser level; a JS .focus() leaves insertText aimed at the
  // document, which is why the paste used to read back 0 chars.
  const rect = await evaluate(ws, `(() => {
    const el = ${PICK_COMPOSER_JS};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`).catch(() => null);
  if (!rect) { log("aviso: no se encontro composer visible para enfocar"); return; }
  // Re-assert foreground: a tab can fall back to the background (another worker
  // activating itself) between job start and now, which zeroes its viewport again.
  await cdpCall(ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
  log(`composer: ${rect.tag} ${Math.round(rect.w)}x${Math.round(rect.h)} en (${Math.round(rect.x)},${Math.round(rect.y)})`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdpCall(ws, ++cdpSeq, "Input.dispatchMouseEvent", {
      type, x: rect.x, y: rect.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
    }).catch(() => {});
  }
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
  const compact = (s) => String(s || "").replace(/[\s-‍⁠﻿ ]+/g, "");
  const readText = async () => await evaluate(ws, `(() => {
    const el = ${PICK_COMPOSER_JS};
    if (!el) return "";
    return el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
  })()`).catch(() => "");

  let got = await readText();
  // RETRY. On a freshly opened thread the composer DIV exists and measures fine,
  // but Lexical has not hydrated yet: insertText and the direct set both land on an
  // element with no model behind it, so the composer reads 0 chars. A second
  // attempt after a short wait succeeds once the editor is live.
  for (let attempt = 2; compact(got) !== compact(content) && attempt <= 4; attempt++) {
    log(`aviso: paste fallo (compact ${compact(got).length}/${compact(content).length}), reintento ${attempt - 1}/3 tras ${attempt * 900}ms`);
    await sleep(attempt * 900);
    await cdpCall(ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
    const r2 = await evaluate(ws, `(() => {
      const el = ${PICK_COMPOSER_JS};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`).catch(() => null);
    if (r2) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdpCall(ws, ++cdpSeq, "Input.dispatchMouseEvent", {
          type, x: r2.x, y: r2.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
        }).catch(() => {});
      }
    }
    if (!SKIP_CLEAR) await clearComposer(ws);
    try { await cdpCall(ws, ++cdpSeq, "Input.insertText", { text: content }); } catch {}
    got = await readText();
  }
  if (compact(got) !== compact(content)) {
    // Fallback: set the value directly and fire the input event React listens to.
    log(`aviso: paste mismatch (compact ${compact(got).length}/${compact(content).length}), intento set directo`);
    // CRITICAL: React installs its own `value` setter on the DOM node, so a plain
    // `el.value = x` updates the DOM but NOT React state: onChange never fires and
    // the send button stays disabled forever. Bypass React's instance-level setter
    // and use the NATIVE prototype setter, then fire the input event it listens to.
    // Symptom this fixes: text reads back fine but send reports "button disabled".
    await evaluate(ws, `(() => {
      const el = ${PICK_COMPOSER_JS};
      if (!el) return false;
      el.focus();
      const text = ${JSON.stringify(content)};
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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

async function typeLike(ws, content, mode = "normal", opts = {}) {
  // "normal": human-like typing via native CDP keystrokes (visible char by char).
  // "speed":  one native paste, 5-10s pause, then the caller clicks send.
  if (mode === "speed") return await pasteReal(ws, content, opts);
  await typeReal(ws, content);
}

async function askMeta(worker, content, progress = null, mode = "normal", images = []) {
  const ws = worker.ws;
  // With more than one worker only ONE window can be foreground at a time, and a
  // background window measures 0x0 — the composer check would fail on a worker that
  // is perfectly fine. Claim the foreground before touching anything.
  await cdpCall(ws, ++cdpSeq, "Page.bringToFront").catch(() => {});
  // The thread is VIRTUALIZED and Meta renames classes between deploys, so a
  // saved index/count is NOT a stable boundary (slicing from it spliced several
  // OLD answers together). Anchor on OUR OWN prompt instead: find the LAST
  // user-message row whose text contains the prompt, then read the assistant
  // message(s) that follow it. This is immune to virtualization, to old turns,
  // and to a repeated answer text (an older identical "ok" stays where it is).
  const compact = (s) => String(s || "").replace(/[\s-‍⁠﻿ ]+/g, "");
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
  // Clear BEFORE attaching, and do not clear again when pasting. Ordering matters:
  // clearComposer() sends Ctrl+A + Backspace for a contenteditable, and in Meta's
  // composer the attachment chip is part of the editor content — selecting all and
  // deleting removes the image we just attached. That is why the chip never
  // confirmed and Meta answered "no me llego el archivo".
  if (images && images.length) await clearComposer(ws);
  await typeLike(ws, content, mode, { skipClear: !!(images && images.length) });

  if (images && images.length) {
    const att = await attachImages(ws, images);
    if (!att.ok) log(`aviso: adjunto de imagenes fallo o incompleto (${att.why || "?"}); mando solo el texto`);
    else log(`adjunto listo: ${att.attached} imagen(es)`);
  }

  // Send the way a human does it: focus the composer, then a REAL Enter key event
  // through CDP. Meta's composer dispatches on Enter. Two things did not work:
  // b.click() was a synthetic DOM click that Meta ignored while an attachment chip
  // was on screen, and the old fallback dispatched `new KeyboardEvent(...)` INSIDE
  // the page, which is untrusted and also ignored. If Enter does not clear the
  // Send the way a human does: the button enables itself as soon as there is
  // text, then we click it for real. Kept deliberately minimal. A previous
  // version inserted a real Enter key first and then re-clicked the button when
  // the composer did not empty; that cascade reported sent:true and then the
  // caller failed with "el envio no tomo efecto". Enter also disturbed the editor
  // while an attachment chip was on screen. Typing already focuses and enables
  // the control, so the button click is the whole flow.
  let human = await evaluate(ws, `(() => {
    const el = ${PICK_COMPOSER_JS};
    if (!el) return { sent:false, why:'no composer' };
    const text = el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
    if (!text.trim()) return { sent:false, why:'empty', tag: el.tagName, chars: text.length };
    const named = Array.from(document.querySelectorAll('button'))
      .filter(x => /enviar|send|submit/i.test((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')));
    const b = named.find(x => !x.disabled);
    if (!b) return { sent:false, why:'boton no habilitado todavia', disabledNamed: named.length };
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return { sent:false, why:'boton sin tamano' };
    return { sent:true, x: r.left + r.width/2, y: r.top + r.height/2, named: named.length, tag: el.tagName, chars: text.length };
  })()`).catch((e) => ({ sent:false, why: String(e) }));

  if (human.sent) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdpCall(ws, ++cdpSeq, "Input.dispatchMouseEvent", {
        type, x: human.x, y: human.y, button: "left",
        buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse",
      }).catch(() => {});
      await sleep(80);
    }
    human = { sent: true, via: "button-mouse", named: human.named, tag: human.tag, chars: human.chars };
  }

  // Prove the submit landed.
  //
  // A cleared composer is the signal for a text-only prompt, but it is WRONG when
  // an image is attached: the attachment chip is composer content, so the check
  // always reported "still full", the job failed, and pump's finally recycled
  // Chrome — which is exactly the "it attaches, then the window closes and it
  // never finishes" symptom. With an image, the reliable signal is the thread
  // URL moving to a NEW prompt: Meta navigates only after dispatching.
  const urlBefore = await evaluate(ws, "location.href").catch(() => "");
  log("sent:", JSON.stringify(human), "url:", (await evaluate(ws, "location.href").catch(()=>""))?.slice(0,70));
  // Persist the thread as soon as it exists, not only when the idle timer fires.
  // Otherwise a restart (or a crash) between the answer and the close loses the
  // conversation and the next request starts from the home screen.
  await rememberThreadUrl();

  let cleared = false, urlMoved = false;
  for (let i = 0; i < 8 && !cleared && !urlMoved; i++) {
    await sleep(1200);
    const snap = await evaluate(ws, `(() => {
      const el = ${PICK_COMPOSER_JS};
      const text = !el ? '' : (el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || ''));
      return { empty: !text.trim(), href: location.href };
    })()`).catch(() => null);
    if (!snap) continue;
    cleared = snap.empty;
    urlMoved = !!urlBefore && !!snap.href && snap.href !== urlBefore;
  }
  const confirmed = cleared || urlMoved;
  if (!human.sent) throw new Error("envio fallido (" + (human.why || "?") + ")");
  if (!confirmed) throw new Error(
    `el envio no tomo efecto: el composer sigue lleno (via=${human.via}) y la URL no cambio. ` +
    `Meta no recibio el prompt; revisa login o dialogos abiertos.`
  );
  if (urlMoved && !cleared) log("envio confirmado por cambio de hilo (el chip sigue en el composer)");

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
    // Do NOT give up while Meta still reports "generating". The old limit was
    // 3 polls (~2.7s) and Meta PAUSES while it interprets the prompt before it
    // writes anything, so every longer answer came back truncated to its
    // preamble ("Interpretando solicitud..."). The short limits only apply once
    // generation has actually stopped.
    const idleLimit = gen ? 24 : (sawGenerating ? 6 : 10);
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

// Shortest queue first. Used when the pool is at MAX and cannot grow: spreading
// over the least loaded worker is what keeps the extra requests moving instead of
// stacking on one conversation.
function leastLoadedWorker() {
  return workers.reduce((best, w) => (w.queue.length < best.queue.length ? w : best), workers[0]);
}

// A free worker if there is one; otherwise grow the pool; otherwise queue.
async function acquireWorker() {
  const free = workers.find((w) => !w.busy && w.queue.length === 0);
  if (free) return free;
  if (workers.length < MAX_WORKERS) {
    const grown = await growPool();          // gives back a brand new, idle worker
    log(`acquireWorker: growPool devolvio ${grown ? "worker " + grown.id : "null"}`);
    if (grown && !grown.busy) return grown;
  }
  return null;                                // caller queues it
}

// Serialize the acquire+assign critical section.
//
// Without this, N concurrent requests each run acquireWorker() as a microtask
// BEFORE any of them has reached assign(), so they all observe the same "free"
// workers, none is marked busy yet, and every job piles onto the same tab. The
// pool then never grows because from its point of view nothing was ever busy.
// Chaining on one promise makes the decision strictly sequential.
let dispatchChain = Promise.resolve();
function dispatchJob(job) {
  dispatchChain = dispatchChain.then(async () => {
    try {
      await ensureChrome();
    } catch (err) {
      job.status = "error";
      job.error = String(err.message || err);
      return;
    }
    if (!workers.length) {
      job.status = "error";
      job.error = "no hay workers: Chrome no arranco";
      return;
    }
    let w = await acquireWorker();
    if (!w) w = leastLoadedWorker();
    job.worker = w.id;
    w.queue.push(job.job_id);
    pump(w);
  }).catch((e) => {
    job.status = "error";
    job.error = "dispatch: " + String(e.message || e);
    log("dispatch error:", String(e.message || e));
  });
  return dispatchChain;
}

function submit(content, copy_at = null, mode = MODE_DEFAULT, images = []) {
  const jobId = "job-" + randomUUID();
  jobs.set(jobId, {
    job_id: jobId, status: "queued", _input: content, content: "",
    copy_at, mode, images, created: new Date().toISOString(),
  });
  persistPending(); // mirror to disk BEFORE dispatch: if we die now, the job survives
  setTimeout(() => dispatchJob(jobs.get(jobId)), 0);
  return jobId;
}

// ---- Crash recovery ---------------------------------------------------------
// Two different failures need two different fixes:
//   * Chrome dies  -> in-memory rescue in recycleChrome() (queued jobs never
//     reached the browser, so replaying them is side-effect free).
//   * Node dies    -> nothing in memory survives, so queued jobs are mirrored to
//     disk and re-dispatched on boot. Without this, a restart silently drops
//     every request the caller is still polling for.
const JOBS_FILE = process.env.META_JOBS_FILE || "/home/test/test/meta-api/pending-jobs.json";
const RECOVERY_MAX_AGE_MS = Number(process.env.META_RECOVERY_MAX_AGE_MS || 30 * 60 * 1000);
const MAX_PERSISTED = Number(process.env.META_MAX_PERSISTED || 50);

function persistPending() {
  try {
    const pending = [...jobs.values()]
      .filter((j) => j.status === "queued" || j.status === "running")
      .slice(0, MAX_PERSISTED)
      .map((j) => ({ job_id: j.job_id, input: j._input, mode: j.mode, copy_at: j.copy_at, images: j.images || [], created: j.created }));
    writeFileSync(JOBS_FILE, JSON.stringify(pending, null, 2));
  } catch (e) { log("aviso: no pude persistir jobs:", String(e.message || e)); }
}

// Re-create job handles for requests that were still pending when the process
// died. Jobs older than the window are dropped: their caller has long given up.
function loadPending() {
  let arr = [];
  try { arr = JSON.parse(readFileSync(JOBS_FILE, "utf8")) || []; } catch { return []; }
  const now = Date.now();
  const recovered = [];
  for (const p of arr) {
    const age = now - Date.parse(p.created || "");
    if (!Number.isFinite(age) || age < 0 || age > RECOVERY_MAX_AGE_MS) continue;
    if (!p.job_id || !p.input) continue;
    jobs.set(p.job_id, {
      job_id: p.job_id, status: "queued", _input: p.input, content: "",
      copy_at: p.copy_at ?? null, mode: p.mode || MODE_DEFAULT, images: p.images || [],
      created: p.created, rescued: 1, recovered: true,
    });
    recovered.push(p.job_id);
  }
  if (recovered.length) log(`recuperacion: ${recovered.length} job(s) reencolados desde ${JOBS_FILE}`);
  return recovered;
}

async function recycleChrome(reason = "fresh per request") {
  // Rescue BEFORE wiping. A job still sitting in a worker queue never reached
  // the browser, so replaying it is safe. A job that was already running got its
  // status set to "error" by pump's catch, so it is not in here.
  const rescue = [];
  for (const w of workers) {
    for (const jobId of w.queue) {
      const j = jobs.get(jobId);
      if (!j || j.status !== "queued") continue;
      if (j.rescued) {           // second death: stop, or we loop forever
        j.status = "error";
        j.error = "Chrome murio dos veces; el job se descarta";
        continue;
      }
      j.rescued = 1;
      rescue.push(jobId);
    }
    w.queue.length = 0;
  }
  if (chromeProc) { try { chromeProc.kill("SIGTERM"); } catch {} }
  chromeProc = null;
  for (const w of workers) { try { w.ws.close(); } catch {} }
  workers = [];
  log("chrome recycled (" + reason + ")");
  if (rescue.length) {
    log(`rescate: ${rescue.length} job(s) reencolados`);
    for (const jobId of rescue) dispatchJob(jobs.get(jobId));
  }
  persistPending();
}

// NOTE: the old resetThread() is gone. It started a fresh thread WITHOUT replaying
// any summary, so every RESET_TURNS requests the conversation silently lost its
// context while the transcript went to a file nobody reads. It also ran before the
// percentage check, so the rotation below almost never got a chance to fire.

async function pump(worker) {
  if (worker.busy) return;
  const jobId = worker.queue.shift();
  if (!jobId) return;
  const j = jobs.get(jobId);
  worker.busy = true;
  j.status = "running";
  clearIdleTimer(); // work is happening: cancel any pending auto-close
  try {
    // One rotation mechanism, two triggers. Both go through rotateThread so the
    // conversation ALWAYS continues with its context: the turn counter is a
    // backstop for pathological message sizes, not a competing reset that dropped
    // the thread on the floor every N requests.
    const usage = await contextUsage(worker, j._input);
    worker.context = usage;
    const byTurns = (worker.turns || 0) >= RESET_TURNS;
    const byPct = usage.pct >= CONTEXT_SOFT_PCT;
    let content = j._input;
    if (byPct || byTurns) {
      const why = byPct && !byTurns ? `${usage.pct}% de contexto`
        : byTurns && !byPct ? `${worker.turns} turnos en el hilo`
        : `${usage.pct}% de contexto y ${worker.turns} turnos`;
      const summary = await rotateThread(worker, usage.pct, why);
      if (summary) {
        content = withRecoveredContext(summary, j._input);
        worker.ctxChars = 0; // fresh thread: the summary is the new baseline
        worker.turns = 0;
      }
    }
    j.content = await askMeta(worker, content, j, j.mode || MODE_DEFAULT, j.images || []);
    // Everything this worker has carried is context the next turn inherits.
    worker.ctxChars = (worker.ctxChars || 0) + String(content).length + String(j.content || "").length;
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
    setTimeout(() => { jobs.delete(jobId); persistPending(); }, 10 * 60 * 1000).unref?.();
  }
  persistPending();
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
      pool: { min: MIN_WORKERS, max: MAX_WORKERS, size: workers.length,
              queued: workers.reduce((n, w) => n + w.queue.length, 0) },
      // ESTIMATED, not measured: Meta's UI exposes no token counter. The page cannot
    // be used: the thread is virtualized, so `main` reads ~250 chars on a long
    // thread while `body` is ~190k chars of React payload. This counts what this
    // broker sent and received instead.
    context: { soft_pct: CONTEXT_SOFT_PCT, budget_chars: CONTEXT_BUDGET_CHARS,
               seed_chars: CONTEXT_SEED_CHARS,
               per_worker: workers.map((w) => ({
                 id: w.id,
                 chars: w.ctxChars || 0,
                 pct: Math.round(((w.ctxChars || 0) / Math.max(1, CONTEXT_BUDGET_CHARS)) * 100),
                 rotates_at: Math.round(((w.ctxChars || 0) / Math.max(1, CONTEXT_BUDGET_CHARS)) * 100) >= CONTEXT_SOFT_PCT,
               })) },
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
    // content can be a plain string OR an array of multimodal parts. The old
    // String(content) turned a pasted screenshot into "[object Object]".
    const rawUser = [...msgs].reverse().find((m) => {
      if (!m || m.role !== "user") return false;
      const { text, images } = parseUserContent(m.content);
      return text || images.length;
    });
    if (!rawUser) return json(400, { error: { message: "messages[].role user required" } });
    const parsed = parseUserContent(rawUser.content);
    const content = parsed.text;
    const images = parsed.images;
    if (!content && !images.length) {
      return json(400, { error: { message: "el mensaje del usuario esta vacio (ni texto ni imagenes)" } });
    }
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
      const jobId = submit(content, Number(payload.copy_at) || null, mode, images);
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
      const jobId = submit(content, Number(payload.copy_at) || null, mode, images);
      return json(202, { job_id: jobId, status: "queued", poll: `/v1/jobs/${jobId}` });
    }

    // sync OpenAI style: wait for the job to finish
    const jobId = submit(content, Number(payload.copy_at) || null, mode, images);
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
  log(`meta-ai broker async on http://${HOST}:${PORT} (workers=${MIN_WORKERS}-${MAX_WORKERS}, mode=${VISIBLE ? "visible" : "hidden"}, fresh=${FRESH ? "yes" : "no"})`);
  log(RESUMED_URL
    ? `sesion reanudada desde disco: ${RESUMED_URL.slice(0, 80)}`
    : `sin sesion guardada; arranco en ${START_URL}`);
  log(`auto-cierre: ${IDLE_CLOSE_MS > 0 ? Math.round(IDLE_CLOSE_MS / 1000) + "s de inactividad" : "desactivado"}`);
  // Re-dispatch anything that was pending when we last died. ensureChrome() runs
  // lazily on the first request, so this only restores the handles.
  const recovered = loadPending();
  for (const jobId of recovered) dispatchJob(jobs.get(jobId));
});