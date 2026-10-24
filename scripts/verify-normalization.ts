/**
 * Stage-4 live verification CLI (docs/live-normalization-acceptance.md).
 *
 *   node --import tsx scripts/verify-normalization.ts --live --rounds 10
 *
 * Without --live this script prints the planned attempts and performs NO SDK
 * calls (fixture/offline usage keeps the network at zero). With --live it runs
 * 4 cases x N rounds of real Qwen3.8-Flash attempts through streamQoder with
 * fresh contexts, executing strictly-gated real read/grep/ls calls and writing
 * all evidence to ignored test-artifacts/.
 *
 * Exit code is 0 only when every planned attempt is a full pass.
 */
import { constants as FS } from "node:fs";
import { access, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { query } from "@qoder-ai/qoder-agent-sdk";
import type { Message, Model, Api, Tool, TranscriptContext, AssistantMessage } from "@earendil-works/pi-ai";
import { __setBridgeInternals, streamQoder, DEFAULT_TOTAL_DEADLINE_MS } from "../extensions/index.js";
import {
  CASE_ORDER,
  buildCasePlans,
  createSdkObserver,
  markerFor,
  runAttempt,
  taskFor,
  type AttemptRecord,
  type CaseId,
  type CaseSpec,
  type FailureClass,
  type SdkObservation,
} from "./live-verification.js";

const TSX_IMPORT_HINT = "node --import tsx scripts/verify-normalization.ts";

interface CliArgs {
  live: boolean;
  rounds: number;
  caseId?: CaseId;
  outDir: string;
  help: boolean;
}

function isCaseId(value: string): value is CaseId {
  return (CASE_ORDER as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: false, rounds: 10, outDir: "test-artifacts/normalization-campaign", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") args.live = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--rounds") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error(`--rounds must be an integer 1..10, got ${raw}`);
      }
      args.rounds = value;
    } else if (arg === "--case") {
      const value = argv[++i];
      if (!value || !isCaseId(value)) {
        throw new Error(`--case must be one of ${CASE_ORDER.join("|")}, got ${value}`);
      }
      args.caseId = value;
    } else if (arg === "--out-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--out-dir requires a value");
      args.outDir = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `Usage: ${TSX_IMPORT_HINT} --live [--case basic|sequential|batch|error-recovery] [--rounds 1..10] [--out-dir DIR]
  --live     Run real Qwen3.8-Flash attempts (requires qoder login). Without it, only prints the plan.
  --case     Run one case only (basic|sequential|batch|error-recovery). Default: all 4 cases.
  --rounds   Rounds per case (default 10, max 10). Planned attempts = selected cases x rounds.
  --out-dir  Artifact directory (default test-artifacts/normalization-campaign).
Exit code is 0 only when all planned attempts are full passes.`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// --- Model / tools (mirroring the extension's declared surface) ----------

const MODEL: Model<Api> = {
  id: "Qwen3.8-Flash",
  name: "Qwen3.8-Flash (normalization campaign)",
  api: "qoder-agent-sdk" as Api,
  provider: "qoder-bridge",
  baseUrl: "qoder-agent-sdk://local",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

const TOOLS: Tool[] = [
  {
    name: "read",
    description: "Read one specified local text file",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "grep",
    description: "Search a local file for a fixed literal string",
    parameters: {
      type: "object",
      required: ["path", "pattern"],
      properties: { path: { type: "string" }, pattern: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "ls",
    description: "List entries of a local directory",
    parameters: {
      type: "object",
      required: ["path", "limit"],
      properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
      additionalProperties: false,
    },
  },
] as unknown as Tool[];

const SYSTEM_PROMPT =
  "You are a verification subagent running a fixed read-only task. " +
  "Do not delegate. Do not print tool-call syntax, patches, or pseudo-tool calls as prose. " +
  "Pi executes the available tools and supplies authoritative results.";

// --- Real executors (only allowlisted targets can reach this) -------------

async function executeRead(path: string): Promise<{ isError: boolean; text: string }> {
  try {
    return { isError: false, text: await readFile(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { isError: true, text: `ENOENT: ${(error as Error).message}` };
    }
    if (code === "EISDIR") return { isError: true, text: `EISDIR: ${(error as Error).message}` };
    throw error;
  }
}

async function executeGrep(path: string, pattern: string): Promise<{ isError: boolean; text: string }> {
  const read = await executeRead(path);
  if (read.isError) return read;
  const lines = read.text.split(/\r?\n/);
  const matches: string[] = [];
  lines.forEach((line, i) => {
    if (line.includes(pattern)) matches.push(`${i + 1}:${line}`);
  });
  return {
    isError: false,
    text: matches.length ? matches.join("\n") : `no matches for ${JSON.stringify(pattern)} in ${path}`,
  };
}

async function executeLs(path: string, limit: number): Promise<{ isError: boolean; text: string }> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const rendered = entries
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .slice(0, limit)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { isError: false, text: rendered.join("\n") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { isError: true, text: `ENOENT: ${(error as Error).message}` };
    }
    throw error;
  }
}

// --- Campaign -------------------------------------------------------------

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function requireCanonicalTarget(target: string, expected: string, root: string): Promise<void> {
  const actual = await realpath(target);
  const rel = relative(root, actual);
  if (rel.startsWith("..") || isAbsolute(rel) || !samePath(actual, expected)) {
    throw new Error(`SAFETY_VIOLATION: redirected or outside target ${target}`);
  }
}

async function prepareArtifactDirectory(root: string, outDir: string): Promise<void> {
  const base = resolve(root, "test-artifacts");
  await requireCanonicalTarget(base, base, root);
  let cursor = outDir;
  while (!samePath(cursor, base)) {
    if (await pathExists(cursor)) await requireCanonicalTarget(cursor, cursor, root);
    cursor = dirname(cursor);
  }
  await mkdir(outDir, { recursive: true });
  await requireCanonicalTarget(outDir, outDir, root);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const root = await realpath(process.cwd());
  const spec: CaseSpec = {
    root,
    packageJsonPath: resolve(root, "package.json"),
    sentinelPath: resolve(root, "test-artifacts/__qwen_sentinel_absent_40061e0__.json"),
    indexPath: resolve(root, "extensions/index.ts"),
    grepPattern: "</pi_tool_call>",
    lsLimit: 10,
  };
  await requireCanonicalTarget(spec.packageJsonPath, spec.packageJsonPath, root);
  await requireCanonicalTarget(spec.indexPath, spec.indexPath, root);
  await requireCanonicalTarget(dirname(spec.sentinelPath), dirname(spec.sentinelPath), root);
  const harnessPaths = {
    cli: resolve(root, "scripts/verify-normalization.ts"),
    gate: resolve(root, "scripts/live-verification.ts"),
  };
  for (const path of Object.values(harnessPaths)) await requireCanonicalTarget(path, path, root);
  const harnessHashes = {
    cli: await sha256File(harnessPaths.cli),
    gate: await sha256File(harnessPaths.gate),
  };
  const totalDeadlineMs = DEFAULT_TOTAL_DEADLINE_MS;
  const plans = buildCasePlans(spec);
  const selectedCases: readonly CaseId[] = args.caseId ? [args.caseId] : CASE_ORDER;
  const planned = selectedCases.flatMap((caseId) =>
    Array.from({ length: args.rounds }, (_, i) => ({ caseId, round: i + 1 })),
  );

  // Source/package drift checks: fixed now, re-verified before every attempt.
  const sourceHash = await sha256File(spec.indexPath);
  const pkgText = await readFile(spec.packageJsonPath, "utf8");
  const pkgVersion = (JSON.parse(pkgText) as { version?: string }).version ?? "unknown";
  const pkgHash = createHash("sha256").update(pkgText).digest("hex");
  if (await pathExists(spec.sentinelPath)) {
    throw new Error(`sentinel path unexpectedly exists: ${spec.sentinelPath}`);
  }

  if (!args.live) {
    console.log(JSON.stringify({
      mode: "plan-only (no --live, no SDK started)",
      totalDeadlineMs,
      selectedCases: [...selectedCases],
      harnessHashes,
      sourceHash,
      packageVersion: pkgVersion,
      spec,
      plannedAttempts: planned.map((p) => ({ case: p.caseId, round: p.round, marker: markerFor(p.caseId, p.round) })),
      counts: { planned: planned.length },
    }, null, 2));
    return;
  }

  const outDir = resolve(root, args.outDir);
  const rel = relative(root, outDir);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/)[0] !== "test-artifacts") {
    throw new Error(`--out-dir must stay inside test-artifacts/, got ${args.outDir}`);
  }
  await prepareArtifactDirectory(root, outDir);
  const stamp = Date.now();
  const attemptsPath = resolve(outDir, `attempts-${stamp}.jsonl`);
  const summaryPath = resolve(outDir, `summary-${stamp}.json`);

  const canonicalize = (p: string) => resolve(p);

  const summaries = {
    planned: planned.length,
    executed: 0,
    fullPass: 0,
    toolFlowOnly: 0,
    failures: {} as Partial<Record<FailureClass, number>>,
    serviceFailures: 0,
    stoppedEarly: false,
    stopReason: "",
  };

  const driftCheck = async (): Promise<void> => {
    await requireCanonicalTarget(spec.indexPath, spec.indexPath, root);
    await requireCanonicalTarget(spec.packageJsonPath, spec.packageJsonPath, root);
    await requireCanonicalTarget(dirname(spec.sentinelPath), dirname(spec.sentinelPath), root);
    await requireCanonicalTarget(outDir, outDir, root);
    const nowSource = await sha256File(spec.indexPath);
    const nowPkg = createHash("sha256").update(await readFile(spec.packageJsonPath, "utf8")).digest("hex");
    if (nowSource !== sourceHash) throw new Error(`SAFETY_VIOLATION: source drift in extensions/index.ts (${sourceHash} -> ${nowSource})`);
    if (nowPkg !== pkgHash) throw new Error("SAFETY_VIOLATION: package.json changed during the campaign");
    if (await pathExists(spec.sentinelPath)) throw new Error("SAFETY_VIOLATION: absent sentinel appeared during the campaign");
    for (const key of ["cli", "gate"] as const) {
      const path = harnessPaths[key];
      await requireCanonicalTarget(path, path, root);
      if (await sha256File(path) !== harnessHashes[key]) {
        throw new Error(`SAFETY_VIOLATION: campaign harness drift in ${key}`);
      }
    }
  };

  let attemptNo = 0;
  for (const { caseId, round } of planned) {
    if (summaries.stoppedEarly) break;
    attemptNo++;
    const plan = plans[caseId];
    const marker = markerFor(caseId, round);
    const task = taskFor(plan, marker, spec);
    try {
      await driftCheck();
    } catch (error) {
      summaries.stoppedEarly = true;
      summaries.stopReason = (error as Error).message;
      console.error(`SAFETY STOP before attempt ${attemptNo}: ${summaries.stopReason}`);
      break;
    }

    const turnTraces: Array<{ promptChars: number; model: unknown; sessionIds: string[]; sdkResponses: unknown[]; sdkObservation?: SdkObservation }> = [];
    __setBridgeInternals({
      queryFactory: (params) => {
        // Wrap the real query without altering its auth/options; record what
        // actually went over the wire plus the SDK session ids. The wrapper
        // returns a QueryLike (AsyncIterable + close) matching the bridge's
        // internal seam.
        const q = query(params);
        const sessionIds = new Set<string>();
        // Monotonic clock anchored at query creation: sdkObservation event
        // timestamps are elapsed ms stamped when the SDK iterator next()
        // resolves (message arrival), which is what separates "still queued"
        // from "ready but silent". Sanitization lives in live-verification
        // (pure allowlist) — a capture failure can never alter execution.
        const t0 = performance.now();
        const observer = createSdkObserver({ now: () => performance.now() - t0 });
        const record = {
          promptChars: typeof params.prompt === "string" ? params.prompt.length : -1,
          model: params.options?.model,
          sessionIds: [] as string[],
          sdkResponses: [] as unknown[],
          // Read the latest observation even when SDK next()/close() never
          // settles: timeout evidence must not depend on iterator finally.
          get sdkObservation(): SdkObservation { return observer.snapshot(); },
        };
        turnTraces.push(record);
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const message of q) {
                observer.observe(message);
                const sid = (message as { session_id?: string }).session_id;
                if (sid && !sessionIds.has(sid)) {
                  sessionIds.add(sid);
                  record.sessionIds.push(sid);
                }
                if (message.type === "assistant") record.sdkResponses.push({ type: message.type, session_id: sid, id: message.message.id, model: message.message.model, stop_reason: message.message.stop_reason, content: message.message.content.filter(block => block.type === "text" || block.type === "tool_use") });
                if (message.type === "result") record.sdkResponses.push({ type: message.type, session_id: sid, subtype: message.subtype, is_error: message.is_error, stop_reason: message.stop_reason });
                yield message;
              }
            } finally {
              // Observation is exposed through the live snapshot getter above.
            }
          },
          close: () => q.close(),
        };
      },
    });

    let record: AttemptRecord;
    try {
      record = await runAttempt({
        plan,
        marker,
        task,
        tools: TOOLS,
        systemPrompt: SYSTEM_PROMPT,
        canonicalize,
        stream: async (context: TranscriptContext): Promise<AssistantMessage> => {
          await driftCheck();
          const stream = streamQoder(MODEL, context, { totalDeadlineMs, maxTokens: 2048, reasoning: "low" });
          for await (const _event of stream) { /* drain */ }
          return stream.result();
        },
        execute: async (call) => {
          await driftCheck();
          const target = String(call.arguments.path);
          if (!samePath(resolve(target), spec.sentinelPath)) {
            const expected = call.name === "ls" ? spec.root : call.name === "grep" ? spec.indexPath : spec.packageJsonPath;
            await requireCanonicalTarget(target, expected, root);
          }
          if (call.name === "read") return executeRead(target);
          if (call.name === "grep") return executeGrep(String(call.arguments.path), String(call.arguments.pattern));
          return executeLs(String(call.arguments.path), Number(call.arguments.limit));
        },
        afterStream: (turn) => turnTraces[turn - 1] ?? null,
      });
    } catch (error) {
      record = {
        caseId,
        marker,
        task,
        maxTurns: plan.groups.length + 1,
        turns: [],
        results: [],
        verdict: {
          toolFlowPass: false,
          responsePass: false,
          fullPass: false,
          failure: "SAFETY_VIOLATION",
          fatal: true,
          detail: error instanceof Error ? error.message : String(error),
        },
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
      };
    } finally {
      __setBridgeInternals({});
    }
    try { await driftCheck(); } catch (error) {
      record.verdict = { toolFlowPass: false, responsePass: false, fullPass: false, fatal: true, failure: "SAFETY_VIOLATION", detail: error instanceof Error ? error.message : String(error) };
    }
    record.attempt = attemptNo;
    record.round = round;
    record.model = MODEL.id;
    record.sourceHash = sourceHash;
    record.packageVersion = pkgVersion;
    record.totalDeadlineMs = totalDeadlineMs;
    record.harnessHashes = { ...harnessHashes };

    summaries.executed++;
    if (record.verdict.fullPass) summaries.fullPass++;
    else if (record.verdict.toolFlowPass) summaries.toolFlowOnly++;
    const failure = record.verdict.failure;
    if (failure) {
      summaries.failures[failure] = (summaries.failures[failure] ?? 0) + 1;
      if (failure === "SERVICE_FAILURE") summaries.serviceFailures++;
    }
    await requireCanonicalTarget(outDir, outDir, root);
    await writeFile(attemptsPath, JSON.stringify(record) + "\n", { flag: "a" });
    console.log(
      `attempt ${attemptNo}/${summaries.planned} ${caseId} round ${round}: ` +
        `${record.verdict.fullPass ? "FULL PASS" : `FAIL ${failure} — ${record.verdict.detail ?? ""}`} (${record.elapsedMs}ms)`,
    );
    if (record.verdict.fatal) {
      summaries.stoppedEarly = true;
      summaries.stopReason = `attempt ${attemptNo}: ${record.verdict.detail ?? failure}`;
      console.error(`SAFETY STOP: ${summaries.stopReason}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    model: MODEL.id,
    totalDeadlineMs,
    harnessHashes,
    sourceHash,
    packageVersion: pkgVersion,
    spec,
    ...summaries,
    allPass: summaries.executed === summaries.planned && summaries.fullPass === summaries.planned,
    note: "Full pass requires every planned attempt; failures are counted, never retried or replaced. Service failures are tallied separately and are not passes. A clean run is evidence for this campaign only, not a guarantee.",
  };
  await requireCanonicalTarget(outDir, outDir, root);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
