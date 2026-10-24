import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_TOTAL_DEADLINE_MS } from "../extensions/index.js";

const root = resolve(import.meta.dirname, "..");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-normalization.ts", ...args], {
    cwd, encoding: "utf8", timeout: 30_000,
  });
}

test("normalization CLI dry-run records the production deadline and real harness hashes", async () => {
  const output = runCli(root, ["--rounds", "1"]);
  assert.equal(output.status, 0, output.stderr);
  const plan = JSON.parse(output.stdout);
  assert.equal(DEFAULT_TOTAL_DEADLINE_MS, 900_000);
  assert.equal(plan.totalDeadlineMs, DEFAULT_TOTAL_DEADLINE_MS);
  assert.equal(plan.mode, "plan-only (no --live, no SDK started)");
  assert.equal(plan.counts.planned, 4);
  assert.equal(plan.harnessHashes.cli, digest(await readFile(join(root, "scripts/verify-normalization.ts"), "utf8")));
  assert.equal(plan.harnessHashes.gate, digest(await readFile(join(root, "scripts/live-verification.ts"), "utf8")));
});

test("--case basic --rounds 1 plans exactly one attempt without starting the SDK", () => {
  const output = runCli(root, ["--case", "basic", "--rounds", "1"]);
  assert.equal(output.status, 0, output.stderr);
  const plan = JSON.parse(output.stdout);
  assert.equal(plan.counts.planned, 1);
  assert.deepEqual(plan.selectedCases, ["basic"]);
  assert.deepEqual(plan.plannedAttempts.map((p: { case: string }) => p.case), ["basic"]);
  assert.equal(plan.mode, "plan-only (no --live, no SDK started)");
});

test("default (no --case) still plans all 4 cases x rounds", () => {
  const output = runCli(root, ["--rounds", "2"]);
  assert.equal(output.status, 0, output.stderr);
  const plan = JSON.parse(output.stdout);
  assert.equal(plan.counts.planned, 8);
  assert.deepEqual(plan.selectedCases, ["basic", "sequential", "batch", "error-recovery"]);
});

for (const bad of [["--case", "all"], ["--case", "BASIC"], ["--case", ""], ["--case"]] ) {
  test(`invalid --case ${JSON.stringify(bad)} is rejected before any SDK start`, () => {
    const output = runCli(root, bad);
    assert.equal(output.status, 1);
    assert.match(output.stderr, /--case must be one of/);
    assert.equal(output.stdout, "", "rejected before any plan/SDK output");
  });
}

test("--help documents --case and stays consistent with planned counts", () => {
  const output = runCli(root, ["--help"]);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /--case/);
  assert.match(output.stdout, /basic\|sequential\|batch\|error-recovery/);
  assert.match(output.stdout, /selected cases x rounds/);
});

// Private copies only. Replace the stream in each copy with an explicit fixture
// assistant: no streamQoder/query invocation, no model/network, no live-source edits.
// The real CLI pre-execution drift guard then handles this synthetic request.
for (const changed of ["cli", "gate"] as const) {
  test(`normalization CLI blocks ${changed} drift before executing a fixture tool call`, async () => {
    const base = join(root, "test-artifacts");
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(join(base, "offline-cli-provenance-"));
    await mkdir(join(fixture, "extensions"));
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "test-artifacts"));
    for (const file of ["extensions/index.ts", "scripts/live-verification.ts", "package.json"]) {
      await writeFile(join(fixture, file), await readFile(join(root, file), "utf8"));
    }
    const original = await readFile(join(root, "scripts/verify-normalization.ts"), "utf8");
    const target = `          const stream = streamQoder(MODEL, context, { totalDeadlineMs, maxTokens: 2048, reasoning: "low" });
          for await (const _event of stream) { /* drain */ }
          return stream.result();`;
    assert.equal(original.split(target).length - 1, 1, "mock replacement must be unique");
    const mock = `          await writeFile(harnessPaths.${changed}, "\\n// offline test drift\\n", { flag: "a" });
          return {
            role: "assistant", api: "qoder-agent-sdk" as Api, provider: "fixture", model: "offline-fixture",
            timestamp: Date.now(), stopReason: "toolUse",
            content: [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: spec.packageJsonPath } }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };`;
    await writeFile(join(fixture, "scripts/verify-normalization.ts"), original.replace(target, mock));
    const initialHashes = {
      cli: digest(await readFile(join(fixture, "scripts/verify-normalization.ts"), "utf8")),
      gate: digest(await readFile(join(fixture, "scripts/live-verification.ts"), "utf8")),
    };
    const output = runCli(fixture, ["--live", "--rounds", "1"]);
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stdout, /SAFETY_VIOLATION/);
    const artifacts = join(fixture, "test-artifacts/normalization-campaign");
    const names = await readdir(artifacts);
    const summary = JSON.parse(await readFile(join(artifacts, names.find(n => n.startsWith("summary-"))!), "utf8"));
    const attempts = (await readFile(join(artifacts, names.find(n => n.startsWith("attempts-"))!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(summary.executed, 1);
    assert.equal(summary.planned, 4);
    assert.equal(summary.stoppedEarly, true);
    assert.equal(summary.allPass, false);
    assert.equal(summary.totalDeadlineMs, DEFAULT_TOTAL_DEADLINE_MS);
    assert.deepEqual(summary.harnessHashes, initialHashes);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].verdict.failure, "SAFETY_VIOLATION");
    assert.equal(attempts[0].results.length, 0, "no fixture file tool must execute");
    assert.equal(attempts[0].totalDeadlineMs, DEFAULT_TOTAL_DEADLINE_MS);
    assert.deepEqual(attempts[0].harnessHashes, initialHashes);
    assert.equal(attempts[0].turns[0].providerTrace, null, "no SDK query was started");
  });
}

test("timeout records queue observations even if SDK next and close never settle", async () => {
  const base = join(root, "test-artifacts");
  await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(join(base, "offline-cli-queue-timeout-"));
  await mkdir(join(fixture, "extensions"));
  await mkdir(join(fixture, "scripts"));
  await mkdir(join(fixture, "test-artifacts"));
  for (const file of ["extensions/index.ts", "scripts/live-verification.ts", "package.json"]) {
    await writeFile(join(fixture, file), await readFile(join(root, file), "utf8"));
  }
  const original = await readFile(join(root, "scripts/verify-normalization.ts"), "utf8");
  const target = "        const q = query(params);";
  assert.equal(original.split(target).length - 1, 1);
  const fakeQuery = `        const q = {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "fixture-session" };
            yield { type: "system", subtype: "model_queue_status", status: "queued", service_available: false, request_id: "fixture-request", session_id: "fixture-session" };
            await new Promise(() => {});
          },
          close: () => new Promise<void>(() => {}),
        } as unknown as ReturnType<typeof query>;`;
  const options = "{ totalDeadlineMs, maxTokens: 2048, reasoning: \"low\" }";
  assert.equal(original.split(options).length - 1, 1);
  await writeFile(join(fixture, "scripts/verify-normalization.ts"), original.replace(target, fakeQuery).replace(options, '{ totalDeadlineMs: 80, providerMessageTimeoutMs: 50, providerQueueTimeoutMs: 50, maxTokens: 2048, reasoning: "low" }'));
  const output = runCli(fixture, ["--live", "--case", "basic", "--rounds", "1"]);
  assert.equal(output.status, 1, output.stderr);
  const artifacts = join(fixture, "test-artifacts/normalization-campaign");
  const names = await readdir(artifacts);
  const attempt = JSON.parse((await readFile(join(artifacts, names.find(n => n.startsWith("attempts-"))!), "utf8")).trim());
  assert.equal(attempt.verdict.failure, "SERVICE_FAILURE");
  assert.equal(attempt.results.length, 0);
  const observed = attempt.turns[0].providerTrace.sdkObservation;
  assert.equal(observed.sawInit, true);
  assert.equal(observed.sawModelEvent, false);
  assert.equal(observed.lastQueueStatus.status, "queued");
  assert.equal(observed.lastQueueStatus.service_available, false);
  assert.equal(observed.events[1].request_id, "fixture-request");
});
