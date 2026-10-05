// Loop behavior with a stubbed ask(): the loop's contract is that it RESOLVES
// an honest result for every in-band outcome. A Meta failure mid-mission must
// not throw the transcript away — the caller needs to see how far the agent
// got, and the tool turns it already collected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./loop.js";

// Stands in for runSandboxed: no docker, instant, records what it ran.
function stubExec(runs) {
  return async (command) => {
    runs.push(command);
    return { ok: true, exitCode: 0, output: `salida de: ${command}`, ms: 1, denied: false, timedOut: false };
  };
}

test("a Meta failure on the first ask resolves ok:false as meta-error", async () => {
  const res = await runAgentLoop({
    ask: async () => { throw new Error("rate limit reached"); },
    task: "revisa el proyecto",
    exec: stubExec([]),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "meta-error:rate limit reached");
  assert.equal(res.steps, 0);
  assert.deepEqual(res.transcript, []);
});

test("a Meta failure after a tool step preserves user, assistant and tool turns", async () => {
  const runs = [];
  let calls = 0;
  const res = await runAgentLoop({
    ask: async () => {
      calls++;
      if (calls === 1) return "```sh\nls /workspace\n```";
      throw new Error("cooldown de tasa");
    },
    task: "revisa el proyecto",
    exec: stubExec(runs),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "meta-error:cooldown de tasa");
  assert.equal(res.steps, 1);
  assert.deepEqual(runs, ["ls /workspace"]);          // the tool turn really happened
  assert.equal(res.transcript.length, 3);             // user + assistant + tool from step 1
  assert.equal(res.transcript[0].role, "user");
  assert.match(res.transcript[0].text, /revisa el proyecto/);
  assert.equal(res.transcript[1].role, "assistant");
  assert.equal(res.transcript[2].role, "tool");
  assert.equal(res.transcript[2].command, "ls /workspace");
  assert.match(res.transcript[2].output, /salida de: ls \/workspace/);
});

test("a meta-error failure surfaces through onEvent", async () => {
  const events = [];
  await runAgentLoop({
    ask: async () => { throw new Error("hilo mudo"); },
    task: "t",
    exec: stubExec([]),
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === "meta-error" && /hilo mudo/.test(e.error)));
});
