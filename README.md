# pi-qoder-agent-sdk-bridge

Use Qoder models in [Pi](https://pi.dev/) through the **official Qoder Agent SDK**. Independent community extension; not affiliated with Qoder or Pi.

> **Release status:** 0.1.0 candidate. The npm package has **not** been published yet. `pi-qoder-bridge` is owned by another project, so this package uses the distinct name `pi-qoder-agent-sdk-bridge` (availability and ownership must be checked again before publishing).

[日本語の導入ガイド](docs/ja/quickstart.md) · [Qoder SDK](https://docs.qoder.com/cli/sdk/overview) · [Third-party terms](THIRD_PARTY_NOTICES.md)

## Install (after npm publication)

Requirements: Node.js 20+, Pi, and a Qoder account with either a Personal Access Token (PAT) or a signed-in Qoder CLI. Your package manager must allow the Qoder SDK postinstall script to fetch its Worker runtime.

```sh
pi install npm:pi-qoder-agent-sdk-bridge@0.1.0
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
- Pi owns tool approval and execution. Built-in Qoder tools are disabled; Pi tools are represented by model-followed `<pi_tool_call>` envelopes, **not native structured tool calling**. These can fail to parse or be ignored by the model.
- Conversation history and tool schemas are sent to Qoder's service. Input is **text-only**; images are represented as placeholders, not transmitted. The catalog is a static snapshot, not a live per-account availability check.
- Token costs/prices in model metadata are zero placeholders; actual Qoder billing/credits are governed by your Qoder account. Browser sign-in launched by the CLI is best-effort and can require an interactive terminal.

## Development / release checklist

```sh
npm run typecheck
npm test
npm pack --dry-run --json
```

Before publication: inspect the tarball contents (no credentials, Worker binary or `node_modules`), obtain an npm account/name, review [the third-party terms](THIRD_PARTY_NOTICES.md), and re-check the documentation captures for accidental personal information. `npm publish --access public` is a separate **manual** release action; it is not run by this repository.

## License

The bridge's own source is [MIT](LICENSE). The Qoder SDK and downloaded Worker are **not** MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No SDK source/runtime is bundled in this package.
