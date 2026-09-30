#!/usr/bin/env node
// Observation only: 5 independent live runs, no provider retries or JSON repair.
// Diagnostics are private ignored artifacts, separate from npm test.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamQoder, __setBridgeInternals } from '../extensions/index.js';
import { query, WorkerTransport, ProcessTransport, DEFAULT_RUNTIME_TRANSPORT } from '@qoder-ai/qoder-agent-sdk';
const secretKeys = /api[_-]?key|token|secret|password|authorization|credential/i;
function redact(value) {
  if (typeof value === 'string') {
    let text = value;
    const token = process.env.QODER_PERSONAL_ACCESS_TOKEN;
    if (token) text = text.split(token).join('<redacted>');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1<redacted>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.test(key) ? '<redacted>' : redact(item)]));
  return value;
}
function observingQuery(params, file, startedAt) {
  const provider = DEFAULT_RUNTIME_TRANSPORT === 'worker' ? WorkerTransport.default : ProcessTransport.default;
  let sequence = 0;
  const save = (label, payload) => appendFileSync(file, JSON.stringify({ label, sequence: sequence++, elapsedMs: Date.now() - startedAt, payload: redact(payload) }) + '\n');
  return query({ ...params, options: { ...params.options, transport: { create(options) {
    const inner = provider.create(options);
    return {
      initialize: () => inner.initialize(), isReady: () => inner.isReady(),
      write(data) {
        let frame;
        try { frame = JSON.parse(data); } catch { frame = {}; }
        // Do not persist auth/control request/response payloads.
        save('transport_write', frame.type === 'user' ? { frame } : { type: frame.type, byteLength: Buffer.byteLength(data) });
        return inner.write(data);
      },
      endInput: () => inner.endInput(), close: () => inner.close(),
      async *readMessages() {
        for await (const frame of inner.readMessages()) {
          if (['assistant', 'result', 'stream_event', 'system', 'command_lifecycle'].includes(frame.type)) save('transport_frame', frame);
          else save('transport_frame_omitted', { type: frame.type });
          yield frame; // No rewriting, deduplication or reordering at the audit boundary.
        }
      },
    };
  } } } });
}
const root = await realpath(process.cwd());
const outputDir = resolve(root, 'test-artifacts/boundary-investigation', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(outputDir, { recursive: true });
const model = { id: process.env.QODER_BRIDGE_TEST_MODEL || 'Qwen3.8-Flash', name: 'boundary investigation', api: 'qoder-agent-sdk', provider: 'qoder-bridge', baseUrl: 'qoder-agent-sdk://local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 };
const tools = ['read', 'ls'].map(name => ({ name, description: name === 'read' ? 'Read repository file' : 'List repository directory, read-only', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }));
async function execute(call) {
  const target = await realpath(resolve(root, call.arguments.path));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Outside repository');
  if (call.name === 'read' && !['package.json', 'README.md'].includes(rel.replaceAll('\\', '/'))) throw new Error('Only verification files allowed');
  if (call.name === 'ls' && target !== root) throw new Error('Only root listing allowed');
  return call.name === 'read' ? await readFile(target, 'utf8') : JSON.stringify(await readdir(target));
}
const reports = [];
for (const [index, sequence] of [['read'], ['read', 'ls'], ['read', 'read'], ['read'], ['read', 'ls']].entries()) {
  const states = [];
  const report = { run: index + 1, model: model.id, toolCount: 0, toolErrors: 0, protocolErrors: 0, providerTimeouts: 0, continuationTimeouts: 0, terminalState: null, finalResponse: false, turns: [] };
  __setBridgeInternals({ onState: state => states.push(state) });
  const plan = sequence.map((name, i) => `${i + 1}: ${name}(${JSON.stringify(name === 'ls' ? '.' : i === 0 ? 'package.json' : 'README.md')})`).join('; ');
  const messages = [{ role: 'user', content: `Execute exactly these tools sequentially, ONE tool call per assistant turn: ${plan}. After ALL tool results, give a short final response containing BOUNDARY_RUN_${index + 1}_DONE. Do not describe calls or repeat completed calls.`, timestamp: Date.now() }];
  try {
    for (let turn = 0; turn < sequence.length + 2; turn++) {
      const file = resolve(outputDir, `run-${index + 1}-turn-${turn + 1}.jsonl`);
      const records = [];
      const transportFile = resolve(outputDir, `run-${index + 1}-turn-${turn + 1}-transport.jsonl`);
      const startedAt = Date.now();
      writeFileSync(file, '');
      writeFileSync(transportFile, '');
      __setBridgeInternals({ onState: state => states.push(state), queryFactory: params => observingQuery(params, transportFile, startedAt) });
      const onDiagnostic = event => {
        // Bridge supplies redacted immutable diagnostic values only in explicit debug mode.
        const safe = JSON.parse(JSON.stringify(event));
        records.push(safe);
        appendFileSync(file, JSON.stringify(safe) + '\n');
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 105000);
      let final;
      try {
        const stream = streamQoder(model, normalizeContext({ systemPrompt: 'You are a precise tool protocol verification assistant. Follow the tool sequence. Pi executes tools externally; transcript tool results are authoritative evidence of completed steps.', tools, messages }), { apiKey: process.env.QODER_PERSONAL_ACCESS_TOKEN, signal: controller.signal, env: { QODER_BRIDGE_DEBUG: '1' }, onDiagnostic, providerMessageTimeoutMs: 60000, postToolContinuationTimeoutMs: 60000, totalDeadlineMs: 100000, maxTokens: 4096, reasoning: 'low' });
        for await (const event of stream) { /* drain Pi events, execute tools only after validated toolUse */ }
        final = await stream.result();
      } finally { clearTimeout(timer); }
      report.turns.push({ turn: turn + 1, diagnosticsFile: relative(root, file).replaceAll('\\', '/'), transportFile: relative(root, transportFile).replaceAll('\\', '/'), stopReason: final.stopReason, error: final.errorMessage || null, diagnosticCount: records.length });
      if (['error', 'aborted'].includes(final.stopReason)) {
        if (/POST_TOOL_CONTINUATION_TIMEOUT/.test(final.errorMessage || '')) report.continuationTimeouts++;
        else if (/PROVIDER_(?:UNAVAILABLE|QUEUE_TIMEOUT|RESPONSE_TIMEOUT|TIMEOUT)/.test(final.errorMessage || '')) report.providerTimeouts++;
        else if (/pi_tool_call|tool call|toolResult|schema|envelope|unlisted tool|SDK stop_reason|PROTOCOL|DUPLICATE|CHUNK/.test(final.errorMessage || '')) report.protocolErrors++;
        break;
      }
      messages.push(final);
      const calls = final.content.filter(block => block.type === 'toolCall');
      if (!calls.length) {
        report.finalResponse = final.content.some(block => block.type === 'text' && block.text.includes(`BOUNDARY_RUN_${index + 1}_DONE`));
        break;
      }
      for (const call of calls) {
        if (call.name !== sequence[report.toolCount]) { report.protocolErrors++; throw new Error('Unexpected tool sequence'); }
        let text, isError = false;
        try { text = await execute(call); report.toolCount++; }
        catch (error) { report.toolErrors++; isError = true; text = String(error); }
        messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, isError, content: [{ type: 'text', text }], timestamp: Date.now() });
      }
    }
  } catch (error) { report.failure = String(error); }
  finally { __setBridgeInternals({}); }
  report.states = states;
  report.terminalState = states.at(-1) || null;
  reports.push(report);
  writeFileSync(resolve(outputDir, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(report));
}
writeFileSync(resolve(root, 'test-artifacts/boundary-investigation/latest-live-directory.txt'), relative(root, outputDir).replaceAll('\\', '/'));
console.log(JSON.stringify({ outputDirectory: relative(root, outputDir).replaceAll('\\', '/'), runs: reports.length }));
