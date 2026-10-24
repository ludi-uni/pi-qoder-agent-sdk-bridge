import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __setBridgeInternals,
  SDK_ERROR_CODE,
  streamQoder,
  type QoderBridgeWarning,
} from "../extensions/index.js";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import {
  ControlRequestError,
  CONTROL_REQUEST_TIMEOUT_CODE,
  ModelPolicyTimeoutError,
  ProtocolVersionMismatchError,
  UnsupportedCliCapabilityError,
  type SDKMessage,
  type SDKResultMessage,
} from "@qoder-ai/qoder-agent-sdk";

const MODEL: Model<Api> = {
  id: "Auto", name: "Auto (Qoder bridge)", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://local", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 65_536,
};
const CTX = normalizeContext({ systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] });
const FAST: Record<string, unknown> = { providerMessageTimeoutMs: 60, postToolContinuationTimeoutMs: 60, providerQueueTimeoutMs: 60, totalDeadlineMs: 5_000 };

type FakeQuery = AsyncIterable<SDKMessage> & { close(): Promise<void> };
const fakeQuery = (messages: SDKMessage[]): FakeQuery => ({
  [Symbol.asyncIterator]: () => (async function* () { yield* messages; })(),
  close: async () => {},
});
const failingQuery = (thrown: unknown): FakeQuery => ({
  [Symbol.asyncIterator]: () => (async function* () { throw thrown; yield undefined as never; })(),
  close: async () => {},
});

function resultMessage(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result", subtype: "success", is_error: false, result: "",
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid: "u1", session_id: "s1",
    ...overrides,
  } as SDKResultMessage;
}
const assistantText = (text: string, uuid = "a1", messageId = "m1", stopReason: string | null = "end_turn"): SDKMessage => ({
  type: "assistant", uuid, session_id: "s1", parent_tool_use_id: null,
  message: { id: messageId, role: "assistant", model: "Auto", content: [{ type: "text", text }], stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 }, type: "message" },
}) as unknown as SDKMessage;
const warningMessage = (): SDKMessage => ({
  type: "system", subtype: "agents_md_size_warning", code: "AGENTS_MD_SIZE_THRESHOLD_REACHED",
  severity: "warning", total_bytes: 2048, threshold_bytes: 1024, threshold_source: "default",
  files: [{ path: "AGENTS.md", bytes: 2048 }], load_status: "complete", truncated: false,
  uuid: `w-${Math.random()}`, session_id: "s1",
}) as unknown as SDKMessage;
const commandsChanged = (): SDKMessage => ({
  type: "system", subtype: "commands_changed", commands: [{ name: "x" }], uuid: `c-${Math.random()}`, session_id: "s1",
}) as unknown as SDKMessage;

async function collect(stream: ReturnType<typeof streamQoder>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
}
async function run(messages: SDKMessage[], options: Record<string, unknown> = {}) {
  __setBridgeInternals({ queryFactory: () => fakeQuery(messages) });
  try { return await collect(streamQoder(MODEL, CTX, { ...FAST, ...options } as never)); }
  finally { __setBridgeInternals({}); }
}

// --- structured SDK failure classification (query() / iterator throws) ---

test("ProtocolVersionMismatchError classifies with a stable code, no retry claim", async () => {
  const error = new ProtocolVersionMismatchError("2.0", "1.0");
  __setBridgeInternals({ queryFactory: () => { throw error; } });
  try {
    const { events, final } = await collect(streamQoder(MODEL, CTX, FAST as never));
    assert.equal(final.stopReason, "error");
    assert.equal(final.errorMessage?.split(":")[0], SDK_ERROR_CODE.PROTOCOL_VERSION_MISMATCH);
    assert.ok(events.some(e => e.type === "error"));
    assert.ok(!/sdk-reported-retryable/.test(final.errorMessage ?? ""));
  } finally { __setBridgeInternals({}); }
});

test("UnsupportedCliCapabilityError and ModelPolicyTimeoutError classify distinctly", async () => {
  for (const [error, code] of [
    [new UnsupportedCliCapabilityError("test_capability"), SDK_ERROR_CODE.UNSUPPORTED_CLI_CAPABILITY],
    [new ModelPolicyTimeoutError(100), SDK_ERROR_CODE.MODEL_POLICY_TIMEOUT],
  ] as const) {
    __setBridgeInternals({ queryFactory: () => { throw error; } });
    try {
      const { final } = await collect(streamQoder(MODEL, CTX, FAST as never));
      assert.equal(final.errorMessage?.split(":")[0], code);
    } finally { __setBridgeInternals({}); }
  }
});

test("ControlRequestError timeout code and retryable flag are forwarded, never retried", async () => {
  let calls = 0;
  const timeoutError = new ControlRequestError({ requestId: "r1", message: "control request timed out", code: CONTROL_REQUEST_TIMEOUT_CODE, retryable: false });
  const retryableError = new ControlRequestError({ requestId: "r2", message: "control rejected", code: "RUNTIME_REJECTED", retryable: true });
  __setBridgeInternals({ queryFactory: () => { calls++; throw calls === 1 ? timeoutError : retryableError; } });
  try {
    const first = await collect(streamQoder(MODEL, CTX, FAST as never));
    assert.equal(first.final.errorMessage?.split(":")[0], SDK_ERROR_CODE.CONTROL_REQUEST_TIMEOUT);
    const second = await collect(streamQoder(MODEL, CTX, FAST as never));
    assert.equal(second.final.errorMessage?.split(":")[0], SDK_ERROR_CODE.CONTROL_REQUEST_REJECTED);
    assert.match(second.final.errorMessage ?? "", /sdk-reported-retryable/);
    assert.equal(calls, 2, "the bridge never retries the SDK call on its own");
  } finally { __setBridgeInternals({}); }
});

test("errors thrown inside the async iterator classify the same way", async () => {
  const error = new UnsupportedCliCapabilityError("test_capability");
  __setBridgeInternals({ queryFactory: () => failingQuery(error) });
  try {
    const { final } = await collect(streamQoder(MODEL, CTX, FAST as never));
    assert.equal(final.errorMessage?.split(":")[0], SDK_ERROR_CODE.UNSUPPORTED_CLI_CAPABILITY);
  } finally { __setBridgeInternals({}); }
});

test("unknown SDK errors keep a plain classified message, still redacted", async () => {
  const error = new Error("boom");
  __setBridgeInternals({ queryFactory: () => { throw error; } });
  try {
    const { final } = await collect(streamQoder(MODEL, CTX, FAST as never));
    assert.equal(final.stopReason, "error");
    assert.equal(final.errorMessage, "boom");
  } finally { __setBridgeInternals({}); }
});

// --- redaction of surfaced errorMessage ---

test("apiKey, Bearer and token-like values are redacted from surfaced errorMessage", async () => {
  const secret = "PAT_SECRET_123";
  const error = new Error(`auth failed Bearer BEARER_TOKEN_9 api_key=${secret} token: 'tk_abc'`);
  __setBridgeInternals({ queryFactory: () => { throw error; } });
  try {
    const { final } = await collect(streamQoder(MODEL, CTX, { ...FAST, apiKey: secret } as never));
    assert.equal(final.stopReason, "error");
    assert.ok(!(final.errorMessage ?? "").includes(secret));
    assert.ok(!(final.errorMessage ?? "").includes("BEARER_TOKEN_9"));
    assert.ok(!(final.errorMessage ?? "").includes("tk_abc"));
  } finally { __setBridgeInternals({}); }
});

test("terminal result errors surface codes but redact secret-bearing error strings", async () => {
  const secret = "RESULT_SECRET_77";
  const { final } = await run([
    resultMessage({ subtype: "error_during_execution", is_error: true, errors: [`denied api_key=${secret}`], error_code: "E_PERM" }),
  ], { apiKey: secret });
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", new RegExp(`^${SDK_ERROR_CODE.TERMINAL_ERROR}:`));
  assert.match(final.errorMessage ?? "", /error_code=E_PERM/);
  assert.ok(!(final.errorMessage ?? "").includes(secret));
});

// --- terminal result error_code / terminal_reason semantics ---

test("numeric and string error_code values on failing results reach the message", async () => {
  for (const error_code of [42, "Q_ERR"] as const) {
    const { final } = await run([resultMessage({ subtype: "error_max_turns", is_error: true, errors: [], error_code })]);
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", new RegExp(`error_code=${String(error_code)}`));
  }
});

test("failing result metadata preserves numeric zero and terminal reason before the error", async () => {
  const diagnostics: { label: string; payload: unknown }[] = [];
  const { final } = await run([resultMessage({ subtype: "error_during_execution", is_error: true, errors: ["failed"], error_code: 0, terminal_reason: "future_reason" })],
    { debug: true, onDiagnostic: (event: { label: string; payload: unknown }) => diagnostics.push(event) });
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", /error_code=0/);
  const metadata = diagnostics.find(d => d.label === "sdk_terminal_metadata")?.payload as Record<string, unknown>;
  assert.equal(metadata?.error_code, 0);
  assert.equal(metadata?.terminal_reason, "future_reason");
});

test("success with informational error_code=0 stays a success", async () => {
  const { final } = await run([assistantText("ok"), resultMessage({ error_code: 0 })]);
  assert.equal(final.stopReason, "stop");
  assert.equal(final.errorMessage, undefined);
});

test("success with an unfamiliar error_code stays compatible without guessing its meaning", async () => {
  for (const error_code of [42, "E_PARTIAL"] as const) {
    const { final } = await run([assistantText("ok"), resultMessage({ error_code })]);
    assert.equal(final.stopReason, "stop");
    assert.equal(final.errorMessage, undefined);
  }
});

test("terminal_reason is recorded in diagnostics and hook_stopped+text completes", async () => {
  const diagnostics: { label: string; payload: unknown }[] = [];
  const { final } = await run([assistantText("hook ended"), resultMessage({ terminal_reason: "hook_stopped" })],
    { debug: true, onDiagnostic: (event: { label: string; payload: unknown }) => diagnostics.push(event) });
  assert.equal(final.stopReason, "stop");
  const terminal = diagnostics.find(d => d.label === "sdk_terminal_result")?.payload as Record<string, unknown>;
  assert.equal(terminal?.terminal_reason, "hook_stopped");
  assert.ok(diagnostics.some(d => d.label === "hook_stopped_result"));
});

test("hook_stopped with tool_use never releases tool calls — fails closed", async () => {
  const context = normalizeContext({ systemPrompt: "sys", tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  __setBridgeInternals({ queryFactory: () => fakeQuery([
    assistantText(`<pi_tool_call>{"name":"read","arguments":{}}</pi_tool_call>`),
    resultMessage({ stop_reason: "tool_use", terminal_reason: "hook_stopped" }),
  ]) });
  let collected;
  try { collected = await collect(streamQoder(MODEL, context, FAST as never)); }
  finally { __setBridgeInternals({}); }
  const { events, final } = collected;
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", new RegExp(`^${SDK_ERROR_CODE.HOOK_STOPPED}:`));
  assert.match(final.errorMessage ?? "", /hook stopped the agent turn/);
  assert.equal(events.some(e => e.type.startsWith("toolcall_")), false);
  assert.equal(events.some(e => e.type === "done"), false);
});

test("hook_stopped with text and stop_reason=tool_use is not a contradiction — hook stop wins", async () => {
  const { final } = await run([assistantText("partial"), resultMessage({ stop_reason: "tool_use", terminal_reason: "hook_stopped" })]);
  // The hook is authoritative: agent stopped, no contradiction error, no invented call.
  assert.equal(final.stopReason, "stop");
  assert.ok(!/STOP_REASON_CONTRADICTION/.test(final.errorMessage ?? ""));
});

test("old results without terminal_reason and unknown reasons stay compatible", async () => {
  const absent = await run([assistantText("ok"), resultMessage()]);
  assert.equal(absent.final.stopReason, "stop");
  const unknown = await run([assistantText("ok"), resultMessage({ terminal_reason: "future_reason" })]);
  assert.equal(unknown.final.stopReason, "stop");
});

// --- agents_md_size_warning via onWarning ---

test("agents_md_size_warning reaches onWarning with debug off, bounded and sanitized", async () => {
  const warnings: QoderBridgeWarning[] = [];
  const { final } = await run([warningMessage(), assistantText("done"), resultMessage()], {
    apiKey: "onWarning-secret",
    onWarning: (warning: QoderBridgeWarning) => warnings.push(warning),
  });
  assert.equal(final.stopReason, "stop");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    kind: "agents_md_size_warning",
    code: "AGENTS_MD_SIZE_THRESHOLD_REACHED",
    severity: "warning",
    total_bytes: 2048,
    threshold_bytes: 1024,
    load_status: "complete",
    file_count: 1,
  });
  assert.equal("files" in warnings[0], false, "no arbitrary fields or file contents leak");
  assert.ok(!JSON.stringify(warnings[0]).includes("onWarning-secret"));
});

test("a throwing onWarning callback never changes the provider outcome", async () => {
  const { final } = await run([warningMessage(), assistantText("done"), resultMessage()], {
    onWarning: () => { throw new Error("sink exploded"); },
  });
  assert.equal(final.stopReason, "stop");
  assert.equal(final.errorMessage, undefined);
});

test("commands_changed catalog events are ignored safely", async () => {
  const { final } = await run([commandsChanged(), assistantText("done"), resultMessage()]);
  assert.equal(final.stopReason, "stop");
});
