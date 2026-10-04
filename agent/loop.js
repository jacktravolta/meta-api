// The agent loop: Meta AI plans, the broker executes.
//
// ask(prompt) -> answerText   (provided by the broker, one Meta request per call)
//   The loop repeats until Meta answers without asking for a tool, the step budget
//   runs out, or the wall-clock budget is gone. Tool output is fed back as the next
//   message so the conversation stays a single Meta thread.
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
    const answer = await ask(prompt);
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
    const result = await runSandboxed(call.command, o.sandbox);
    transcript.push({ role: "tool", command: call.command, step, output: result.output });
    emit({ type: "tool-result", step, ok: result.ok, denied: !!result.denied, ms: result.ms });

    prompt = `${formatResult(call.command, result)}\n\n` +
             `Continua con la tarea original usando esta salida. ` +
             `Si ya podes responder, responde sin bloque tool.`;
  }

  emit({ type: "max-steps" });
  return { ok: false, reason: "max-steps", steps: o.maxSteps, transcript, answer: final };
}