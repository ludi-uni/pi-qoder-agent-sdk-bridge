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
    assert.match(out.errorMessage ?? "", /^PROVIDER_UNAVAILABLE: total deadline 100ms reached \(elapsed \d+ms\)$/);
    assert.ok(closed, "queue query must be closed on timeout");
    assert.ok(Date.now() - started < 1000, "heartbeats must not keep the turn running");
  } finally { closed = true; __setBridgeInternals({}); }
});

test("absolute deadline is not reported as a short provider-silence window", async () => {
  const out = await run([user], (async function* () { await new Promise<void>(() => {}); yield result; })(), {
    providerMessageTimeoutMs: 500,
    totalDeadlineMs: 40,
  });
  assert.match(out.errorMessage ?? "", /^PROVIDER_RESPONSE_TIMEOUT: total deadline 40ms reached \(elapsed \d+ms\)$/);
});

// Regression: the production default deadline (900s) tolerates congested
// queues that outlast the ordinary silence bounds, but queue heartbeats still
// never extend it. A fake Date.now + stubbed (never-firing) timers keep this
// deterministic — no real 5/15-minute waits — while streamQoder genuinely runs
// with no explicit totalDeadlineMs, so it exercises DEFAULT_TOTAL_DEADLINE_MS.
// Every heartbeat yield resolves on microtask turns, so heartbeats always win
// their race against the armed bound (the real pattern where SDK status polls
// arrive inside the queue silence bound); elapsed wall-clock advances only via
// clock.advance() between yields.
const installFakeClock = () => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  Date.now = () => now;
  (globalThis as { setTimeout: unknown }).setTimeout = () => ++seq;
  (globalThis as { clearTimeout: unknown }).clearTimeout = () => {};
  const restore = () => {
    Date.now = realNow;
    (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
  };
  return { advance: (ms: number) => { now += ms; }, restore, now: () => now };
};

// Streams queue heartbeats until `until` (checked against the fake clock)
// passes, then completes normally.
async function* queuedHeartbeats(until: () => boolean): AsyncGenerator<SDKMessage> {
  let index = 0;
  while (!until()) {
    yield queue("queued", `hb-${index++}`);
  }
  yield queue("ready", "ready");
  yield text;
  yield result;
}

// Runs streamQoder without any explicit totalDeadlineMs (the production
// default is under test), advancing the fake clock by strideMs whenever the
// stream still has not settled after a batch of microtask hops.
async function runWithFakeClock(messages: Message[], source: AsyncGenerator<SDKMessage>, clock: ReturnType<typeof installFakeClock>, strideMs: number) {
  let closed = false;
  __setBridgeInternals({ queryFactory: () => ({
    [Symbol.asyncIterator]: () => source,
    close: async () => { closed = true; },
  }) });
  try {
    const stream = streamQoder(MODEL, normalizeContext({ systemPrompt: "fixture", tools: [], messages }), {
      providerMessageTimeoutMs: 30, postToolContinuationTimeoutMs: 30, providerQueueTimeoutMs: 100,
    });
    const drain = (async () => {
      for await (const _ of stream) { /* drain */ }
      return stream.result();
    })();
    let settled = false;
    drain.then(() => { settled = true; }, () => { settled = true; });
    for (let guard = 0; guard < 2_000 && !settled; guard++) {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (!settled) clock.advance(strideMs);
    }
    assert.ok(settled, "stream settled within the fake-clock drive loop");
    return { out: await drain, closed };
  } finally { __setBridgeInternals({}); }
}

for (const [label, messages] of [["initial response", [user]], ["post-tool continuation", continuation]] as const) {
  test(`default 900s deadline outlasts 5min of queue heartbeats for ${label}`, async () => {
    const clock = installFakeClock();
    try {
      const source = queuedHeartbeats(() => clock.now() >= 310_000);
      const { out } = await runWithFakeClock([...messages], source, clock, 20_000);
      assert.equal(out.stopReason, "stop", out.errorMessage ?? "a 310s congested queue must still complete under the 900s default");
      assert.equal((out.content[0] as { text: string }).text, "OK");
      assert.ok(clock.now() >= 300_000, "simulated elapsed time must exceed the old 300s default");
    } finally { clock.restore(); }
  });
}

test("default 900s deadline still fails finitely while heartbeats keep arriving", async () => {
  const clock = installFakeClock();
  try {
    const { out, closed } = await runWithFakeClock(continuation, queuedHeartbeats(() => false), clock, 20_000);
    assert.equal(out.stopReason, "error");
    assert.match(out.errorMessage ?? "", /total deadline 900000ms reached \(elapsed \d+ms\)$/);
    assert.ok(closed, "queue query must be closed when the absolute deadline fires");
    assert.ok(clock.now() >= 900_000, "the default deadline elapsed before the error was raised");
  } finally { clock.restore(); }
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
