// The agent loop: Meta AI plans, the broker executes.
//
// ask(prompt) -> answerText   (provided by the broker, one Meta request per call)
//   The loop repeats until Meta answers without asking for a tool, the step budget
//   runs out, or the wall-clock budget is gone. Tool output is fed back as the next
//   message so the conversation stays a single Meta thread.
//
// The loop RESOLVES for every in-band outcome, including a Meta failure
// mid-mission: ask() throwing used to propagate out to the caller's catch and
// lose the transcript, so nobody could tell how far the agent actually got.
import { runSandboxed } from "./sandbox.js";
import { TOOL_PROTOCOL, parseToolCall, formatResult } from "./tools.js";

const DEFAULTS = {
  maxSteps: 8,
  budgetMs: 180_000,
  sandbox: {},          // merged into every runSandboxed call
  onEvent: () => {},
};

export async function runAgentLoop({ ask, task, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  // The sandbox executor is injectable so the loop is testable without docker:
  // tests stub it to drive multi-step transcripts. Production callers never
  // pass one and always get the real runSandboxed.
  const exec = o.exec || runSandboxed;
  const started = Date.now();
  const transcript = [];
  const emit = (e) => { try { o.onEvent(e); } catch {} };

  let prompt = `${task}\n\n---\n${TOOL_PROTOCOL}`;
  let final = null;

  for (let step = 1; step <= o.maxSteps; step++) {
    if (Date.now() - started > o.budgetMs) {
      emit({ type: "budget-exhausted", step });
      return { ok: false, reason: "budget", steps: step - 1, transcript, answer: final };
    }

    emit({ type: "step", step });
    // A Meta failure mid-mission (rate limit, dead thread, silent generation)
    // resolves with the partial transcript instead of throwing it away: the
    // job reports how far it got and the caller keeps the evidence.
    let answer;
    try {
      answer = await ask(prompt);
    } catch (e) {
      const msg = String(e?.message || e);
      emit({ type: "meta-error", step, error: msg });
      return { ok: false, reason: `meta-error:${msg}`, steps: step - 1, transcript, answer: final };
    }
    transcript.push({ role: "user", text: prompt, step });
    transcript.push({ role: "assistant", text: answer, step });

    const call = parseToolCall(answer);
    if (!call) {
      final = answer;
      emit({ type: "final", step, chars: answer.length });
      return { ok: true, steps: step, transcript, answer };
    }

    if (call.error) {
      emit({ type: "tool-rejected", step, error: call.error });
      prompt = `La herramienta fue rechazada: ${call.error}\n\n` +
               `Corrige el bloque y volvelo a emitir, o responde con texto si no necesitas ejecutarlo.`;
      continue;
    }

    emit({ type: "tool", step, command: call.command });
    const result = await exec(call.command, o.sandbox);
    transcript.push({ role: "tool", command: call.command, step, output: result.output });
    emit({ type: "tool-result", step, ok: result.ok, denied: !!result.denied, ms: result.ms });

    prompt = `${formatResult(call.command, result)}\n\n` +
             `Continua con la tarea original usando esta salida. ` +
             `Si ya podes responder, responde sin bloque tool.`;
  }

  emit({ type: "max-steps" });
  return { ok: false, reason: "max-steps", steps: o.maxSteps, transcript, answer: final };
}