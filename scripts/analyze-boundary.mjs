#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const base = process.cwd();
const directory = process.argv[2] || (await readFile('test-artifacts/boundary-investigation/latest-live-directory.txt', 'utf8')).trim();
const path = resolve(base, directory);
const runs = JSON.parse(await readFile(resolve(path, 'summary.json'), 'utf8'));
const readLines = async file => (await readFile(resolve(base, file), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const comparable = value => {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, /api[_-]?key|token|secret|password|authorization|credential/i.test(key) ? '<redacted>' : comparable(value[key])]));
  return value;
};
const textFromFrame = frame => frame.type === 'assistant' ? (frame.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('') : frame.type === 'result' ? frame.result || '' : '';
const parseEnvelopes = text => [...text.matchAll(/<pi_tool_call>\s*([\s\S]*?)\s*<\/pi_tool_call>/g)].map(match => { try { JSON.parse(match[1]); return { raw: match[1], valid: true }; } catch (error) { return { raw: match[1], valid: false, error: String(error) }; } });
const clean = text => text.replace(/([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '\ufffd');
for (const run of runs) {
  let rawChunkCount = 0, providerFailureCount = 0, bridgeFailureCount = 0, transportFailureCount = 0;
  for (const turn of run.turns) {
    const records = await readLines(turn.diagnosticsFile);
    const transport = await readLines(turn.transportFile);
    const events = label => records.filter(record => record.label === label);
    const A = events('sdk_raw_message');
    const B = events('assembled_text').at(-1)?.payload;
    const C = events('normalization_input').at(-1)?.payload;
    const D = events('parse_input').map(record => record.payload);
    const E = events('error_input').at(-1)?.payload;
    const snapshots = events('assistant_snapshot');
    const frames = transport.filter(record => record.label === 'transport_frame');
    rawChunkCount += A.length;
    const mismatches = [];
    let lastTransportIndex = -1;
    for (const record of A) {
      const frame = record.payload.message;
      if (!['assistant', 'result', 'stream_event'].includes(frame.type)) continue;
      const transportIndex = frames.findIndex((item, index) => index > lastTransportIndex && item.payload.uuid === frame.uuid && item.payload.type === frame.type);
      const earlier = frames[transportIndex];
      if (!earlier) mismatches.push({ seq: record.payload.seq, reason: 'SDK message absent or reordered at transport frame boundary' });
      else {
        lastTransportIndex = transportIndex;
        if (textFromFrame(earlier.payload) !== textFromFrame(frame) || JSON.stringify(comparable(earlier.payload.event || null)) !== JSON.stringify(comparable(frame.event || null))) mismatches.push({ seq: record.payload.seq, reason: 'SDK text/delta differs from transport frame (common redaction applied)' });
      }
    }
    const assembledReplay = snapshots.map(record => record.payload.text).join('');
    const sourceMatches = snapshots.every(record => {
      const source = A.find(item => item.payload.seq === record.payload.seq)?.payload.message;
      return source && clean(textFromFrame(source)) === record.payload.text;
    });
    const fallback = events('sdk_terminal_result').at(-1)?.payload.resultText || '';
    const assemblyValid = !B ? null : sourceMatches && (B.text === assembledReplay || (assembledReplay === '' && B.text === clean(fallback)));
    const normalizationValid = !C ? null : B?.text === C.text && hash(C.text) === C.digest && D.every(item => item.index === 0 ? item.raw === C.text : parseEnvelopes(C.text)[item.index - 1]?.raw === item.raw) && (!E || E.text === C.text);
    const textDeltaFrames = A.filter(record => record.payload.message.type === 'stream_event' && record.payload.message.event?.delta?.type === 'text_delta');
    const deltaText = textDeltaFrames.map(record => record.payload.message.event.delta.text || '').join('');
    const malformedAtTransport = frames.filter(record => parseEnvelopes(textFromFrame(record.payload)).some(item => !item.valid));
    const malformedAtA = A.filter(record => parseEnvelopes(textFromFrame(record.payload.message)).some(item => !item.valid));
    const malformedB = B && parseEnvelopes(B.text).some(item => !item.valid);
    const malformedD = D.some(item => { if (item.index === 0) return false; try { JSON.parse(item.raw); return false; } catch { return true; } });
    let origin = 'NONE', firstBadStage = null;
    if (malformedAtTransport.length || parseEnvelopes(deltaText).some(item => !item.valid)) { origin = 'PROVIDER_OUTPUT_DEFECT'; firstBadStage = 'A_TRANSPORT_FRAME'; providerFailureCount++; }
    else if (malformedAtA.length) { origin = 'TRANSPORT_OR_SDK_DEFECT'; firstBadStage = 'A_SDK_MESSAGE'; transportFailureCount++; }
    else if (malformedB && assemblyValid && parseEnvelopes(assembledReplay).some(item => !item.valid)) { origin = 'UNDETERMINED_FRAGMENT_ASSEMBLY'; firstBadStage = 'B'; }
    else if (malformedB || assemblyValid === false) { origin = 'TRANSPORT_OR_STREAM_ASSEMBLY_DEFECT'; firstBadStage = 'B'; bridgeFailureCount++; }
    else if (malformedD || normalizationValid === false) { origin = 'BRIDGE_NORMALIZATION_DEFECT'; firstBadStage = 'C_OR_D'; bridgeFailureCount++; }
    if (mismatches.length && origin === 'NONE') { origin = 'TRANSPORT_OR_SDK_DEFECT'; firstBadStage = 'A_SDK_MESSAGE'; transportFailureCount++; }
    const timeout = events('timeout_classification').at(-1)?.payload;
    if (timeout) providerFailureCount++;
    const queue = events('queue_status');
    const firstToken = A.find(record => (record.payload.message.type === 'stream_event' && record.payload.message.event?.delta?.type === 'text_delta') || textFromFrame(record.payload.message).length > 0);
    turn.audit = {
      boundary: 'Worker runtime parsed stdout frames -> SDK QueryRunner -> Bridge; provider HTTP wire is not observed',
      requestSentToTransport: transport.some(record => record.label === 'transport_write' && record.payload.frame?.type === 'user'),
      runtimeAcknowledgement: events('handoff_ack')[0]?.payload || null,
      providerAcknowledgementEvidence: queue.length ? 'model_queue_status' : firstToken ? 'model_output' : 'NOT_OBSERVED',
      firstSdkEventMs: events('first_message')[0]?.elapsedMs ?? null,
      firstTokenMs: firstToken?.elapsedMs ?? null,
      timeout: timeout || null,
      timeoutObservedMs: events('timeout_classification')[0]?.elapsedMs ?? null,
      queueEvents: queue.map(record => ({ elapsedMs: record.elapsedMs, ...record.payload })),
      rawChunkCount: A.length, transportFrameCount: frames.length,
      snapshotCount: snapshots.length, textDeltaCount: textDeltaFrames.length,
      rawTextDeltaSequence: textDeltaFrames.map(record => ({ seq: record.payload.seq, uuid: record.payload.uuid, text: record.payload.message.event.delta.text })),
      deltaText, deltaMatchesAssembled: B && deltaText ? deltaText === B.text : null,
      duplicateUuids: events('duplicate_uuid').length, duplicateFinalSnapshots: events('duplicate_final_snapshot').length,
      transportTerminalCount: frames.filter(record => record.payload.type === 'result').length,
      sdkTerminalCount: A.filter(record => record.payload.type === 'result').length,
      transportToSdkTextValid: mismatches.length === 0, transportToSdkMismatches: mismatches,
      sourceSnapshotsValid: sourceMatches, assemblyValid, normalizationValid,
      malformedProvenance: origin, firstBadStage,
      A_badFrames: malformedAtTransport.map(record => ({ sequence: record.sequence, uuid: record.payload.uuid, text: textFromFrame(record.payload) })),
      B, C, D, E: E || null,
    };
  }
  run.rawChunkCount = rawChunkCount;
  run.providerAvailability = run.turns.flatMap(turn => turn.audit.queueEvents);
  run.malformedProvenance = run.turns.map(turn => turn.audit.malformedProvenance).filter(origin => origin !== 'NONE');
  run.providerSideFailures = providerFailureCount;
  run.bridgeSideFailures = bridgeFailureCount;
  run.transportSideFailures = transportFailureCount;
  console.log(JSON.stringify({ run: run.run, rawChunkCount, toolCount: run.toolCount, protocolErrors: run.protocolErrors, providerTimeouts: run.providerTimeouts, continuationTimeouts: run.continuationTimeouts, terminalState: run.terminalState, finalResponse: run.finalResponse, malformedProvenance: run.malformedProvenance, providerSideFailures: providerFailureCount, bridgeSideFailures: bridgeFailureCount, transportSideFailures: transportFailureCount }));
}
await writeFile(resolve(path, 'boundary-audit.json'), JSON.stringify(runs, null, 2));
const summary = { runs: runs.length, rawChunkCount: runs.reduce((sum, run) => sum + run.rawChunkCount, 0), providerSideFailures: runs.reduce((sum, run) => sum + run.providerSideFailures, 0), bridgeSideFailures: runs.reduce((sum, run) => sum + run.bridgeSideFailures, 0), transportSideFailures: runs.reduce((sum, run) => sum + run.transportSideFailures, 0), completedRuns: runs.filter(run => run.terminalState === 'COMPLETED').length, classifications: runs.flatMap(run => run.turns.map(turn => turn.audit.timeout?.kind).filter(Boolean)) };
await writeFile(resolve(path, 'boundary-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
