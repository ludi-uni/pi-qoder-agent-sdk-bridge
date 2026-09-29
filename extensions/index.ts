import { spawn, spawnSync } from "node:child_process";
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
  type Api,
  type ProviderAuthInteraction,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type Tool,
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
  const schema = tool.parameters as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: schema.type ?? "object",
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    },
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

export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const matches = [...text.matchAll(/<pi_tool_call>\s*([\s\S]*?)\s*<\/pi_tool_call>/g)];
  if (matches.length === 0) return null;
  const outside = text.replace(/<pi_tool_call>[\s\S]*?<\/pi_tool_call>/g, "").trim();
  if (outside) return null;

  try {
    return matches.map((match) => {
      const parsed = JSON.parse(match[1]) as ParsedToolCall;
      if (!parsed || typeof parsed.name !== "string" || !parsed.name || !parsed.arguments || typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments) || parsed.id !== undefined && typeof parsed.id !== "string") {
        throw new Error("Invalid tool call envelope");
      }
      return parsed;
    });
  } catch {
    return null;
  }
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

export function streamQoder(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
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

  void (async () => {
    stream.push({ type: "start", partial: output });
    const controller = new AbortController();
    const abort = () => controller.abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    let q: ReturnType<typeof query> | undefined;

    try {
      const resolvedKey = options?.apiKey;
      const auth = resolvedKey && resolvedKey !== LOCAL_AUTH ? accessToken(resolvedKey) : qodercliAuth();
      q = query({
        prompt: `PI_CONVERSATION_JSON=${serializeContext(context)}`,
        options: {
          auth,
          cwd: process.cwd(),
          model: model.id,
          systemPrompt: bridgeSystemPrompt(context),
          tools: [],
          disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill"],
          permissionMode: "dontAsk",
          includePartialMessages: false,
          maxTurns: 1,
          extraArgs: {
            "max-output-tokens": String(options?.maxTokens ?? model.maxTokens),
            ...(options?.reasoning ? { "reasoning-effort": options.reasoning } : {}),
          },
          persistSession: false,
          abortController: controller,
        },
      });

      let text = "";
      let result: SDKResultMessage | undefined;
      for await (const message of q) {
        if (message.type === "assistant") {
          if (message.error) throw new Error(`Qoder model error: ${message.error}`);
          text += textFromMessage(message);
        } else if (message.type === "result") {
          result = message;
          if (message.subtype !== "success") throw new Error(message.errors.join("; ") || message.subtype);
          if (!text) text = clean(message.result);
        }
      }

      usageFromResult(result, output);
      const toolCalls = parseToolCalls(text);
      const allowed = new Set(getCurrentTools(context.messages).map((tool) => tool.name));
      if (toolCalls && toolCalls.every((call) => allowed.has(call.name))) {
        for (const call of toolCalls) {
          const block = {
            type: "toolCall" as const,
            id: call.id ?? `qoder_${crypto.randomUUID()}`,
            name: call.name,
            arguments: call.arguments as JsonObject,
          };
          const contentIndex = output.content.length;
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }
        output.stopReason = "toolUse";
      } else {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex, partial: output });
        if (text) stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: text, partial: output });
        output.stopReason = result?.stop_reason === "max_tokens" ? "length" : "stop";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = controller.signal.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      await q?.close().catch(() => undefined);
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
