import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import qoderBridgeExtension, { bridgeSystemPrompt, cliInstallCommand, cliSetupInstructions, completeCliLogin, loginMethods, offerCliInstall, parseToolCalls, qoderCliCommand, serializeContext } from "../extensions/index.js";
import { normalizeContext, type Context, type Provider, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("serializeContext maps user / assistant / tool_result messages", () => {
  const context: Context = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file body" }],
      },
    ],
  } as unknown as Context;

  const history = JSON.parse(serializeContext(normalizeContext(context)));
  assert.equal(history.length, 4);
  assert.equal(history[0].role, "system");
  assert.equal(history[1].role, "user");
  assert.equal(history[1].content, "hello");
  assert.equal(history[2].role, "assistant");
  assert.deepEqual(history[2].content[2], { type: "tool_call", id: "t1", name: "read", arguments: { path: "a" } });
  assert.equal(history[3].role, "tool_result");
  assert.equal(history[3].toolCallId, "t1");
});

test("bridgeSystemPrompt reads Pi's normalized transcript and current tool set", () => {
  const tool = { name: "read", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
  const context = normalizeContext({ systemPrompt: "base", tools: [tool], messages: [
    { role: "system", content: "updated", toolsRemoved: [{ name: "read" }], toolsAdded: [{ ...tool, name: "write" }], timestamp: 1 },
  ] });
  const prompt = bridgeSystemPrompt(context);
  assert.match(prompt, /base/);
  assert.match(prompt, /updated/);
  assert.match(prompt, /"name":"write"/);
  assert.doesNotMatch(prompt, /"name":"read"/);
});

test("Reuse login is hidden without an available Qoder CLI session", () => {
  assert.deepEqual(loginMethods(false).map((method) => method.id), ["pat"]);
  assert.deepEqual(loginMethods(true).map((method) => method.id), ["local", "pat"]);
});

test("CLI discovery prefers an actual bundled executable over a PATH shim", () => {
  const bundled = join(homedir(), ".qoder", "bin", "qodercli", process.platform === "win32" ? "qodercli.exe" : "qodercli");
  if (existsSync(bundled)) assert.equal(qoderCliCommand(), bundled);
});

test("CLI setup gives platform-specific guidance without executing an installer", () => {
  const windows = cliSetupInstructions("win32", false, false);
  assert.match(windows, /docs\.qoder\.com\/ja\/cli\/installation/);
  assert.match(windows, /irm https:\/\/qoder\.com\/install\.ps1 \| iex/);
  assert.match(windows, /No installer is run/);
  assert.match(cliSetupInstructions("linux", false, false), /curl -fsSL https:\/\/qoder\.com\/install \| bash/);
  assert.match(cliSetupInstructions("win32", true, false), /Run the detected CLI with login/);
  assert.match(cliSetupInstructions("win32", true, true), /Reuse Qoder CLI login/);
});

test("CLI install commands match supported OS and CPU combinations", () => {
  assert.equal(cliInstallCommand("win32", "x64"), "irm https://qoder.com/install.ps1 | iex");
  assert.equal(cliInstallCommand("darwin", "arm64"), "curl -fsSL https://qoder.com/install | bash");
  assert.equal(cliInstallCommand("linux", "x64"), "curl -fsSL https://qoder.com/install | bash");
  assert.equal(cliInstallCommand("linux", "arm64"), "curl -fsSL https://qoder.com/install | bash");
  assert.equal(cliInstallCommand("win32", "arm64"), undefined);
  assert.equal(cliInstallCommand("linux", "ia32"), undefined);
  assert.equal(cliInstallCommand("freebsd", "x64"), undefined);
});

test("CLI installer defaults to No and only launches after an explicit Yes", async () => {
  const launches: [NodeJS.Platform, string][] = [];
  const launch = async (platform: NodeJS.Platform, command: string) => { launches.push([platform, command]); };
  const select = async (_title: string, options: string[]) => {
    assert.match(options[0], /^No/);
    assert.match(options[1], /^Yes/);
    return options[0];
  };
  assert.equal(await offerCliInstall("win32", select, launch, "x64"), false);
  assert.equal(await offerCliInstall("linux", async () => undefined, launch, "x64"), false);
  assert.equal(await offerCliInstall("win32", async () => { throw new Error("UI should not open"); }, launch, "arm64"), false);
  assert.deepEqual(launches, []);
  assert.equal(await offerCliInstall("win32", async (_title, options) => options[1], launch, "x64"), true);
  assert.equal(await offerCliInstall("darwin", async (_title, options) => options[1], launch, "arm64"), true);
  assert.equal(await offerCliInstall("linux", async (_title, options) => options[1], launch, "x64"), true);
  assert.deepEqual(launches, [
    ["win32", "irm https://qoder.com/install.ps1 | iex"],
    ["darwin", "curl -fsSL https://qoder.com/install | bash"],
    ["linux", "curl -fsSL https://qoder.com/install | bash"],
  ]);
});

test("CLI browser login launches the CLI and waits for its own saved session", async () => {
  let saved = false;
  let launches = 0;
  const notifications: unknown[] = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    notify: (event) => { notifications.push(event); },
    prompt: async (prompt) => {
      assert.equal(prompt.type, "select");
      return "browser";
    },
  };
  await completeCliLogin("qoder", interaction, () => saved, async (command) => {
    assert.equal(command, "qoder");
    launches++;
    saved = true;
  });
  assert.equal(launches, 1);
  assert.equal((notifications[0] as { type: string }).type, "progress");
  await completeCliLogin("qoder", interaction, () => saved, async () => { launches++; });
  assert.equal(launches, 1);
  await assert.rejects(
    completeCliLogin("qoder", interaction, () => false, async () => {}),
    /login not found yet/,
  );
});

test("PAT login opens the official creation page and stores the entered token", async () => {
  let provider: Provider | undefined;
  qoderBridgeExtension({ registerProvider: (entry: Provider) => { provider = entry; }, registerCommand: () => {} } as unknown as ExtensionAPI);
  assert.ok(provider);
  const login = provider.auth?.apiKey?.login;
  assert.ok(login);
  const notifications: unknown[] = [];
  const prompts: unknown[] = [];
  const credential = await login({
    signal: new AbortController().signal,
    notify: (event) => { notifications.push(event); },
    prompt: async (prompt) => { prompts.push(prompt); return prompt.type === "select" ? "pat" : "test-token"; },
  });
  assert.deepEqual(notifications, [{
    type: "auth_url",
    url: "https://qoder.com/account/integrations",
    instructions: "Create a Personal Access Token in Account → Integrations, then paste it into Pi. The token is shown only once.",
  }]);
  assert.equal((prompts[1] as { type: string }).type, "secret");
  assert.deepEqual(credential, { type: "api_key", key: "test-token" });
});

test("parseToolCalls extracts a single envelope", () => {
  const text = `<pi_tool_call>{"name":"read","arguments":{"path":"x.ts"}}</pi_tool_call>`;
  const calls = parseToolCalls(text);
  assert.ok(calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.deepEqual(calls[0].arguments, { path: "x.ts" });
});

test("parseToolCalls extracts multiple envelopes", () => {
  const text = `<pi_tool_call>{"name":"a","arguments":{}}</pi_tool_call>\n<pi_tool_call>{"name":"b","arguments":{"x":1}}</pi_tool_call>`;
  const calls = parseToolCalls(text);
  assert.ok(calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, "b");
});

test("parseToolCalls returns null when text surrounds envelopes", () => {
  const text = `some prose <pi_tool_call>{"name":"a","arguments":{}}</pi_tool_call>`;
  assert.equal(parseToolCalls(text), null);
});

test("parseToolCalls returns null for malformed JSON", () => {
  assert.equal(parseToolCalls(`<pi_tool_call>{bad}</pi_tool_call>`), null);
});

test("parseToolCalls returns null for invalid envelope shape", () => {
  assert.equal(parseToolCalls(`<pi_tool_call>{"name":"a"}</pi_tool_call>`), null);
  assert.equal(parseToolCalls(`<pi_tool_call>{"arguments":{}}</pi_tool_call>`), null);
  assert.equal(parseToolCalls(`<pi_tool_call>{"name":"read","arguments":[]}</pi_tool_call>`), null);
});

test("parseToolCalls returns null without envelopes", () => {
  assert.equal(parseToolCalls("plain answer"), null);
});
