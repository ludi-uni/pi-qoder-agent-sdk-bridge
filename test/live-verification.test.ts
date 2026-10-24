import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve, sep } from "node:path";
import type { AssistantMessage, Api, Tool } from "@earendil-works/pi-ai";
import {
  buildCasePlans,
  checkCallAllowlist,
  checkMarker,
  classifyStreamError,
  evaluateAttempt,
  groupsEqual,
  markerFor,
  runAttempt,
  taskFor,
  type CaseSpec,
  type ObservedCall,
} from "../scripts/live-verification.js";

const ROOT = resolve("/repo");
const SPEC: CaseSpec = {
  root: ROOT,
  packageJsonPath: join(ROOT, "package.json"),
  sentinelPath: join(ROOT, "test-artifacts/__qwen_sentinel_absent_40061e0__.json"),
  indexPath: join(ROOT, "extensions/index.ts"),
  grepPattern: "</pi_tool_call>",
  lsLimit: 10,
};
const PLANS = buildCasePlans(SPEC);
const canon = (p: string) => resolve(p);

const TOOLS: Tool[] = [
  { name: "read", description: "read", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } },
  { name: "grep", description: "grep", parameters: { type: "object", required: ["path", "pattern"], properties: { path: { type: "string" }, pattern: { type: "string" } }, additionalProperties: false } },
  { name: "ls", description: "ls", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } },
] as unknown as Tool[];

const PKG_BODY = JSON.stringify({ name: "pi-qoder-agent-sdk-bridge", version: "0.2.2" });
const LS_BODY = "extensions/\ntest/\npackage.json";
const GREP_BODY = "42:const TOOL_CALL_CLOSE = \"</pi_tool_call>\";";
const ENOENT_BODY = `ENOENT: no such file or directory, open '${SPEC.sentinelPath}'`;
// Exact terminal error observed in test-artifacts/qwen38flash-ordered-*-20261023
// (SDK result subtype=error_during_execution, is_error=true, error_code=10605).
const SDK_BUSY =
  "SDK_TERMINAL_ERROR: The model is busy and could not complete the request. Please try again later. [error_code=10605]";

let counter = 0;
const call = (name: string, args: Record<string, unknown>): ObservedCall => ({
  id: `call_${++counter}`,
  name,
  arguments: args,
});
const readPkg = () => call("read", { path: SPEC.packageJsonPath });
const readSentinel = () => call("read", { path: SPEC.sentinelPath });
const grepIndex = () => call("grep", { path: SPEC.indexPath, pattern: SPEC.grepPattern });
const lsRoot = () => call("ls", { path: SPEC.root, limit: SPEC.lsLimit });

const assistant = (parts: { calls?: ObservedCall[]; text?: string; stop?: string; error?: string }): AssistantMessage => ({
  role: "assistant",
  content: [
    ...(parts.calls ?? []).map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.arguments as never })),
    ...(parts.text !== undefined ? [{ type: "text" as const, text: parts.text }] : []),
  ],
  api: "qoder-agent-sdk" as Api,
  provider: "qoder-bridge",
  model: "fixture",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: (parts.stop ?? (parts.calls?.length ? "toolUse" : "stop")) as AssistantMessage["stopReason"],
  errorMessage: parts.error,
  timestamp: 1,
});

function scriptRunner(turns: AssistantMessage[]) {
  const executed: { name: string; arguments: Record<string, unknown> }[] = [];
  let turn = 0;
  const stream = async () => {
    const next = turns[turn++];
    assert.ok(next, `script ran out at turn ${turn}`);
    return next;
  };
  const execute = async (c: { name: string; arguments: Record<string, unknown> }) => {
    executed.push(c);
    if (c.name === "read" && c.arguments.path === SPEC.sentinelPath) return { isError: true, text: ENOENT_BODY };
    if (c.name === "read") return { isError: false, text: PKG_BODY };
    if (c.name === "grep") return { isError: false, text: GREP_BODY };
    return { isError: false, text: LS_BODY };
  };
  return { stream, execute, executed };
}

function depsFor(caseId: keyof typeof PLANS, turns: AssistantMessage[], runner = scriptRunner(turns)) {
  const plan = PLANS[caseId];
  const marker = markerFor(caseId, 1);
  return {
    plan,
    marker,
    task: taskFor(plan, marker, SPEC),
    tools: TOOLS,
    systemPrompt: "sys",
    stream: runner.stream,
    execute: runner.execute,
    canonicalize: canon,
  };
}

test("sequential task states its result-wait grouping rather than only call order", () => {
  const task = taskFor(PLANS.sequential, markerFor("sequential", 1), SPEC);
  assert.match(task, /各手順の結果を受け取ってから/);
  assert.match(task, /次の応答で次の手順/);
  assert.match(task, /同一assistant messageで複数手順を発行しない/);
  const batch = taskFor(PLANS.batch, markerFor("batch", 1), SPEC);
  assert.match(batch, /同一応答でこの順序で発行/);
  assert.doesNotMatch(batch, /同一assistant messageで複数手順を発行しない/);
});

// --- pure helpers ----------------------------------------------------------

test("marker/checkMarker: standalone final line only, single occurrence", () => {
  const marker = markerFor("basic", 3);
  assert.equal(marker, "QWEN_LIVE_BASIC_3");
  assert.equal(checkMarker(`result text\n${marker}`, marker), true);
  assert.equal(checkMarker(`result text\n${marker}\n`, marker), true);
  assert.equal(checkMarker(`result text\n${marker}\r\n`, marker), true);
  for (const bad of [
    `result text\n${marker}\n\n`,
    `result text\n${marker} `,
    `${marker}\nthen more lines`,
    `there is no ${marker} here`, // negated mention is not a marker line
    `result\n${marker} extra`,
    `result\n  ${marker}`,
    `${marker} ... ${marker}`,
  ]) {
    assert.equal(checkMarker(bad, marker), false, JSON.stringify(bad));
  }
});

test("classifyStreamError: queue/timeout/abort → SERVICE_FAILURE, protocol codes → PROTOCOL_FAILURE", () => {
  assert.equal(classifyStreamError('Model requested unlisted tool "rm_rf"'), "SAFETY_VIOLATION");
  assert.equal(classifyStreamError('duplicate tool call id "x"'), "SAFETY_VIOLATION");
  for (const msg of [
    "PROVIDER_UNAVAILABLE: queued",
    "PROVIDER_QUEUE_TIMEOUT: no provider message",
    "POST_TOOL_CONTINUATION_TIMEOUT: no provider message for 15000ms",
    "total deadline 150000ms",
    "Qoder stream aborted",
  ]) {
    assert.equal(classifyStreamError(msg), "SERVICE_FAILURE", msg);
  }
  for (const msg of [
    "UNKNOWN_TOOL_LIKE_FORMAT: Unrecognized tool-call tag",
    "MISSING_RESULT: Qoder stream ended without a terminal result message",
  ]) {
    assert.equal(classifyStreamError(msg), "PROTOCOL_FAILURE", msg);
  }
});

test("classifyStreamError: observed SDK model-busy code 10605 → SERVICE_FAILURE, lookalikes stay PROTOCOL_FAILURE", () => {
  // The exact message captured live, plus the optional terminal_reason suffix
  // the bridge can append after the structured error_code token.
  assert.equal(classifyStreamError(SDK_BUSY), "SERVICE_FAILURE");
  assert.equal(
    classifyStreamError(`${SDK_BUSY} [terminal_reason=model_busy]`),
    "SERVICE_FAILURE",
  );
  // Everything below must NOT be promoted: the code allowlist is exact, the
  // suffix is end-anchored, and the stable prefix is required.
  for (const msg of [
    "SDK_TERMINAL_ERROR: The model is busy and could not complete the request. Please try again later.", // missing code
    "SDK_TERMINAL_ERROR: The model is busy [error_code=106050]", // longer code, not allowlisted
    "SDK_TERMINAL_ERROR: context overflow [error_code=9999]", // unknown code
    "SDK_TERMINAL_ERROR: failed [error_code=10605] and trailing text", // code not terminal
    "SDK_TERMINAL_ERROR: failed [error_code=10605][terminal_reason=x]", // no space separator
    "SDK_TERMINAL_ERROR: failed[error_code=10605]", // code needs the generated separator
    "SDK_TERMINAL_ERROR:failed [error_code=10605]", // exact generated prefix required
    "The model is busy [error_code=10605]", // missing stable prefix
    "provider reported error_code=10605 in plain text", // not the structured suffix
    "SDK_TERMINAL_ERROR: freeform mention of code 10605 without brackets",
    "UNKNOWN_TOOL_LIKE_FORMAT: Unrecognized tool-call tag near error_code=10605", // protocol code + 10605 prose
  ]) {
    assert.equal(classifyStreamError(msg), "PROTOCOL_FAILURE", msg);
  }
  // Safety precedence: a violation mentioning 10605 is still fatal-class.
  assert.equal(
    classifyStreamError('Model requested unlisted tool "rm_rf" [error_code=10605]'),
    "SAFETY_VIOLATION",
  );
  assert.equal(classifyStreamError(undefined), "PROTOCOL_FAILURE");
});

test("checkCallAllowlist: planned calls match, unknown/out-of-domain/duplicates are fatal", () => {
  const plan = PLANS.sequential;
  const consumed = new Set<number>();
  // Correct first group.
  const ok = checkCallAllowlist(plan, consumed, [readPkg()], canon);
  assert.deepEqual(ok.matchedIndexes, [0]);
  assert.equal(ok.fatal, undefined);
  // Unknown tool.
  const unknown = checkCallAllowlist(plan, consumed, [call("rm_rf", { path: SPEC.root })], canon);
  assert.match(unknown.fatal ?? "", /not an allowlisted/);
  // Out-of-domain path (canonicalized outside every planned call).
  const outside = checkCallAllowlist(plan, consumed, [call("read", { path: resolve("/etc/passwd") })], canon);
  assert.match(outside.fatal ?? "", /outside the planned allowlist/);
  // Wrong argument shape.
  const badArgs = checkCallAllowlist(plan, consumed, [call("read", { path: SPEC.packageJsonPath, extra: 1 })], canon);
  assert.match(badArgs.fatal ?? "", /allowlisted tool call shape/);
  // Unplanned duplicate: consume index 0, then request it again.
  const dup = checkCallAllowlist(plan, new Set([0]), [readPkg()], canon);
  assert.match(dup.fatal ?? "", /re-execution/);
});

test("groupsEqual: exact arity+order+arguments", () => {
  const group = PLANS.batch.groups[0];
  assert.equal(groupsEqual(group, [readPkg(), lsRoot()], canon), true);
  assert.equal(groupsEqual(group, [lsRoot(), readPkg()], canon), false, "reversed order is not the same group");
  assert.equal(groupsEqual(group, [readPkg()], canon), false, "split batch is not the same group");
  assert.equal(groupsEqual(group, [readPkg(), lsRoot(), grepIndex()], canon), false, "extra call is not the same group");
});

// --- evaluateAttempt (post-hoc) --------------------------------------------

function recordFrom(turns: AssistantMessage[], results: { id: string; name: string; isError: boolean; body: string }[], pkg?: string) {
  return {
    marker: "M",
    turns: turns.map((t, i) => ({
      turn: i + 1,
      stopReason: t.stopReason,
      errorMessage: t.errorMessage,
      calls: t.content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, name: b.name, arguments: b.arguments as Record<string, unknown> })),
      text: t.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    })),
    results,
    observedPackageName: pkg,
  };
}

test("evaluateAttempt: correct basic case passes", () => {
  const c = readPkg();
  const verdict = evaluateAttempt(PLANS.basic, recordFrom(
    [assistant({ calls: [c] }), assistant({ text: `name pi-qoder-agent-sdk-bridge\nM` })],
    [{ id: c.id, name: "read", isError: false, body: PKG_BODY }],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.deepEqual(verdict, { toolFlowPass: true, responsePass: true, fullPass: true, fatal: false });
});

test("evaluateAttempt: premature text with unexecuted groups → INCOMPLETE_PLAN", () => {
  const verdict = evaluateAttempt(PLANS.sequential, recordFrom(
    [assistant({ text: "I will now run read, grep and ls." })],
    [],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.fullPass, false);
  assert.equal(verdict.failure, "INCOMPLETE_PLAN");
});

test("evaluateAttempt: batch split into two turns → UNEXPECTED_CALL", () => {
  const c1 = readPkg();
  const c2 = lsRoot();
  const verdict = evaluateAttempt(PLANS.batch, recordFrom(
    [assistant({ calls: [c1] }), assistant({ calls: [c2] }), assistant({ text: "pi-qoder-agent-sdk-bridge\nM" })],
    [
      { id: c1.id, name: "read", isError: false, body: PKG_BODY },
      { id: c2.id, name: "ls", isError: false, body: LS_BODY },
    ],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "UNEXPECTED_CALL");
});

test("evaluateAttempt: batch reversed order → UNEXPECTED_CALL", () => {
  const c1 = lsRoot();
  const c2 = readPkg();
  const verdict = evaluateAttempt(PLANS.batch, recordFrom(
    [assistant({ calls: [c1, c2] })],
    [
      { id: c1.id, name: "ls", isError: false, body: LS_BODY },
      { id: c2.id, name: "read", isError: false, body: PKG_BODY },
    ],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "UNEXPECTED_CALL");
});

test("evaluateAttempt: out-of-domain path → SAFETY_VIOLATION fatal", () => {
  const evil = call("read", { path: resolve("/etc/passwd") });
  const verdict = evaluateAttempt(PLANS.basic, recordFrom([assistant({ calls: [evil] })], []), canon);
  assert.equal(verdict.failure, "SAFETY_VIOLATION");
  assert.equal(verdict.fatal, true);
});

test("evaluateAttempt: unknown tool → SAFETY_VIOLATION fatal", () => {
  const evil = call("bash", { command: "rm -rf" });
  const verdict = evaluateAttempt(PLANS.basic, recordFrom([assistant({ calls: [evil] })], []), canon);
  assert.equal(verdict.failure, "SAFETY_VIOLATION");
  assert.equal(verdict.fatal, true);
});

test("evaluateAttempt: wrong result id → RESULT_MISMATCH", () => {
  const c = readPkg();
  const verdict = evaluateAttempt(PLANS.basic, recordFrom(
    [assistant({ calls: [c] }), assistant({ text: "pi-qoder-agent-sdk-bridge\nM" })],
    [{ id: "WRONG_ID", name: "read", isError: false, body: PKG_BODY }],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "RESULT_MISMATCH");
});

test("evaluateAttempt: marker in a negated sentence → FINAL_RESPONSE_NONCOMPLIANCE", () => {
  const c = readPkg();
  const verdict = evaluateAttempt(PLANS.basic, recordFrom(
    [assistant({ calls: [c] }), assistant({ text: `name pi-qoder-agent-sdk-bridge\n(there is no M line)` })],
    [{ id: c.id, name: "read", isError: false, body: PKG_BODY }],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "FINAL_RESPONSE_NONCOMPLIANCE");
  assert.equal(verdict.toolFlowPass, true);
  assert.equal(verdict.responsePass, false);
  assert.equal(verdict.fullPass, false);
});

test("evaluateAttempt: missing observed package name in final → FINAL_RESPONSE_NONCOMPLIANCE", () => {
  const c = readPkg();
  const verdict = evaluateAttempt(PLANS.basic, recordFrom(
    [assistant({ calls: [c] }), assistant({ text: "the file exists\nM" })],
    [{ id: c.id, name: "read", isError: false, body: PKG_BODY }],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "FINAL_RESPONSE_NONCOMPLIANCE");
});

test("evaluateAttempt: service timeout classified separately, never a pass", () => {
  const verdict = evaluateAttempt(PLANS.basic, recordFrom(
    [assistant({ stop: "error", error: "PROVIDER_RESPONSE_TIMEOUT: no provider message for 120000ms" })],
    [],
  ), canon);
  assert.equal(verdict.failure, "SERVICE_FAILURE");
  assert.equal(verdict.fullPass, false);
});

test("evaluateAttempt: SDK busy after a fully-linked batch keeps toolFlowPass, still fails", () => {
  const c1 = readPkg();
  const c2 = lsRoot();
  const verdict = evaluateAttempt(PLANS.batch, recordFrom(
    [assistant({ calls: [c1, c2] }), assistant({ stop: "error", error: SDK_BUSY })],
    [
      { id: c1.id, name: "read", isError: false, body: PKG_BODY },
      { id: c2.id, name: "ls", isError: false, body: LS_BODY },
    ],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "SERVICE_FAILURE");
  assert.equal(verdict.toolFlowPass, true);
  assert.equal(verdict.responsePass, false);
  assert.equal(verdict.fullPass, false);
  assert.equal(verdict.fatal, false);
  assert.equal(verdict.detail, SDK_BUSY);
});

test("evaluateAttempt: SDK busy before or midway through groups is service failure without toolFlowPass", () => {
  // Busy on the first turn — nothing executed.
  const empty = evaluateAttempt(PLANS.batch, recordFrom(
    [assistant({ stop: "error", error: SDK_BUSY })], [],
  ), canon);
  assert.equal(empty.failure, "SERVICE_FAILURE");
  assert.equal(empty.toolFlowPass, false);
  // Busy midway through a sequential plan: the executed group stays evidence
  // but the plan is incomplete, so toolFlowPass cannot be preserved.
  const c1 = readPkg();
  const midway = evaluateAttempt(PLANS.sequential, recordFrom(
    [assistant({ calls: [c1] }), assistant({ stop: "error", error: SDK_BUSY })],
    [{ id: c1.id, name: "read", isError: false, body: PKG_BODY }],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(midway.failure, "SERVICE_FAILURE");
  assert.equal(midway.toolFlowPass, false);
  // Same for error-recovery after only the sentinel read.
  const s1 = readSentinel();
  const recovery = evaluateAttempt(PLANS["error-recovery"], recordFrom(
    [assistant({ calls: [s1] }), assistant({ stop: "error", error: SDK_BUSY })],
    [{ id: s1.id, name: "read", isError: true, body: ENOENT_BODY }],
  ), canon);
  assert.equal(recovery.failure, "SERVICE_FAILURE");
  assert.equal(recovery.toolFlowPass, false);
});

test("evaluateAttempt: error-recovery needs the observed ENOENT result, not just the claim", () => {
  const c1 = readSentinel();
  const c2 = readPkg();
  // Claimed ENOENT in text but the sentinel result is a success → mismatch.
  const verdict = evaluateAttempt(PLANS["error-recovery"], recordFrom(
    [
      assistant({ calls: [c1] }),
      assistant({ calls: [c2] }),
      assistant({ text: "name pi-qoder-agent-sdk-bridge, ENOENT observed\nM" }),
    ],
    [
      { id: c1.id, name: "read", isError: false, body: "{}" },
      { id: c2.id, name: "read", isError: false, body: PKG_BODY },
    ],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.equal(verdict.failure, "RESULT_MISMATCH");
});

test("evaluateAttempt: error-recovery full pass with real ENOENT result", () => {
  const c1 = readSentinel();
  const c2 = readPkg();
  const verdict = evaluateAttempt(PLANS["error-recovery"], recordFrom(
    [
      assistant({ calls: [c1] }),
      assistant({ calls: [c2] }),
      assistant({ text: "package pi-qoder-agent-sdk-bridge; ENOENT on sentinel\nM" }),
    ],
    [
      { id: c1.id, name: "read", isError: true, body: ENOENT_BODY },
      { id: c2.id, name: "read", isError: false, body: PKG_BODY },
    ],
    "pi-qoder-agent-sdk-bridge",
  ), canon);
  assert.deepEqual(verdict, { toolFlowPass: true, responsePass: true, fullPass: true, fatal: false });
});

// --- runAttempt (injected IO) -----------------------------------------------

test("runAttempt: full sequential flow executes exactly the plan and passes", async () => {
  const turns = [
    assistant({ calls: [readPkg()] }),
    assistant({ calls: [grepIndex()] }),
    assistant({ calls: [lsRoot()] }),
    assistant({ text: "package pi-qoder-agent-sdk-bridge\n" + markerFor("sequential", 1) }),
  ];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("sequential", turns, runner));
  assert.equal(record.verdict.fullPass, true, JSON.stringify(record.verdict));
  assert.deepEqual(runner.executed.map((e) => e.name), ["read", "grep", "ls"]);
  assert.equal(record.results.length, 3);
  assert.equal(record.observedPackageName, "pi-qoder-agent-sdk-bridge");
});

test("runAttempt: unexpected call is never executed and is fatal", async () => {
  const evil = call("read", { path: resolve("/outside/secret.txt") });
  const turns = [assistant({ calls: [evil] })];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("basic", turns, runner));
  assert.equal(record.verdict.failure, "SAFETY_VIOLATION");
  assert.equal(record.verdict.fatal, true);
  assert.equal(runner.executed.length, 0, "gate must block execution before any tool runs");
});

test("runAttempt: premature text stop → INCOMPLETE_PLAN without executing more", async () => {
  const turns = [assistant({ calls: [readPkg()] }), assistant({ text: "done early" })];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("sequential", turns, runner));
  assert.equal(record.verdict.failure, "INCOMPLETE_PLAN");
  assert.equal(runner.executed.length, 1);
});

test("runAttempt: planned ENOENT → correct continuation → full pass", async () => {
  const turns = [
    assistant({ calls: [readSentinel()] }),
    assistant({ calls: [readPkg()] }),
    assistant({ text: `package pi-qoder-agent-sdk-bridge, ENOENT observed\n${markerFor("error-recovery", 1)}` }),
  ];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("error-recovery", turns, runner));
  assert.equal(record.verdict.fullPass, true, JSON.stringify(record.verdict));
  assert.equal(record.results[0].isError, true);
  assert.match(record.results[0].body, /ENOENT/);
});

test("runAttempt: re-issuing the already-answered sentinel read is a fatal duplicate", async () => {
  const turns = [
    assistant({ calls: [readSentinel()] }),
    assistant({ calls: [readSentinel()] }),
  ];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("error-recovery", turns, runner));
  assert.equal(record.verdict.failure, "SAFETY_VIOLATION");
  assert.match(record.verdict.detail ?? "", /re-execution/);
  assert.equal(runner.executed.length, 1, "the duplicate call must not execute");
});

test("runAttempt: stream error becomes SERVICE/PROTOCOL failure, no retry", async () => {
  const turns = [assistant({ stop: "error", error: "PROVIDER_QUEUE_TIMEOUT: queued too long" })];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("basic", turns, runner));
  assert.equal(record.verdict.failure, "SERVICE_FAILURE");
  assert.equal(runner.executed.length, 0);
});

test("runAttempt: streamed SDK busy ends the attempt — no extra call, no retry", async () => {
  const turns = [
    assistant({ calls: [readPkg(), lsRoot()] }),
    assistant({ stop: "error", error: SDK_BUSY }),
  ];
  let streamCalls = 0;
  const runner = scriptRunner(turns);
  const stream = async () => {
    streamCalls++;
    return runner.stream();
  };
  const record = await runAttempt({ ...depsFor("batch", turns, runner), stream });
  assert.equal(record.verdict.failure, "SERVICE_FAILURE");
  assert.equal(record.verdict.toolFlowPass, true);
  assert.equal(record.verdict.fullPass, false);
  assert.equal(streamCalls, 2, "the busy turn must be the last stream call — no retry");
  assert.deepEqual(runner.executed.map((e) => e.name), ["read", "ls"]);
  assert.equal(record.results.length, 2);
  assert.equal(record.turns.length, 2);
  assert.equal(record.observedPackageName, "pi-qoder-agent-sdk-bridge");
});

test("runAttempt: a thrown stream exception is recorded, not propagated", async () => {
  const plan = PLANS.basic;
  const marker = markerFor("basic", 1);
  const record = await runAttempt({
    plan,
    marker,
    task: taskFor(plan, marker, SPEC),
    tools: TOOLS,
    systemPrompt: "sys",
    canonicalize: canon,
    execute: async () => ({ isError: false, text: PKG_BODY }),
    stream: async () => { throw new Error("transport exploded"); },
  });
  assert.equal(record.verdict.failure, "PROTOCOL_FAILURE");
});

test("runAttempt: no self-report — verdict is re-derived from the raw record", async () => {
  // Model claims completion in text without ever calling the tool.
  const turns = [assistant({ text: `all done, package pi-qoder-agent-sdk-bridge\n${markerFor("basic", 1)}` })];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("basic", turns, runner));
  assert.equal(record.verdict.fullPass, false);
  assert.equal(record.verdict.failure, "INCOMPLETE_PLAN");
});

test("maxTurns bound: extra tool loop cannot run forever", async () => {
  // error-recovery maxTurns = 3; if the model keeps calling tools it stops
  // accepting turns after the bound and the gate fails the attempt.
  const turns = [assistant({ calls: [readSentinel()] }), assistant({ calls: [readPkg()] }), assistant({ calls: [readPkg()] })];
  const runner = scriptRunner(turns);
  const record = await runAttempt(depsFor("error-recovery", turns, runner));
  assert.equal(record.turns.length, 3);
  assert.equal(record.verdict.fullPass, false);
});

test("canonicalize maps equivalent paths (root boundary + realpath handling)", () => {
  // A path that resolves to the same canonical target still matches the plan.
  const aliased = call("read", { path: `${ROOT}${sep}.${sep}package.json` });
  const gate = checkCallAllowlist(PLANS.basic, new Set(), [aliased], canon);
  assert.deepEqual(gate.matchedIndexes, [0]);
  // An escape that only *looks* inside the root must not match.
  const escape = call("read", { path: `${ROOT}${sep}..${sep}other${sep}package.json` });
  assert.ok(checkCallAllowlist(PLANS.basic, new Set(), [escape], canon).fatal);
});
