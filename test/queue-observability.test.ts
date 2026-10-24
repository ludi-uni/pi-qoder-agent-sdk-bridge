import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSdkObserver,
  describeSdkMessage,
  SDK_OBSERVATION_SCHEMA,
  type SdkObserver,
  type TraceEvent,
} from "../scripts/live-verification.js";

/** Structural trace for the live harness queue/init/model-output split.
 *  Everything here is offline: fixtures are plain objects matching the SDK
 *  1.0.51 wire types (dist/protocol/messages.d.ts), no SDK import needed. */

const init = () => ({
  type: "system", subtype: "init", model: "Qwen3.8-Flash",
  apiKeySource: "login", qodercli_version: "1.2.3", protocol_version: "2.0",
  cwd: "D:/repo", tools: ["Read", "Bash"], mcp_servers: [],
  permissionMode: "dontAsk", slash_commands: [], output_style: "default",
  skills: [], plugins: [], uuid: "u-init", session_id: "s1",
});
const queue = (status: string, extra: Record<string, unknown> = {}) => ({
  type: "system", subtype: "model_queue_status", status,
  request_id: "req-1", request_set_id: "rs-1", model_key: "qfmodel",
  queue_type: "p3", queue_count: 2, wait_time_ms: 30000,
  queue_wait_elapsed_ms: 1500, queue_max_wait_ms: 120000,
  service_available: status !== "queued",
  uuid: `q-${Math.random()}`, session_id: "s1", ...extra,
});
const lifecycle = (state: string) => ({
  type: "command_lifecycle", command_uuid: "c1", state,
  uuid: `cl-${Math.random()}`, session_id: "s1",
});
const apiRetry = (attempt: number) => ({
  type: "system", subtype: "api_retry", attempt, max_retries: 5,
  retry_delay_ms: 2000, error_status: 503,
  error: { message: "free-form body must NOT be captured" },
  uuid: `ar-${Math.random()}`, session_id: "s1",
});
const controlProgress = (status: string, attempt?: number) => ({
  type: "system", subtype: "control_request_progress", request_id: "cr-1",
  status, attempt, max_retries: 3, retry_delay_ms: 500, error_status: null,
  uuid: `cp-${Math.random()}`, session_id: "s1",
});
const streamDelta = () => ({
  type: "stream_event", uuid: `d-${Math.random()}`, session_id: "s1",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "secret text" } },
});
const assistant = (stopReason: string | null = "end_turn") => ({
  type: "assistant", uuid: `a-${Math.random()}`, session_id: "s1",
  parent_tool_use_id: null,
  message: {
    id: "m1", type: "message", role: "assistant", model: "Qwen3.8-Flash",
    stop_reason: stopReason,
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "text", text: "assistant body must NOT be captured" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "/etc/secret" } },
    ],
  },
});
const result = () => ({
  type: "result", subtype: "success", is_error: false,
  result: "free-form final body must NOT be captured",
  duration_ms: 4000, duration_api_ms: 3500, num_turns: 1,
  stop_reason: "end_turn", error_code: 0, terminal_reason: null,
  total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
  uuid: "u-res", session_id: "s1",
});

/** Deterministic virtual clock: each call returns the next fixture ms. */
function ticking(times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

test("trace splits init → queued → heartbeat → ready → model output by arrival time", () => {
  const obs: SdkObserver = createSdkObserver({ now: ticking([10, 20, 5000, 30000, 60000, 62000, 63000, 64000]) });
  obs.observe(init());
  obs.observe(lifecycle("started"));
  obs.observe(queue("queued"));
  obs.observe(queue("queued", { queue_wait_elapsed_ms: 30000 })); // heartbeat
  obs.observe(queue("ready"));
  obs.observe(streamDelta());
  obs.observe(assistant());
  obs.observe(result());
  const snap = obs.snapshot();
  assert.equal(snap.schema, SDK_OBSERVATION_SCHEMA);
  assert.equal(snap.totalEvents, 8);
  assert.equal(snap.droppedEvents, 0);
  assert.equal(snap.events.length, 8);
  assert.equal(snap.events[0].t, 10);
  assert.equal(snap.firstEventElapsedMs, 10);
  assert.equal(snap.lastEventElapsedMs, 64000);
  // Init arrived but that alone is not readiness; queue ready proves the split.
  assert.equal(snap.sawInit, true);
  assert.equal(snap.initElapsedMs, 10);
  assert.equal(snap.sawCommandStarted, true);
  assert.equal(snap.commandStartedElapsedMs, 20);
  assert.equal(snap.lastCommandLifecycleState, "started");
  assert.equal(snap.sawQueueReady, true);
  assert.equal(snap.queueReadyElapsedMs, 60000);
  // Last queue frame is the "ready" transition, kept for post-hoc reading.
  assert.deepEqual(snap.lastQueueStatus, {
    status: "ready", service_available: true,
    queue_wait_elapsed_ms: 1500, queue_max_wait_ms: 120000, queue_count: 2,
  });
  assert.equal(snap.sawModelEvent, true);
  assert.equal(snap.firstModelEventElapsedMs, 62000); // stream_event is model output
  assert.equal(snap.lastModelEventElapsedMs, 64000);
  assert.deepEqual(snap.counts, {
    assistant: 1, streamEvent: 1, result: 1, system: 4, commandLifecycle: 1, other: 0,
  });
  // A "queued forever" turn: ready/model flags distinguish where it waited.
  assert.ok(snap.queueReadyElapsedMs! < snap.firstModelEventElapsedMs!,
    "queue-ready vs first model event is the wait-stage split");
});

test("service_available=false last queue status is preserved for UNAVAILABLE diagnosis", () => {
  const obs = createSdkObserver({ now: ticking([5, 30000]) });
  obs.observe(init());
  obs.observe(queue("queued", { service_available: false, queue_wait_elapsed_ms: 30000 }));
  const snap = obs.snapshot();
  assert.equal(snap.sawQueueReady, false);
  assert.equal(snap.sawModelEvent, false);
  assert.equal(snap.lastQueueStatus?.service_available, false);
  assert.equal(snap.lastQueueStatus?.status, "queued");
  assert.equal(snap.lastQueueStatus?.queue_wait_elapsed_ms, 30000);
});

test("SDK-internal api_retry/control_request_progress counters are captured, error body is not", () => {
  const obs = createSdkObserver({ now: ticking([10, 2000, 4000, 5000, 6000, 7000]) });
  obs.observe(init());
  obs.observe(apiRetry(1));
  obs.observe(apiRetry(3));
  obs.observe(controlProgress("started"));
  obs.observe(controlProgress("api_retry", 2));
  obs.observe(result());
  const snap = obs.snapshot();
  assert.equal(snap.apiRetryCount, 2);
  assert.equal(snap.maxApiRetryAttempt, 3);
  assert.equal(snap.controlRequestRetryCount, 1);
  const retry = snap.events.find(e => e.kind === "api_retry" && e.attempt === 3)!;
  assert.equal(retry.max_retries, 5);
  assert.equal(retry.retry_delay_ms, 2000);
  assert.equal(retry.error_status, 503);
  const cp = snap.events.find(e => e.kind === "control_request_progress" && e.status === "api_retry")!;
  assert.equal(cp.attempt, 2);
  assert.equal(cp.request_id, "cr-1");
  assert.equal(cp.error_status, null, "nullable error_status preserved as null");
  assert.ok(!JSON.stringify(snap).includes("free-form"));
});

test("event timeline is bounded; overflow only bumps droppedEvents while aggregates continue", () => {
  const obs = createSdkObserver({ now: ticking(Array.from({ length: 30 }, (_, i) => i * 10)), maxEvents: 5 });
  for (let i = 0; i < 20; i++) obs.observe(queue("queued"));
  for (let i = 0; i < 8; i++) obs.observe(assistant(null));
  obs.observe(result());
  const snap = obs.snapshot();
  assert.equal(snap.events.length, 5);
  assert.equal(snap.totalEvents, 29);
  assert.equal(snap.droppedEvents, 24);
  // Aggregates saw every frame even though the timeline was capped.
  assert.equal(snap.counts.system, 20);
  assert.equal(snap.counts.assistant, 8);
  assert.equal(snap.counts.result, 1);
  assert.equal(snap.sawModelEvent, true);
  assert.equal(snap.lastModelEventElapsedMs, 280);
});

test("assistant bodies, stream deltas, result text and file paths never enter the trace", () => {
  const obs = createSdkObserver({ now: ticking([0, 1, 2]) });
  obs.observe(assistant());
  obs.observe(streamDelta());
  obs.observe(result());
  const json = JSON.stringify(obs.snapshot());
  for (const forbidden of ["assistant body", "private chain", "/etc/secret", "secret text", "final body"]) {
    assert.ok(!json.includes(forbidden), `forbidden content leaked: ${forbidden}`);
  }
  const assistantEv = obs.snapshot().events[0];
  assert.deepEqual(
    { text: assistantEv.text_blocks, tool: assistantEv.tool_use_blocks, thinking: assistantEv.thinking_blocks, other: assistantEv.other_blocks },
    { text: 1, tool: 1, thinking: 1, other: 0 },
  );
  const delta = obs.snapshot().events[1];
  assert.equal(delta.kind, "stream_event");
  assert.equal(delta.event_type, "content_block_delta");
  const res = obs.snapshot().events[2];
  assert.equal(res.kind, "result");
  assert.equal(res.subtype, "success");
  assert.equal(res.error_code, "0");
  assert.equal(res.terminal_reason, undefined, "null terminal_reason is dropped, not stored");
});

test("overlong tokens, NaN/Infinity and non-identifier strings are excluded", () => {
  const ev = describeSdkMessage({
    type: "system", subtype: "model_queue_status",
    status: "queued with spaces and a long free-form reason that is not an identifier token at all",
    request_id: "r1",
    queue_wait_elapsed_ms: Number.NaN,
    wait_time_ms: Infinity,
    queue_count: -Infinity,
    service_available: "yes", // wrong type
    error_code: Symbol("nope"),
  }, 42);
  assert.equal(ev.kind, "queue_status");
  assert.equal(ev.status, undefined, "non-token status dropped");
  assert.equal(ev.request_id, "r1");
  assert.equal(ev.queue_wait_elapsed_ms, undefined, "NaN excluded");
  assert.equal(ev.wait_time_ms, undefined, "Infinity excluded");
  assert.equal(ev.queue_count, undefined, "-Infinity excluded");
  assert.equal(ev.service_available, undefined, "non-boolean excluded");
  assert.equal(ev.t, 42);
});

test("unknown/unexpected message shapes degrade to kind=other without throwing", () => {
  const obs = createSdkObserver({ now: ticking([0, 1, 2, 3]) });
  obs.observe(null);
  obs.observe("garbage");
  obs.observe({ type: "cloud_agent_event", event: "anything", data: { huge: "payload not copied" } });
  obs.observe({ type: "system", subtype: "future_subtype_v99", whatever: "ignored" });
  const snap = obs.snapshot();
  assert.equal(snap.counts.other, 3);
  assert.equal(snap.counts.system, 1);
  assert.equal(snap.events[3].kind, "system");
  assert.equal(snap.events[3].subtype, "future_subtype_v99");
  assert.ok(!JSON.stringify(snap).includes("payload not copied"));
});

test("observe() never throws and counts internal capture failures", () => {
  const obs = createSdkObserver({ now: () => 1 });
  // Pathological input that could break a naive recorder.
  const cyclic: Record<string, unknown> = { type: "assistant" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => obs.observe(cyclic));
  const snap = obs.snapshot();
  assert.equal(snap.totalEvents, 1);
  // Malformed assistant still counts as an assistant arrival (timing evidence).
  assert.equal(snap.counts.assistant, 1);
  assert.equal(snap.sawModelEvent, true);
});

test("a throwing clock cannot break the provider path — captureErrorCount records it", () => {
  let calls = 0;
  const obs = createSdkObserver({ now: () => { calls++; if (calls === 1) throw new Error("clock exploded"); return 5; } });
  obs.observe(init());      // clock throws inside ingest → captureError
  obs.observe(lifecycle("started")); // clock works again
  const snap = obs.snapshot();
  assert.equal(snap.captureErrorCount, 1);
  assert.equal(snap.totalEvents, 1, "the failed frame is not counted");
  assert.equal(snap.sawInit, false);
  assert.equal(snap.sawCommandStarted, true);
});

test("monotonic timestamps come from receipt time, not message content", () => {
  const obs = createSdkObserver({ now: ticking([100, 250]) });
  obs.observe({ ...init(), timestamp: "2030-01-01T00:00:00Z" }); // wire timestamp ignored
  obs.observe(result());
  const snap = obs.snapshot();
  assert.equal(snap.events[0].t, 100);
  assert.equal(snap.events[1].t, 250);
});

test("snapshot() is a defensive copy; mutating it cannot corrupt the observer", () => {
  const obs = createSdkObserver({ now: ticking([0]) });
  obs.observe(init());
  const snap = obs.snapshot();
  snap.events.push({ t: 999, kind: "result" } as TraceEvent);
  snap.counts.assistant = 99;
  const again = obs.snapshot();
  assert.equal(again.events.length, 1);
  assert.equal(again.counts.assistant, 0);
  snap.events[0].kind = "other";
  assert.equal(obs.snapshot().events[0].kind, "init");
  obs.observe(queue("queued"));
  const queued = obs.snapshot();
  queued.lastQueueStatus!.status = "ready";
  assert.equal(obs.snapshot().lastQueueStatus!.status, "queued");
});

test("non-finite or oversized event limits cannot disable the hard bound", () => {
  for (const maxEvents of [NaN, Infinity, 10000]) {
    const obs = createSdkObserver({ now: () => 1, maxEvents });
    for (let i = 0; i < 300; i++) obs.observe(init());
    assert.equal(obs.snapshot().events.length, 256);
    assert.equal(obs.snapshot().droppedEvents, 44);
  }
});
