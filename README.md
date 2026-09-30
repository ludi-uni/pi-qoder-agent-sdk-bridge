# pi-qoder-agent-sdk-bridge

Use Qoder models in [Pi](https://pi.dev/) through the **official Qoder Agent SDK**. Independent community extension; not affiliated with Qoder or Pi.

> **Release status:** 0.2.1 prepared for npm publication; this version has not been published by this release preparation. `pi-qoder-bridge` is owned by another project, so this package uses the distinct name `pi-qoder-agent-sdk-bridge`.

[日本語の導入ガイド](docs/ja/quickstart.md) · [Qoder SDK](https://docs.qoder.com/cli/sdk/overview) · [Third-party terms](THIRD_PARTY_NOTICES.md)

## Install (after npm publication)

Requirements: Node.js 20+, Pi, and a Qoder account with either a Personal Access Token (PAT) or a signed-in Qoder CLI. Your package manager must allow the Qoder SDK postinstall script to fetch its Worker runtime.

```sh
pi install npm:pi-qoder-agent-sdk-bridge@0.2.1
pi list
```

Restart Pi or run `/reload`, then use `/login` → **Qoder Bridge** → **Personal Access Token** or **Reuse Qoder CLI login**. Select `qoder-bridge/Auto` (or another listed model) in `/model`. PAT creation opens Qoder's official Account → Integrations page; create a token there and paste it into Pi. A CLI login option appears only when a CLI executable is detected. If it has not signed in, choose **Open browser via Qoder CLI**; the CLI, not this bridge, stores its browser credential. See the [step-by-step Japanese guide](docs/ja/quickstart.md) for screenshots and troubleshooting.

```text
/qoder-bridge-setup   # CLI install guidance; No is the first/default option
/qoder-bridge-status  # CLI version and local login availability
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

- Registers a `qoder-bridge` model provider. Each request is one ephemeral SDK `query()` through its default Worker runtime, authenticated with `qodercliAuth()` or `accessToken()`.
- Pi owns tool approval and execution. Built-in Qoder runtime tools remain disabled. The model-followed `<pi_tool_call>` contract is still supported; SDK-native `tool_use` requests and the wrapperless function envelope below normalize to the same Pi tool-call path. This does not enable SDK-side tool execution.
- Conversation history and tool schemas are sent to Qoder's service. Input is **text-only**; images are represented as placeholders, not transmitted. The catalog is a static snapshot, not a live per-account availability check.
- Token costs/prices in model metadata are zero placeholders; actual Qoder billing/credits are governed by your Qoder account. Browser sign-in launched by the CLI is best-effort and can require an interactive terminal.
- Malformed tool envelopes and unknown tools fail with terminal protocol errors (no automatic repair or retry). SDK terminal results complete the Pi turn without waiting for transport EOF. Post-tool silence is classified as `POST_TOOL_CONTINUATION_TIMEOUT`.
- Debugging: set `QODER_BRIDGE_DEBUG=1` to emit redacted requests, responses, normalized output, tool calls/results, transitions and timeout classifications to stderr; redirect stderr to save diagnostics. Payload logging is off by default. Debug output may still contain repository content; keep it private. `providerMessageTimeoutMs` (120s), `postToolContinuationTimeoutMs` (15s) and `totalDeadlineMs` (300s) can be set per stream call. Each call is stateless; the full validated Pi transcript is replayed, not a Qoder session resume.
- Live verification (separate from fixtures): `node --import tsx scripts/verify-provider.mjs`. It uses existing Qoder authentication without changing Pi settings and performs real repository-only reads/listings across three runs. `QODER_BRIDGE_TEST_MODEL` optionally overrides the default `Qwen3.8-Flash`; live checks allow 120s per continuation. Results are saved under `test-artifacts/`.

## Tool envelope dispatch

Payload shape selects exactly one strict parser; a parse failure never tries another parser or completes as text. Supported shapes:

- Qoder: `<pi_tool_call>{"id":"call_1","name":"read","arguments":{"path":"package.json"}}</pi_tool_call>`. Qoder IDs remain optional (generated when omitted). Text outside complete envelopes (including commentary or stray `}`) is ignored, not emitted or executed. Extra incomplete/malformed markers and invalid JSON inside envelopes still fail; no JSON repair is performed.
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
