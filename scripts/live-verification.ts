/**
 * Stage-4 upper gate for the live normalization campaign
 * (docs/live-normalization-acceptance.md).
 *
 * This module is intentionally pure: no SDK, no filesystem, no network.
 * All IO (streaming, tool execution, path canonicalization) is injected so
 * the gate logic is deterministic and fully covered by offline unit tests.
 * The Bridge itself never guesses natural-language completion — this gate
 * owns the plan, the completion check, and the marker check.
 */
import { isDeepStrictEqual } from "node:util";
import {
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

// --- Case plans ---------------------------------------------------------

export type ToolName = "read" | "grep" | "ls";
export type CaseId = "basic" | "sequential" | "batch" | "error-recovery";
export const CASE_ORDER: readonly CaseId[] = ["basic", "sequential", "batch", "error-recovery"];

export interface ExpectedCall {
  name: ToolName;
  arguments: Record<string, unknown>;
}
/** Mandatory tool-call group: emitted in ONE assistant message, in this order. */
export type CallGroup = ExpectedCall[];

/** Canonical locations the campaign is allowed to touch. Anything outside
 *  this spec is a safety violation, never a tolerated deviation. */
export interface CaseSpec {
  /** canonical repository root */
  root: string;
  /** canonical root package.json */
  packageJsonPath: string;
  /** canonical path that was verified absent before the campaign */
  sentinelPath: string;
  /** canonical extensions/index.ts */
  indexPath: string;
  /** fixed literal grep pattern ("</pi_tool_call>") */
  grepPattern: string;
  /** fixed ls limit (10) */
  lsLimit: number;
}

export interface CasePlan {
  id: CaseId;
  groups: CallGroup[];
  requiresPackageName: boolean;
  requiresENOENT: boolean;
}

export function buildCasePlans(spec: CaseSpec): Record<CaseId, CasePlan> {
  const readPkg: ExpectedCall = { name: "read", arguments: { path: spec.packageJsonPath } };
  const readSentinel: ExpectedCall = { name: "read", arguments: { path: spec.sentinelPath } };
  const grepIndex: ExpectedCall = { name: "grep", arguments: { path: spec.indexPath, pattern: spec.grepPattern } };
  const lsRoot: ExpectedCall = { name: "ls", arguments: { path: spec.root, limit: spec.lsLimit } };
  return {
    basic: { id: "basic", groups: [[readPkg]], requiresPackageName: true, requiresENOENT: false },
    sequential: {
      id: "sequential",
      groups: [[readPkg], [grepIndex], [lsRoot]],
      requiresPackageName: true,
      requiresENOENT: false,
    },
    batch: { id: "batch", groups: [[readPkg, lsRoot]], requiresPackageName: true, requiresENOENT: false },
    "error-recovery": {
      id: "error-recovery",
      groups: [[readSentinel], [readPkg]],
      requiresPackageName: true,
      requiresENOENT: true,
    },
  };
}

/** Fixed marker per (case, round). Printed output only — never a filename,
 *  never a grep target, per the acceptance contract. */
export function markerFor(caseId: CaseId, round: number): string {
  return `QWEN_LIVE_${caseId.toUpperCase().replace(/-/g, "_")}_${round}`;
}

/** Task text sent as the single user message. It fixes the mandatory ordered
 *  steps and states explicitly that the marker is print-only. */
export function taskFor(plan: CasePlan, marker: string, spec: CaseSpec): string {
  const pkg = JSON.stringify(spec.packageJsonPath);
  const sentinel = JSON.stringify(spec.sentinelPath);
  const index = JSON.stringify(spec.indexPath);
  const pattern = JSON.stringify(spec.grepPattern);
  const root = JSON.stringify(spec.root);
  const steps: Record<CaseId, string> = {
    basic: `(1) read(path=${pkg})を1回。結果を受け取るまで最終回答をしない。`,
    sequential:
      `(1) read(path=${pkg})を1回。(2) grep(path=${index}, pattern=${pattern})を1回。` +
      `(3) ls(path=${root}, limit=${spec.lsLimit})を1回。この順序を守る。` +
      `各手順の結果を受け取ってから、次の応答で次の手順を呼び出す。同一assistant messageで複数手順を発行しない。`,
    batch:
      `(1) read(path=${pkg})とls(path=${root}, limit=${spec.lsLimit})を同一応答でこの順序で発行する。` +
      `両方の結果を受け取るまで最終回答をしない。`,
    "error-recovery":
      `(1) read(path=${sentinel})を1回。意図的なENOENTを受け取ったら、(2) read(path=${pkg})を1回。` +
      `最初のreadを再試行しない。2番目の成功結果を受け取るまで最終回答をしない。`,
  };
  const report = plan.requiresENOENT
    ? "最後に観測したpackage nameとENOENTを報告し"
    : "最後に観測したpackage nameを報告し";
  return (
    `次の必須手順をすべて実際に実行する。${steps[plan.id]}` +
    `${report}、最終行に ${marker} とだけ印字する。` +
    `この固定文字列は出力用であり、ファイル名や検索対象ではない。編集・外部操作・追加ツールは禁止。`
  );
}

// --- Call domain / safety gate ------------------------------------------

/** Canonicalize a path for comparison (realpath when it exists, else
 *  resolved+normalized). Injected so tests need no filesystem. */
export type Canonicalize = (path: string) => string;

const ARG_SHAPES: Record<ToolName, Record<string, "string" | "number">> = {
  read: { path: "string" },
  grep: { path: "string", pattern: "string" },
  ls: { path: "string", limit: "number" },
};

export interface ObservedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function isToolName(name: string): name is ToolName {
  return name === "read" || name === "grep" || name === "ls";
}

function canonicalCall(call: ObservedCall, canonicalize: Canonicalize): ExpectedCall | undefined {
  if (!isToolName(call.name)) return undefined;
  const shape = ARG_SHAPES[call.name];
  const args = call.arguments;
  const keys = Object.keys(args);
  if (keys.length !== Object.keys(shape).length || !keys.every((k) => k in shape)) return undefined;
  for (const [key, kind] of Object.entries(shape)) {
    if (typeof args[key] !== kind) return undefined;
  }
  const canonical: Record<string, unknown> = { ...args, path: canonicalize(String(args.path)) };
  return { name: call.name, arguments: canonical };
}

function callsEqual(expected: ExpectedCall, observed: ExpectedCall): boolean {
  return expected.name === observed.name && isDeepStrictEqual(expected.arguments, observed.arguments);
}

export interface CallGateResult {
  /** Matched flat indexes into the plan (in observed order). Only set when
   *  every call is an allowlisted, not-yet-consumed planned call. */
  matchedIndexes?: number[];
  /** Fatal safety violation: unknown tool, malformed args, out-of-domain
   *  target, unplanned call, or unscheduled re-execution. Stop the campaign. */
  fatal?: string;
}

/** Flatten plan groups to expected calls, remembering each call's group. */
function flatPlan(plan: CasePlan): ExpectedCall[] {
  return plan.groups.flat();
}

/**
 * Pre-execution gate: verify every observed call is (a) a known tool with a
 * well-formed argument shape, (b) canonical-equal to a planned call, and
 * (c) not already consumed. Any failure is fatal — the calls are never
 * executed and the campaign stops.
 */
export function checkCallAllowlist(
  plan: CasePlan,
  consumed: ReadonlySet<number>,
  calls: readonly ObservedCall[],
  canonicalize: Canonicalize,
  seenIds: ReadonlySet<string> = new Set(),
): CallGateResult {
  const expected = flatPlan(plan);
  const matched: number[] = [];
  const ids = new Set(seenIds);
  for (const call of calls) {
    if (typeof call.id !== "string" || call.id.length === 0) {
      return { fatal: `tool call missing a non-empty id (name=${call.name})` };
    }
    if (ids.has(call.id)) return { fatal: `duplicate tool call id ${call.id}` };
    ids.add(call.id);
    const canonical = canonicalCall(call, canonicalize);
    if (!canonical) {
      return { fatal: `call ${JSON.stringify({ name: call.name, arguments: call.arguments })} is not an allowlisted tool call shape` };
    }
    const index = expected.findIndex((candidate, i) => !consumed.has(i) && !matched.includes(i) && callsEqual(candidate, canonical));
    if (index === -1) {
      const duplicate = expected.some((candidate, i) => consumed.has(i) && callsEqual(candidate, canonical));
      return {
        fatal: duplicate
          ? `unscheduled re-execution of already-answered call ${JSON.stringify(canonical)}`
          : `call ${JSON.stringify(canonical)} is outside the planned allowlist`,
      };
    }
    matched.push(index);
  }
  return { matchedIndexes: matched };
}

/** Exact positional group match: same arity, same order, same arguments. */
export function groupsEqual(expected: CallGroup, calls: readonly ObservedCall[], canonicalize: Canonicalize): boolean {
  if (calls.length !== expected.length) return false;
  return expected.every((want, i) => {
    const got = canonicalCall(calls[i], canonicalize);
    return got !== undefined && callsEqual(want, got);
  });
}

// --- Verdict -------------------------------------------------------------

export type FailureClass =
  | "INCOMPLETE_PLAN"
  | "UNEXPECTED_CALL"
  | "FINAL_RESPONSE_NONCOMPLIANCE"
  | "RESULT_MISMATCH"
  | "PROTOCOL_FAILURE"
  | "SERVICE_FAILURE"
  | "SAFETY_VIOLATION";

export interface Verdict {
  toolFlowPass: boolean;
  responsePass: boolean;
  fullPass: boolean;
  failure?: FailureClass;
  /** fatal=true → safety violation → the whole campaign must stop. */
  fatal: boolean;
  detail?: string;
}

const pass = (): Verdict => ({ toolFlowPass: true, responsePass: true, fullPass: true, fatal: false });
const fail = (failure: FailureClass, detail: string, extra?: Partial<Verdict>): Verdict => ({
  toolFlowPass: false,
  responsePass: false,
  fullPass: false,
  failure,
  fatal: failure === "SAFETY_VIOLATION",
  detail,
  ...extra,
});

const SERVICE_ERROR_RE =
  /PROVIDER_UNAVAILABLE|PROVIDER_QUEUE_TIMEOUT|PROVIDER_RESPONSE_TIMEOUT|POST_TOOL_CONTINUATION_TIMEOUT|deadline|timed?\s*out|abort/i;

/** SDK terminal-result error codes observed to mean a service-side fault
 *  rather than a model/protocol violation (live evidence: qwen38flash
 *  ordered campaign, 2026-10-23 — "The model is busy" [error_code=10605]).
 *  Exact-code allowlist only; this is diagnostic metadata, never retry
 *  permission — no retry or success is inferred from it. */
const SDK_SERVICE_ERROR_CODES: ReadonlySet<string> = new Set(["10605"]);
/** Matches the structured suffix the bridge appends in extensions/index.ts:
 *  a stable `SDK_TERMINAL_ERROR:` prefix, then a trailing `[error_code=<token>]`
 *  optionally followed by `[terminal_reason=<token>]` — anchored to the END of
 *  the message. Free-form prose ("busy"), a missing/embedded code, a longer
 *  numeric code (106050) and unknown codes do NOT match. */
const SDK_TERMINAL_SERVICE_RE =
  /^SDK_TERMINAL_ERROR: [\s\S]* \[error_code=([A-Za-z0-9_.:-]{1,64})\](?: \[terminal_reason=[A-Za-z0-9_.:-]{1,64}\])?$/;

/** Classify a terminal stream error: provider-queue/timeout/abort evidence and
 *  allowlisted SDK terminal service codes are service failures (separately
 *  tallied, never a pass); everything else is a protocol/model failure for
 *  that case. Safety violations keep precedence over every other signal. */
export function classifyStreamError(errorMessage: string | undefined): FailureClass {
  if (errorMessage?.startsWith("SAFETY_VIOLATION:") || /Model requested unlisted tool|duplicate tool call id|reused a tool call id/i.test(errorMessage ?? "")) return "SAFETY_VIOLATION";
  if (SERVICE_ERROR_RE.test(errorMessage ?? "")) return "SERVICE_FAILURE";
  const sdkTerminal = errorMessage ? SDK_TERMINAL_SERVICE_RE.exec(errorMessage) : null;
  return sdkTerminal && SDK_SERVICE_ERROR_CODES.has(sdkTerminal[1]) ? "SERVICE_FAILURE" : "PROTOCOL_FAILURE";
}

/** The completion marker must be the exact standalone final line and appear
 *  exactly once — a mention inside a negated sentence or mid-body is a fail. */
export function checkMarker(text: string, marker: string): boolean {
  const trimmed = text.replace(/\r?\n$/, "");
  const lines = trimmed.split(/\r?\n/);
  if (lines[lines.length - 1] !== marker) return false;
  return text.split(marker).length - 1 === 1;
}

export function evaluateFinalText(
  plan: CasePlan,
  text: string,
  observedPackageName: string | undefined,
  marker: string,
): { pass: boolean; detail?: string } {
  if (!text.trim()) return { pass: false, detail: "empty final text" };
  if (plan.requiresPackageName) {
    if (!observedPackageName) return { pass: false, detail: "no observed package name from a successful read" };
    if (!text.includes(observedPackageName)) return { pass: false, detail: `final text lacks observed package name ${observedPackageName}` };
  }
  if (plan.requiresENOENT && !/ENOENT/.test(text)) {
    return { pass: false, detail: "final text does not report the observed ENOENT" };
  }
  if (!checkMarker(text, marker)) {
    return { pass: false, detail: `marker ${marker} is not the exact standalone final line` };
  }
  return { pass: true };
}

// --- Attempt record + post-hoc evaluation --------------------------------

export interface TurnRecord {
  turn: number;
  stopReason: string;
  errorMessage?: string;
  calls: ObservedCall[];
  text: string;
  providerTrace?: unknown;
}

export interface ExecutedResult {
  id: string;
  name: string;
  isError: boolean;
  body: string;
}

export interface AttemptRecord {
  caseId: CaseId;
  marker: string;
  task: string;
  maxTurns: number;
  turns: TurnRecord[];
  results: ExecutedResult[];
  /** package name parsed from the actual read result — never self-reported. */
  observedPackageName?: string;
  verdict: Verdict;
  startedAt: string;
  elapsedMs: number;
  // Populated by the caller (CLI):
  attempt?: number;
  round?: number;
  model?: string;
  sourceHash?: string;
  packageVersion?: string;
  totalDeadlineMs?: number;
  harnessHashes?: { cli: string; gate: string };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function callsOf(message: AssistantMessage): ObservedCall[] {
  return message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments as Record<string, unknown> }));
}

/**
 * Pure post-hoc verdict: re-derive pass/fail from the raw attempt record
 * (turns, executed results, observed package name). This is the authoritative
 * gate — it does not trust the runner's own claims, so a snapshot's self-report
 * can never produce a pass on its own.
 */
export function evaluateAttempt(
  plan: CasePlan,
  record: Pick<AttemptRecord, "turns" | "results" | "observedPackageName" | "marker">,
  canonicalize: Canonicalize,
): Verdict {
  const consumed = new Set<number>();
  const executedCalls: ObservedCall[] = [];
  const seenIds = new Set<string>();
  let step = 0;
  let sawFinalText = false;
  let finalText = "";
  let pendingServiceError: string | undefined;
  for (const turn of record.turns) {
    if (turn.stopReason === "error" || turn.stopReason === "aborted") {
      const failure = classifyStreamError(turn.errorMessage);
      if (failure === "SERVICE_FAILURE") {
        pendingServiceError = turn.errorMessage ?? "stream terminated without a reason";
        break;
      }
      return fail(failure, turn.errorMessage ?? "stream terminated without a reason");
    }
    if (turn.calls.length > 0) {
      const gate = checkCallAllowlist(plan, consumed, turn.calls, canonicalize, seenIds);
      if (gate.fatal) return fail("SAFETY_VIOLATION", `turn ${turn.turn}: ${gate.fatal}`);
      const expected = plan.groups[step];
      if (!expected || !groupsEqual(expected, turn.calls, canonicalize)) {
        return fail(
          "UNEXPECTED_CALL",
          `turn ${turn.turn}: expected group ${JSON.stringify(expected ?? [])} but got ${JSON.stringify(turn.calls.map((c) => ({ name: c.name, arguments: c.arguments })))}`,
        );
      }
      for (const index of gate.matchedIndexes ?? []) consumed.add(index);
      executedCalls.push(...turn.calls);
      for (const call of turn.calls) seenIds.add(call.id);
      step++;
      continue;
    }
    // Text turn: acceptable only once every group is complete.
    sawFinalText = true;
    finalText = turn.text;
    if (step < plan.groups.length) {
      return fail(
        "INCOMPLETE_PLAN",
        `turn ${turn.turn}: text/stop with ${plan.groups.length - step} mandatory group(s) still unexecuted`,
        { responsePass: evaluateFinalText(plan, finalText, record.observedPackageName, record.marker).pass },
      );
    }
  }
  if (step < plan.groups.length || (!sawFinalText && !pendingServiceError)) {
    if (pendingServiceError) return fail("SERVICE_FAILURE", pendingServiceError);
    return fail("INCOMPLETE_PLAN", `plan finished ${step}/${plan.groups.length} groups without a compliant final answer`);
  }
  // Result linkage: every executed call needs exactly one result with the
  // same id and name, in order. A wrong/missing/orphan result id fails here.
  if (record.results.length !== executedCalls.length) {
    return fail("RESULT_MISMATCH", `executed ${executedCalls.length} calls but recorded ${record.results.length} results`);
  }
  let observedPackageName: string | undefined;
  for (const [i, call] of executedCalls.entries()) {
    const result = record.results[i];
    if (!result || result.id !== call.id || result.name !== call.name) {
      return fail("RESULT_MISMATCH", `result #${i + 1} does not match call ${call.name}#${call.id}`);
    }
    const expectsError = plan.requiresENOENT && i === 0;
    if (result.isError !== expectsError || (expectsError && !/\bENOENT\b/.test(result.body))) {
      return fail("RESULT_MISMATCH", `result #${i + 1} has an unexpected success/error outcome`);
    }
    if (call.name === "read" && !result.isError) {
      observedPackageName = defaultExtractPackageName(result.body);
      if (!observedPackageName) return fail("RESULT_MISMATCH", "successful package read lacks a JSON package name");
    }
  }
  if (record.observedPackageName && record.observedPackageName !== observedPackageName) {
    return fail("RESULT_MISMATCH", "claimed package name differs from the executed read result");
  }
  if (pendingServiceError) return fail("SERVICE_FAILURE", pendingServiceError, { toolFlowPass: true });
  const response = evaluateFinalText(plan, finalText, observedPackageName, record.marker);
  if (!response.pass) return fail("FINAL_RESPONSE_NONCOMPLIANCE", response.detail ?? "final text failed checks", { toolFlowPass: true });
  return pass();
}

// --- Attempt runner (IO injected) -----------------------------------------

export type StreamFn = (context: TranscriptContext) => Promise<AssistantMessage>;
export type Executor = (call: { name: ToolName; arguments: Record<string, unknown> }) => Promise<{ isError: boolean; text: string }>;

export interface AttemptDeps {
  plan: CasePlan;
  marker: string;
  task: string;
  tools: readonly Tool[];
  systemPrompt: string;
  stream: StreamFn;
  execute: Executor;
  canonicalize: Canonicalize;
  /** Optional per-turn hook returning provider trace data (SDK session ids,
   *  request digests) stored on the turn record. */
  afterStream?: (turn: number) => unknown;
  /** Parse the observed package name out of a successful read body. */
  extractPackageName?: (body: string) => string | undefined;
}

const defaultExtractPackageName = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name ? parsed.name : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Drive one fresh-context attempt: user task → model turns → strict gate →
 * real executed results → final answer → post-hoc verdict. The gate validates
 * calls BEFORE anything executes; only an exact expected group runs. A fatal
 * verdict means the caller must stop the whole campaign.
 */
export async function runAttempt(deps: AttemptDeps): Promise<AttemptRecord> {
  const { plan, marker, task, tools, systemPrompt, stream, execute, canonicalize } = deps;
  const extractPackageName = deps.extractPackageName ?? defaultExtractPackageName;
  const startedAt = new Date();
  const t0 = Date.now();
  const record: AttemptRecord = {
    caseId: plan.id,
    marker,
    task,
    maxTurns: plan.groups.length + 1,
    turns: [],
    results: [],
    verdict: fail("INCOMPLETE_PLAN", "attempt produced no verdict"),
    startedAt: startedAt.toISOString(),
    elapsedMs: 0,
  };
  const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
  const consumed = new Set<number>();
  const seenIds = new Set<string>();
  let step = 0;

  for (let turn = 1; turn <= record.maxTurns; turn++) {
    const context: TranscriptContext = normalizeContext({ systemPrompt, tools: [...tools], messages });
    let final: AssistantMessage;
    try {
      final = await stream(context);
    } catch (error) {
      record.turns.push({
        turn,
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        calls: [],
        text: "",
      });
      break;
    }
    const turnRecord: TurnRecord = {
      turn,
      stopReason: final.stopReason,
      errorMessage: final.errorMessage,
      calls: callsOf(final),
      text: textOf(final),
    };
    if (deps.afterStream) {
      try {
        turnRecord.providerTrace = deps.afterStream(turn);
      } catch {
        turnRecord.providerTrace = { captureError: true };
      }
    }
    record.turns.push(turnRecord);

    if (final.stopReason === "error" || final.stopReason === "aborted") break;

    if (turnRecord.calls.length > 0) {
      // Strict argument check completes before ANY tool executes. Both the
      // allowlist (any consumed/unplanned/foreign call) and the exact group
      // shape (arity, order, arguments) must pass before anything runs.
      const gate = checkCallAllowlist(plan, consumed, turnRecord.calls, canonicalize, seenIds);
      const expected = plan.groups[step];
      if (gate.fatal || !expected || !groupsEqual(expected, turnRecord.calls, canonicalize)) {
        // Do not execute; the post-hoc evaluation produces the verdict.
        break;
      }
      messages.push(final);
      for (const call of turnRecord.calls) {
        let result: Awaited<ReturnType<Executor>>;
        try {
          result = await execute({ name: call.name as ToolName, arguments: call.arguments });
        } catch (error) {
          record.verdict = fail("SAFETY_VIOLATION", error instanceof Error ? error.message : String(error));
          record.elapsedMs = Date.now() - t0;
          return record;
        }
        seenIds.add(call.id);
        record.results.push({ id: call.id, name: call.name, isError: result.isError, body: result.text });
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: result.isError,
          content: [{ type: "text", text: result.text }],
          timestamp: Date.now(),
        });
        if (!result.isError) {
          const canonical = canonicalCall(call, canonicalize);
          if (canonical?.name === "read") {
            const observed = extractPackageName(result.text);
            if (observed) record.observedPackageName = observed;
          }
        }
      }
      for (const index of gate.matchedIndexes ?? []) consumed.add(index);
      step++;
      continue;
    }
    // Text turn ends the attempt either way (post-hoc gate classifies it).
    break;
  }

  record.verdict = evaluateAttempt(plan, record, canonicalize);
  record.elapsedMs = Date.now() - t0;
  return record;
}

// --- SDK observation trace (pure; no SDK import) ------------------------------

/**
 * Bounded, sanitized per-query lifecycle observation for the live harness.
 * The providerTrace previously kept only session ids plus assistant/result
 * bodies, so raw system/queue/command_lifecycle frames were discarded and a
 * ~300s PROVIDER_UNAVAILABLE could not be split into SDK-init, queue, or
 * model-output waiting. This observer classifies each raw SDK message into an
 * allowlisted kind and copies only short identifier/status tokens
 * (^[A-Za-z0-9_.:-]{1,64}$), finite numbers, nulls and booleans. Assistant
 * text, tool input/file contents, free-form error/reason strings, arbitrary
 * SDK fields and credentials can never enter the trace. Timestamps are
 * monotonic elapsed ms since the wrapped query() call, stamped when the SDK
 * iterator's next() resolves — i.e. they record message ARRIVAL, which is
 * what distinguishes "still queued" from "ready but silent".
 *
 * What this canNOT prove: service-side queue position, network stalls inside
 * the SDK/CLI process, hook-side latency, or why the runtime retried — only
 * which frames arrived, in which order, and when.
 */
export const SDK_OBSERVATION_SCHEMA = "sdk-observation-v1";
export const SDK_OBSERVATION_NOTE =
  "structural timing only: proves SDK frame arrival order/timing and declared status fields; " +
  "cannot prove server-side queue state, in-SDK network stalls, or hook latency. " +
  "init receipt alone is not provider-ready — see sawQueueReady/sawModelEvent.";
export const DEFAULT_MAX_TRACE_EVENTS = 256;

const OBS_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const obsToken = (v: unknown): string | undefined =>
  typeof v === "string" && OBS_TOKEN_RE.test(v) ? v : undefined;
const obsNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const obsBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obsNullableNumber = (v: unknown): number | null | undefined =>
  v === null ? null : obsNumber(v);
/** error_code accepts a short token or a finite number, rendered as a string. */
const obsCode = (v: unknown): string | undefined => {
  const s = obsToken(v);
  if (s !== undefined) return s;
  const n = obsNumber(v);
  return n === undefined ? undefined : String(n);
};

export type TraceEventKind =
  | "init"
  | "queue_status"
  | "api_retry"
  | "control_request_progress"
  | "system"
  | "command_lifecycle"
  | "assistant"
  | "stream_event"
  | "result"
  | "other";

/** One allowlisted trace frame. Every field is a token, finite number,
 *  boolean or null — never free-form text. */
export interface TraceEvent {
  /** Monotonic ms since query creation, stamped at SDK next() receipt. */
  t: number;
  kind: TraceEventKind;
  /** Wire `type` token kept for kind="other". */
  wire_type?: string;
  /** system subtype / result subtype token. */
  subtype?: string;
  /** queue status / control_request_progress status token. */
  status?: string;
  /** command_lifecycle state token. */
  state?: string;
  service_available?: boolean;
  queue_wait_elapsed_ms?: number;
  wait_time_ms?: number;
  queue_max_wait_ms?: number;
  queue_count?: number;
  queue_type?: string;
  request_id?: string;
  request_set_id?: string;
  model_key?: string;
  /** SDK-internal retry counters (api_retry / control_request_progress). */
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  model?: string;
  qodercli_version?: string;
  protocol_version?: string;
  api_key_source?: string;
  tool_count?: number;
  message_id?: string;
  is_api_error_message?: boolean;
  aborted?: boolean;
  /** assistant content-block counts only — never text/tool input. */
  text_blocks?: number;
  tool_use_blocks?: number;
  thinking_blocks?: number;
  other_blocks?: number;
  event_type?: string;
  is_error?: boolean;
  stop_reason?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  error_code?: string;
  terminal_reason?: string;
}

export interface LastQueueStatus {
  status?: string;
  service_available?: boolean;
  queue_wait_elapsed_ms?: number;
  queue_max_wait_ms?: number;
  queue_count?: number;
}

export interface SdkObservation {
  schema: typeof SDK_OBSERVATION_SCHEMA;
  clock: "monotonic_ms_since_query_create";
  note: typeof SDK_OBSERVATION_NOTE;
  /** Bounded timeline; once maxEvents is reached further events only bump
   *  droppedEvents — aggregates below still reflect every message. */
  events: TraceEvent[];
  totalEvents: number;
  droppedEvents: number;
  captureErrorCount: number;
  firstEventElapsedMs?: number;
  lastEventElapsedMs?: number;
  /** system/init arrived — SDK handshake completed. NOT provider-ready. */
  sawInit: boolean;
  initElapsedMs?: number;
  /** command_lifecycle reached "started" (runtime acknowledged the command). */
  sawCommandStarted: boolean;
  commandStartedElapsedMs?: number;
  lastCommandLifecycleState?: string;
  /** A model_queue_status with status="ready" arrived — queued vs ready split. */
  sawQueueReady: boolean;
  queueReadyElapsedMs?: number;
  lastQueueStatus?: LastQueueStatus;
  /** Any assistant/stream_event/result arrived — real model output started. */
  sawModelEvent: boolean;
  firstModelEventElapsedMs?: number;
  lastModelEventElapsedMs?: number;
  /** SDK/CLI-internal retry evidence (bridge itself never retries). */
  apiRetryCount: number;
  maxApiRetryAttempt?: number;
  controlRequestRetryCount: number;
  counts: {
    assistant: number;
    streamEvent: number;
    result: number;
    system: number;
    commandLifecycle: number;
    other: number;
  };
}

export interface SdkObserver {
  /** Feed one raw SDK message. Never throws; internal failures bump
   *  captureErrorCount so a bad frame cannot change provider execution. */
  observe(message: unknown): void;
  snapshot(): SdkObservation;
}

const loose = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Classify one raw SDK message into a bounded trace event (no throw). */
export function describeSdkMessage(raw: unknown, t: number): TraceEvent {
  const m = loose(raw);
  const type = obsToken(m.type);
  const ev: TraceEvent = { t, kind: "other", wire_type: type };
  if (type === "system") {
    const subtype = obsToken(m.subtype);
    ev.subtype = subtype;
    ev.kind =
      subtype === "init" ? "init" :
      subtype === "model_queue_status" ? "queue_status" :
      subtype === "api_retry" ? "api_retry" :
      subtype === "control_request_progress" ? "control_request_progress" : "system";
    if (ev.kind === "init") {
      ev.model = obsToken(m.model);
      ev.qodercli_version = obsToken(m.qodercli_version);
      ev.protocol_version = obsToken(m.protocol_version);
      ev.api_key_source = obsToken(m.apiKeySource);
      ev.tool_count = Array.isArray(m.tools) ? m.tools.length : undefined;
    } else if (ev.kind === "queue_status") {
      ev.status = obsToken(m.status);
      ev.service_available = obsBool(m.service_available);
      ev.queue_wait_elapsed_ms = obsNumber(m.queue_wait_elapsed_ms);
      ev.wait_time_ms = obsNumber(m.wait_time_ms);
      ev.queue_max_wait_ms = obsNumber(m.queue_max_wait_ms);
      ev.queue_count = obsNumber(m.queue_count);
      ev.queue_type = obsToken(m.queue_type);
      ev.request_id = obsToken(m.request_id);
      ev.request_set_id = obsToken(m.request_set_id);
      ev.model_key = obsToken(m.model_key);
    } else if (ev.kind === "api_retry") {
      ev.attempt = obsNumber(m.attempt);
      ev.max_retries = obsNumber(m.max_retries);
      ev.retry_delay_ms = obsNumber(m.retry_delay_ms);
      ev.error_status = obsNullableNumber(m.error_status);
      // m.error is free-form SDKAssistantMessageError — intentionally dropped.
    } else if (ev.kind === "control_request_progress") {
      ev.request_id = obsToken(m.request_id);
      ev.status = obsToken(m.status);
      ev.attempt = obsNumber(m.attempt);
      ev.max_retries = obsNumber(m.max_retries);
      ev.retry_delay_ms = obsNumber(m.retry_delay_ms);
      ev.error_status = obsNullableNumber(m.error_status);
    }
    return ev;
  }
  if (type === "command_lifecycle") {
    ev.kind = "command_lifecycle";
    ev.state = obsToken(m.state);
    return ev;
  }
  if (type === "assistant") {
    ev.kind = "assistant";
    const msg = loose(m.message);
    ev.message_id = obsToken(msg.id);
    ev.model = obsToken(msg.model);
    ev.stop_reason = obsToken(msg.stop_reason);
    ev.is_api_error_message = obsBool(m.isApiErrorMessage);
    ev.aborted = obsBool(m.aborted);
    let text = 0, tool = 0, thinking = 0, other = 0;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      const bt = loose(block).type;
      if (bt === "text") text++;
      else if (bt === "tool_use") tool++;
      else if (bt === "thinking") thinking++;
      else other++;
    }
    ev.text_blocks = text;
    ev.tool_use_blocks = tool;
    ev.thinking_blocks = thinking;
    ev.other_blocks = other;
    return ev;
  }
  if (type === "stream_event") {
    ev.kind = "stream_event";
    ev.event_type = obsToken(loose(m.event).type);
    return ev;
  }
  if (type === "result") {
    ev.kind = "result";
    ev.subtype = obsToken(m.subtype);
    ev.is_error = obsBool(m.is_error);
    ev.stop_reason = obsToken(m.stop_reason);
    ev.duration_ms = obsNumber(m.duration_ms);
    ev.duration_api_ms = obsNumber(m.duration_api_ms);
    ev.num_turns = obsNumber(m.num_turns);
    ev.error_code = obsCode(m.error_code);
    ev.terminal_reason = obsToken(m.terminal_reason);
    // m.result / m.errors are free-form — intentionally dropped.
    return ev;
  }
  return ev;
}

/** Create a per-query observer. `now` must be a monotonic ms clock whose zero
 *  is the wrapped query() call; the harness passes performance.now(). */
export function createSdkObserver(opts: { now: () => number; maxEvents?: number }): SdkObserver {
  const requestedMax = opts.maxEvents ?? DEFAULT_MAX_TRACE_EVENTS;
  const maxEvents = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(DEFAULT_MAX_TRACE_EVENTS, Math.floor(requestedMax)))
    : DEFAULT_MAX_TRACE_EVENTS;
  const events: TraceEvent[] = [];
  const snapshotState: SdkObservation = {
    schema: SDK_OBSERVATION_SCHEMA,
    clock: "monotonic_ms_since_query_create",
    note: SDK_OBSERVATION_NOTE,
    events,
    totalEvents: 0,
    droppedEvents: 0,
    captureErrorCount: 0,
    sawInit: false,
    sawCommandStarted: false,
    sawQueueReady: false,
    sawModelEvent: false,
    apiRetryCount: 0,
    controlRequestRetryCount: 0,
    counts: { assistant: 0, streamEvent: 0, result: 0, system: 0, commandLifecycle: 0, other: 0 },
  };
  const markModel = (t: number) => {
    if (!snapshotState.sawModelEvent) {
      snapshotState.sawModelEvent = true;
      snapshotState.firstModelEventElapsedMs = t;
    }
    snapshotState.lastModelEventElapsedMs = t;
  };
  const ingest = (raw: unknown) => {
    const rawT = opts.now();
    const t = Number.isFinite(rawT) && rawT > 0 ? Math.round(rawT) : 0;
    const ev = describeSdkMessage(raw, t);
    snapshotState.totalEvents++;
    if (snapshotState.firstEventElapsedMs === undefined) snapshotState.firstEventElapsedMs = t;
    snapshotState.lastEventElapsedMs = t;
    switch (ev.kind) {
      case "init":
        snapshotState.counts.system++;
        if (!snapshotState.sawInit) { snapshotState.sawInit = true; snapshotState.initElapsedMs = t; }
        break;
      case "queue_status": {
        snapshotState.counts.system++;
        snapshotState.lastQueueStatus = {
          status: ev.status,
          service_available: ev.service_available,
          queue_wait_elapsed_ms: ev.queue_wait_elapsed_ms,
          queue_max_wait_ms: ev.queue_max_wait_ms,
          queue_count: ev.queue_count,
        };
        if (ev.status === "ready" && !snapshotState.sawQueueReady) {
          snapshotState.sawQueueReady = true;
          snapshotState.queueReadyElapsedMs = t;
        }
        break;
      }
      case "api_retry":
        snapshotState.counts.system++;
        snapshotState.apiRetryCount++;
        if (ev.attempt !== undefined) {
          snapshotState.maxApiRetryAttempt = Math.max(snapshotState.maxApiRetryAttempt ?? 0, ev.attempt);
        }
        break;
      case "control_request_progress":
        snapshotState.counts.system++;
        if (ev.status === "api_retry") snapshotState.controlRequestRetryCount++;
        break;
      case "system":
        snapshotState.counts.system++;
        break;
      case "command_lifecycle":
        snapshotState.counts.commandLifecycle++;
        if (ev.state !== undefined) snapshotState.lastCommandLifecycleState = ev.state;
        if (ev.state === "started" && !snapshotState.sawCommandStarted) {
          snapshotState.sawCommandStarted = true;
          snapshotState.commandStartedElapsedMs = t;
        }
        break;
      case "assistant":
        snapshotState.counts.assistant++;
        markModel(t);
        break;
      case "stream_event":
        snapshotState.counts.streamEvent++;
        markModel(t);
        break;
      case "result":
        snapshotState.counts.result++;
        markModel(t);
        break;
      default:
        snapshotState.counts.other++;
    }
    if (events.length < maxEvents) events.push(ev);
    else snapshotState.droppedEvents++;
  };
  return {
    observe(raw) {
      try {
        ingest(raw);
      } catch {
        snapshotState.captureErrorCount++;
      }
    },
    snapshot() {
      return {
        ...snapshotState,
        events: events.map(event => ({ ...event })),
        counts: { ...snapshotState.counts },
        ...(snapshotState.lastQueueStatus ? { lastQueueStatus: { ...snapshotState.lastQueueStatus } } : {}),
      };
    },
  };
}
