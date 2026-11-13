# pi-qoder-agent-sdk-bridge

Use Qoder models in [Pi](https://pi.dev/) through the **official Qoder Agent SDK**. Independent community extension; not affiliated with Qoder or Pi.

> **Release status:** this checkout is version 0.5.1 (see `package.json`). Its npm publication status is not asserted here; confirm the version is actually published before using the npm install command below. `pi-qoder-bridge` is owned by another project, so this package uses the distinct name `pi-qoder-agent-sdk-bridge`.

[日本語の導入ガイド](docs/ja/quickstart.md) · [Qoder SDK](https://docs.qoder.com/cli/sdk/overview) · [Third-party terms](THIRD_PARTY_NOTICES.md)

## Install (after the corresponding version is published to npm)

Requirements: Node.js >= 22.23.4 (per `engines` in `package.json`), Pi, and a Qoder account with either a Personal Access Token (PAT) or a signed-in Qoder CLI. Your package manager must allow the Qoder SDK postinstall script to fetch its Worker runtime. Verify that the version you want is actually published on npm before running the command — this checkout's version, 0.5.1, is not asserted to be published.

```sh
pi install npm:pi-qoder-agent-sdk-bridge@0.5.1
pi list
```

Restart Pi or run `/reload`, then use `/login` → **Qoder Bridge** → **Personal Access Token** or **Reuse Qoder CLI login**. Select `qoder-bridge/Auto` (or another listed model) in `/model`. PAT creation opens Qoder's official Account → Integrations page; create a token there and paste it into Pi. A CLI login option appears only when a CLI executable is detected. If it has not signed in, choose **Open browser via Qoder CLI**; the CLI, not this bridge, stores its browser credential. See the [step-by-step Japanese guide](docs/ja/quickstart.md) for screenshots and troubleshooting.

```text
/qoder-bridge-setup   # CLI install guidance; No is the first/default option
/qoder-bridge-status  # installed SDK version, qodercli availability and CLI login status
```

The setup command runs an official installer **only after you explicitly select Yes**. Windows x64 uses the PowerShell installer; macOS/Linux x64/arm64 use `curl -fsSL https://qoder.com/install | bash` in a separate terminal. Windows arm64 and other unsupported combinations do not offer installation. Review downloaded scripts before consenting. No installs are run by the package at startup.

## Try a local checkout

```sh
npm install
npm test
npm run typecheck
pi --extension ./extensions/index.ts
```

To load this checkout across Pi sessions, run `pi install <absolute-path-to-this-directory>`. Do not install both the checkout and a future npm release at the same time.

## Design and limitations

- Registers a `qoder-bridge` model provider. Each request is one ephemeral SDK `query()`, authenticated with `qodercliAuth()` or `accessToken()`. SDK 1.0.59 routes default queries through its process-wide shared daemon using the package's default Worker launch mode; closing a query closes its session, not the shared daemon.
- Pi owns tool approval and execution. Built-in Qoder runtime tools remain disabled (`tools: []` plus the existing deny list). SDK 1.0.59 shared-daemon queries use `permissionMode: "default"` with a deny-only `canUseTool` callback, not permission bypass; this is not proof that every ambient SDK execution path is closed. The model-followed `<pi_tool_call>` contract is still supported; SDK-native `tool_use` requests and the wrapperless function envelope below normalize to the same Pi tool-call path. This does not enable SDK-side tool execution.
- Conversation history and tool schemas are sent to Qoder's service. Input is **text-only**; images are represented as placeholders, not transmitted. The catalog is a static snapshot, not a live per-account availability check.
- Token costs/prices in model metadata are zero placeholders; actual Qoder billing/credits are governed by your Qoder account. Browser sign-in launched by the CLI is best-effort and can require an interactive terminal.
- Malformed tool envelopes and unknown tools fail with terminal protocol errors (no automatic repair or retry). SDK terminal results complete the Pi turn without waiting for transport EOF. Post-tool silence is classified as `POST_TOOL_CONTINUATION_TIMEOUT`.
- SDK failure classification: errors thrown by the SDK surface with stable prefixes — `SDK_PROTOCOL_VERSION_MISMATCH` (wire-protocol major mismatch between qodercli and this SDK build), `SDK_UNSUPPORTED_CLI_CAPABILITY` (a required capability is not advertised), `SDK_CONTROL_REQUEST_TIMEOUT` / `SDK_CONTROL_REQUEST_REJECTED` (outbound control request timed out or was rejected; the SDK's own `retryable` flag is forwarded verbatim but the bridge never retries), `SDK_MODEL_POLICY_TIMEOUT`, `SDK_HOOK_STOPPED` (a hook ended the agent turn; pending tool calls are never released), and `SDK_TERMINAL_ERROR` (non-success result subtype or `is_error`). The supplied PAT, `Bearer` values and token-like assignments are redacted from surfaced messages; SDK `error.details` is never surfaced. `SDK_DAEMON_CONFIGURATION_CONFLICT` identifies incompatible shared-daemon settings (including changing PATs or switching between PAT and CLI authentication); restart the Pi process after changing authentication. The bridge does not reset a daemon that other queries may share. These codes are diagnostics, not retry-safety claims.
- Terminal result metadata: `error_code` and `terminal_reason` (agent-termination signal independent of the model `stop_reason`) are recorded in `sdk_terminal_metadata` even for failing results, and in `sdk_terminal_result` / `handoff` for successful results. Finite numbers and short identifier-like strings are retained; arbitrary free-form values are omitted and secrets are redacted. The bridge does not infer success or failure from `error_code`; `subtype` and `is_error` remain authoritative. `terminal_reason=hook_stopped` means a hook ended the turn; with pending tool calls it fails closed, with text it completes normally and is never a stop-reason contradiction. Unknown or absent reasons remain compatible and are recorded, not invented into errors.
- SDK warnings: an optional `onWarning(warning)` stream extra receives bounded, sanitized warnings (currently `agents_md_size_warning`: kind, code, severity, byte totals, load status and file count — never file contents or model text). It is independent of `QODER_BRIDGE_DEBUG` and payload logging; callback failures are swallowed. `commands_changed`/model-catalog events are ignored safely — they never become tools or commands. Live catalog, BYOK configuration, explicit daemon management, additional auth modes, SDK tool execution, images and persistent goals are not implemented. The SDK's implicit shared daemon is used by default.
- Debugging: set `QODER_BRIDGE_DEBUG=1` to emit redacted requests, responses, normalized output, tool calls/results, transitions and timeout classifications to stderr; redirect stderr to save diagnostics. Payload logging is off by default. Debug output may still contain repository content; keep it private. `providerMessageTimeoutMs` (120s), `postToolContinuationTimeoutMs` (15s), `providerQueueTimeoutMs` (120s) and `totalDeadlineMs` (900s / 15min) can be set per stream call. While the SDK reports a model queue, the dedicated queue silence bound replaces the normal response/continuation bound so the SDK's 30s polling interval is not cut short. A ready notification or model output restores normal silence monitoring. Queue messages never extend the absolute deadline. The 15min default is a finite allowance for congested model queues such as Qwen's — it is not the SDK's maximum queue time and not a service guarantee. The turn can always be cancelled via `signal`, still ends in an error once the deadline elapses, and the bridge never retries or waits indefinitely. Each call is stateless; the full validated Pi transcript is replayed, not a Qoder session resume.
- Live verification (separate from fixtures): `node --import tsx scripts/verify-provider.mjs`. It uses existing Qoder authentication without changing Pi settings and performs real repository-only reads/listings across three runs. `QODER_BRIDGE_TEST_MODEL` optionally overrides the default `Qwen3.8-Flash`; live checks allow 120s per continuation. Results are saved under `test-artifacts/`.

## Tool envelope dispatch

Payload shape selects exactly one strict parser; a parse failure never tries another parser or completes as text. Supported shapes:

- Qoder: `<pi_tool_call>{"id":"call_1","name":"read","arguments":{"path":"package.json"}}</pi_tool_call>`. Qoder IDs remain optional (generated when omitted). Text outside complete envelopes (including commentary or stray `}`) is ignored, not emitted or executed. Envelope boundaries recognize JSON strings and escapes, so literal `<pi_tool_call>` / `</pi_tool_call>` inside argument strings are preserved. Markdown code spans and code blocks in explanatory prose are literal examples, not executable calls (including quoted template envelopes such as `tool_name`). This also preserves tag mentions such as `</pi_tool_call>` or `const close = "</pi_tool_call>";`. Unquoted envelopes and code-only responses beginning with JSON-like envelopes still undergo strict tool validation; unknown tools are never enabled by this rule. Extra incomplete/malformed markers and invalid JSON inside envelopes still fail; no JSON repair is performed.
- SDK-native assistant content block: `{"type":"tool_use","id":"call_1","name":"read","input":{"path":"package.json"}}`.
- Wrapperless function envelope as the entire assistant text: `{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"package.json\"}"}}`.

Standard IDs are required. Both standard shapes reject unknown fields, malformed JSON, non-object arguments, unknown tools, duplicate IDs and schema-invalid arguments without coercion. Unsupported tool-like shapes (`tool_calls`, `function_call`, other explicit invocation types) fail rather than become text; ordinary prose and ordinary JSON remain text. Native requests are confined to one assistant snapshot; ambiguous native/text mixtures and conflicting final replays fail explicitly. Arbitrary future SDK formats are not implicitly supported.

The previous audit fixtures are now ordinary regression tests in `test/standard-fallback.test.ts`. `node --import tsx scripts/replay-standard-equivalence.mjs` replays saved real Qoder output and standard fixtures through the same Pi event/tool-result/continuation path, without live provider requests; results are saved in `test-artifacts/standard-envelope/`.

## Boundary investigation

`node --import tsx scripts/verify-boundary.mjs` performs five independent live runs (no retries), recording redacted transport frames and SDK→assembly→normalization→parse→error provenance under ignored `test-artifacts/`. Run `node scripts/analyze-boundary.mjs` to compare the saved boundaries. Availability failures are reported separately from protocol failures. See [boundary investigation evidence](docs/boundary-investigation.md) for observed results and limits. The parser remains strict; diagnostics do not repair model output.

## Development / release checklist

```sh
npm run typecheck
npm test
npm pack --dry-run --json
```

Before publication: inspect the tarball contents (no credentials, Worker binary or `node_modules`), obtain an npm account/name, review [the third-party terms](THIRD_PARTY_NOTICES.md), and re-check the documentation captures for accidental personal information. `npm publish --access public` is a separate **manual** release action; it is not run by this repository.

## License

The bridge's own source is [MIT](LICENSE). The Qoder SDK and downloaded Worker are **not** MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No SDK source/runtime is bundled in this package.
