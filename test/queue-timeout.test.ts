import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Api, type Model, type Message } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import { streamQoder, __setBridgeInternals, type QoderBridgeStreamExtras } from "../extensions/index.js";

const MODEL: Model<Api> = {
  id: "Auto", name: "queue fixture", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://local", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096,
};
const user: Message = { role: "user", content: "Reply after the tool result", timestamp: 1 };
const continuation: Message[] = [user, {
  role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "package.json" } }], timestamp: 1,
}, {
  role: "toolResult", toolCallId: "read1", toolName: "read", isError: false, content: [{ type: "text", text: "file content" }], timestamp: 2,
}];
const queue = (status = "queued", uuid = "queue"): SDKMessage => ({
  type: "system", subtype: "model_queue_status", status, service_available: status !== "queued",
  wait_time_ms: 30_000, uuid, session_id: "fixture",
}) as unknown as SDKMessage;
const assistant = (blocks: unknown[]): SDKMessage => ({
  type: "assistant", uuid: "assistant", session_id: "fixture",
  message: { id: "final", type: "message", role: "assistant", content: blocks, stop_reason: "end_turn" },
}) as unknown as SDKMessage;
const result: SDKMessage = {
  type: "result", subtype: "success", is_error: false, result: "OK", stop_reason: "end_turn", usage: {}, uuid: "result", session_id: "fixture",
} as unknown as SDKMessage;
const text = assistant([{ type: "text", text: "OK" }]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function run(messages: Message[], source: AsyncGenerator<SDKMessage>, options: QoderBridgeStreamExtras = {}) {
  __setBridgeInternals({ queryFactory: () => ({
    [Symbol.asyncIterator]: () => source,
    close: async () => {},
  }) });
  try {
    const stream = streamQoder(MODEL, normalizeContext({ systemPrompt: "fixture", tools: [], messages }), {
      providerMessageTimeoutMs: 30, postToolContinuationTimeoutMs: 30, totalDeadlineMs: 1000, ...options,
    });
    for await (const _ of stream) { /* drain */ }
    return await stream.result();
  } finally { __setBridgeInternals({}); }
}

for (const [label, messages] of [["initial response", [user]], ["post-tool continuation", continuation]] as const) {
  test(`queue grace outlasts ordinary silence for ${label}`, async () => {
    const out = await run([...messages], (async function* () {
      yield queue();
      await delay(80); // Longer than the ordinary 30ms bound.
      yield queue("ready", "ready"); yield text; yield result;
    })()); // Default queue timeout, no explicit override.
    assert.equal(out.stopReason, "stop", out.errorMessage ?? "queued response should complete");
    assert.equal((out.content[0] as { text: string }).text, "OK");
  });
}

test("queue timeout has its own configurable bound", async () => {
  const out = await run(continuation, (async function* () { yield queue(); await new Promise<void>(() => {}); })(), { providerQueueTimeoutMs: 50 });
  assert.equal(out.stopReason, "error");
  assert.match(out.errorMessage ?? "", /^PROVIDER_UNAVAILABLE: no provider message for 50ms$/);
});

test("ready restores the short continuation silence bound", async () => {
  const out = await run(continuation, (async function* () { yield queue(); yield queue("ready", "ready"); await new Promise<void>(() => {}); })());
  assert.match(out.errorMessage ?? "", /^POST_TOOL_CONTINUATION_TIMEOUT: no provider message for 30ms$/);
});

for (const [label, message] of [
  ["assistant text", text],
  ["native tool_use", assistant([{ type: "tool_use", id: "native1", name: "read", input: { path: "package.json" } }])],
  ["text delta", { type: "stream_event", uuid: "delta", session_id: "fixture", event: { type: "content_block_delta", delta: { type: "text_delta", text: "working" } } } as unknown as SDKMessage],
] as const) {
  test(`${label} restores ordinary timeout without a ready notification`, async () => {
    const out = await run(continuation, (async function* () { yield queue(); yield message; await new Promise<void>(() => {}); })());
    assert.match(out.errorMessage ?? "", /^POST_TOOL_CONTINUATION_TIMEOUT: no provider message for 30ms$/);
  });
}

test("queue heartbeats cannot extend the absolute deadline", async () => {
  let closed = false;
  const source = (async function* () {
    let index = 0;
    while (!closed) { yield queue("queued", `queue-${index++}`); await delay(10); }
  })();
  __setBridgeInternals({ queryFactory: () => ({ [Symbol.asyncIterator]: () => source, close: async () => { closed = true; } }) });
  const started = Date.now();
  try {
    const stream = streamQoder(MODEL, normalizeContext({ systemPrompt: "fixture", tools: [], messages: continuation }), {
      postToolContinuationTimeoutMs: 30, providerQueueTimeoutMs: 500, totalDeadlineMs: 100,
    });
    for await (const _ of stream) { /* drain */ }
    const out = await stream.result();
    assert.equal(out.stopReason, "error");
    assert.match(out.errorMessage ?? "", /^PROVIDER_UNAVAILABLE:/);
    assert.ok(closed, "queue query must be closed on timeout");
    assert.ok(Date.now() - started < 1000, "heartbeats must not keep the turn running");
  } finally { closed = true; __setBridgeInternals({}); }
});

test("abort still interrupts queued waiting immediately", async () => {
  const controller = new AbortController();
  __setBridgeInternals({ queryFactory: () => ({
    [Symbol.asyncIterator]: () => (async function* () { yield queue(); controller.abort(); await new Promise<void>(() => {}); })(),
    close: async () => {},
  }) });
  try {
    const stream = streamQoder(MODEL, normalizeContext({ systemPrompt: "fixture", tools: [], messages: continuation }), { signal: controller.signal });
    for await (const _ of stream) { /* drain */ }
    assert.equal((await stream.result()).stopReason, "aborted");
  } finally { __setBridgeInternals({}); }
});
