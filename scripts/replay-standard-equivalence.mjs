#!/usr/bin/env node
// Saved real Qoder output + standard fixtures. No live provider requests/retries.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamQoder, __setBridgeInternals, serializeContext } from '../extensions/index.js';
const root = await realpath(process.cwd());
const base = 'test-artifacts/boundary-investigation';
const directory = (await readFile(`${base}/latest-live-directory.txt`, 'utf8')).trim();
const directoryPath = await realpath(resolve(root, directory));
if (relative(root, directoryPath).startsWith('..') || isAbsolute(relative(root, directoryPath))) throw new Error('Artifact must be inside repository');
const summary = JSON.parse(await readFile(resolve(directoryPath, 'summary.json'), 'utf8'));
const validTurn = summary.flatMap(run => run.turns).find(turn => turn.stopReason === 'toolUse');
if (!validTurn) throw new Error('No saved valid Qoder tool response');
const capturedRecords = (await readFile(resolve(root, validTurn.diagnosticsFile), 'utf8')).trim().split('\n').map(JSON.parse);
const captured = capturedRecords.filter(record => record.label === 'sdk_raw_message').map(record => record.payload.message);
const model = { id: 'Qwen3.8-Flash', name: 'saved replay', api: 'qoder-agent-sdk', provider: 'qoder-bridge', baseUrl: 'qoder-agent-sdk://fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 };
const tools = [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];
const user = { role: 'user', content: 'replay one read and final', timestamp: 1 };
const makeContext = messages => normalizeContext({ systemPrompt: 'Replay only; no provider requests', tools, messages });
const assistant = (content, stopReason = 'end_turn') => ({ type: 'assistant', uuid: 'fixture_assistant', session_id: 'fixture_session', parent_tool_use_id: null, message: { id: 'fixture_message', type: 'message', role: 'assistant', model: model.id, content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } } });
const result = stopReason => ({ type: 'result', subtype: 'success', is_error: false, uuid: 'fixture_result', session_id: 'fixture_session', stop_reason: stopReason, result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
let fixtureQueries = 0;
async function turn(messages, response) {
  const types = [], diagnostics = [];
  __setBridgeInternals({ queryFactory: () => {
    fixtureQueries++;
    return { async *[Symbol.asyncIterator]() { for (const message of response) yield message; }, async close() {} };
  } });
  try {
    const stream = streamQoder(model, makeContext(messages), { debug: true, onDiagnostic: event => diagnostics.push(event), providerMessageTimeoutMs: 1000, totalDeadlineMs: 5000 });
    for await (const event of stream) types.push(event.type);
    const final = await stream.result();
    assert.notEqual(final.stopReason, 'error', final.errorMessage);
    return { final, eventTypes: types, diagnostics };
  } finally { __setBridgeInternals({}); }
}
const qoder = await turn([user], captured);
const qoderCall = qoder.final.content.find(block => block.type === 'toolCall');
assert.ok(qoderCall);
const normal = call => ({ id: call.id, name: call.name, arguments: call.arguments });
assert.equal(qoderCall.name, 'read');
assert.equal(qoderCall.arguments.path, 'package.json');
const native = await turn([user], [assistant([{ type: 'tool_use', id: qoderCall.id, name: qoderCall.name, input: qoderCall.arguments }], 'tool_use'), result('tool_use')]);
const wrapperlessText = JSON.stringify({ id: qoderCall.id, type: 'function', function: { name: qoderCall.name, arguments: JSON.stringify(qoderCall.arguments) } });
const wrapperless = await turn([user], [assistant([{ type: 'text', text: wrapperlessText }]), result('end_turn')]);
const reports = [];
for (const [format, response] of [['QODER_CAPTURED', qoder], ['STANDARD_NATIVE_FIXTURE', native], ['STANDARD_FUNCTION_FIXTURE', wrapperless]]) {
  assert.equal(response.final.stopReason, 'toolUse');
  const calls = response.final.content.filter(block => block.type === 'toolCall');
  assert.equal(calls.length, 1);
  assert.deepEqual(normal(calls[0]), normal(qoderCall));
  assert.deepEqual(response.eventTypes, qoder.eventTypes);
  // Same external Pi-style read execution and identical tool result serialization.
  const body = await readFile(resolve(root, 'package.json'), 'utf8');
  const toolResult = { role: 'toolResult', toolCallId: calls[0].id, toolName: calls[0].name, isError: false, content: [{ type: 'text', text: body }], timestamp: 1 };
  const history = [user, response.final, toolResult];
  const transcript = JSON.parse(serializeContext(makeContext(history)));
  const final = await turn(history, [assistant([{ type: 'text', text: 'replay final' }]), result('end_turn')]);
  assert.equal(final.final.stopReason, 'stop');
  assert.equal(final.final.content[0].text, 'replay final');
  reports.push({ format, mode: format === 'QODER_CAPTURED' ? 'SAVED_PROVIDER_REPLAY' : 'STANDARD_FIXTURE', source: format === 'QODER_CAPTURED' ? validTurn.diagnosticsFile : 'audit fixture shape', normal: normal(calls[0]), eventTypes: response.eventTypes, toolExecutions: 1, resultIdMatches: transcript.at(-1).toolCallId === calls[0].id, finalStopReason: final.final.stopReason, parserObservations: response.diagnostics.filter(event => /parser|envelope_kind|classification/.test(event.label)) });
}
const outcome = { liveProviderRequests: 0, fixtureQueries, commonEmissionPath: true, commonToolResultContinuation: true, formats: reports };
await mkdir('test-artifacts/standard-envelope', { recursive: true });
await writeFile('test-artifacts/standard-envelope/replay-equivalence.json', JSON.stringify(outcome, null, 2));
console.log(JSON.stringify(outcome));
