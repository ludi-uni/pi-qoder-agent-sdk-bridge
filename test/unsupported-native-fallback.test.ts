import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __setBridgeInternals,
  installedQoderSdkVersion,
  normalizeProviderResponse,
  qoderCapabilityRegistry,
  qoderNativeFallbackReasons,
  QODER_NATIVE_FALLBACK_REASONS,
  streamQoder,
} from "../extensions/index.js";
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai";

const tool = {
  name: "read", description: "Read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
} as unknown as Tool;
const model: Model<Api> = {
  id: "Auto", name: "Auto", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://local", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const block = (id = "call_123", input: unknown = { path: "foo.txt" }) => ({ type: "tool_use", id, name: "read", input });
const normalize = (blocks: unknown[]) => normalizeProviderResponse({ kind: "blocks", blocks }, [tool]);

// T1-T5/T9/T10 prove the EXISTING pure normalization boundary, not safe runtime
// fallback activation. No SDK runtime, Pi executor, or simulated approval here.
test("T1 valid native uses existing standard normal form (offline only)", () => {
  const result = normalize([block()]);
  assert.equal(result.kind, "tool_calls");
  if (result.kind !== "tool_calls") return;
  assert.deepEqual(result.calls, [{ id: "call_123", name: "read", arguments: { path: "foo.txt" } }]);
});

test("T2 native call ID is preserved, never replaced by generation ID", () => {
  const result = normalize([block("native_id")]);
  assert.equal(result.kind, "tool_calls");
  if (result.kind === "tool_calls") assert.equal(result.calls[0].id, "native_id");
});

test("T3 arguments/name/ID are not repaired, renamed, coerced or case-changed", () => {
  const input = { path: "Foo/Token-08.txt" };
  const before = structuredClone(input);
  const result = normalize([block("Call_ABC", input)]);
  assert.equal(result.kind, "tool_calls");
  if (result.kind !== "tool_calls") return;
  assert.equal(result.calls[0].arguments, input);
  assert.deepEqual(input, before);
  assert.equal(result.calls[0].id, "Call_ABC");
  assert.equal(result.calls[0].name, "read");
  assert.equal(Object.hasOwn(input, "fallbackReason"), false);
  for (const invalid of [{ ...block(), name: "Read" }, block("c", { path: 12 }), block("c", { path: "x", extra: true })]) {
    assert.equal(normalize([invalid]).kind, "protocol_error");
  }
});

test("T4 malformed native cannot trigger parser repair/fallback", () => {
  for (const bad of [{ type: "tool_use", name: "read", input: {} }, { ...block(), name: "" }, block("c", '{"path":"x"'), { ...block(), type: "unknown" }]) {
    const result = normalize([bad]);
    assert.equal(result.kind, "protocol_error");
  }
});

test("T5 unknown tool remains rejected by existing guard", () => {
  const result = normalize([{ ...block(), name: "foreign" }]);
  assert.equal(result.kind, "protocol_error");
  if (result.kind === "protocol_error") assert.equal(result.error.code, "UNKNOWN_TOOL");
});

test.skip("T6 Pi approval through active fallback: BLOCKED before SDK startup; no approval integration evidence", () => {});
test.skip("T7 rejected Pi approval prevents execution: active fallback unavailable; do not substitute fake approval", () => {});

test("T8 same-ID repeated blocks stay rejected rather than emitting two calls", () => {
  const result = normalize([block(), block()]);
  assert.equal(result.kind, "protocol_error");
  if (result.kind === "protocol_error") assert.equal(result.error.code, "DUPLICATE_ID");
  // Actual duplicate-final-snapshot dedup is covered by standard-fallback.test.ts.
  // This does not claim an executor count or semantic replay policy.
});

test("T9 conflicting same-ID payload is rejected by existing duplicate guard", () => {
  const result = normalize([block(), block("call_123", { path: "different.txt" })]);
  assert.equal(result.kind, "protocol_error");
  if (result.kind === "protocol_error") assert.equal(result.error.code, "DUPLICATE_ID");
  // Existing production guard does not distinguish CALL_ID_CONFLICT.
});

test("T10 three native call IDs remain independent in existing normal form", () => {
  const result = normalize([block("a"), block("b"), block("c")]);
  assert.equal(result.kind, "tool_calls");
  if (result.kind === "tool_calls") assert.deepEqual(result.calls.map(c => c.id), ["a", "b", "c"]);
});

test("T11 unverified requirements retain distinct machine-readable reasons, not authorization", () => {
  const keys = Object.keys(QODER_NATIVE_FALLBACK_REASONS) as (keyof typeof QODER_NATIVE_FALLBACK_REASONS)[];
  assert.deepEqual(qoderNativeFallbackReasons("1.0.32", keys), [
    "SDK_NATIVE_HOST_EXECUTION_UNVERIFIED", "SDK_NATIVE_DEFER_UNVERIFIED", "SDK_NATIVE_APPROVAL_UNVERIFIED",
    "SDK_NATIVE_SEQUENTIAL_UNVERIFIED", "SDK_AMBIENT_EXECUTION_CLOSURE_UNVERIFIED",
  ]);
  assert.equal(qoderNativeFallbackReasons("1.0.32", [keys[0], keys[0]]).length, 1);
});

test("T12 audited parse/identity support is not treated as unsupported execution", () => {
  const { sdkVersion, capabilities } = qoderCapabilityRegistry("1.0.32");
  assert.equal(sdkVersion, "1.0.32");
  for (const key of ["native_tool_use_parse", "native_single_identity", "native_parallel_identity"] as const) assert.equal(capabilities[key], "SUPPORTED");
  for (const key of Object.keys(QODER_NATIVE_FALLBACK_REASONS) as (keyof typeof QODER_NATIVE_FALLBACK_REASONS)[]) assert.equal(capabilities[key], "UNVERIFIED");
  assert.deepEqual(qoderNativeFallbackReasons("1.0.32", []), []);
  assert.ok(Object.isFrozen(capabilities));
});

test("T13 unknown/new SDK versions start UNVERIFIED without semver promotion", () => {
  for (const version of ["UNKNOWN", "1.0.33", "1.1.0", "2.0.0", "1.0.32-beta", ""]) {
    const registry = qoderCapabilityRegistry(version);
    assert.equal(registry.sdkVersion, version);
    assert.ok(Object.values(registry.capabilities).every(v => v === "UNVERIFIED"));
    assert.deepEqual(qoderNativeFallbackReasons(version, ["native_ambient_execution_closure"]), ["SDK_AMBIENT_EXECUTION_CLOSURE_UNVERIFIED"]);
  }
});

test.skip("T14 SDK executor=0 AND real Pi executor=1: UNPROVEN; active safe fallback is BLOCKED", () => {});

test("installed version awareness reads actual SDK package", () => {
  assert.equal(installedQoderSdkVersion(), "1.0.32");
  assert.equal(qoderCapabilityRegistry().sdkVersion, installedQoderSdkVersion());
});

test("opt-in fails before query creation; zero tool emissions, no continuation retry", async () => {
  let queries = 0;
  __setBridgeInternals({ queryFactory: () => { queries++; throw new Error("must not reach SDK"); } });
  const diagnostics: unknown[] = [];
  try {
    const stream = streamQoder(model, normalizeContext({ tools: [tool], messages: [
      { role: "user", content: "secret-not-for-diagnostic", timestamp: 1 },
    ] }), { apiKey: "test-secret", debug: true,
      env: { QODER_UNVERIFIED_NATIVE_FALLBACK: "1" }, onDiagnostic: event => diagnostics.push(event) });
    const events = [];
    for await (const event of stream) events.push(event);
    const final = await stream.result();
    assert.equal(queries, 0);
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^SDK_AMBIENT_EXECUTION_CLOSURE_UNVERIFIED:/);
    assert.equal(events.some(e => e.type.startsWith("toolcall_")), false);
    assert.equal(events.some(e => e.type === "done"), false);
    const serialized = JSON.stringify(diagnostics);
    assert.match(serialized, /native_fallback_blocked/);
    assert.match(serialized, /NOT_REQUESTED/);
    assert.match(serialized, /NOT_STARTED/);
    assert.ok(!serialized.includes("test-secret"));
    assert.ok(!serialized.includes("secret-not-for-diagnostic"));
    // This is pre-query blocking evidence, NOT T14 (Pi also executes nothing).
  } finally { __setBridgeInternals({}); }
});

test("explicit flag=0 retains legacy query path (fake query only)", async () => {
  let queries = 0;
  __setBridgeInternals({ queryFactory: () => { queries++; throw new Error("legacy-query-reached"); } });
  try {
    const stream = streamQoder(model, normalizeContext({ tools: [tool], messages: [
      { role: "user", content: "hi", timestamp: 1 },
    ] }), { env: { QODER_UNVERIFIED_NATIVE_FALLBACK: "0" } });
    for await (const _ of stream) { /* consume */ }
    const final = await stream.result();
    assert.equal(queries, 1);
    assert.equal(final.errorMessage, "legacy-query-reached");
  } finally { __setBridgeInternals({}); }
});
