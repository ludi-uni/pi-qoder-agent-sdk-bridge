import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import {
  __setBridgeInternals,
  bridgeSystemPrompt,
  classifyProviderPayload,
  normalizeProviderResponse,
  parseToolCalls,
  streamQoder,
} from "../extensions/index.js";

const tools: Tool[] = [{ name: "read", description: "Read file", parameters: {
  type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false,
} } as unknown as Tool];

const validCall = '<pi_tool_call>{"name":"read","arguments":{"path":"package.json"}}</pi_tool_call>';

// The observed real-SDK failure: a read request wrapped in numbered
// <tool_call_1> tags streamed as ordinary text and finished stop=end_turn.
const realFailure = '<tool_call_1>{"name":"read","arguments":{"path":"package.json"}}</tool_call_1>';

function assertUnknownTag(input: string, label = input) {
  const out = normalizeProviderResponse(input, tools);
  assert.equal(out.kind, "protocol_error", label);
  if (out.kind !== "protocol_error") return;
  assert.equal(out.error.code, "UNKNOWN_TOOL_LIKE_FORMAT", label);
  assert.equal(parseToolCalls(input), null, `${label}: never executable as an alias`);
  assert.equal(classifyProviderPayload(input), "MALFORMED_TOOL_LIKE", label);
}

// --- Goal 1: explicit unknown tool-call-like tags are refused, never text ---

test("real failure shape: numbered tool_call_1 envelope is refused, never text", () => {
  for (const text of [
    realFailure,
    `I will read the file now.\n${realFailure}`,
    `${realFailure}\nThat should show the package name.`,
  ]) assertUnknownTag(text);
});

test("numbered / renamed opening tags are refused even without a close tag", () => {
  for (const text of [
    '<tool_call_1>{"name":"read","arguments":{"path":"x"}}',
    '<pi_tool_call_2>{"name":"read","arguments":{"path":"x"}}</pi_tool_call_2>',
    '<function_call>{"name":"read","arguments":{"path":"x"}}</function_call>',
    '<function_calls>{"name":"read","arguments":{"path":"x"}}</function_calls>',
    '<invoke name="read">{"path":"x"}</invoke>',
    '<tool_use>{"name":"read","input":{"path":"x"}}</tool_use>',
    '<tool_invocation>{"name":"read","arguments":{"path":"x"}}</tool_invocation>',
    '<TOOL_CALL>{"name":"read","arguments":{"path":"x"}}</TOOL_CALL>',
    '</tool_call_1>',
  ]) assertUnknownTag(text);
});

test("unknown tag alone inside code fences or inline code stays strict", () => {
  assertUnknownTag(`\`${realFailure}\``);
  assertUnknownTag(`\`\`\`xml\n${realFailure}\n\`\`\``);
  assertUnknownTag('```\n<tool_call_1>{"name":"read","arguments":{"path":"x"}}```');
  // Code-only foreign tag without a JSON payload is still refused.
  assertUnknownTag('`<tool_call_1></tool_call_1>`');
});

test("a valid pi_tool_call envelope cannot hide a neighboring unknown tag", () => {
  for (const text of [
    `${validCall}${realFailure}`,
    `${realFailure}${validCall}`,
    `${validCall} <tool_call_2>`,
    `${validCall}\nSure — next: <function_call>{"name":"read"}</function_call>`,
  ]) assertUnknownTag(text);
  // Mixing is caught even when the foreign tag precedes the contract tag.
  const out = normalizeProviderResponse(`${realFailure}\n${validCall}`, tools);
  assert.equal(out.kind, "protocol_error");
  if (out.kind === "protocol_error") assert.equal(out.error.code, "UNKNOWN_TOOL_LIKE_FORMAT");
});

test("tags inside JSON string values are data, never detected as markers", () => {
  // Inside a valid envelope payload.
  const tagString = 'literal <tool_call_1> and </tool_call_1> mentions';
  const payload = JSON.stringify({ name: "read", arguments: { path: tagString } });
  const out = normalizeProviderResponse(`<pi_tool_call>${payload}</pi_tool_call>`, tools);
  assert.equal(out.kind, "tool_calls");
  if (out.kind === "tool_calls") assert.deepEqual(out.calls[0].arguments, { path: tagString });
  // Inside a JSON-looking fragment in prose (not an envelope).
  for (const text of [
    JSON.stringify({ note: tagString }),
    `Result: {"note":"${tagString}"} end`,
    `{"list":["<tool_call_1>","x"]}`,
  ]) {
    assert.equal(classifyProviderPayload(text), "PLAIN_TEXT", text);
    assert.deepEqual(normalizeProviderResponse(text, tools), { kind: "text", text });
  }
});

test("markdown code examples and ordinary markup are not refused", () => {
  const example = 'Use `<pi_tool_call>` like `<tool_call_1>` would be wrong.';
  assert.equal(classifyProviderPayload(example), "PLAIN_TEXT");
  assert.deepEqual(normalizeProviderResponse(example, tools), { kind: "text", text: example });
  const fenced = '```\n<tool_call_1>{"name":"read","arguments":{}}</tool_call_1>\n``` is a bad example.';
  assert.deepEqual(normalizeProviderResponse(fenced, tools), { kind: "text", text: fenced });
  for (const html of [
    "Here is a <b>bold</b> word and a <div class=\"x\">div</div>.",
    "XML sample: <note><to>User</to></note>",
    "Uses <tool_result> blocks in the transcript.",
    "The <tool_calls>-style JSON shape is unsupported.", // tag-name mention, no invocation
    "Normal XML: <tool_calligraphy>text</tool_calligraphy>",
  ]) {
    assert.equal(classifyProviderPayload(html), "PLAIN_TEXT", html);
    assert.deepEqual(normalizeProviderResponse(html, tools), { kind: "text", text: html });
  }
});

test("real live final: quoted grep pattern is data, not an orphan closing tag", () => {
  const final = 'Based on the executed tools:\n\n1. **read(path="D:/Develop/pi-qoder-bridge/package.json")**: The package name is `"pi-qoder-agent-sdk-bridge"`.\n\n2. **grep(path="extensions/index.ts", pattern="</pi_tool_call>")**: Found 4 matches - line 332 defines `TOOL_CALL_CLOSE`, line 442 mentions the accepted envelope format in an error message, and lines 829-830 contain documentation showing the literal closing tag `` </pi_tool_call> ``.\n\n3. **ls(path="D:/Develop/pi-qoder-bridge", limit=10)**: Listed 10 entries including `.git`, `LICENSE`, `README.md`, and several log files.\n\n**Package name**: `pi-qoder-agent-sdk-bridge`  \n**QWEN_FORMAT_SEQUENTIAL_OK**';
  for (const text of [final, 'pattern="</pi_tool_call>"', "Literal '</pi_tool_call>'."]) {
    assert.deepEqual(normalizeProviderResponse(text, tools), { kind: "text", text });
  }
  for (const text of ['</pi_tool_call>', `${validCall}</pi_tool_call>`, '<pi_tool_call>{"name":"read","arguments":{"path":"x"}}"</pi_tool_call>"']) {
    assert.equal(normalizeProviderResponse(text, tools).kind, "protocol_error", "quoted data must not close an actual invocation");
  }
});

// --- Strict rejections that must keep working (regression guards) ---

test("re-emitted opening tag without a close tag stays UNCLOSED_ENVELOPE", () => {
  for (const text of [
    `${validCall}<pi_tool_call>`,
    `${validCall}<pi_tool_call>{"name":"read","arguments":{"path":"x"}`,
    `${validCall}</pi_tool_call>`,
  ]) {
    const out = normalizeProviderResponse(text, tools);
    assert.equal(out.kind, "protocol_error", text);
    if (out.kind === "protocol_error") assert.equal(out.error.code, "UNCLOSED_ENVELOPE", text);
  }
});

test("extra closing brace inside the envelope stays MALFORMED_ENVELOPE_JSON", () => {
  const out = normalizeProviderResponse('<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}}</pi_tool_call>', tools);
  assert.equal(out.kind, "protocol_error");
  if (out.kind === "protocol_error") assert.equal(out.error.code, "MALFORMED_ENVELOPE_JSON");
});

test("existing literal-marker, tool, schema and id validations are unaffected", () => {
  // Literal tag mentions in prose code spans stay text.
  const mention = 'Opening tag: `<pi_tool_call>`.';
  assert.equal(normalizeProviderResponse(mention, tools).kind, "text");
  // Valid envelope still normalizes; schema/unknown-tool/id checks unchanged.
  const ok = normalizeProviderResponse(validCall, tools);
  assert.equal(ok.kind, "tool_calls");
  for (const [text, code] of [
    ['<pi_tool_call>{"name":"rm_rf","arguments":{}}</pi_tool_call>', "UNKNOWN_TOOL"],
    ['<pi_tool_call>{"name":"read","arguments":{"path":42}}</pi_tool_call>', "INVALID_ARGUMENTS"],
    [`${'<pi_tool_call>{"name":"read","arguments":{"path":"a"},"id":"t1"}</pi_tool_call>'}${'<pi_tool_call>{"name":"read","arguments":{"path":"b"},"id":"t1"}</pi_tool_call>'}`, "DUPLICATE_ID"],
  ] as const) {
    const out = normalizeProviderResponse(text, tools);
    assert.equal(out.kind, "protocol_error", text);
    if (out.kind === "protocol_error") assert.equal(out.error.code, code, text);
  }
});

// --- Goal 2: prompt contract mentions the transport and tag rules ---

test("bridgeSystemPrompt states the envelope is the real invocation path and tags are exact", () => {
  const prompt = bridgeSystemPrompt(normalizeContext({ systemPrompt: "base", tools, messages: [{ role: "user", content: "hi", timestamp: 1 }] }));
  assert.match(prompt, /base/);
  assert.match(prompt, /not print tool-call syntax/i);
  assert.match(prompt, /<pi_tool_call>\{"name":"tool_name","arguments":\{\}\}<\/pi_tool_call>/);
  assert.match(prompt, /<tool_call_1>|numbered tags/i);
  assert.match(prompt, /multiple separate envelopes/i);
  assert.match(prompt, /tool_name/);
});

// --- End-to-end: the real failure becomes a stream error, not a text stop ---

test("streamQoder surfaces a numbered-tag tool attempt as a protocol error", async () => {
  const model: Model<Api> = {
    id: "Auto", name: "fixture", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge", baseUrl: "qoder-agent-sdk://local",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096,
  };
  const messages: SDKMessage[] = [
    { type: "assistant", uuid: "a1", session_id: "fixture", message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: realFailure }], stop_reason: "end_turn" } },
    { type: "result", subtype: "success", is_error: false, result: realFailure, stop_reason: "end_turn", usage: {}, uuid: "result", session_id: "fixture" },
  ] as unknown as SDKMessage[];
  __setBridgeInternals({ queryFactory: () => ({ [Symbol.asyncIterator]: () => (async function* () { yield* messages; })(), close: async () => {} }) });
  try {
    const stream = streamQoder(model, normalizeContext({ systemPrompt: "fixture", tools, messages: [{ role: "user", content: "read package.json", timestamp: 1 }] }), { providerMessageTimeoutMs: 50, totalDeadlineMs: 1000 });
    for await (const _ of stream) { /* drain */ }
    const out = await stream.result();
    assert.equal(out.stopReason, "error", "unknown tool-like tag must never complete as text");
    assert.match(out.errorMessage ?? "", /UNKNOWN_TOOL_LIKE_FORMAT|tool-call tag/i);
    assert.equal(out.content.filter(b => b.type === "text" || b.type === "toolCall").length, 0);
  } finally { __setBridgeInternals({}); }
});
