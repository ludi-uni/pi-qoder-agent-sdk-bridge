import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import { classifyProviderPayload, normalizeProviderResponse, parseToolCalls, streamQoder, __setBridgeInternals } from "../extensions/index.js";

const tools: Tool[] = [{ name: "grep", description: "Search literal text", parameters: {
  type: "object", required: ["pattern"], properties: { pattern: { type: "string" } }, additionalProperties: false,
} } as unknown as Tool];
const finalAnswer = 'Package name observed: `pi-qoder-agent-sdk-bridge`  \nGrep results for `</pi_tool_call>` in `D:/Develop/pi-qoder-bridge/extensions/index.ts`: Line 332, Line 736\n\nQODER_RESTART_TOOL_TEST_OK';
const expandedAnswer = 'QODER_RESTART_TOOL_TEST_OK\n\nBased on the cached observation from the previous run:\n\n- **Package name observed** (from `read`): `"name": "pi-qoder-agent-sdk-bridge"`\n- **grep matches** for literal pattern ```</pi_tool_call>``` in `extensions/index.ts`:\n  - Line 332: `const TOOL_CALL_CLOSE = "</pi_tool_call>";`\n  - Line 736: Contains closing tag reference in template string\n\nThe exact search string ```</pi_tool_call>``` was found in both locations.';
const templateReport = '前回のツール実行結果に基づき報告します：\n\n- **package.json の name**: `pi-qoder-agent-sdk-bridge`\n- **grep 結果**（pattern: `</pi_tool_call>`）：\n  - 行番号 332: `const TOOL_CALL_CLOSE = "</pi_tool_call>";`\n  - 行番号 736: `<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>\\n` +\n\nQODER_RESTART_TOOL_TEST_OK';
const call = '<pi_tool_call>{"name":"grep","arguments":{"pattern":"</pi_tool_call>"}}</pi_tool_call>';

for (const [index, text] of [finalAnswer, expandedAnswer, templateReport, 'Opening tag: `<pi_tool_call>`.', 'Both `<pi_tool_call>` and `</pi_tool_call>` are literals.', 'Literal `</PI_TOOL_CALL>`.', '```typescript\nconst close = "</pi_tool_call>";\n```'].entries()) {
  test(`standalone inline-code tag case ${index + 1} is ordinary text`, () => {
    assert.equal(classifyProviderPayload(text), "PLAIN_TEXT");
    const selections: string[] = [];
    const out = normalizeProviderResponse(text, tools, (stage, raw) => { if (stage === "parser_selected") selections.push(raw); });
    assert.deepEqual(out, { kind: "text", text });
    assert.deepEqual(selections, [], "literal mentions must not select a tool parser");
    assert.equal(parseToolCalls(text), null);
  });
}

test("inline-code tag commentary does not hide a real envelope or alter its arguments", () => {
  const text = `Searching for \`</pi_tool_call>\`. ${call} The opening tag is \`<pi_tool_call>\`.`;
  const out = normalizeProviderResponse(text, tools);
  assert.equal(out.kind, "tool_calls");
  if (out.kind !== "tool_calls") return;
  assert.equal(out.calls.length, 1);
  assert.deepEqual(out.calls[0].arguments, { pattern: "</pi_tool_call>" });
  assert.deepEqual(parseToolCalls(text)?.[0].arguments, { pattern: "</pi_tool_call>" });
});

test("full inline or fenced envelopes still undergo strict parsing", () => {
  for (const text of [`\`${call}\``, `\`\`\`xml\n${call}\n\`\`\``]) {
    assert.equal(normalizeProviderResponse(text, tools).kind, "tool_calls");
  }
  assert.equal(normalizeProviderResponse('`<pi_tool_call>{bad}</pi_tool_call>`', tools).kind, "protocol_error");
  assert.equal(normalizeProviderResponse('```xml\n<pi_tool_call>{"name":"grep"\n```', tools).kind, "protocol_error");
});

test("complete tool-shaped examples in explanatory prose are text, never executable calls", () => {
  for (const text of [`Example: \`${call}\`.`, `Example:\n\`\`\`xml\n${call}\n\`\`\``, 'Example: `<pi_tool_call>{bad}</pi_tool_call>`.']) {
    assert.deepEqual(normalizeProviderResponse(text, tools), { kind: "text", text });
  }
  const unknown = '<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>';
  assert.equal(normalizeProviderResponse(`\`${unknown}\``, tools).kind, "protocol_error", "code-only unknown invocation remains strict");
  assert.equal(normalizeProviderResponse(`Example \`${call}\` then ${unknown}`, tools).kind, "protocol_error", "an actual unquoted unknown invocation remains strict");
});

test("a literal mention never suppresses a malformed real marker", () => {
  for (const bad of ['<pi_tool_call>{', '</pi_tool_call>', '<PI_TOOL_CALL>{}</PI_TOOL_CALL>']) {
    assert.equal(normalizeProviderResponse(`Mention \`</pi_tool_call>\` then ${bad}`, tools).kind, "protocol_error");
    assert.equal(normalizeProviderResponse(`${call} Mention \`<pi_tool_call>\` then ${bad}`, tools).kind, "protocol_error");
  }
  for (const bad of [
    '<pi_tool_call>{"name":"delete_all","arguments":{"pattern":"</pi_tool_call>"}}</pi_tool_call>',
    '<pi_tool_call>{"name":"grep","arguments":{"pattern":42}}</pi_tool_call>',
  ]) assert.equal(normalizeProviderResponse(`Mention \`</pi_tool_call>\` ${bad}`, tools).kind, "protocol_error");
});

test("quoted tags inside JSON arguments are preserved verbatim", () => {
  const pattern = 'literal `</pi_tool_call>` and `<pi_tool_call>`';
  const text = `<pi_tool_call>${JSON.stringify({ name: "grep", arguments: { pattern } })}</pi_tool_call>`;
  const out = normalizeProviderResponse(text, tools);
  assert.equal(out.kind, "tool_calls");
  if (out.kind !== "tool_calls") return;
  assert.deepEqual(out.calls[0].arguments, { pattern });
});

test("SDK final answer mentioning a tag completes instead of becoming a protocol error", async () => {
  const model: Model<Api> = {
    id: "Auto", name: "fixture", api: "qoder-agent-sdk" as Api, provider: "qoder-bridge", baseUrl: "qoder-agent-sdk://local",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096,
  };
  const messages: SDKMessage[] = [
    { type: "assistant", uuid: "answer", session_id: "fixture", message: { id: "answer", type: "message", role: "assistant", content: [{ type: "text", text: templateReport }], stop_reason: "end_turn" } },
    { type: "result", subtype: "success", is_error: false, result: templateReport, stop_reason: "end_turn", usage: {}, uuid: "result", session_id: "fixture" },
  ] as unknown as SDKMessage[];
  __setBridgeInternals({ queryFactory: () => ({ [Symbol.asyncIterator]: () => (async function* () { yield* messages; })(), close: async () => {} }) });
  try {
    const stream = streamQoder(model, normalizeContext({ systemPrompt: "fixture", tools, messages: [{ role: "user", content: "Report results", timestamp: 1 }] }));
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const out = await stream.result();
    assert.equal(out.stopReason, "stop", out.errorMessage ?? "literal final answer should complete");
    assert.deepEqual(out.content, [{ type: "text", text: templateReport }]);
    assert.equal(eventTypes.includes("error"), false);
  } finally { __setBridgeInternals({}); }
});
