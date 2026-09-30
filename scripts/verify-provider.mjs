#!/usr/bin/env node
// Live provider only; separate from npm test. Real read/list, repository boundary enforced.
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamQoder, __setBridgeInternals } from '../extensions/index.js';
const root = await realpath(process.cwd());
const model = { id: process.env.QODER_BRIDGE_TEST_MODEL || 'Qwen3.8-Flash', name: 'live verification', api: 'qoder-agent-sdk', provider: 'qoder-bridge', baseUrl: 'qoder-agent-sdk://local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 };
const tools = ['read', 'ls'].map(name => ({ name, description: name === 'read' ? 'Read repository file' : 'List repository directory (read-only)', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }));
async function execute(call) {
  const target = await realpath(resolve(root, call.arguments.path));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Outside repository');
  if (call.name === 'read' && !['package.json', 'README.md'].includes(rel.replaceAll('\\', '/'))) throw new Error('Only verification files allowed');
  if (call.name === 'ls' && target !== root) throw new Error('Only root listing allowed');
  return call.name === 'read' ? await readFile(target, 'utf8') : JSON.stringify(await readdir(target));
}
const reports = [];
for (const [index, sequence] of [['read'], ['read', 'ls'], ['read', 'read']].entries()) {
  const states = [];
  const report = { run: index + 1, model: model.id, toolExecutions: 0, toolErrors: 0, protocolErrors: 0, providerErrors: 0, providerTimeouts: 0, continuationTimeouts: 0, finalResponse: false, terminalState: null, sequence: [], turns: [] };
  __setBridgeInternals({ onState: state => states.push(state) });
  const plan = sequence.map((name, i) => `${i + 1}: ${name}(${JSON.stringify(name === 'ls' ? '.' : i === 0 ? 'package.json' : 'README.md')})`).join('; ');
  const messages = [{ role: 'user', content: `Execute exactly these tools sequentially, ONE tool call per assistant turn: ${plan}. After ALL tool results, give a short final response containing QODER_RUN_${index + 1}_DONE. Do not describe calls or repeat completed calls.`, timestamp: Date.now() }];
  try {
    for (let turn = 0; turn < sequence.length + 2; turn++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 150000);
      let final;
      try {
        const stream = streamQoder(model, normalizeContext({ systemPrompt: 'You are a precise tool protocol verification assistant. Follow the tool sequence. Pi executes tools externally; transcript tool results are authoritative evidence of completed steps.', tools, messages }), { apiKey: process.env.QODER_PERSONAL_ACCESS_TOKEN, signal: controller.signal, providerMessageTimeoutMs: 120000, postToolContinuationTimeoutMs: 120000, totalDeadlineMs: 140000, maxTokens: 4096, reasoning: 'low' });
        for await (const event of stream) { /* drain Pi events */ }
        final = await stream.result();
      } finally { clearTimeout(timer); }
      report.turns.push({ stopReason: final.stopReason, error: final.errorMessage || null });
      if (['error', 'aborted'].includes(final.stopReason)) {
        if (/POST_TOOL_CONTINUATION_TIMEOUT/.test(final.errorMessage || '')) report.continuationTimeouts++;
        else if (/PROVIDER_TIMEOUT/.test(final.errorMessage || '')) report.providerTimeouts++;
        else if (/pi_tool_call|tool call|toolResult|schema|envelope|unlisted tool|SDK stop_reason/.test(final.errorMessage || '')) report.protocolErrors++;
        else report.providerErrors++;
        break;
      }
      messages.push(final);
      const calls = final.content.filter(block => block.type === 'toolCall');
      if (!calls.length) {
        report.finalResponse = final.content.some(block => block.type === 'text' && block.text.includes(`QODER_RUN_${index + 1}_DONE`));
        break;
      }
      for (const call of calls) {
        if (call.name !== sequence[report.toolExecutions]) { report.protocolErrors++; throw new Error('Unexpected tool sequence'); }
        let text, isError = false;
        try { text = await execute(call); report.toolExecutions++; report.sequence.push(call.name); }
        catch (error) { report.toolErrors++; isError = true; text = String(error); }
        messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, isError, content: [{ type: 'text', text }], timestamp: Date.now() });
      }
    }
  } catch (error) { report.failure = String(error); }
  finally { __setBridgeInternals({}); }
  report.states = states;
  report.terminalState = states.at(-1) || null;
  report.pass = report.toolExecutions === sequence.length && report.toolErrors === 0 && report.protocolErrors === 0 && report.continuationTimeouts === 0 && report.providerTimeouts === 0 && report.providerErrors === 0 && report.finalResponse && report.terminalState === 'COMPLETED';
  reports.push(report);
  console.log(JSON.stringify(report));
}
await mkdir('test-artifacts', { recursive: true });
await writeFile('test-artifacts/real-provider-summary.json', JSON.stringify(reports, null, 2));
process.exitCode = reports.every(report => report.pass) ? 0 : 1;
