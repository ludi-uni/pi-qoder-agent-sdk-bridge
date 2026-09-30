#!/usr/bin/env node
// Captured SDK replay, NOT a new live-provider run; no requests are sent.
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamQoder, __setBridgeInternals } from '../extensions/index.js';
const directory = 'test-artifacts/boundary-investigation';
const previous = JSON.parse(await readFile(`${directory}/previous-run-provenance.json`, 'utf8')).malformed[0];
if (!previous) throw new Error('No previously captured malformed SDK run');
const captured = previous.A.sequence.map(item => item.message);
const records = [];
let calls = 0;
__setBridgeInternals({ queryFactory: () => {
  calls++;
  return { async *[Symbol.asyncIterator]() { for (const message of captured) yield message; }, async close() {} };
} });
const model = { id: 'Qwen3.8-Flash', name: 'captured replay', api: 'qoder-agent-sdk', provider: 'qoder-bridge', baseUrl: 'qoder-agent-sdk://local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 };
try {
  const stream = streamQoder(model, normalizeContext({ systemPrompt: 'Captured replay only; no live provider', tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], messages: [{ role: 'user', content: 'replay captured SDK output', timestamp: Date.now() }] }), { debug: true, onDiagnostic: record => records.push(JSON.parse(JSON.stringify(record))) });
  for await (const event of stream) { /* drain */ }
  const final = await stream.result();
  await writeFile(`${directory}/previous-run3-replay.jsonl`, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const B = records.find(record => record.label === 'assembled_text')?.payload;
  const C = records.find(record => record.label === 'normalization_input')?.payload;
  const D = records.filter(record => record.label === 'parse_input').map(record => record.payload);
  const E = records.find(record => record.label === 'error_input')?.payload;
  const outcome = { mode: 'CAPTURED_SDK_REPLAY_NOT_LIVE', requestsSent: 0, queryFactoryCalls: calls, origin: previous.origin, firstBadStage: previous.firstBadStage, stopReason: final.stopReason, error: final.errorMessage, B, C, D, E, unchanged: previous.B.value === B?.text && B?.text === C?.text && C?.text === E?.text, strictFailure: final.stopReason === 'error' && E?.code === 'MALFORMED_ENVELOPE_JSON' };
  await writeFile(`${directory}/previous-run3-replay-summary.json`, JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ mode: outcome.mode, origin: outcome.origin, firstBadStage: outcome.firstBadStage, unchanged: outcome.unchanged, strictFailure: outcome.strictFailure, requestsSent: 0 }));
  process.exitCode = outcome.unchanged && outcome.strictFailure && calls === 1 ? 0 : 1;
} finally { __setBridgeInternals({}); }
