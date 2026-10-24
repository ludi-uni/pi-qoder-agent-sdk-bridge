import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import type { AssistantMessage, Api } from "@earendil-works/pi-ai";
import { buildCasePlans, checkCallAllowlist, classifyStreamError, evaluateAttempt, markerFor, runAttempt, type AttemptRecord } from "../scripts/live-verification.js";

const root = resolve("/repo");
const pkg = join(root, "package.json");
const absent = join(root, "test-artifacts/missing.json");
const plans = buildCasePlans({ root, packageJsonPath: pkg, sentinelPath: absent, indexPath: join(root, "extensions/index.ts"), grepPattern: "</pi_tool_call>", lsLimit: 10 });
const canonicalize = (path: string) => resolve(path);
const name = "pi-qoder-agent-sdk-bridge";
const body = JSON.stringify({ name, version: "0.2.2" });
const read = (path: string, id: string) => ({ name: "read", id, arguments: { path } });

function basicRecord(): Pick<AttemptRecord, "marker" | "observedPackageName" | "turns" | "results"> {
  const marker = markerFor("basic", 1);
  return { marker, observedPackageName: name, turns: [
    { turn: 1, stopReason: "toolUse", calls: [read(pkg, "p")], text: "" },
    { turn: 2, stopReason: "stop", calls: [], text: `${name}\n${marker}` },
  ], results: [{ id: "p", name: "read", isError: false, body }] };
}

test("gate rejects duplicate ids and same planned call twice within a group", () => {
  assert.ok(checkCallAllowlist(plans.basic, new Set(), [read(pkg, "p")], canonicalize, new Set(["p"])).fatal);
  assert.ok(checkCallAllowlist(plans.batch, new Set(), [read(pkg, "p"), read(pkg, "p")], canonicalize).fatal);
  assert.ok(checkCallAllowlist(plans.batch, new Set(), [read(pkg, "p"), read(pkg, "q")], canonicalize).fatal);
});

test("gate preserves toolFlowPass when only the final response fails", () => {
  const record = basicRecord();
  record.turns[1].text = `${name}\nMarker ${record.marker} not found`;
  const verdict = evaluateAttempt(plans.basic, record, canonicalize);
  assert.equal(verdict.failure, "FINAL_RESPONSE_NONCOMPLIANCE");
  assert.equal(verdict.toolFlowPass, true);
  assert.equal(verdict.responsePass, false);
  assert.equal(verdict.fullPass, false);
});

test("gate does not trust claimed package name or failed package reads", () => {
  const record = basicRecord();
  record.results[0].isError = true;
  assert.equal(evaluateAttempt(plans.basic, record, canonicalize).failure, "RESULT_MISMATCH");
  record.results[0].isError = false;
  record.results[0].body = JSON.stringify({ name: "different-package" });
  assert.equal(evaluateAttempt(plans.basic, record, canonicalize).failure, "RESULT_MISMATCH");
});

test("ENOENT must occur at the sentinel result, not a later successful-read step", () => {
  const marker = markerFor("error-recovery", 1);
  const record = { marker, observedPackageName: name, turns: [
    { turn: 1, stopReason: "toolUse", calls: [read(absent, "a")], text: "" },
    { turn: 2, stopReason: "toolUse", calls: [read(pkg, "p")], text: "" },
    { turn: 3, stopReason: "stop", calls: [], text: `${name}\nENOENT\n${marker}` },
  ], results: [{ id: "a", name: "read", isError: false, body }, { id: "p", name: "read", isError: true, body: "ENOENT: missing" }] };
  assert.equal(evaluateAttempt(plans["error-recovery"], record, canonicalize).failure, "RESULT_MISMATCH");
});

function fake(calls: ReturnType<typeof read>[]): AssistantMessage {
  return {
    role: "assistant", stopReason: "toolUse", content: calls.map(call => ({ type: "toolCall", ...call })),
    api: "qoder-agent-sdk" as Api, provider: "qoder-bridge", model: "fixture", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

test("duplicate historical id is blocked before the second execution", async () => {
  let turn = 0;
  let executions = 0;
  const record = await runAttempt({ plan: plans["error-recovery"], marker: markerFor("error-recovery", 1), task: "fixed", tools: [], systemPrompt: "sys", canonicalize,
    stream: async () => fake([read(turn++ === 0 ? absent : pkg, "duplicate")]),
    execute: async () => { executions++; return { isError: true, text: "ENOENT: missing" }; },
  });
  assert.equal(executions, 1);
  assert.equal(record.verdict.failure, "SAFETY_VIOLATION");
  assert.equal(record.verdict.fatal, true);
});

test("executor safety exception retains earlier evidence and stops the attempt", async () => {
  let turn = 0;
  const record = await runAttempt({ plan: plans["error-recovery"], marker: markerFor("error-recovery", 1), task: "fixed", tools: [], systemPrompt: "sys", canonicalize,
    stream: async () => fake([read(turn++ === 0 ? absent : pkg, `call-${turn}`)]),
    execute: async call => { if (call.arguments.path === pkg) throw new Error("SAFETY_VIOLATION: redirected file"); return { isError: true, text: "ENOENT: missing" }; },
  });
  assert.equal(record.results.length, 1);
  assert.equal(record.turns.length, 2);
  assert.equal(record.verdict.fatal, true);
});

test("service failure after completed tools does not erase tool-flow success", () => {
  const record = basicRecord();
  record.turns[1] = { ...record.turns[1], stopReason: "error", text: "", errorMessage: "PROVIDER_UNAVAILABLE: deadline" } as typeof record.turns[number];
  const verdict = evaluateAttempt(plans.basic, record, canonicalize);
  assert.equal(verdict.failure, "SERVICE_FAILURE");
  assert.equal(verdict.toolFlowPass, true);
  assert.equal(verdict.responsePass, false);
  assert.equal(verdict.fullPass, false);
  assert.equal(verdict.fatal, false);
});

test("SDK busy 10605 after completed tools preserves tool-flow like other service failures", () => {
  const record = basicRecord();
  record.turns[1] = {
    ...record.turns[1],
    stopReason: "error",
    text: "",
    errorMessage: "SDK_TERMINAL_ERROR: The model is busy and could not complete the request. Please try again later. [error_code=10605]",
  } as typeof record.turns[number];
  const verdict = evaluateAttempt(plans.basic, record, canonicalize);
  assert.equal(verdict.failure, "SERVICE_FAILURE");
  assert.equal(verdict.toolFlowPass, true);
  assert.equal(verdict.fullPass, false);
  assert.equal(verdict.fatal, false);
});

test("SDK busy does not forgive corrupted or forged results", () => {
  const busy = "SDK_TERMINAL_ERROR: The model is busy and could not complete the request. Please try again later. [error_code=10605]";
  const withBusy = () => {
    const record = basicRecord();
    record.turns[1] = { ...record.turns[1], stopReason: "error", text: "", errorMessage: busy } as typeof record.turns[number];
    return record;
  };
  // Wrong result id — linkage must still fail before toolFlowPass is granted.
  const wrongId = withBusy();
  wrongId.results[0].id = "WRONG_ID";
  assert.equal(evaluateAttempt(plans.basic, wrongId, canonicalize).failure, "RESULT_MISMATCH");
  // Wrong result name.
  const wrongName = withBusy();
  wrongName.results[0].name = "ls";
  assert.equal(evaluateAttempt(plans.basic, wrongName, canonicalize).failure, "RESULT_MISMATCH");
  // Extra/missing result count.
  const extra = withBusy();
  extra.results.push({ id: "orphan", name: "ls", isError: false, body: "x" });
  assert.equal(evaluateAttempt(plans.basic, extra, canonicalize).failure, "RESULT_MISMATCH");
  const missing = withBusy();
  missing.results.length = 0;
  assert.equal(evaluateAttempt(plans.basic, missing, canonicalize).failure, "RESULT_MISMATCH");
  // Failed package read (isError) is not a completed read.
  const failedRead = withBusy();
  failedRead.results[0].isError = true;
  assert.equal(evaluateAttempt(plans.basic, failedRead, canonicalize).failure, "RESULT_MISMATCH");
  // Forged package name in the result body must not self-certify the flow.
  const forged = withBusy();
  forged.results[0].body = JSON.stringify({ name: "attacker-package" });
  assert.equal(evaluateAttempt(plans.basic, forged, canonicalize).failure, "RESULT_MISMATCH");
  // Malformed JSON result cannot produce the observed package name.
  const malformed = withBusy();
  malformed.results[0].body = "{not json";
  assert.equal(evaluateAttempt(plans.basic, malformed, canonicalize).failure, "RESULT_MISMATCH");
  // A SAFETY_VIOLATION-prefixed stream error never becomes a service failure.
  const safety = withBusy();
  safety.turns[1].errorMessage = "SAFETY_VIOLATION: redirected file [error_code=10605]";
  const safetyVerdict = evaluateAttempt(plans.basic, safety, canonicalize);
  assert.equal(safetyVerdict.failure, "SAFETY_VIOLATION");
  assert.equal(safetyVerdict.fatal, true);
});

test("source drift is a safety stop, not a service/model failure", () => {
  assert.equal(classifyStreamError("SAFETY_VIOLATION: source drift"), "SAFETY_VIOLATION");
});
