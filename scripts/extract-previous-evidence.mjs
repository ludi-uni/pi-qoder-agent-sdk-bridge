#!/usr/bin/env node
// Observational replay of the previous run: never repairs or resends payloads.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const lines = (await readFile('real-provider-debug.log', 'utf8')).split(/\r?\n/);
const turns = [];
let turn;
for (const line of lines) {
  const match = line.match(/^\[qoder-bridge\] (\w+) (.*)$/);
  if (!match) continue;
  let payload;
  try { payload = JSON.parse(match[2]); } catch { continue; }
  const [, label] = match;
  if (label === 'provider_request' || label === 'continuation_request') {
    turn = { request: payload, rawSequence: [], rawMessage: null, error: null, availabilityEvents: [] };
    turns.push(turn);
  }
  if (!turn) continue;
  if (label === 'provider_response' || label === 'continuation_response') {
    turn.rawSequence.push({ index: turn.rawSequence.length, message: payload });
    if (payload.subtype === 'model_queue_status') turn.availabilityEvents.push(payload);
  }
  if (label === 'raw_text') turn.rawMessage = payload;
  if (label === 'error') turn.error = payload;
}
const malformed = turns.filter(item => /pi_tool_call.*invalid JSON/.test(item.error || ''));
const evidence = malformed.map(item => {
  const textChunks = item.rawSequence.flatMap(({ index, message }) => message.type === 'assistant' ? (message.message?.content || []).flatMap((block, blockIndex) => block.type === 'text' ? [{ index, blockIndex, uuid: message.uuid, messageId: message.message.id, text: block.text }] : []) : []);
  const assembled = textChunks.map(chunk => chunk.text).join('');
  const targets = [...assembled.matchAll(/<pi_tool_call>\s*([\s\S]*?)\s*<\/pi_tool_call>/g)].map(match => match[1]);
  const parse = text => { try { JSON.parse(text); return { valid: true }; } catch (error) { return { valid: false, error: String(error) }; } };
  const badAtA = textChunks.some(chunk => [...chunk.text.matchAll(/<pi_tool_call>\s*([\s\S]*?)\s*<\/pi_tool_call>/g)].some(match => !parse(match[1]).valid));
  return {
    source: 'real-provider-debug.log (previous phase; preserved unchanged)',
    boundary: 'SDKMessage received by Bridge, not provider network wire',
    A: { observed: true, sequence: item.rawSequence, textChunks },
    B: { observed: item.rawMessage !== null, value: item.rawMessage, replay: assembled, replayMatchesObserved: assembled === item.rawMessage },
    C: { observed: false, derivedFromCode: true, value: assembled },
    D: { observed: false, derivedFromExactEnvelopeRegex: true, targets, parseResults: targets.map(parse) },
    E: { observedError: item.error, inputObserved: false, derivedInput: targets },
    firstBadStage: badAtA ? 'A' : 'UNDETERMINED',
    origin: badAtA ? 'PROVIDER_OUTPUT_DEFECT' : 'UNDETERMINED',
    duplicates: textChunks.length - new Set(textChunks.map(chunk => `${chunk.uuid}:${chunk.blockIndex}`)).size,
    availabilityEvents: item.availabilityEvents,
    limitation: 'Previous diagnostics lacked transport bytes/partial deltas and explicit C/D/E capture; derived stages are not mislabeled as observed.',
  };
});
const queueTurns = turns.filter(item => /TIMEOUT/.test(item.error || '') && item.availabilityEvents.length).map(item => ({ request: item.request, error: item.error, events: item.availabilityEvents, firstSdkEvent: item.rawSequence[0]?.message, receivedAssistant: item.rawSequence.some(({ message }) => message.type === 'assistant') }));
await mkdir('test-artifacts/boundary-investigation', { recursive: true });
await writeFile('test-artifacts/boundary-investigation/previous-run-provenance.json', JSON.stringify({ malformed: evidence, queueTurns }, null, 2));
console.log(JSON.stringify({ malformedCount: evidence.length, firstBadStages: evidence.map(item => item.firstBadStage), queueTimeoutTurns: queueTurns.length }));
