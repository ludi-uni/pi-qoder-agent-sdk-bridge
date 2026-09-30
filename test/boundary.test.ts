import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __setBridgeInternals,
  streamQoder,
  type QoderBridgeDiagnosticEvent,
} from "../extensions/index.js";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type Api,
  type Tool,
} from "@earendil-works/pi-ai";
import type { SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";

const MODEL: Model<Api> = {
  id: "Auto",
  name: "Auto (Qoder bridge)",
  api: "qoder-agent-sdk" as Api,
  provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

const READ_TOOL: Tool = {
  name: "read",
  description: "Read file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
} as unknown as Tool;
const TOOLS = [READ_TOOL];

const FAST: Record<string, unknown> = { postToolContinuationTimeoutMs: 60, providerMessageTimeoutMs: 60, totalDeadlineMs: 5_000 };
const DEBUG_FAST: Record<string, unknown> = { ...FAST, env: { QODER_BRIDGE_DEBUG: "0" }, debug: true };

function resultMessage(overrides: Partial<SDKResultMessage> = {}, uuid = "u1"): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: "s1",
    ...overrides,
  } as SDKResultMessage;
}

function assistantBlocks(blocks: unknown[], uuid: string, messageId = "m1", stopReason: string | null = null): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "s1",
    parent_tool_use_id: null,
    message: {
      id: messageId,
      role: "assistant",
      model: "Auto",
      content: blocks,
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
      type: "message",
    },
  } as unknown as SDKMessage;
}

const assistantText = (text: string, uuid = "a1", messageId = "m1", stopReason: string | null = null): SDKMessage =>
  assistantBlocks([{ type: "text", text }], uuid, messageId, stopReason);

function queueStatus(serviceAvailable: boolean, status = "queued", uuid?: string): SDKMessage {
  return {
    type: "system",
    subtype: "model_queue_status",
    status,
    request_id: "r1",
    request_set_id: "rs1",
    model_key: "qfmodel",
    queue_type: "p3",
    queue_wait_elapsed_ms: 10,
    service_available: serviceAvailable,
    uuid: uuid ?? `q-${Math.random()}`,
    session_id: "s1",
  } as unknown as SDKMessage;
}

function commandLifecycle(state: string): SDKMessage {
  return {
    type: "command_lifecycle",
    command_uuid: "c1",
    state,
    uuid: `cl-${Math.random()}`,
    session_id: "s1",
  } as unknown as SDKMessage;
}

async function* streamFrom(messages: SDKMessage[], opts?: { hangAfter?: number }): AsyncGenerator<SDKMessage, void> {
  for (let i = 0; i < messages.length; i++) {
    yield messages[i];
    if (opts?.hangAfter === i) await new Promise<void>(() => {});
  }
}

type FakeQuery = AsyncGenerator<SDKMessage, void> & { close(): Promise<void> };

function makeFakeQuery(messages: SDKMessage[], opts?: { hangAfter?: number; neverResponds?: boolean }): FakeQuery {
  const gen = opts?.neverResponds
    ? (async function* () { await new Promise<void>(() => {}); })() as AsyncGenerator<SDKMessage, void>
    : streamFrom(messages, opts);
  const fake = {
    next: () => gen.next(),
    return: async () => ({ done: true as const, value: undefined }),
    throw: async (e: unknown) => { throw e; },
    [Symbol.asyncIterator]() { return fake; },
    close: async () => {},
  };
  return fake as unknown as FakeQuery;
}

async function collect(stream: ReturnType<typeof streamQoder>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
}

function ctx(messages: Message[]) {
  return normalizeContext({ systemPrompt: "sys", tools: TOOLS, messages });
}

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistantMsg = (calls: { id: string; name: string; arguments: Record<string, unknown> }[]): Message => ({
  role: "assistant",
  content: calls.map((c) => ({ type: "toolCall" as const, ...c, arguments: c.arguments as never })),
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: 1,
});
const toolRes = (toolCallId: string, toolName: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName,
  isError: false,
  content: [{ type: "text", text }],
  timestamp: 1,
});

const BASE_CTX = ctx([user("hi")]);

function diagCapture() {
  const events: QoderBridgeDiagnosticEvent[] = [];
  return { events, sink: (e: QoderBridgeDiagnosticEvent) => events.push(e) };
}

test("provenance retains complete B/C/E inputs, not just digests", async () => {
  const diag = diagCapture();
  const bad = '<pi_tool_call>{"name":"read","arguments":{"path":"x"}}}</pi_tool_call>';
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText(bad), resultMessage({ result: bad })]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "error");
    for (const label of ["assembled_text", "normalization_input", "error_input"]) {
      const payload = diag.events.find(e => e.label === label)?.payload as { text: string };
      assert.equal(payload.text, bad, label);
    }
  } finally { __setBridgeInternals({}); }
});

test("queue ready without repeated availability flag clears stale unavailable classification", async () => {
  const ready = { ...queueStatus(true, "ready") } as unknown as Record<string, unknown>;
  delete ready.service_available;
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([queueStatus(false), ready as unknown as SDKMessage], { hangAfter: 1 }) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, DEBUG_FAST as never));
    assert.match(final.errorMessage ?? "", /^PROVIDER_RESPONSE_TIMEOUT:/);
  } finally { __setBridgeInternals({}); }
});

test("duplicate final snapshot with a new UUID cannot execute the same tool twice", async () => {
  const text = '<pi_tool_call>{"name":"read","arguments":{"path":"x"}}</pi_tool_call>';
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([
    assistantText(text, "final1", "message1", "end_turn"),
    assistantText(text, "final2", "message1", "end_turn"),
    resultMessage({ result: text }),
  ]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.content.filter(block => block.type === "toolCall").length, 1);
    assert.equal(final.stopReason, "toolUse");
  } finally { __setBridgeInternals({}); }
});

test("model output after unavailable queue status supersedes stale availability evidence", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([queueStatus(false), assistantText("working")], { hangAfter: 1 }) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.match(final.errorMessage ?? "", /^PROVIDER_RESPONSE_TIMEOUT:/);
  } finally { __setBridgeInternals({}); }
});

test("a standalone closing brace chunk assembles strictly without adding or dropping braces", async () => {
  const first = '<pi_tool_call>{"name":"read","arguments":{"path":"x"}';
  const text = first + '}' + '</pi_tool_call>';
  const diag = diagCapture();
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText(first, "part1"), assistantText("}", "part2"), assistantText("</pi_tool_call>", "part3"), resultMessage({ result: text })]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "toolUse");
    assert.equal(final.content.filter(block => block.type === "toolCall").length, 1);
    const B = diag.events.find(record => record.label === "assembled_text")?.payload as { text: string };
    assert.equal(B.text, text);
    const snapshots = diag.events.filter(record => record.label === "assistant_snapshot").map(record => (record.payload as { text: string }).text);
    assert.deepEqual(snapshots, [first, "}", "</pi_tool_call>"]);
  } finally { __setBridgeInternals({}); }
});

test("tool result continuation starts with a new empty buffer and request identity", async () => {
  const firstDiag = diagCapture(), secondDiag = diagCapture();
  let round = 0;
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText(round++ ? "finished" : '<pi_tool_call>{"name":"read","arguments":{"path":"x"}}</pi_tool_call>'), resultMessage()]) });
  try {
    const { final: first } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: firstDiag.sink } as never));
    const call = first.content.find(block => block.type === "toolCall");
    assert.ok(call?.type === "toolCall");
    const { final: second } = await collect(streamQoder(MODEL, ctx([user("hi"), first, toolRes(call.id, call.name, "body")]), { ...DEBUG_FAST, onDiagnostic: secondDiag.sink } as never));
    assert.equal(second.stopReason, "stop");
    assert.notEqual(firstDiag.events[0].requestId, secondDiag.events[0].requestId);
    const firstA = secondDiag.events.find(record => record.label === "sdk_raw_message")?.payload as { assembledOffset: number };
    assert.equal(firstA.assembledOffset, 0);
    assert.equal((secondDiag.events.find(record => record.label === "assembled_text")?.payload as { text: string }).text, "finished");
  } finally { __setBridgeInternals({}); }
});

// --- Boundary instrumentation (A raw chunk / B assembly / C normalize input / D parse input / E error input) ---

test("instrumentation: A→B→C→D chain sees identical data for a split-JSON tool call", async () => {
  const diag = diagCapture();
  // The envelope JSON is split across two SDK assistant chunks (UUID-distinct snapshots).
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText('<pi_tool_call>{"name":"read","arg', "a1"),
      assistantText('uments":{"path":"x.ts"}}</pi_tool_call>', "a2"),
      resultMessage(),
    ]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "toolUse");
    const raws = diag.events.filter(e => e.label === "sdk_raw_message");
    assert.equal(raws.length, 3, "expected one A record per SDK chunk");
    const asm = diag.events.find(e => e.label === "assembled_text")?.payload as { digest: string; length: number };
    const norm = diag.events.find(e => e.label === "normalization_input")?.payload as { digest: string };
    assert.equal(norm.digest, asm.digest, "C must carry exactly B");
    const parseInputs = diag.events.filter(e => e.label === "parse_input").map(e => (e.payload as { raw: string }).raw);
    assert.equal(parseInputs.join(""), '{"name":"read","arguments":{"path":"x.ts"}}');
    // Offsets are monotonically increasing boundaries.
    const aOffsets = raws.map(e => (e.payload as { assembledOffset: number }).assembledOffset);
    assert.deepEqual(aOffsets, [...aOffsets].sort((a, b) => a - b));
    // Stable request id + ordered sequence.
    assert.ok(diag.events.every(e => e.requestId === diag.events[0].requestId));
    assert.deepEqual(diag.events.map(e => e.sequence), diag.events.map((_, i) => i + 1));
  } finally { __setBridgeInternals({}); }
});

test("instrumentation: plain default mode emits no payload diagnostics", async () => {
  const diag = diagCapture();
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("hi"), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "stop");
    assert.equal(diag.events.length, 0, "onDiagnostic must be debug-gated");
  } finally { __setBridgeInternals({}); }
});

test("instrumentation: standalone } chunk and provider output defect are classified at boundary A", async () => {
  const diag = diagCapture();
  // Reproduces the observed real-provider defect: assistant text carries a
  // trailing `}` inside the envelope JSON ("...README.md\"}}").
  const defective = '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}}</pi_tool_call>';
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText(defective, "a1"),
      resultMessage({ result: defective }),
    ]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /invalid JSON/i);
    const defect = diag.events.find(e => e.label === "provider_output_defect");
    assert.ok(defect, "expected a PROVIDER_OUTPUT_DEFECT diagnostic record");
    const errInput = diag.events.find(e => e.label === "error_input");
    assert.ok(errInput, "expected a boundary E error_input record");
    assert.equal((errInput!.payload as { code: string }).code, "MALFORMED_ENVELOPE_JSON");
  } finally { __setBridgeInternals({}); }
});

test("instrumentation: E error_input records what normalization would have rejected", async () => {
  const diag = diagCapture();
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("<pi_tool_call>{bad}</pi_tool_call>"), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "error");
    const errInput = diag.events.find(e => e.label === "error_input");
    assert.ok(errInput);
    assert.equal((errInput!.payload as { code: string }).code, "MALFORMED_ENVELOPE_JSON");
  } finally { __setBridgeInternals({}); }
});

// --- Duplicate UUID detection ---

test("duplicate uuid: same uuid + identical content dedups without appending twice", async () => {
  const diag = diagCapture();
  const snap = assistantText("once", "dup-1");
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([snap, snap, resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "stop");
    const text = (final.content.find(b => b.type === "text") as { text: string }).text;
    assert.equal(text, "once", "replayed snapshot must not append a second copy");
    assert.ok(diag.events.some(e => e.label === "duplicate_uuid" && (e.payload as { action: string }).action === "dedup"));
  } finally { __setBridgeInternals({}); }
});

test("duplicate uuid: same uuid + different content is a strict error", async () => {
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText("first", "dup-2"),
      assistantText("DIFFERENT", "dup-2", "m1"),
      resultMessage(),
    ]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /uuid|duplicate/i);
  } finally { __setBridgeInternals({}); }
});

test("duplicate uuid: replayed duplicate assistant cannot append an extra } unnoticed", async () => {
  // If a replay path re-appended snapshot content, a stray `}` could enter the
  // assembled text silently. Identical-uuid replays are dropped by identity,
  // not by text-equality guessing.
  const snap = assistantText("}", "dup-3");
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([snap, snap, snap, resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "stop");
    const text = (final.content.find(b => b.type === "text") as { text: string }).text;
    assert.equal(text, "}");
  } finally { __setBridgeInternals({}); }
});

// --- Terminal result / final chunk behavior ---

test("terminal result stops chunk processing: chunks after result are never consumed", async () => {
  // The loop must finish at the first terminal result — a trailing assistant
  // chunk (e.g. transport replay) must not be pulled at all.
  let pulled = 0;
  const messages = [assistantText("done"), resultMessage(), assistantText("SHOULD-NOT-APPEAR")];
  const gen = (async function* () { for (const m of messages) { pulled++; yield m; } })();
  const fake = {
    next: () => gen.next(),
    return: async () => ({ done: true as const, value: undefined }),
    throw: async (e: unknown) => { throw e; },
    [Symbol.asyncIterator]() { return fake; },
    close: async () => {},
  } as unknown as FakeQuery;
  __setBridgeInternals({ queryFactory: () => fake });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "stop");
    const text = (final.content.find(b => b.type === "text") as { text: string }).text;
    assert.equal(text, "done");
    assert.equal(pulled, 2, "no pull after terminal result");
  } finally { __setBridgeInternals({}); }
});

test("split JSON chunks across assistant snapshots assemble into one envelope", async () => {
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText('<pi_tool_call>{"name":"re', "s1"),
      assistantText('ad","arguments":{"path', "s2"),
      assistantText('":"x.ts"}}</pi_tool_call>', "s3"),
      resultMessage(),
    ]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "toolUse");
    const calls = final.content.filter(b => b.type === "toolCall");
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { name: string }).name, "read");
    assert.deepEqual((calls[0] as { arguments: unknown }).arguments, { path: "x.ts" });
  } finally { __setBridgeInternals({}); }
});

test("malformed provider output stays a strict terminal error (no repair/retry)", async () => {
  let calls = 0;
  __setBridgeInternals({
    queryFactory: () => {
      calls++;
      return makeFakeQuery([assistantText('<pi_tool_call>{"name":"read","arguments":{"path":"x"}}}</pi_tool_call>'), resultMessage()]);
    },
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /invalid JSON/i);
    assert.equal(calls, 1, "no retry on strict protocol failure");
  } finally { __setBridgeInternals({}); }
});

test("new continuation turn resets assembly state (no leftover buffers)", async () => {
  // Turn 1 ends in an error mid-envelope; turn 2 is a fresh streamQoder call
  // and must not inherit any partial assembly from turn 1.
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText('<pi_tool_call>{"name":"read","arguments":{"path":"x"}', "t1-a"),
      resultMessage(),
    ]),
  });
  try {
    const { final: f1 } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(f1.stopReason, "error");
    __setBridgeInternals({
      queryFactory: () => makeFakeQuery([assistantText("clean answer", "t2-a"), resultMessage()]),
    });
    const { final: f2 } = await collect(streamQoder(MODEL, ctx([user("hi"), assistantMsg([{ id: "c1", name: "read", arguments: { path: "x" } }]), toolRes("c1", "read", "body")]), FAST));
    assert.equal(f2.stopReason, "stop");
    assert.equal((f2.content.find(b => b.type === "text") as { text: string }).text, "clean answer");
  } finally { __setBridgeInternals({}); }
});

// --- Timeout classification ---

test("timeout: queue service_available=false before any model event → PROVIDER_UNAVAILABLE", async () => {
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([queueStatus(false), queueStatus(false)], { hangAfter: 1 }),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^PROVIDER_UNAVAILABLE:/);
  } finally { __setBridgeInternals({}); }
});

test("timeout: still queued without service flag → PROVIDER_QUEUE_TIMEOUT", async () => {
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([queueStatus(true, "queued"), queueStatus(true, "queued")], { hangAfter: 1 }),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^PROVIDER_QUEUE_TIMEOUT:/);
  } finally { __setBridgeInternals({}); }
});

test("timeout: silence with no queue evidence → PROVIDER_RESPONSE_TIMEOUT", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([], { neverResponds: true }) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^PROVIDER_RESPONSE_TIMEOUT:/);
  } finally { __setBridgeInternals({}); }
});

test("timeout: continuation silence keeps POST_TOOL_CONTINUATION_TIMEOUT", async () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
  ];
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([], { neverResponds: true }) });
  try {
    const { final } = await collect(streamQoder(MODEL, ctx(messages), FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^POST_TOOL_CONTINUATION_TIMEOUT:/);
  } finally { __setBridgeInternals({}); }
});

test("timeout: queue unavailability during continuation is NOT a continuation timeout", async () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
  ];
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([queueStatus(false), queueStatus(false)], { hangAfter: 1 }),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, ctx(messages), FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^PROVIDER_UNAVAILABLE:/, "queue availability failure must not count as a tool/continuation timeout");
  } finally { __setBridgeInternals({}); }
});

test("timeout: handoff ack then silence in continuation → POST_TOOL_CONTINUATION_TIMEOUT", async () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
  ];
  const diag = diagCapture();
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([commandLifecycle("started"), queueStatus(true, "ready")], { hangAfter: 1 }),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, ctx(messages), { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /^POST_TOOL_CONTINUATION_TIMEOUT:/);
    const cls = diag.events.find(e => e.label === "timeout_classification");
    assert.ok(cls);
    assert.equal((cls!.payload as { kind: string }).kind, "POST_TOOL_CONTINUATION_TIMEOUT");
  } finally { __setBridgeInternals({}); }
});

// --- stream_event observation (debug-only, never an assembly source) ---

test("stream_event deltas are diagnostics only and never double-assembled", async () => {
  const diag = diagCapture();
  const delta: SDKMessage = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "ignored-delta" } },
    parent_tool_use_id: null,
    uuid: "se-1",
    session_id: "s1",
  } as unknown as SDKMessage;
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([delta, assistantText("final text", "a1"), resultMessage()]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...DEBUG_FAST, onDiagnostic: diag.sink } as never));
    assert.equal(final.stopReason, "stop");
    const text = (final.content.find(b => b.type === "text") as { text: string }).text;
    assert.equal(text, "final text", "delta text must never merge into the authoritative snapshot path");
    assert.ok(diag.events.some(e => e.label === "sdk_stream_event"));
  } finally { __setBridgeInternals({}); }
});
