import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __setBridgeInternals,
  normalizeProviderResponse,
  isContinuationContext,
  validateContinuation,
  ProviderProtocolError,
  streamQoder,
  BRIDGE_STATE,
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
const LS_TOOL: Tool = {
  name: "ls",
  description: "List directory",
  parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
} as unknown as Tool;
const TOOLS = [READ_TOOL, LS_TOOL];

function resultMessage(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
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
    uuid: "u1",
    session_id: "s1",
    ...overrides,
  } as SDKResultMessage;
}

function assistantText(text: string, stopReason: string | null = null): SDKMessage {
  return {
    type: "assistant",
    uuid: "a1",
    session_id: "s1",
    parent_tool_use_id: null,
    message: {
      id: "m1",
      role: "assistant",
      model: "Auto",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
      type: "message",
    },
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

// --- normalizeProviderResponse (strict) ---

test("A: single valid envelope → ToolCallResponse", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":{"path":"x.ts"}}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "tool_calls");
  if (out.kind !== "tool_calls") return;
  assert.equal(out.calls[0].name, "read");
  assert.deepEqual(out.calls[0].arguments, { path: "x.ts" });
});

test("D: two envelopes preserve order", () => {
  const out = normalizeProviderResponse(
    `<pi_tool_call>{"name":"read","arguments":{"path":"a"}}</pi_tool_call>\n<pi_tool_call>{"name":"ls","arguments":{}}</pi_tool_call>`,
    TOOLS,
  );
  assert.equal(out.kind, "tool_calls");
  if (out.kind !== "tool_calls") return;
  assert.deepEqual(out.calls.map((c) => c.name), ["read", "ls"]);
});

test("B: malformed envelope JSON → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{bad}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "MALFORMED_ENVELOPE_JSON");
});

test("B: marker with prose around envelope → protocol_error (strict)", () => {
  const out = normalizeProviderResponse(`let me check <pi_tool_call>{"name":"read","arguments":{"path":"a"}}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "PROSE_AROUND_ENVELOPE");
});

test("B: unclosed pi_tool_call marker → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":{"path":"a"}}`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "UNCLOSED_ENVELOPE");
});

test("B: unknown fields in envelope → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":{"path":"a"},"role":"assistant"}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "INVALID_ENVELOPE");
  assert.match(out.error.message, /"role"/);
});

test("B: empty id → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":{"path":"a"},"id":""}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "INVALID_ENVELOPE");
});

test("B: duplicate ids → protocol_error", () => {
  const out = normalizeProviderResponse(
    `<pi_tool_call>{"name":"read","arguments":{"path":"a"},"id":"t1"}</pi_tool_call><pi_tool_call>{"name":"ls","arguments":{},"id":"t1"}</pi_tool_call>`,
    TOOLS,
  );
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "DUPLICATE_ID");
});

test("B: schema-invalid arguments → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":{}}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "INVALID_ARGUMENTS");
});

test("F: unknown tool name → protocol_error", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"rm_rf","arguments":{}}</pi_tool_call>`, TOOLS);
  assert.equal(out.kind, "protocol_error");
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "UNKNOWN_TOOL");
});

test("E: plain text without any marker → TextResponse", () => {
  const out = normalizeProviderResponse("just an answer", TOOLS);
  assert.equal(out.kind, "text");
  if (out.kind !== "text") return;
  assert.equal(out.text, "just an answer");
});

// --- continuation validation ---

test("continuation: valid assistant→toolResult chain passes", () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
  ];
  assert.equal(validateContinuation(messages), undefined);
  assert.equal(isContinuationContext(ctx(messages)), true);
});

test("continuation: missing toolResult → protocol error", () => {
  const messages: Message[] = [user("hi"), assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }])];
  const err = validateContinuation(messages);
  assert.ok(err instanceof ProviderProtocolError);
  assert.equal(err?.code, "CONTINUATION_RESULTS_MISMATCH");
});

test("continuation: mismatched id/name → protocol error", () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "ls", "body"),
  ];
  assert.equal(validateContinuation(messages)?.code, "CONTINUATION_RESULTS_MISMATCH");
  const messages2: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("WRONG", "read", "body"),
  ];
  assert.equal(validateContinuation(messages2)?.code, "CONTINUATION_ORDER");
});

test("continuation: duplicate call id across history → protocol error", () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
    assistantMsg([{ id: "c1", name: "ls", arguments: {} }]),
    toolRes("c1", "ls", "out"),
  ];
  assert.equal(validateContinuation(messages)?.code, "DUPLICATE_ID");
});

test("continuation: fresh context is not a continuation", () => {
  assert.equal(isContinuationContext(BASE_CTX), false);
});

test("strict arguments do not coerce numeric path into text", () => {
  assert.equal(normalizeProviderResponse('<pi_tool_call>{"name":"read","arguments":{"path":42}}</pi_tool_call>', TOOLS).kind, "protocol_error");
});

test("tool-like broken opening tag never becomes text", () => {
  assert.equal(normalizeProviderResponse('<pi_tool_call {"name":"read"}', TOOLS).kind, "protocol_error");
});

test("orphan result without assistant is rejected", () => {
  assert.ok(validateContinuation([user("hi"), toolRes("orphan", "read", "body")]));
});

test("duplicate historical result is rejected", () => {
  assert.ok(validateContinuation([user("hi"), assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]), toolRes("c1", "read", "body"), toolRes("c1", "read", "duplicate"), user("next")]));
});

test("abort interrupts a silent provider immediately", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([], { neverResponds: true }) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    const start = Date.now();
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { signal: controller.signal, providerMessageTimeoutMs: 10000 }));
    assert.equal(final.stopReason, "aborted");
    assert.ok(Date.now() - start < 1000);
  } finally { clearTimeout(timer); __setBridgeInternals({}); }
});

test("debug payloads are opt-in and redact structured and inline secrets", async () => {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((value: string) => { writes.push(String(value)); return true; }) as typeof process.stderr.write;
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText('done apiKey=INLINE_SECRET'), resultMessage()]) });
  const context = ctx([user('token=USER_SECRET Bearer BEARER_SECRET API_LITERAL')]);
  try {
    await collect(streamQoder(MODEL, context, { apiKey: 'API_LITERAL', env: { QODER_BRIDGE_DEBUG: '0' } }));
    assert.equal(writes.length, 0);
    await collect(streamQoder(MODEL, context, { apiKey: 'API_LITERAL', env: { QODER_BRIDGE_DEBUG: '1' } }));
    const text = writes.join('');
    assert.match(text, /provider_request/);
    assert.match(text, /provider_response/);
    assert.match(text, /normalized/);
    assert.doesNotMatch(text, /USER_SECRET|BEARER_SECRET|INLINE_SECRET|API_LITERAL/);
  } finally { process.stderr.write = original; __setBridgeInternals({}); }
});

test("terminal event waits for bounded transport cleanup before continuation handoff", async () => {
  let closed = false;
  __setBridgeInternals({ queryFactory: () => {
    const fake = makeFakeQuery([assistantText("done"), resultMessage()]);
    fake.close = async () => { await new Promise(resolve => setTimeout(resolve, 20)); closed = true; };
    return fake;
  } });
  try {
    await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(closed, true);
  } finally { __setBridgeInternals({}); }
});

// --- streamQoder ---

const FAST: Record<string, unknown> = { postToolContinuationTimeoutMs: 50, postResultTimeoutMs: 50, providerMessageTimeoutMs: 50, totalDeadlineMs: 5_000 };

test("A: streamQoder emits toolUse for a valid single tool call", async () => {
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([
      assistantText(`<pi_tool_call>{"name":"read","arguments":{"path":"x.ts"}}</pi_tool_call>`),
      resultMessage(),
    ]),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "toolUse");
    const calls = final.content.filter((b) => b.type === "toolCall");
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { name: string }).name, "read");
  } finally {
    __setBridgeInternals({});
  }
});

test("A: second turn consumes assistant+toolResult context and completes", async () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "x.ts" } }]),
    toolRes("c1", "read", "file body"),
  ];
  const states: string[] = [];
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([assistantText("done"), resultMessage()]),
    onState: (s: string) => states.push(s),
  });
  try {
    const { final } = await collect(streamQoder(MODEL, ctx(messages), FAST));
    assert.equal(final.stopReason, "stop");
    assert.equal(states[0], BRIDGE_STATE.WAITING_PROVIDER);
    assert.equal(states[1], BRIDGE_STATE.WAITING_CONTINUATION, `expected WAITING_CONTINUATION second, got ${states}`);
    assert.equal(states[states.length - 1], BRIDGE_STATE.COMPLETED);
  } finally {
    __setBridgeInternals({});
  }
});

test("TEST_D_TWO_CONSECUTIVE_TOOLS: tool1/result1/tool2/result2/final", async () => {
  const messages: Message[] = [user("go")];
  const responses = [
    '<pi_tool_call>{"name":"read","arguments":{"path":"a"}}</pi_tool_call>',
    '<pi_tool_call>{"name":"ls","arguments":{"path":"."}}</pi_tool_call>',
    'final',
  ];
  let round = 0;
  const states: string[] = [];
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText(responses[round++]), resultMessage()]), onState: state => states.push(state) });
  try {
    for (let i = 0; i < 3; i++) {
      const { final } = await collect(streamQoder(MODEL, ctx(messages), FAST));
      assert.equal(final.stopReason, i < 2 ? "toolUse" : "stop");
      messages.push(final);
      const calls = final.content.filter(block => block.type === "toolCall");
      assert.equal(calls.length, i < 2 ? 1 : 0);
      for (const call of calls) messages.push(toolRes(call.id, call.name, "real fixture result"));
    }
    assert.deepEqual(states, ["WAITING_PROVIDER", "WAITING_TOOL", "WAITING_PROVIDER", "WAITING_CONTINUATION", "WAITING_TOOL", "WAITING_PROVIDER", "WAITING_CONTINUATION", "COMPLETED"]);
  } finally { __setBridgeInternals({}); }
});

test("D: two consecutive tool turns (3-turn loop) keep ordering and ids", async () => {
  // Turn 2: model emits two envelopes → Pi executes both → context grows.
  const t2ctx = ctx([
    user("go"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body-a"),
  ]);
  let round = 0;
  __setBridgeInternals({
    queryFactory: () => {
      round++;
      return round === 1
        ? makeFakeQuery([
            assistantText(`<pi_tool_call>{"name":"read","arguments":{"path":"b"}}</pi_tool_call><pi_tool_call>{"name":"ls","arguments":{"path":"."}}</pi_tool_call>`),
            resultMessage(),
          ])
        : makeFakeQuery([assistantText("all done"), resultMessage()]);
    },
  });
  try {
    const { final: f2 } = await collect(streamQoder(MODEL, t2ctx, FAST));
    assert.equal(f2.stopReason, "toolUse");
    const calls = f2.content.filter((b) => b.type === "toolCall") as { id: string; name: string }[];
    assert.deepEqual(calls.map((c) => c.name), ["read", "ls"]);

    // Turn 3: append both results, model answers with text → stop.
    const t3ctx = ctx([
      user("go"),
      assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
      toolRes("c1", "read", "body-a"),
      {
        role: "assistant",
        content: f2.content,
        api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
        usage: f2.usage, stopReason: f2.stopReason, timestamp: 2,
      },
      ...calls.map((c) => toolRes(c.id, c.name, `out-${c.name}`)),
    ]);
    const { final: f3 } = await collect(streamQoder(MODEL, t3ctx, FAST));
    assert.equal(f3.stopReason, "stop");
  } finally {
    __setBridgeInternals({});
  }
});

test("E: streamQoder completes with text response", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("plain answer"), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "stop");
    assert.equal((final.content.find((b) => b.type === "text") as { text: string }).text, "plain answer");
  } finally {
    __setBridgeInternals({});
  }
});

test("F: unknown tool → terminal protocol error (no retry)", async () => {
  let calls = 0;
  __setBridgeInternals({
    queryFactory: () => { calls++; return makeFakeQuery([assistantText(`<pi_tool_call>{"name":"rm_rf","arguments":{}}</pi_tool_call>`), resultMessage()]); },
  });
  try {
    const { events, final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /unlisted tool "rm_rf"/i);
    assert.ok(events.some((e) => e.type === "error"));
    assert.equal(calls, 1, "protocol errors must not retry the provider call");
  } finally {
    __setBridgeInternals({});
  }
});

test("B: malformed JSON → terminal protocol error, stream error", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText(`<pi_tool_call>{bad}</pi_tool_call>`), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /invalid JSON/i);
  } finally {
    __setBridgeInternals({});
  }
});

test("native tool_use block is normalized to a Pi toolCall (SDK-side execution stays disabled)", async () => {
  // The SDK block uses name "Read" — the Pi tool is "read". Native names
  // must match the allowed tool list, so use a matching-name block.
  const native = {
    type: "assistant", uuid: "a2", session_id: "s1", parent_tool_use_id: null,
    message: {
      id: "m2", role: "assistant", model: "Auto",
      content: [{ type: "tool_use", id: "tu_1", name: "read", input: { path: "x" } }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, type: "message",
    },
  } as unknown as SDKMessage;
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([native, resultMessage({ stop_reason: "tool_use" })]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "toolUse");
    const calls = final.content.filter((b) => b.type === "toolCall") as { id: string; name: string; arguments: unknown }[];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "tu_1");
    assert.equal(calls[0].name, "read");
    assert.deepEqual(calls[0].arguments, { path: "x" });
  } finally {
    __setBridgeInternals({});
  }
});

test("mixed meaningful text + native tool_use → terminal protocol error", async () => {
  const mixed = {
    type: "assistant", uuid: "a3", session_id: "s1", parent_tool_use_id: null,
    message: {
      id: "m3", role: "assistant", model: "Auto",
      content: [{ type: "text", text: "let me run this" }, { type: "tool_use", id: "tu_2", name: "read", input: { path: "x" } }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, type: "message",
    },
  } as unknown as SDKMessage;
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([mixed, resultMessage({ stop_reason: "tool_use" })]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /MIXED_CONTENT|mixes/i);
  } finally {
    __setBridgeInternals({});
  }
});

test("stop_reason tool_use with no envelope → terminal protocol error", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("hi"), resultMessage({ stop_reason: "tool_use" })]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /tool_use/i);
  } finally {
    __setBridgeInternals({});
  }
});

test("C: post-result iterator hang completes from terminal result", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("done"), resultMessage()], { hangAfter: 1 }) });
  try {
    const started = Date.now();
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "stop");
    assert.ok(Date.now() - started < 5_000);
  } finally {
    __setBridgeInternals({});
  }
});

test("C: continuation timeout — provider never responds after toolResult → FAILED", async () => {
  const messages: Message[] = [
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("c1", "read", "body"),
  ];
  const states: string[] = [];
  __setBridgeInternals({
    queryFactory: () => makeFakeQuery([], { neverResponds: true }),
    onState: (s: string) => states.push(s),
  });
  try {
    const started = Date.now();
    const { final } = await collect(streamQoder(MODEL, ctx(messages), FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /POST_TOOL_CONTINUATION_TIMEOUT/);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(states[states.length - 1], BRIDGE_STATE.FAILED);
    assert.ok(states.includes(BRIDGE_STATE.WAITING_CONTINUATION));
  } finally {
    __setBridgeInternals({});
  }
});

test("EOF without a result message → protocol error", async () => {
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("hi")]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /terminal result|no messages/i);
  } finally {
    __setBridgeInternals({});
  }
});

test("abort: pre-aborted signal terminates immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("hi"), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, BASE_CTX, { ...FAST, signal: controller.signal } as never));
    assert.equal(final.stopReason, "aborted");
  } finally {
    __setBridgeInternals({});
  }
});

test("invalid continuation context → immediate protocol error", async () => {
  const bad = ctx([
    user("hi"),
    assistantMsg([{ id: "c1", name: "read", arguments: { path: "a" } }]),
    toolRes("WRONG", "read", "body"),
  ]);
  __setBridgeInternals({ queryFactory: () => makeFakeQuery([assistantText("hi"), resultMessage()]) });
  try {
    const { final } = await collect(streamQoder(MODEL, bad, FAST));
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /toolResult|tool call/i);
  } finally {
    __setBridgeInternals({});
  }
});
