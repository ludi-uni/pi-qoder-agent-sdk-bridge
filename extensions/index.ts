import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  accessToken,
  qodercliAuth,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@qoder-ai/qoder-agent-sdk";
import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  validateToolCall,
  type Api,
  type ProviderAuthInteraction,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "qoder-bridge";
const API_ID = "qoder-agent-sdk" as Api;
const LOCAL_AUTH = "qoder-local-session";
const AUTH_FILE = "~/.qoder/.auth/user";
const PAT_URL = "https://qoder.com/account/integrations";
const CLI_INSTALL_URL = "https://docs.qoder.com/ja/cli/installation";
const INSTALL_NO = "No — show instructions only";
const INSTALL_YES = "Yes — run the official Qoder installer in a new terminal";

export function qoderCliCommand(): string | undefined {
  // Prefer the real executable: `where qoder` can find an npm .cmd shim that
  // Node's spawn() cannot execute without a shell.
  const bundled = join(homedir(), ".qoder", "bin", "qodercli", process.platform === "win32" ? "qodercli.exe" : "qodercli");
  if (existsSync(bundled)) return bundled;
  for (const name of process.platform === "win32"
    ? ["qoder.exe", "qodercli.exe", "qoder.cmd", "qodercli.cmd"]
    : ["qoder", "qodercli"]) {
    const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (found.status === 0) {
      const path = found.stdout.split(/\r?\n/).find((line) => line.trim());
      if (path && existsSync(path)) return path;
    }
  }
  return undefined;
}

function cliLoginCommand(command: string): string {
  return process.platform === "win32" ? `& "${command.replace(/"/g, '`"')}" login` : `"${command}" login`;
}

function hasQoderLogin(): boolean {
  return existsSync(join(process.env.QODER_CONFIG_DIR || join(homedir(), ".qoder"), ".auth", "user"));
}

function canReuseQoderLogin(): boolean {
  return !!qoderCliCommand() && hasQoderLogin();
}

async function startQoderBrowserLogin(command: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Qoder CLI login cancelled");
  const isCmd = process.platform === "win32" && /\.cmd$/i.test(command);
  if (isCmd && /["&|<>\r\n]/.test(command)) throw new Error("Unsupported Qoder CLI path for Windows cmd");
  const child = spawn(isCmd ? process.env.ComSpec || "cmd.exe" : command,
    isCmd ? ["/d", "/s", "/c", `"${command}" login`] : ["login"], {
      detached: process.platform === "win32",
      stdio: "ignore",
      windowsHide: false,
    });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve();
    };
    const check = () => { if (hasQoderLogin()) finish(); };
    const onAbort = () => finish(new Error("Qoder CLI login cancelled"));
    const interval = setInterval(check, 1_000);
    const timeout = setTimeout(() => finish(new Error("Qoder CLI browser login timed out. Run the CLI login command in a separate terminal.")), 180_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      check();
      if (!settled) finish(new Error(`Qoder CLI login exited (${code ?? "unknown"}). Run the CLI login command in a separate terminal.`));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

export async function completeCliLogin(
  command: string,
  interaction: ProviderAuthInteraction,
  checkLogin: () => boolean = hasQoderLogin,
  launch: (command: string, signal: AbortSignal) => Promise<void> = startQoderBrowserLogin,
): Promise<void> {
  if (checkLogin()) return;
  const choice = await interaction.prompt({
    type: "select",
    message: "Sign in with Qoder CLI",
    options: [
      { id: "browser", label: "Open browser via Qoder CLI", description: "CLI saves its own login automatically" },
      { id: "manual", label: "Run login in another terminal", description: cliLoginCommand(command) },
    ],
  });
  if (choice === "browser") {
    interaction.notify({ type: "progress", message: "Waiting for Qoder CLI browser sign-in (up to 3 minutes)..." });
    await launch(command, interaction.signal);
  } else if (choice === "manual") {
    await interaction.prompt({
      type: "text",
      message: `Run ${cliLoginCommand(command)} in another terminal, finish browser sign-in, then press Enter here`,
    });
  } else throw new Error("Unknown Qoder CLI login method");
  if (!checkLogin()) throw new Error("Qoder CLI login not found yet. Finish browser sign-in and retry /login.");
}

export function cliInstallCommand(platform: NodeJS.Platform, arch: string): string | undefined {
  if (arch !== "x64" && arch !== "arm64") return undefined;
  if (platform === "win32") return arch === "arm64" ? undefined : "irm https://qoder.com/install.ps1 | iex";
  if (platform === "darwin" || platform === "linux") return "curl -fsSL https://qoder.com/install | bash";
  return undefined;
}

async function launchCliInstaller(platform: NodeJS.Platform, command: string): Promise<void> {
  let executable: string;
  let args: string[];
  if (platform === "win32") {
    executable = "powershell.exe";
    args = ["-NoExit", "-NoProfile", "-Command", command];
  } else if (platform === "darwin") {
    executable = "osascript";
    args = ["-e", `tell application "Terminal" to do script "${command}"`, "-e", "tell application \"Terminal\" to activate"];
  } else if (platform === "linux") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error("No graphical desktop detected. Run the installation command in your own terminal.");
    }
    const terminal = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"].find((name) =>
      spawnSync("which", [name], { stdio: "ignore" }).status === 0
    );
    if (!terminal) throw new Error("No supported terminal emulator found. Run the installation command in your own terminal.");
    executable = terminal;
    const script = `${command}; printf '\\nInstaller finished. Press Enter to close.\\n'; read -r _`;
    args = terminal === "gnome-terminal" ? ["--", "sh", "-c", script] : ["-e", "sh", "-c", script];
  } else throw new Error(`Unsupported platform: ${platform}`);
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: false });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function offerCliInstall(
  platform: NodeJS.Platform,
  select: (title: string, options: string[]) => Promise<string | undefined>,
  launch: (platform: NodeJS.Platform, command: string) => Promise<void>,
  arch: string = process.arch,
): Promise<boolean> {
  const command = cliInstallCommand(platform, arch);
  if (!command) return false;
  const choice = await select(`Install Qoder CLI? Official command: ${command}`, [INSTALL_NO, INSTALL_YES]);
  if (choice !== INSTALL_YES) return false;
  await launch(platform, command);
  return true;
}

export function cliSetupInstructions(platform: NodeJS.Platform, cliInstalled: boolean, loggedIn: boolean): string {
  if (cliInstalled && loggedIn) return "Qoder CLI login is ready. Use /login → Qoder Bridge → Reuse Qoder CLI login.";
  if (cliInstalled) return "Qoder CLI is installed but not signed in. Run the detected CLI with login in a terminal, complete browser sign-in, then select Reuse Qoder CLI login in Pi.";
  const command = cliInstallCommand(platform, process.arch);
  if (!command) return `Qoder CLI installation is not supported on ${platform}/${process.arch}. Official guide: ${CLI_INSTALL_URL}`;
  return `Qoder CLI is not installed. Official guide: ${CLI_INSTALL_URL}\n` +
    `Run in your own terminal after reviewing the official installer: ${command}\n` +
    "Then open a fresh terminal, run qoder --version, start qoder, choose /login → Login with Qoder Platform (Browser), and restart Pi to refresh PATH. No installer is run by this command.";
}

export function loginMethods(canReuse: boolean) {
  return [
    ...(canReuse ? [{ id: "local", label: "Reuse Qoder CLI login", description: "Sign in through your CLI if needed" }] : []),
    { id: "pat", label: "Personal Access Token", description: "Create at qoder.com/account/integrations" },
  ];
}

interface QoderModelEntry {
  id: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  efforts?: Record<string, string>;
}

// Model list mirrors the ids reported by the local qodercli installation
// (~/.qoder models catalog). maxTokens is capped at 65_536 because the
// worker/runtime rejects higher values for SDK sessions.
const QODER_MODELS: QoderModelEntry[] = [
  { id: "Qwen3.8-Max", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", xhigh: "xhigh" } },
  { id: "Qwen3.8-Flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", xhigh: "xhigh" } },
  { id: "Qwen3.7-Max", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "Qwen3.7-Plus", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "Kimi-K3", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", high: "high", max: "max" } },
  { id: "Kimi-K2.8-Preview", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", high: "high", max: "max" } },
  { id: "GLM-5.3", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", high: "high", max: "max" } },
  { id: "GLM-5.3-Flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { high: "high", max: "max" } },
  { id: "DeepSeek-V4-Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { high: "high", max: "max" } },
  { id: "DeepSeek-Flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", high: "high", max: "max" } },
  { id: "MiniMax-M3", reasoning: false, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "Auto", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "Ultimate", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { id: "Performance", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { id: "Efficient", reasoning: false, contextWindow: 200_000, maxTokens: 65_536 },
  { id: "Sonus", reasoning: true, contextWindow: 200_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { id: "Cantus", reasoning: true, contextWindow: 200_000, maxTokens: 65_536, efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
];

const models: Model<Api>[] = QODER_MODELS.map((entry) => ({
  id: entry.id,
  name: `${entry.id} (Qoder bridge)`,
  api: API_ID,
  provider: PROVIDER_ID,
  baseUrl: "qoder-agent-sdk://local",
  reasoning: entry.reasoning,
  thinkingLevelMap: entry.efforts,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: entry.contextWindow,
  maxTokens: entry.maxTokens,
}));

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "�")
    : "";
}

function compactSchema(tool: Tool): Record<string, unknown> {
  // Preserve the full TypeBox JSON schema so the model sees every constraint
  // (additionalProperties, nested types, enums, formats). Previously only
  // type/properties/required survived, dropping nested schema information.
  const parameters = (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    parameters: { type: "object", properties: {}, ...parameters },
  };
}

export function serializeContext(context: TranscriptContext): string {
  const history = context.messages.map((message) => {
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.type === "text" ? part.text : `[image:${part.mimeType}]`).join("\n");
      return { role: "user", content };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "thinking") return { type: "thinking", text: part.thinking };
          return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
        }),
      };
    }
    if (message.role === "system") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n");
      return { role: "system", content };
    }
    return {
      role: "tool_result",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      content: message.content.map((part) => part.type === "text" ? part.text : `[image:${part.mimeType}]`).join("\n"),
    };
  });
  return JSON.stringify(history);
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

export class ProviderProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderProtocolError";
    this.code = code;
  }
}

/** Common normal form every accepted parser produces. Downstream emission
 *  consumes this type only — it never branches on which parser produced it. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type TextResponse = { kind: "text"; text: string };
export type ToolCallResponse = { kind: "tool_calls"; calls: NormalizedToolCall[]; parser: ParserKey };
export type ProtocolErrorResponse = { kind: "protocol_error"; error: ProviderProtocolError };
export type ProviderResponse = TextResponse | ToolCallResponse | ProtocolErrorResponse;

const TOOL_CALL_OPEN = "<pi_tool_call>";
const TOOL_CALL_CLOSE = "</pi_tool_call>";
const ENVELOPE_KEYS = new Set(["name", "arguments", "id"]);

/** Markdown code in a prose answer is an example, not a tool request.
 * A code-only response starting with a JSON-like envelope still dispatches
 * strictly (including malformed envelopes). Masking preserves source offsets. */
function maskCodeLiteralToolMarkers(text: string): string {
  const codeSpans = /(`+)([\s\S]*?)\1(?!`)/g;
  const codeOnly = text.replace(codeSpans, "").trim().length === 0;
  return text.replace(codeSpans, (literal: string, _delimiter: string, code: string) => {
    if (codeOnly && /^(?:[\w+-]+\r?\n)?\s*<pi_tool_call\b(?:\s*>|\s+)?\s*[\[{]/i.test(code.trim())) return literal;
    return " ".repeat(literal.length);
  });
}

/** Find envelope boundaries outside JSON strings; JSON.parse still validates the payload. */
function scanToolCallEnvelopes(text: string): { envelopes: string[]; error?: ProviderProtocolError } {
  const envelopes: string[] = [];
  const markers = /<\/?pi_tool_call\b/gi;
  const incomplete = () => ({ envelopes, error: new ProviderProtocolError("UNCLOSED_ENVELOPE", "pi_tool_call marker found without a complete envelope") });
  const markerText = maskCodeLiteralToolMarkers(text);
  let marker: RegExpExecArray | null;
  while ((marker = markers.exec(markerText))) {
    if (!text.startsWith(TOOL_CALL_OPEN, marker.index)) return incomplete();
    const start = marker.index + TOOL_CALL_OPEN.length;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (text.startsWith(TOOL_CALL_CLOSE, index)) {
        envelopes.push(text.slice(start, index).trim());
        markers.lastIndex = index + TOOL_CALL_CLOSE.length;
        closed = true;
        break;
      }
    }
    if (!closed) return incomplete();
  }
  return envelopes.length ? { envelopes } : incomplete();
}

// --- Up-front input-shape classifier ---
// Every provider payload (assembled text or structured native blocks) is
// classified once into exactly one shape before any parser runs. The Qoder
// marker check has priority over JSON detection so a malformed envelope can
// never leak into the generic/standard path.
export type ProviderPayloadShape = "QODER_TOOL" | "STANDARD_TOOL" | "MALFORMED_TOOL_LIKE" | "PLAIN_TEXT";
export type ParserKey = "qoder_envelope" | "standard_function_envelope" | "native_tool_use";

/** Structured (non-text) provider payload: SDK-native tool_use content blocks. */
export type StructuredProviderPayload = {
  kind: "blocks";
  blocks: readonly unknown[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Keys whose presence is a strong tool-intent signal on a parsed object.
const STRONG_TOOL_KEYS = new Set(["tool_calls", "tool_call", "tool_invocation", "function_call", "call_id", "tool_use_id"]);
const TOOL_ARG_KEYS = ["arguments"];
const TOOL_NAMEISH_KEYS = ["name", "tool", "function"];
const TOOL_TYPE_VALUES = new Set(["tool_call", "tool_calls", "tool_invocation", "function_call", "tool_use", "function"]);

/** Structural tool-intent check for an already-parsed object (bounded, no string re-scan). */
function objectIsToolLike(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value));
  if (typeof value.type === "string" && TOOL_TYPE_VALUES.has(value.type)) return true;
  for (const key of STRONG_TOOL_KEYS) if (keys.has(key)) return true;
  return TOOL_ARG_KEYS.some((key) => keys.has(key)) && TOOL_NAMEISH_KEYS.some((key) => keys.has(key));
}

function jsonContainsToolLike(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((entry) => jsonContainsToolLike(entry, depth + 1));
  if (isPlainObject(value)) return objectIsToolLike(value) || Object.values(value).some((entry) => jsonContainsToolLike(entry, depth + 1));
  return false;
}

// Bounded text-level signal for payloads that are NOT valid JSON: an actual
// tool-intent key pattern must appear inside a JSON-looking shell, so ordinary
// prose and prose-with-JSON-fragments are never classified as tool-like.
const TOOL_LIKE_TEXT_RE = /"(tool_calls|tool_call|tool_invocation|function_call|call_id|tool_use_id)"\s*:|"type"\s*:\s*"(tool_call|tool_calls|tool_invocation|function_call|tool_use|function)"|"function"\s*:\s*\{|(?=[\s\S]*"(name|tool)"\s*:)(?=[\s\S]*"arguments"\s*:)/;

function isMalformedToolLikeText(trimmed: string): boolean {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  return TOOL_LIKE_TEXT_RE.test(trimmed);
}

/**
 * Classify a parsed JSON value once. Exactly one accepted standard shape
 * exists — a single wrapperless {id, type:"function", function:{name,
 * arguments:string}} envelope — everything else that signals tool intent is
 * malformed tool-like, and anything else is ordinary JSON → plain text.
 */
function classifyParsedJson(value: unknown): ProviderPayloadShape {
  if (!isPlainObject(value) && !Array.isArray(value)) return "PLAIN_TEXT";
  if (isPlainObject(value) && value.type === "function" && isPlainObject(value.function)) return "STANDARD_TOOL";
  return jsonContainsToolLike(value) ? "MALFORMED_TOOL_LIKE" : "PLAIN_TEXT";
}

/** Internal classify that also returns the already-parsed JSON value. */
function classifyString(input: string): { shape: ProviderPayloadShape; parsed?: unknown } {
  // Qoder marker recognition has priority over malformed-JSON detection.
  if (/<\/?pi_tool_call\b/i.test(maskCodeLiteralToolMarkers(input))) return { shape: "QODER_TOOL" };
  const trimmed = input.trim();
  if (!trimmed) return { shape: "PLAIN_TEXT" };
  try {
    const parsed = JSON.parse(trimmed);
    return { shape: classifyParsedJson(parsed), parsed };
  } catch {
    return { shape: isMalformedToolLikeText(trimmed) ? "MALFORMED_TOOL_LIKE" : "PLAIN_TEXT" };
  }
}

/** Classify an entire provider payload up front. */
export function classifyProviderPayload(input: string | StructuredProviderPayload): ProviderPayloadShape {
  if (typeof input !== "string") {
    if (!isPlainObject(input) || input.kind !== "blocks" || Object.keys(input).some(key => key !== "kind" && key !== "blocks") ||
      !Array.isArray(input.blocks) || input.blocks.length === 0 || !input.blocks.every(block => isPlainObject(block) && block.type === "tool_use")) return "MALFORMED_TOOL_LIKE";
    return "STANDARD_TOOL";
  }
  return classifyString(input).shape;
}

function parseToolCallEnvelope(raw: string, index: number): ParsedToolCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderProtocolError(
      "MALFORMED_ENVELOPE_JSON",
      `pi_tool_call #${index} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError("INVALID_ENVELOPE", `pi_tool_call #${index} is not an object`);
  }
  const call = parsed as Record<string, unknown>;
  for (const key of Object.keys(call)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new ProviderProtocolError("INVALID_ENVELOPE", `pi_tool_call #${index} has unknown field "${key}"`);
    }
  }
  if (typeof call.name !== "string" || call.name.length === 0) {
    throw new ProviderProtocolError("INVALID_ENVELOPE", `pi_tool_call #${index} has no non-empty string name`);
  }
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
    throw new ProviderProtocolError("INVALID_ENVELOPE", `pi_tool_call #${index} has no object arguments`);
  }
  if (call.id !== undefined && (typeof call.id !== "string" || call.id.length === 0)) {
    throw new ProviderProtocolError("INVALID_ENVELOPE", `pi_tool_call #${index} has a non-string or empty id`);
  }
  return { name: call.name as string, arguments: call.arguments as Record<string, unknown>, id: call.id as string | undefined };
}

/**
 * Strict bridge contract normalizer.
 * - Any pi_tool_call marker (except literal tag mentions in Markdown code)
 *   forces tool-call semantics, even if unclosed:
 *   a missing close tag, malformed JSON, unknown fields,
 *   empty/duplicate ids, unlisted tool names, or schema-invalid arguments are
 *   all ProviderProtocolError — never silently degraded to text.
 *   Text outside complete envelopes is ignored, not emitted or executed.
 * - Exactly one standard text shape is accepted: a single wrapperless
 *   {id, type:"function", function:{name, arguments:JSONstring}} envelope.
 * - Structured input (SDK-native tool_use content blocks) is parsed by the
 *   native parser into the same common NormalizedToolCall form.
 * - Any other tool-like payload (tool_calls/function_call/tool_invocation/
 *   tool_call types, name+arguments objects, malformed JSON with tool
 *   signals) is a protocol error — never retried, repaired, or downgraded
 *   to text. Ordinary text and ordinary JSON stay TextResponse.
 */
/** Optional instrumentation hook: observes parser selection and each raw
 *  parse input (boundary D). Exactly one "parser_selected" event fires per
 *  normalize call; no fallback ever selects a second parser. */
export type NormalizeInstrument = (stage: "parse_input" | "parser_selected", raw: string, index: number) => void;

const STANDARD_ENVELOPE_KEYS = new Set(["id", "type", "function"]);
const STANDARD_FUNCTION_KEYS = new Set(["name", "arguments"]);
const NATIVE_BLOCK_KEYS = new Set(["type", "id", "name", "input"]);

/** Strict parser for the wrapperless OpenAI-style function envelope. */
function parseStandardFunctionEnvelope(parsed: unknown): ParsedToolCall {
  if (!isPlainObject(parsed)) {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call is not an object");
  }
  for (const key of Object.keys(parsed)) {
    if (!STANDARD_ENVELOPE_KEYS.has(key)) {
      throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", `standard tool call has unknown field "${key}"`);
    }
  }
  if (parsed.type !== "function") {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", `standard tool call type must be "function", got ${JSON.stringify(parsed.type)}`);
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call requires a non-empty string id");
  }
  const fn = parsed.function;
  if (!isPlainObject(fn)) {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call function must be an object");
  }
  for (const key of Object.keys(fn)) {
    if (!STANDARD_FUNCTION_KEYS.has(key)) {
      throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", `standard tool call function has unknown field "${key}"`);
    }
  }
  if (typeof fn.name !== "string" || fn.name.length === 0) {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call function requires a non-empty string name");
  }
  if (typeof fn.arguments !== "string") {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call function arguments must be a JSON string");
  }
  let args: unknown;
  try {
    args = JSON.parse(fn.arguments);
  } catch (error) {
    throw new ProviderProtocolError(
      "MALFORMED_ENVELOPE_JSON",
      `standard tool call arguments are invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(args)) {
    throw new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "standard tool call arguments must decode to an object");
  }
  return { id: parsed.id, name: fn.name, arguments: args };
}

/** Strict parser for one SDK-native tool_use content block. */
function parseNativeToolUseBlock(block: unknown, index: number): ParsedToolCall {
  if (!isPlainObject(block) || block.type !== "tool_use") {
    throw new ProviderProtocolError("INVALID_NATIVE_TOOL_USE", `native tool_use block #${index} is not a tool_use object`);
  }
  for (const key of Object.keys(block)) {
    if (!NATIVE_BLOCK_KEYS.has(key)) {
      throw new ProviderProtocolError("INVALID_NATIVE_TOOL_USE", `native tool_use block #${index} has unknown field "${key}"`);
    }
  }
  if (typeof block.id !== "string" || block.id.length === 0) {
    throw new ProviderProtocolError("INVALID_NATIVE_TOOL_USE", `native tool_use block #${index} requires a non-empty string id`);
  }
  if (typeof block.name !== "string" || block.name.length === 0) {
    throw new ProviderProtocolError("INVALID_NATIVE_TOOL_USE", `native tool_use block #${index} requires a non-empty string name`);
  }
  if (!isPlainObject(block.input)) {
    throw new ProviderProtocolError("INVALID_NATIVE_TOOL_USE", `native tool_use block #${index} requires object input`);
  }
  return { id: block.id, name: block.name, arguments: block.input };
}

/** Qoder pi_tool_call marker path. Owns its parser exclusively — malformed
 *  marker output is never retried through the standard/generic parser. */
function normalizeQoderEnvelopeText(
  text: string,
  instrument: NormalizeInstrument | undefined,
): ParsedToolCall[] | ProtocolErrorResponse {
  const fail = (error: ProviderProtocolError): ProtocolErrorResponse => ({ kind: "protocol_error", error });
  const scanned = scanToolCallEnvelopes(text);
  if (scanned.error) return fail(scanned.error);
  try {
    return scanned.envelopes.map((raw, index) => {
      instrument?.("parse_input", raw, index + 1);
      return parseToolCallEnvelope(raw, index + 1);
    });
  } catch (error) {
    if (error instanceof ProviderProtocolError) return fail(error);
    throw error;
  }
}

/** Shared normal-form validation for every parser's calls: id policy,
 *  duplicates, allowed tool names, and strict uncoerced schema checks. */
function validateParsedCalls(
  calls: ParsedToolCall[],
  parser: ParserKey,
  tools: readonly Tool[],
): NormalizedToolCall[] | ProtocolErrorResponse {
  const fail = (error: ProviderProtocolError): ProtocolErrorResponse => ({ kind: "protocol_error", error });
  const seen = new Set<string>();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const normalized: NormalizedToolCall[] = [];
  for (const call of calls) {
    if (call.id !== undefined) {
      if (seen.has(call.id)) return fail(new ProviderProtocolError("DUPLICATE_ID", `duplicate tool call id "${call.id}"`));
      seen.add(call.id);
    }
    const tool = byName.get(call.name);
    if (!tool) {
      return fail(new ProviderProtocolError(
        "UNKNOWN_TOOL",
        `Model requested unlisted tool "${call.name}". Allowed: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
      ));
    }
    try {
      const validated = validateToolCall([tool], { type: "toolCall", id: call.id ?? "_", name: call.name, arguments: call.arguments as JsonObject }) as Record<string, unknown>;
      if (!isDeepStrictEqual(validated, call.arguments)) throw new Error("Argument coercion is not permitted");
    } catch (error) {
      return fail(new ProviderProtocolError(
        "INVALID_ARGUMENTS",
        `arguments for "${call.name}" failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    if (call.id === undefined && parser !== "qoder_envelope") return fail(new ProviderProtocolError("INVALID_STANDARD_ENVELOPE", "Standard tool call id is required"));
    // Normalization edge: Qoder envelopes may omit ids (generated here);
    // standard and native ids are already required non-empty by their parsers.
    normalized.push({ id: call.id ?? `qoder_${crypto.randomUUID()}`, name: call.name, arguments: call.arguments });
  }
  return normalized;
}

export function normalizeProviderResponse(input: string | StructuredProviderPayload, tools: readonly Tool[], instrument?: NormalizeInstrument): ProviderResponse {
  const fail = (error: ProviderProtocolError): ProtocolErrorResponse => ({ kind: "protocol_error", error });

  // Structured payload path: SDK-native tool_use content blocks.
  if (typeof input !== "string") {
    if (classifyProviderPayload(input) !== "STANDARD_TOOL") return fail(new ProviderProtocolError("UNKNOWN_TOOL_LIKE_FORMAT", "Invalid structured tool payload shape"));
    instrument?.("parser_selected", "native_tool_use", 0);
    let calls: ParsedToolCall[];
    try {
      calls = input.blocks.map((block, index) => {
        instrument?.("parse_input", JSON.stringify(block), index + 1);
        return parseNativeToolUseBlock(block, index + 1);
      });
    } catch (error) {
      if (error instanceof ProviderProtocolError) return fail(error);
      throw error;
    }
    const validated = validateParsedCalls(calls, "native_tool_use", tools);
    if (!Array.isArray(validated)) return validated;
    return { kind: "tool_calls", calls: validated, parser: "native_tool_use" };
  }

  const { shape, parsed } = classifyString(input);
  if (shape === "PLAIN_TEXT") {
    instrument?.("parse_input", input, 0);
    return { kind: "text", text: input };
  }
  if (shape === "MALFORMED_TOOL_LIKE") {
    return fail(new ProviderProtocolError("UNKNOWN_TOOL_LIKE_FORMAT", "Unrecognized tool-call payload shape; refusing to repair or treat as text"));
  }
  if (shape === "QODER_TOOL") {
    instrument?.("parser_selected", "qoder_envelope", 0);
    const calls = normalizeQoderEnvelopeText(input, instrument);
    if (!Array.isArray(calls)) return calls;
    const validated = validateParsedCalls(calls, "qoder_envelope", tools);
    if (!Array.isArray(validated)) return validated;
    return { kind: "tool_calls", calls: validated, parser: "qoder_envelope" };
  }
  // STANDARD_TOOL: exactly one wrapperless function envelope.
  instrument?.("parser_selected", "standard_function_envelope", 0);
  let call: ParsedToolCall;
  try {
    instrument?.("parse_input", input, 1);
    call = parseStandardFunctionEnvelope(parsed);
  } catch (error) {
    if (error instanceof ProviderProtocolError) return fail(error);
    throw error;
  }
  const validated = validateParsedCalls([call], "standard_function_envelope", tools);
  if (!Array.isArray(validated)) return validated;
  return { kind: "tool_calls", calls: validated, parser: "standard_function_envelope" };
}

/** Lenient legacy helper kept for callers that predate the strict normalizer. */
export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const parsed = normalizeQoderEnvelopeText(text, undefined);
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Validates continuation structure: the last assistant message's toolCall
 * blocks must be answered by the following toolResult messages in order,
 * names matching, ids unique across the whole history, and no toolResult may
 * reference an unknown or already-consumed call id.
 */
export function validateContinuation(messages: readonly Message[]): ProviderProtocolError | undefined {
  const ids = new Set<string>();
  let pending: ToolCall[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      const expected = pending.shift();
      if (!expected) return new ProviderProtocolError("CONTINUATION_ORPHAN_RESULT", "Unexpected or duplicate tool result");
      if (message.toolCallId !== expected.id) return new ProviderProtocolError("CONTINUATION_ORDER", "toolResult id/order mismatch");
      if (message.toolName !== expected.name) return new ProviderProtocolError("CONTINUATION_RESULTS_MISMATCH", "Tool result name mismatch");
      if (typeof message.isError !== "boolean" || !Array.isArray(message.content)) return new ProviderProtocolError("INVALID_TOOL_RESULT", "Invalid tool result content or error flag");
      continue;
    }
    if (pending.length) return new ProviderProtocolError("CONTINUATION_RESULTS_MISMATCH", "Missing tool results before next message");
    if (message.role === "assistant") {
      pending = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      for (const call of pending) {
        if (!call.id || ids.has(call.id)) return new ProviderProtocolError("DUPLICATE_ID", "Empty or reused tool call id");
        ids.add(call.id);
      }
    }
  }
  if (pending.length) return new ProviderProtocolError("CONTINUATION_RESULTS_MISMATCH", "Missing tool results");
  return undefined;
}

export function isContinuationContext(context: TranscriptContext): boolean {
  return context.messages.length > 0 && context.messages[context.messages.length - 1].role === "toolResult";
}

export function bridgeSystemPrompt(context: TranscriptContext): string {
  const tools = getCurrentTools(context.messages).map(compactSchema);
  return `${getCurrentSystemPrompt(context.messages)}\n\n` +
    `QODER-PI BRIDGE CONTRACT\n` +
    `You are the model backend inside Pi. Qoder runtime tools are disabled. Pi owns all tool execution and approval.\n` +
    `When a tool is needed, output only one or more exact envelopes, with no prose or Markdown:\n` +
    `<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>\n` +
    `Use only listed tools. Arguments must satisfy JSON Schema. After Pi returns tool results, continue from transcript.\n` +
    `When no tool is needed, answer normally and never emit the envelope.\n` +
    `PI_TOOLS=${JSON.stringify(tools)}`;
}

function usageFromResult(result: SDKResultMessage | undefined, output: AssistantMessage): void {
  if (!result) return;
  const usage = result.usage;
  output.usage.input = Number(usage.input_tokens ?? 0);
  output.usage.output = Number(usage.output_tokens ?? 0);
  output.usage.cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  output.usage.cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  output.usage.cost.total = Number(result.total_cost_usd ?? 0);
}

function textFromMessage(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  return message.message.content
    .filter((block) => block.type === "text")
    .map((block) => clean(block.text))
    .join("");
}

export const BRIDGE_STATE = {
  WAITING_PROVIDER: "WAITING_PROVIDER",
  WAITING_TOOL: "WAITING_TOOL",
  WAITING_CONTINUATION: "WAITING_CONTINUATION",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type BridgeState = (typeof BRIDGE_STATE)[keyof typeof BRIDGE_STATE];

type QueryLike = AsyncIterable<SDKMessage> & { close(): Promise<void> };

interface BridgeInternals {
  queryFactory?: (params: Parameters<typeof query>[0]) => QueryLike;
  onState?: (state: BridgeState) => void;
  /** Test hook: receives the same diagnostic events as options.onDiagnostic. */
  onDiagnostic?: (event: QoderBridgeDiagnosticEvent) => void;
}

const internals: BridgeInternals = {};

/** Test seam: swap the SDK query factory / observe state. Not part of the public API. */
export function __setBridgeInternals(patch: BridgeInternals): void {
  internals.queryFactory = patch.queryFactory;
  internals.onState = patch.onState;
  internals.onDiagnostic = patch.onDiagnostic;
}

/** Options accepted on top of SimpleStreamOptions; parent passes via ProviderStreamOptions extras. */
export interface QoderBridgeStreamExtras {
  /** Max silence while awaiting a provider response after Pi tool results. */
  postToolContinuationTimeoutMs?: number;
  /** Max silence awaiting an initial provider response outside a queue. */
  providerMessageTimeoutMs?: number;
  /** Max silence while the SDK reports a model queue; absolute deadline still applies. */
  providerQueueTimeoutMs?: number;
  /** Absolute deadline for the whole stream. */
  totalDeadlineMs?: number;
  /**
   * Per-call provenance sink. Invoked only when debug output is enabled
   * (QODER_BRIDGE_DEBUG or options.debug enabled); payloads are already
   * secret-redacted. Callers must treat payloads as read-only.
   */
  onDiagnostic?: (event: QoderBridgeDiagnosticEvent) => void;
  /** Enable redacted Bridge diagnostics and observation of SDK stream_event deltas. */
  debug?: boolean;
}

/** Stable diagnostic event shape consumed by the live harness (jsonl per turn). */
export interface QoderBridgeDiagnosticEvent {
  label: string;
  requestId: string;
  sequence: number;
  elapsedMs: number;
  payload: unknown;
}

/** Timeout classification labels surfaced in errorMessage (prefix before `:`). */
export const PROVIDER_TIMEOUT_KIND = {
  /** SDK signalled queue/status with service_available=false before any model event. */
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  /** Still queued when the bound elapsed (queue messages seen, no model output yet). */
  QUEUE: "PROVIDER_QUEUE_TIMEOUT",
  /** Provider started/stayed silent without queue evidence. */
  RESPONSE: "PROVIDER_RESPONSE_TIMEOUT",
  /** Silence after Pi tool results were handed off. */
  CONTINUATION: "POST_TOOL_CONTINUATION_TIMEOUT",
} as const;

const DEFAULT_POST_TOOL_CONTINUATION_TIMEOUT_MS = 15_000;
const DEFAULT_PROVIDER_MESSAGE_TIMEOUT_MS = 120_000;
const DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_DEADLINE_MS = 300_000;
const CLOSE_TIMEOUT_MS = 5_000;

const SECRET_KEY_RE = /api[_-]?key|token|secret|password|authorization|credential/i;

function redactValue(value: unknown, extraSecrets: readonly string[], keyPath = ""): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const secret of extraSecrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("<redacted>");
    }
    if (SECRET_KEY_RE.test(keyPath)) return "<redacted>";
    return out.replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, extraSecrets, keyPath));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactValue(entry, extraSecrets, key);
    return out;
  }
  return value;
}

function debugEnabled(options?: SimpleStreamOptions & QoderBridgeStreamExtras): boolean {
  if (options?.debug === true) return true;
  const env = options?.env?.QODER_BRIDGE_DEBUG ?? process.env.QODER_BRIDGE_DEBUG;
  return env === "1" || env === "true";
}

function digestOf(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized ?? "").digest("hex").slice(0, 16);
}

type DebugRecorder = (label: string, payload: unknown) => void;

function makeDebug(enabled: boolean, secrets: readonly string[]): DebugRecorder {
  if (!enabled) return () => {};
  return (label, payload) => {
    const safe = redactValue(payload, secrets);
    let line: string;
    try {
      line = JSON.stringify(safe);
    } catch {
      line = String(safe);
    }
    process.stderr.write(`[qoder-bridge] ${label} ${line}\n`);
  };
}

export function streamQoder(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions & QoderBridgeStreamExtras,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  const isDebug = debugEnabled(options);
  const secrets = [options?.apiKey ?? ""].filter((s): s is string => !!s);
  const debug = makeDebug(isDebug, secrets);
  const requestId = crypto.randomUUID();
  let diagSeq = 0;
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  // Per-call provenance sink: only invoked in debug mode; payloads are already
  // secret-redacted. Never a global — a new callback can be supplied per call.
  const emitDiagnostic = (label: string, payload: unknown) => {
    if (!isDebug) return;
    const event: QoderBridgeDiagnosticEvent = {
      label,
      requestId,
      sequence: ++diagSeq,
      elapsedMs: elapsedMs(),
      payload: redactValue(payload, secrets),
    };
    try { internals.onDiagnostic?.(event); } catch { /* sink must never break the stream */ }
    try { options?.onDiagnostic?.(event); } catch { /* sink must never break the stream */ }
  };
  let state: BridgeState = BRIDGE_STATE.WAITING_PROVIDER;
  const terminal = () => state === BRIDGE_STATE.COMPLETED || state === BRIDGE_STATE.FAILED;
  const setState = (next: BridgeState) => {
    if (state === next) return;
    if (terminal()) throw new ProviderProtocolError("INVALID_STATE_TRANSITION", `${state} -> ${next}`);
    // Transition guard: only forward edges are legal.
    const legal: Record<BridgeState, BridgeState[]> = {
      WAITING_PROVIDER: [BRIDGE_STATE.WAITING_TOOL, BRIDGE_STATE.WAITING_CONTINUATION, BRIDGE_STATE.COMPLETED, BRIDGE_STATE.FAILED],
      WAITING_TOOL: [BRIDGE_STATE.WAITING_CONTINUATION, BRIDGE_STATE.COMPLETED, BRIDGE_STATE.FAILED],
      WAITING_CONTINUATION: [BRIDGE_STATE.WAITING_TOOL, BRIDGE_STATE.COMPLETED, BRIDGE_STATE.FAILED],
      COMPLETED: [],
      FAILED: [],
    };
    if (!legal[state].includes(next)) throw new ProviderProtocolError("INVALID_STATE_TRANSITION", `${state} -> ${next}`);
    state = next;
    internals.onState?.(next);
    debug("state", next);
  };
  // Emit the initial state once so observers always see WAITING_PROVIDER first.
  internals.onState?.(state);
  debug("state", state);

  const totalDeadlineMs = options?.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  const remaining = () => Math.max(0, totalDeadlineMs - elapsedMs());
  const continuation = isContinuationContext(context);
  let waitingInQueue = false;
  const perMessageBound = () => Math.min(
    waitingInQueue
      ? (options?.providerQueueTimeoutMs ?? DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS)
      : continuation
        ? (options?.postToolContinuationTimeoutMs ?? DEFAULT_POST_TOOL_CONTINUATION_TIMEOUT_MS)
        : (options?.providerMessageTimeoutMs ?? options?.timeoutMs ?? DEFAULT_PROVIDER_MESSAGE_TIMEOUT_MS),
    remaining(),
  );
  // Queue/availability signals observed while awaiting the provider, used to
  // classify a silent-window timeout without conflating it with protocol or
  // post-tool continuation failures.
  let sawQueueStatus = false;
  let sawServiceUnavailable = false;
  let lastQueueStatus: string | undefined;
  let lastQueueServiceAvailable: boolean | undefined;
  let sawFirstMessage = false;
  let sawFirstModelEvent = false; // assistant / stream_event / result
  let sawHandoffAck = false; // command_lifecycle reached "started"
  let firstMessageMs: number | undefined;
  let firstModelEventMs: number | undefined;
  let handoffAckMs: number | undefined;
  let lastQueueElapsedMs: number | undefined;
  // Queue/availability failures are provider-availability problems, never
  // protocol or post-tool timeouts — they win over the continuation class.
  // A later "ready"/available status means the request left the queue, so
  // subsequent silence is classified normally (continuation / response).
  const classifyTimeout = (): string => {
    if (lastQueueServiceAvailable === false) return PROVIDER_TIMEOUT_KIND.UNAVAILABLE;
    if (lastQueueStatus === "queued" && !sawFirstModelEvent) return PROVIDER_TIMEOUT_KIND.QUEUE;
    if (continuation) return PROVIDER_TIMEOUT_KIND.CONTINUATION;
    return PROVIDER_TIMEOUT_KIND.RESPONSE;
  };
  const timeoutError = (detail: string) => new Error(`${classifyTimeout()}: ${detail}`);

  void (async () => {
    stream.push({ type: "start", partial: output });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const externalAborted = () => options?.signal?.aborted === true || controller.signal.aborted;
    options?.signal?.addEventListener("abort", abort, { once: true });
    let q: QueryLike | undefined;
    let cleanup: Promise<void> | undefined;
    const closeQuery = () => cleanup ??= (async () => {
      if (!q) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => q!.close()).catch(error => debug("cleanup_error", String(error))),
          new Promise<void>(resolve => { timer = setTimeout(() => { debug("cleanup_timeout", CLOSE_TIMEOUT_MS); resolve(); }, CLOSE_TIMEOUT_MS); }),
        ]);
      } finally { clearTimeout(timer); }
    })();

    try {
      // Terminal immediately when the caller's signal is already aborted.
      if (externalAborted()) throw Object.assign(new Error("Qoder stream aborted before start"), { name: "AbortError" });
      const structureError = validateContinuation(context.messages);
      if (structureError) throw structureError;
      if (continuation) setState(BRIDGE_STATE.WAITING_CONTINUATION);
      const tools = getCurrentTools(context.messages);
      debug("request", {
        model: model.id,
        continuation,
        messageCount: context.messages.length,
        toolNames: tools.map((t) => t.name),
      });

      const resolvedKey = options?.apiKey;
      const auth = resolvedKey && resolvedKey !== LOCAL_AUTH ? accessToken(resolvedKey) : qodercliAuth();
      const makeQuery = internals.queryFactory ?? ((params: Parameters<typeof query>[0]) => query(params) as unknown as QueryLike);
      const history = JSON.parse(serializeContext(context));
      const systemPrompt = bridgeSystemPrompt(context);
      debug(continuation ? "continuation_request" : "provider_request", {
        prompt: { PI_CONVERSATION_JSON: history },
        options: { cwd: process.cwd(), model: model.id, systemPrompt, tools: [], permissionMode: "dontAsk", maxTurns: 1, persistSession: false, maxTokens: options?.maxTokens ?? model.maxTokens, reasoning: options?.reasoning },
      });
      for (const message of history) if (message.role === "tool_result") debug("tool_result", message);
      q = makeQuery({
        prompt: `PI_CONVERSATION_JSON=${JSON.stringify(history)}`,
        options: {
          auth,
          cwd: process.cwd(),
          model: model.id,
          systemPrompt,
          tools: [],
          disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill"],
          permissionMode: "dontAsk",
          // Debug mode additionally observes raw stream_event deltas. They are
          // diagnostics ONLY — the single authoritative assembly path is the
          // final SDK assistant message snapshots; deltas and result.result
          // echo are never merged into the assembled text.
          includePartialMessages: isDebug,
          maxTurns: 1,
          extraArgs: {
            "max-output-tokens": String(options?.maxTokens ?? model.maxTokens),
            ...(options?.reasoning ? { "reasoning-effort": options.reasoning } : {}),
          },
          persistSession: false,
          abortController: controller,
        },
      });

      // Per-query assembly state. Nothing survives across streamQoder calls,
      // so continuation turns can never inherit leftover buffers.
      const assembled = { text: "", offsets: [] as number[], snapshots: [] as Array<{ uuid?: string; messageId?: string; digest: string; sawThinking: boolean; sawText: boolean }> };
      // Native tool_use blocks collected from assistant snapshots; they join
      // the SAME normalized-toolcall emission path as text envelopes at B→C.
      let nativeToolCalls: unknown[] | undefined;
      let result: SDKResultMessage | undefined;
      let sawTerminal = false;
      let sawAnyMessage = false;
      let rawSeq = 0;
      let afterTerminalDropped = 0;
      // uuid → content digest for every SDK message that carried a uuid. Same
      // uuid + same content = transport replay (dedup, never appended twice);
      // same uuid + different content = strict protocol error.
      const seenUuids = new Map<string, string>();
      const finalSnapshots = new Map<string, string>();
      const iterator = q[Symbol.asyncIterator]();
      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("Qoder stream aborted"), { name: "AbortError" })), { once: true });
      });

      // The SDK normally ends its iterator after the transport closes. The
      // observed failure mode is the iterator never resolving `next()` again
      // after a terminal `result` message. Finish at the terminal result, not
      // transport EOF. Bound provider silence and the whole turn; continuation
      // silence is classified separately from initial-provider timeout.
      while (!sawTerminal) {
        if (externalAborted()) throw Object.assign(new Error("Qoder stream aborted"), { name: "AbortError" });
        if (remaining() <= 0) throw timeoutError(`total deadline ${totalDeadlineMs}ms`);
        let settled: IteratorResult<SDKMessage> | undefined;
        const nextPromise = iterator.next().then((r) => { settled = r; return r; });
        const bound = perMessageBound();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let raced: "next" | "timeout";
        try {
          raced = await Promise.race([
            nextPromise.then(() => "next" as const),
            new Promise<"timeout">((resolve) => { timeout = setTimeout(() => resolve("timeout"), Math.max(1, bound)); }),
            abortPromise,
          ]);
        } finally { clearTimeout(timeout); }
        if (raced === "timeout") {
          throw timeoutError(`no provider message for ${bound}ms`);
        }
        if (settled?.done) break;
        const message = settled?.value;
        if (!message) continue;
        sawAnyMessage = true;
        rawSeq++;
        const messageUuid = (message as { uuid?: string }).uuid;
        const messageDigest = digestOf(message);
        if (!sawFirstMessage) {
          sawFirstMessage = true;
          firstMessageMs = elapsedMs();
          emitDiagnostic("first_message", { type: message.type, subtype: (message as { subtype?: string }).subtype, firstMessageMs });
        }
        // Boundary A: every raw SDK chunk, redacted, before any processing.
        emitDiagnostic("sdk_raw_message", {
          boundary: "A",
          seq: rawSeq,
          type: message.type,
          subtype: (message as { subtype?: string }).subtype,
          uuid: messageUuid,
          session_id: (message as { session_id?: string }).session_id,
          digest: messageDigest,
          assembledOffset: assembled.text.length,
          message,
        });
        debug(continuation ? "continuation_response" : "provider_response", message);
        // Terminal result already received: never process further chunks.
        if (sawTerminal) {
          afterTerminalDropped++;
          emitDiagnostic("after_terminal_chunk", { seq: rawSeq, type: message.type, uuid: messageUuid, digest: messageDigest });
          continue;
        }
        if (message.type === "system" && (message as { subtype?: string }).subtype === "model_queue_status") {
          const queue = message as { status?: string; service_available?: boolean; queue_wait_elapsed_ms?: number };
          sawQueueStatus = true;
          // A queued request may be silent for the SDK's 30s polling interval.
          // Do not apply the ordinary 15s continuation bound until it is ready.
          waitingInQueue = queue.status !== "ready" && (queue.status === "queued" || queue.service_available === false);
          lastQueueStatus = queue.status;
          if (queue.service_available !== undefined) lastQueueServiceAvailable = queue.service_available;
          else if (queue.status === "ready") lastQueueServiceAvailable = undefined;
          if (queue.service_available === false) sawServiceUnavailable = true;
          if (typeof queue.queue_wait_elapsed_ms === "number") lastQueueElapsedMs = queue.queue_wait_elapsed_ms;
          emitDiagnostic("queue_status", { status: queue.status, service_available: queue.service_available, queue_wait_elapsed_ms: queue.queue_wait_elapsed_ms });
        }
        if (message.type === "command_lifecycle" && (message as { state?: string }).state === "started") {
          if (!sawHandoffAck) { sawHandoffAck = true; handoffAckMs = elapsedMs(); emitDiagnostic("handoff_ack", { state: "started", handoffAckMs }); }
        }
        if (messageUuid) {
          const previous = seenUuids.get(messageUuid);
          if (previous !== undefined) {
            if (previous !== messageDigest) {
              throw new ProviderProtocolError("DUPLICATE_UUID", `SDK message uuid ${messageUuid} repeated with different content`);
            }
            // Exact replay: record and drop — never append twice.
            emitDiagnostic("duplicate_uuid", { seq: rawSeq, type: message.type, uuid: messageUuid, action: "dedup" });
            continue;
          }
          seenUuids.set(messageUuid, messageDigest);
        }
        const emittedModelContent = message.type === "assistant" && message.message?.content?.some(block =>
          block.type === "tool_use" || block.type === "text" && typeof block.text === "string" && block.text.length > 0 || block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0);
        const delta = message.type === "stream_event" ? message.event?.delta as { type?: string; text?: string; thinking?: string } | undefined : undefined;
        if (emittedModelContent || delta?.type === "text_delta" && !!delta.text || delta?.type === "thinking_delta" && !!delta.thinking) {
          // A real model token supersedes earlier queue evidence. Only a new
          // queue event may classify a subsequent stall as unavailable again.
          waitingInQueue = false;
          lastQueueServiceAvailable = undefined;
          lastQueueStatus = undefined;
        }
        if (message.type === "stream_event") {
          // Observation only (includePartialMessages in debug mode). Raw
          // content_block deltas are NEVER an assembly source.
          if (!sawFirstModelEvent) { sawFirstModelEvent = true; firstModelEventMs = elapsedMs(); }
          emitDiagnostic("sdk_stream_event", {
            seq: rawSeq,
            eventType: (message as { event?: { type?: string } }).event?.type,
            digest: messageDigest,
          });
        } else if (message.type === "assistant") {
          if (!sawFirstModelEvent) { sawFirstModelEvent = true; firstModelEventMs = elapsedMs(); }
          if (message.error) throw new Error(`Qoder model error: ${message.error}`);
          if (message.message?.role !== "assistant" || message.message?.type !== "message" || !Array.isArray(message.message.content)) {
            throw new ProviderProtocolError("INVALID_ASSISTANT_MESSAGE", "Invalid SDK assistant role/type/content");
          }
          const blocks = message.message.content;
          const assistantStop = message.message?.stop_reason;
          // Dedup finalized message identity before processing native blocks.
          const snapshotId = message.message.id;
          if (assistantStop && snapshotId) {
            const contentDigest = digestOf({ blocks, stopReason: assistantStop });
            const priorFinal = finalSnapshots.get(snapshotId);
            if (priorFinal !== undefined) {
              if (priorFinal !== contentDigest) throw new ProviderProtocolError("DUPLICATE_ASSISTANT_FINAL", "Conflicting final snapshots for one SDK message id");
              emitDiagnostic("duplicate_final_snapshot", { seq: rawSeq, uuid: messageUuid, messageId: snapshotId, action: "dedup" });
              continue;
            }
            finalSnapshots.set(snapshotId, contentDigest);
          }
          // Bridge contract: SDK runtime tools are disabled
          // (options.tools=[]), but a native tool_use block is still a
          // supported REQUEST shape — it is normalized to a Pi toolCall and
          // Pi executes it. SDK-side tool execution is never permitted.
          const toolUseBlocks = blocks.filter((block) => block.type === "tool_use");
          const nonToolBlocks = blocks.filter((block) => block.type !== "tool_use");
          const hasUnknownBlocks = nonToolBlocks.some((block) => block.type !== "text" && block.type !== "thinking");
          if (hasUnknownBlocks) {
            throw new ProviderProtocolError(
              "INVALID_ASSISTANT_CONTENT",
              "SDK assistant message contains unsupported content block type",
            );
          }
          if (toolUseBlocks.length > 0 && assembled.text.trim() || nativeToolCalls && nonToolBlocks.some(block => block.type === "text" && typeof block.text === "string" && block.text.trim())) {
            throw new ProviderProtocolError("MIXED_CONTENT", "SDK stream mixes meaningful text with native tool_use across snapshots");
          }
          // Mixed-content policy (explicit, never silently dropped):
          // text/thinking blocks may accompany native tool_use blocks only
          // when every text block is empty/whitespace. Any meaningful text
          // mixed with tool_use is an ambiguous shape → strict error.
          if (toolUseBlocks.length > 0) {
            const meaningfulText = nonToolBlocks.some((block) =>
              (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) ||
              (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0));
            if (meaningfulText) {
              throw new ProviderProtocolError(
                "MIXED_CONTENT",
                "SDK assistant message mixes meaningful text/thinking with native tool_use blocks",
              );
            }
            if (nativeToolCalls) {
              throw new ProviderProtocolError(
                "MIXED_CONTENT",
                "native tool_use blocks must be confined to a single assistant snapshot",
              );
            }
            nativeToolCalls = toolUseBlocks;
          }
          if (assistantStop === "tool_use" && toolUseBlocks.length === 0 && !nativeToolCalls) {
            throw new ProviderProtocolError(
              "STOP_REASON_CONTRADICTION",
              "Qoder assistant stop_reason is " + JSON.stringify(assistantStop) + " without an emitted tool_use block",
            );
          }
          const snapshotText = textFromMessage(message);
          const snapshot = {
            uuid: messageUuid,
            messageId: (message.message as { id?: string }).id,
            digest: digestOf(blocks),
            sawThinking: blocks.some((block) => block.type === "thinking"),
            sawText: blocks.some((block) => block.type === "text"),
          };
          assembled.snapshots.push(snapshot);
          assembled.offsets.push(assembled.text.length);
          assembled.text += snapshotText;
          emitDiagnostic("assistant_snapshot", {
            seq: rawSeq,
            ...snapshot,
            offset: assembled.offsets[assembled.offsets.length - 1],
            text: snapshotText,
            stop_reason: assistantStop,
          });
        } else if (message.type === "result") {
          if (!sawFirstModelEvent) { sawFirstModelEvent = true; firstModelEventMs = elapsedMs(); }
          result = message;
          sawTerminal = true;
          debug("raw_result", {
            subtype: message.subtype,
            is_error: message.is_error,
            stop_reason: message.stop_reason,
            num_turns: message.num_turns,
            usage: message.usage,
          });
          if (message.subtype !== "success" || message.is_error) throw new Error(("errors" in message ? message.errors?.join("; ") : "") || message.subtype);
          const resultText = "result" in message && typeof message.result === "string" ? message.result : "";
          // result.result is an echo of assistant output, never an additional
          // chunk — it may only fill in when no assistant snapshot arrived.
          emitDiagnostic("sdk_terminal_result", {
            seq: rawSeq,
            uuid: messageUuid,
            resultText,
            resultDigest: digestOf(resultText),
            echoesAssembled: resultText === assembled.text,
          });
          if (!nativeToolCalls && !assembled.text) assembled.text = clean(resultText);
        }
      }
      iterator.return?.().catch(() => undefined);
      if (afterTerminalDropped) {
        emitDiagnostic("after_terminal_summary", { dropped: afterTerminalDropped });
      }

      // EOF without a terminal result is a protocol violation, not a text turn.
      if (!result) {
        throw new ProviderProtocolError(
          "MISSING_RESULT",
          sawAnyMessage
            ? "Qoder stream ended without a terminal result message"
            : "Qoder stream produced no messages at all",
        );
      }
      usageFromResult(result, output);
      const text = assembled.text;
      // Boundary B: the assembled text is derived exclusively from final SDK
      // assistant message snapshots. Delta stream_events and the result.result
      // echo are never merged in.
      emitDiagnostic("assembled_text", {
        boundary: "B",
        text,
        digest: digestOf(text),
        length: text.length,
        snapshots: assembled.snapshots,
      });
      debug("raw_text", text);
      const resultEcho = "result" in result && typeof result.result === "string" ? result.result : "";
      // PROVIDER_OUTPUT_DEFECT: the SDK boundary delivered text the bridge
      // contract cannot parse (e.g. a trailing `}` after the JSON payload). We
      // cannot see inside the SDK/transport, so this records the observation
      // at boundary A without claiming where the defect originated.
      const defectDiagnostics = (stage: string, data: string) => {
        if (!/<\/?pi_tool_call\b/i.test(data)) return;
        const { envelopes } = scanToolCallEnvelopes(data);
        for (const [index, raw] of envelopes.entries()) {
          try {
            JSON.parse(raw);
          } catch (error) {
            emitDiagnostic("provider_output_defect", {
              stage,
              envelopeIndex: index + 1,
              envelopeRaw: raw,
              parseError: error instanceof Error ? error.message : String(error),
              digest: digestOf(data),
            });
          }
        }
      };
      defectDiagnostics("assembled_text", text);
      if (resultEcho && resultEcho !== text) defectDiagnostics("result_echo", resultEcho);

      // Boundaries C (normalization input) and D (per-envelope parse input)
      // are the same string derived from B; the instrument callback asserts
      // A→B→C→D equality in tests.
      // Native tool_use blocks and assembled text share ONE dispatcher:
      // normalized payload = native blocks when present, else assembled text.
      const normalizeInput: string | StructuredProviderPayload = nativeToolCalls
        ? { kind: "blocks", blocks: nativeToolCalls }
        : text;
      emitDiagnostic("normalization_input", { boundary: "C", text, digest: digestOf(text), length: text.length, nativeBlocks: nativeToolCalls?.length ?? 0 });
      const normalized = normalizeProviderResponse(normalizeInput, tools, isDebug
        ? (stage, raw, index) => emitDiagnostic(stage === "parser_selected" ? "parser_selected" : "parse_input", { boundary: "D", stage, index, raw, digest: digestOf(raw) })
        : undefined);
      if (normalized.kind === "tool_calls") {
        const historicalIds = new Set(context.messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []));
        if (normalized.calls.some(call => historicalIds.has(call.id))) throw new ProviderProtocolError("DUPLICATE_ID", "Provider reused a tool call id from history");
      }
      debug("normalized", normalized.kind === "protocol_error" ? { kind: normalized.kind, code: normalized.error.code, message: normalized.error.message } : normalized);
      if (normalized.kind === "protocol_error") {
        emitDiagnostic("error_input", { boundary: "E", code: normalized.error.code, message: normalized.error.message, text, inputDigest: digestOf(text) });
        throw normalized.error;
      }

      // Stop-reason contradiction: the model emitted envelope tool calls while
      // the SDK-level stop_reason says the turn ended for another reason, or
      // vice versa the stop reason demands tool use but none were emitted.
      const sdkStop = result.stop_reason;
      if (normalized.kind === "tool_calls" && sdkStop && sdkStop !== "tool_use" && sdkStop !== "end_turn" && sdkStop !== "stop_sequence") {
        throw new ProviderProtocolError("STOP_REASON_CONTRADICTION", `tool envelopes emitted but SDK stop_reason is ${JSON.stringify(sdkStop)}`);
      }
      if (normalized.kind === "text" && sdkStop === "tool_use") {
        throw new ProviderProtocolError("STOP_REASON_CONTRADICTION", "SDK stop_reason is tool_use but no envelope was emitted");
      }

      if (normalized.kind === "tool_calls") {
        setState(BRIDGE_STATE.WAITING_TOOL);
        for (const call of normalized.calls) {
          const block = {
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments as JsonObject,
          };
          const contentIndex = output.content.length;
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
          debug("tool_call", { id: block.id, name: block.name, arguments: block.arguments });
        }
        output.stopReason = "toolUse";
      } else {
        const body = normalized.text;
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: body });
        stream.push({ type: "text_start", contentIndex, partial: output });
        if (body) stream.push({ type: "text_delta", contentIndex, delta: body, partial: output });
        stream.push({ type: "text_end", contentIndex, content: body, partial: output });
        output.stopReason = result.stop_reason === "max_tokens" ? "length" : "stop";
      }
      output.rawStopReason = result.stop_reason ?? undefined;
      emitDiagnostic("handoff", {
        stopReason: output.stopReason,
        rawStopReason: result.stop_reason,
        firstMessageMs,
        firstModelEventMs,
        handoffAckMs,
        lastQueueElapsedMs,
        sawQueueStatus,
        sawServiceUnavailable,
        afterTerminalDropped,
      });
      await closeQuery();
      stream.push({ type: "done", reason: output.stopReason, message: output });
      if (output.stopReason !== "toolUse") setState(BRIDGE_STATE.COMPLETED);
      stream.end();
    } catch (error) {
      const isAbort = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      output.stopReason = isAbort ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      await closeQuery();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      setState(BRIDGE_STATE.FAILED);
      debug("error", output.errorMessage);
      if (/TIMEOUT/.test(output.errorMessage)) debug("timeout_classification", output.errorMessage.split(":")[0]);
      if (/UNAVAILABLE|TIMEOUT/.test(output.errorMessage)) {
        emitDiagnostic("timeout_classification", {
          kind: output.errorMessage.split(":")[0],
          sawQueueStatus,
          sawServiceUnavailable,
          sawFirstMessage,
          sawFirstModelEvent,
          firstMessageMs,
          firstModelEventMs,
          handoffAckMs,
          lastQueueElapsedMs,
          continuation,
        });
      }
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      // close() can itself hang if the transport is wedged; bound it and
      // never let teardown block the terminal event already emitted.
      await closeQuery();
    }
  })();

  return stream;
}

export default function qoderBridgeExtension(pi: ExtensionAPI): void {
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Qoder Bridge",
    auth: {
      apiKey: {
        name: "Qoder account",
        async login(interaction) {
          const method = await interaction.prompt({
            type: "select",
            message: "Qoder authentication",
            options: loginMethods(!!qoderCliCommand()),
          });
          if (method === "local") {
            const command = qoderCliCommand();
            if (!command) throw new Error("Qoder CLI is not available");
            await completeCliLogin(command, interaction);
            return { type: "api_key", key: LOCAL_AUTH };
          }
          if (method !== "pat") throw new Error("Unknown Qoder authentication method");
          interaction.notify({
            type: "auth_url",
            url: PAT_URL,
            instructions: "Create a Personal Access Token in Account → Integrations, then paste it into Pi. The token is shown only once.",
          });
          const key = (await interaction.prompt({ type: "secret", message: "Paste your Qoder Personal Access Token" })).trim();
          if (!key) throw new Error("Qoder Personal Access Token is required");
          return { type: "api_key", key };
        },
        async check({ ctx, credential }) {
          if (credential?.key && credential.key !== LOCAL_AUTH) return { type: "api_key", source: "stored PAT" };
          if (await ctx.env("QODER_PERSONAL_ACCESS_TOKEN")) return { type: "api_key", source: "QODER_PERSONAL_ACCESS_TOKEN" };
          if (canReuseQoderLogin() && (credential?.key === LOCAL_AUTH || await ctx.fileExists(AUTH_FILE))) {
            return { type: "api_key", source: "Qoder CLI login" };
          }
          return undefined;
        },
        async resolve({ ctx, credential }) {
          if (credential?.key && credential.key !== LOCAL_AUTH) return { auth: { apiKey: credential.key }, source: "stored PAT" };
          const token = await ctx.env("QODER_PERSONAL_ACCESS_TOKEN");
          if (token) return { auth: { apiKey: token }, source: "QODER_PERSONAL_ACCESS_TOKEN" };
          if (canReuseQoderLogin() && (credential?.key === LOCAL_AUTH || await ctx.fileExists(AUTH_FILE))) {
            return { auth: { apiKey: LOCAL_AUTH }, source: "Qoder CLI login" };
          }
          return undefined;
        },
      },
    },
    models,
    api: { stream: streamQoder, streamSimple: streamQoder },
  });

  pi.registerProvider(provider);

  pi.registerCommand("qoder-bridge-setup", {
    description: "Guide Qoder CLI installation (installs only after explicit Yes)",
    handler: async (_args, ctx) => {
      const command = qoderCliCommand();
      const guidance = cliSetupInstructions(process.platform, !!command, hasQoderLogin());
      try {
        if (ctx.hasUI && await offerCliInstall(
          process.platform,
          (title, options) => ctx.ui.select(title, options),
          launchCliInstaller,
        )) {
          ctx.ui.notify("Installer launched in a separate terminal. Complete it there, then restart Pi.", "info");
          return;
        }
      } catch (error) {
        const manualCommand = cliInstallCommand(process.platform, process.arch);
        ctx.ui.notify(`Could not open an installer terminal: ${error instanceof Error ? error.message : String(error)}\n${guidance}${manualCommand ? `\nRun manually: ${manualCommand}` : ""}`, "warning");
        return;
      }
      ctx.ui.notify(command && !hasQoderLogin() ? `${guidance}\nRun: ${cliLoginCommand(command)}` : guidance, command ? "info" : "warning");
    },
  });

  pi.registerCommand("qoder-bridge-status", {
    description: "Show Qoder CLI version and local login availability",
    handler: async (_args, ctx) => {
      const command = qoderCliCommand();
      if (!command) {
        ctx.ui.notify("Qoder CLI is not on PATH. Run /qoder-bridge-setup for installation guidance.", "warning");
        return;
      }
      const result = await pi.exec(command, ["--version"], { timeout: 15_000 });
      ctx.ui.notify(`${(result.stdout || result.stderr || "No output").trim()}\nLocal login: ${hasQoderLogin() ? "found" : "not found"}`, result.code === 0 ? "info" : "warning");
    },
  });
}
