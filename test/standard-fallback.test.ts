// Promoted from test/audit/standard-fallback.audit.ts: these compatibility
// expectations are now part of the ordinary npm test suite (test/*.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import { __setBridgeInternals, streamQoder, normalizeProviderResponse } from "../extensions/index.js";

const model: Model<Api> = {
  id: "fixture", name: "fixture", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const tools = [{ name: "read", description: "Read file", parameters: {
  type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
} }] as unknown as Tool[];
const context = normalizeContext({ systemPrompt: "Fixture only; no provider request", tools,
  messages: [{ role: "user", content: "read package.json", timestamp: 1 }] });
const id = "call_standard_1";
const args = { path: "package.json" };
function assistant(content: unknown[], stopReason = "end_turn"): SDKMessage {
  return { type: "assistant", uuid: "assistant_fixture", session_id: "session_fixture", parent_tool_use_id: null,
    message: { type: "message", id: "message_fixture", role: "assistant", model: model.id, content, stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 } },
  } as unknown as SDKMessage;
}
function terminal(text = "", stopReason = "end_turn"): SDKMessage {
  return { type: "result", subtype: "success", is_error: false, result: text, stop_reason: stopReason,
    uuid: "result_fixture", session_id: "session_fixture", num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as SDKMessage;
}
async function run(messages: SDKMessage[]) {
  let providerCalls = 0;
  __setBridgeInternals({ queryFactory: () => {
    providerCalls++;
    return { async *[Symbol.asyncIterator]() { for (const message of messages) yield message; }, async close() {} };
  } });
  try {
    const stream = streamQoder(model, context, { providerMessageTimeoutMs: 100, totalDeadlineMs: 1000, env: { QODER_BRIDGE_DEBUG: "0" } });
    for await (const event of stream) { /* fixture; no actual tool execution */ }
    return { final: await stream.result(), providerCalls };
  } finally { __setBridgeInternals({}); }
}
function assertTool(final: Awaited<ReturnType<typeof run>>["final"], expectedId: string) {
  assert.equal(final.stopReason, "toolUse", final.errorMessage ?? "Expected a normalized tool call");
  const calls = final.content.filter(block => block.type === "toolCall");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.equal(calls[0].id, expectedId);
  assert.deepEqual(calls[0].arguments, args);
}

function uniqueAssistant(content: unknown[], uuid: string, messageId: string, stopReason = "end_turn"): SDKMessage {
  const snapshot = assistant(content, stopReason);
  if (snapshot.type !== "assistant") throw new Error("Invalid fixture");
  return { ...snapshot, uuid, message: { ...snapshot.message, id: messageId } };
}

test("native and meaningful text across snapshots cannot silently discard text", async () => {
  for (const reverse of [false, true]) {
    const native = uniqueAssistant([{ type: "tool_use", id, name: "read", input: args }], "native", "native-message", "tool_use");
    const text = uniqueAssistant([{ type: "text", text: "meaningful text" }], "text", "text-message");
    const { final } = await run([...(reverse ? [native, text] : [text, native]), terminal("", "tool_use")]);
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /MIXED|mixes|mixed/i);
    assert.equal(final.content.length, 0);
  }
});

test("native final replay with a new event UUID dedups before mixed-content processing", async () => {
  const content = [{ type: "tool_use", id, name: "read", input: args }];
  const { final } = await run([
    uniqueAssistant(content, "native1", "same-native", "tool_use"),
    uniqueAssistant(content, "native2", "same-native", "tool_use"),
    terminal("", "tool_use"),
  ]);
  assertTool(final, id);
});

test("ordinary name/parameters or name/input JSON is not tool intent", () => {
  for (const text of ['{"name":"cake","parameters":{"servings":2}}', '{"user":{"name":"Alice","input":{"language":"ja"}}}', '{"parameters":{"count":1}']) {
    assert.equal(normalizeProviderResponse(text, tools).kind, "text", text);
  }
});

test("empty or unknown structured payload shapes cannot produce empty toolUse", () => {
  for (const invalid of [{ kind: "blocks", blocks: [] }, { kind: "other", blocks: [] }, { kind: "blocks", blocks: [{ type: "tool_use", id, name: "read", input: args }], extra: true }]) {
    const result = normalizeProviderResponse(invalid as unknown as import("../extensions/index.js").StructuredProviderPayload, tools);
    assert.equal(result.kind, "protocol_error");
  }
});

test("TEST_STANDARD_TOOL_ENVELOPE: valid SDK-native tool_use", async () => {
  // This shape is the SDK's declared native ContentBlock, not repaired JSON.
  const block = { type: "tool_use", id, name: "read", input: args };
  const { final, providerCalls } = await run([assistant([block], "tool_use"), terminal("", "tool_use")]);
  assert.equal(providerCalls, 1);
  assertTool(final, id);
});

test("TEST_STANDARD_TOOL_ENVELOPE_WRAPPERLESS_JSON: valid OpenAI function envelope", async () => {
  const text = JSON.stringify({ id, type: "function", function: { name: "read", arguments: JSON.stringify(args) } });
  const normalized = normalizeProviderResponse(text, tools);
  assert.equal(normalized.kind, "tool_calls", "Valid standard envelope must not become TextResponse");
  const { final } = await run([assistant([{ type: "text", text }]), terminal(text)]);
  assertTool(final, id);
});

test("TEST_QODER_TOOL_ENVELOPE", async () => {
  const qoderId = "call_qoder_1";
  const text = `<pi_tool_call>${JSON.stringify({ id: qoderId, name: "read", arguments: args })}</pi_tool_call>`;
  const normalized = normalizeProviderResponse(text, tools);
  assert.equal(normalized.kind, "tool_calls");
  const { final, providerCalls } = await run([assistant([{ type: "text", text }]), terminal(text)]);
  assert.equal(providerCalls, 1);
  assertTool(final, qoderId);
});

test("TEST_MALFORMED_QODER_NO_FALLBACK", async () => {
  for (const text of [
    '<pi_tool_call>{bad}</pi_tool_call>',
    '<pi_tool_call>{"name":"read","arguments":{"path":"package.json"}}}</pi_tool_call>',
    '<pi_tool_call>{"name":"read","arguments":{"path":42}}</pi_tool_call>',
    '<pi_tool_call>{"name":"read","arguments":{"path":"package.json"},"role":"tool"}</pi_tool_call>',
  ]) {
    const normalized = normalizeProviderResponse(text, tools);
    assert.equal(normalized.kind, "protocol_error");
    const { final, providerCalls } = await run([assistant([{ type: "text", text }]), terminal(text)]);
    assert.equal(providerCalls, 1, "No retry");
    assert.equal(final.stopReason, "error");
    assert.equal(final.content.filter(block => block.type === "text" || block.type === "toolCall").length, 0);
  }
});

test("TEST_UNKNOWN_TOOL_LIKE_FORMAT", async () => {
  for (const bad of [
    { type: "tool_call", call_id: "call_unknown_1", tool: "read", parameters: args },
    { tool_calls: [{ id, function: { name: "read", arguments: JSON.stringify(args) } }] },
    { function_call: { name: "read", arguments: JSON.stringify(args) } },
    { type: "tool_invocation", name: "read", arguments: args },
    { name: "read", arguments: args },
  ]) {
    const text = JSON.stringify(bad);
    const normalized = normalizeProviderResponse(text, tools);
    assert.equal(normalized.kind, "protocol_error", `tool-like payload must not become text: ${text}`);
    const { final, providerCalls } = await run([assistant([{ type: "text", text }]), terminal(text)]);
    assert.equal(providerCalls, 1);
    assert.equal(final.stopReason, "error", `Unknown tool-like payload must not become text completion: ${text}`);
    assert.equal(final.content.filter(block => block.type === "text" || block.type === "toolCall").length, 0);
  }
});

test("TEST_MALFORMED_STANDARD: missing name/id/arguments → protocol_error, never text", () => {
  for (const bad of [
    { type: "function", function: { name: "read", arguments: JSON.stringify(args) } },                    // missing id
    { id, type: "function", function: { arguments: JSON.stringify(args) } },                             // missing name
    { id, type: "function", function: { name: "read" } },                                                // missing arguments
    { id, type: "function", function: { name: "read", arguments: args } },                                // arguments not a JSON string
    { id: "", type: "function", function: { name: "read", arguments: JSON.stringify(args) } },           // empty id
    { id, type: "function", function: { name: "read", arguments: "{bad}" } },                             // invalid arguments JSON
    { id, type: "function", function: { name: "read", arguments: JSON.stringify(args) }, extra: 1 },      // unknown field
  ]) {
    const out = normalizeProviderResponse(JSON.stringify(bad), tools);
    assert.equal(out.kind, "protocol_error", JSON.stringify(bad));
  }
  // Malformed JSON with a clear function-envelope signal → protocol_error.
  const brokenJson = '{"id":"x","type":"function","function":{"name":"read","arguments":{';
  assert.equal(normalizeProviderResponse(brokenJson, tools).kind, "protocol_error");
});

test("TEST_MALFORMED_NATIVE: native tool_use blocks missing required fields → protocol_error", async () => {
  for (const block of [
    { type: "tool_use", name: "read", input: args },                              // missing id
    { type: "tool_use", id, input: args },                                        // missing name
    { type: "tool_use", id, name: "read" },                                      // missing input
    { type: "tool_use", id: "", name: "read", input: args },                     // empty id
    { type: "tool_use", id, name: "read", input: "not-an-object" },               // non-object input
    { type: "tool_use", id, name: "read", input: args, extra: true },             // unknown field
  ]) {
    const { final, providerCalls } = await run([assistant([block], "tool_use"), terminal("", "tool_use")]);
    assert.equal(providerCalls, 1);
    assert.equal(final.stopReason, "error", JSON.stringify(block));
    assert.equal(final.content.filter(b => b.type === "text" || b.type === "toolCall").length, 0);
  }
});

test("TEST_DUPLICATE_IDS: duplicate native and duplicate function ids → protocol_error", async () => {
  // Duplicate native ids across two blocks in one snapshot.
  const dupNative = [
    { type: "tool_use", id: "dup_1", name: "read", input: args },
    { type: "tool_use", id: "dup_1", name: "read", input: args },
  ];
  const { final: f1 } = await run([assistant(dupNative, "tool_use"), terminal("", "tool_use")]);
  assert.equal(f1.stopReason, "error");
  // Historical reuse: a call id that already exists in context → error.
  const text = `<pi_tool_call>{"id":"hist_1","name":"read","arguments":${JSON.stringify(args)}}</pi_tool_call>`;
  const history = [
    { role: "user", content: "go", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "hist_1", name: "read", arguments: args }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "hist_1", toolName: "read", isError: false, content: [{ type: "text", text: "body" }], timestamp: 1 },
  ];
  const histCtx = normalizeContext({ systemPrompt: "Fixture only", tools, messages: history as never });
  let providerCalls = 0;
  __setBridgeInternals({ queryFactory: () => { providerCalls++; return { async *[Symbol.asyncIterator]() { yield assistant([{ type: "text", text }]); yield terminal(text); }, async close() {} }; } });
  try {
    const stream = streamQoder(model, histCtx, { providerMessageTimeoutMs: 100, totalDeadlineMs: 1000, env: { QODER_BRIDGE_DEBUG: "0" } });
    for await (const event of stream) { /* fixture */ }
    const final = await stream.result();
    assert.equal(providerCalls, 1);
    assert.equal(final.stopReason, "error");
    assert.match(final.errorMessage ?? "", /duplicate|reused/i);
  } finally { __setBridgeInternals({}); }
});

test("TEST_PLAIN_TEXT: prose and ordinary JSON stay TextResponse", () => {
  for (const input of [
    "just an answer",
    "Here is the file contents: {\"key\": \"value\"} as requested.",
    '{"summary": "done", "count": 3}',
    '{"results": [{"path": "a"}, {"path": "b"}]}',
    "{}",
    '[1, 2, 3]',
    'It calls read("package.json") internally.',
  ]) {
    const out = normalizeProviderResponse(input, tools);
    assert.equal(out.kind, "text", `expected text for: ${input}`);
  }
});

test("TEST_PARSER_ISOLATION: exactly one parser runs per payload; malformed Qoder never falls to generic", () => {
  const selections: string[] = [];
  const instrument = (stage: string, raw: string) => { if (stage === "parser_selected") selections.push(raw); };

  // Qoder marker → qoder parser only.
  selections.length = 0;
  normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":${JSON.stringify(args)}}</pi_tool_call>`, tools, instrument);
  assert.deepEqual(selections, ["qoder_envelope"]);

  // Malformed Qoder (invalid JSON) → qoder parser only, no generic fallback.
  selections.length = 0;
  const badQoder = normalizeProviderResponse('<pi_tool_call>{bad}</pi_tool_call>', tools, instrument);
  assert.equal(badQoder.kind, "protocol_error");
  assert.deepEqual(selections, ["qoder_envelope"], "malformed Qoder must not trigger standard/generic parse");

  // Standard envelope → standard parser only.
  selections.length = 0;
  normalizeProviderResponse(JSON.stringify({ id, type: "function", function: { name: "read", arguments: JSON.stringify(args) } }), tools, instrument);
  assert.deepEqual(selections, ["standard_function_envelope"]);

  // Native blocks → native parser only.
  selections.length = 0;
  normalizeProviderResponse({ kind: "blocks", blocks: [{ type: "tool_use", id, name: "read", input: args }] }, tools, instrument);
  assert.deepEqual(selections, ["native_tool_use"]);

  // Plain text → no parser selected.
  selections.length = 0;
  assert.equal(normalizeProviderResponse("hello", tools, instrument).kind, "text");
  assert.deepEqual(selections, []);
});

test("TEST_NORMAL_FORM_EQUIVALENCE: all parsers yield identical {id,name,arguments} normal form", () => {
  const qoder = normalizeProviderResponse(`<pi_tool_call>{"id":"c1","name":"read","arguments":${JSON.stringify(args)}}</pi_tool_call>`, tools);
  const standard = normalizeProviderResponse(JSON.stringify({ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify(args) } }), tools);
  const native = normalizeProviderResponse({ kind: "blocks", blocks: [{ type: "tool_use", id: "c1", name: "read", input: args }] }, tools);
  for (const out of [qoder, standard, native]) {
    assert.equal(out.kind, "tool_calls");
    if (out.kind !== "tool_calls") continue;
    assert.equal(out.calls.length, 1);
    assert.deepEqual(
      { id: out.calls[0].id, name: out.calls[0].name, arguments: out.calls[0].arguments },
      { id: "c1", name: "read", arguments: args },
    );
  }
});

test("TEST_QODER_MISSING_ID: Qoder envelope without id gets a deterministic generated id at normalization edge", () => {
  const out = normalizeProviderResponse(`<pi_tool_call>{"name":"read","arguments":${JSON.stringify(args)}}</pi_tool_call>`, tools);
  assert.equal(out.kind, "tool_calls");
  if (out.kind !== "tool_calls") return;
  assert.match(out.calls[0].id, /^qoder_[0-9a-f-]{36}$/);
});

test("TEST_QODER_MARKER_PRIORITY: malformed JSON inside Qoder marker is qoder-classified, not malformed-tool-like", () => {
  const out = normalizeProviderResponse('<pi_tool_call>{"name":"read","arguments":{"path":"x"}}</pi_tool_call>', tools);
  assert.equal(out.kind, "tool_calls", "valid qoder envelope must win over any other shape detection");
});
