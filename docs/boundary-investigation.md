# Qoder Bridge boundary investigation

## Scope

Qoder Bridge 内のみ。strict parse／schema validation を維持し、JSON修復・provider retry は追加していない。Pi settings、DOLL、OCI、Cloudflare は未変更。

## Evidence

- 前回 Run 3 の SDK assistant text と `result.result` は、受信時点で両方とも以下だった。
  `<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}}</pi_tool_call>`
- 最初の不正地点は A（SDK受信）。運用分類は `PROVIDER_OUTPUT_DEFECT`。Bridge が余分な `}` を挿入した証拠はない。
- `previous-run-provenance.json` の C/D/E は前回ログからの派生値であり、直接観測ではない。
- `previous-run3-replay.jsonl` は保存済みSDKメッセージの再生で、実provider再実行ではない。再生時に B/C/D/E を直接保存し、B=C=E が元の受信文字列と一致、`MALFORMED_ENVELOPE_JSON` の strict failure を確認した。
- SDK 1.0.32 の transport は stdout JSONL を `JSON.parse` して返し、QueryRunner は assistant／partial event／result の text を書き換えず enqueue する。新規実検証では public transport wrapper で QueryRunner 手前の parsed frame を別保存した。ネットワークの provider HTTP wire／obfuscated worker runtime 内部は未観測。したがってモデル生成と worker runtime 内部の責任までは断定しない。

## Real provider runs

証跡ディレクトリ: `test-artifacts/boundary-investigation/2026-09-30T05-12-53.712Z/`

| run | SDK raw chunks | tool count | protocol errors | provider unavailable | continuation timeout | terminal state |
|---|---:|---:|---:|---:|---:|---|
| 1 | 18 | 0 | 0 | 1 | 0 | FAILED |
| 2 | 18 | 0 | 0 | 1 | 0 | FAILED |
| 3 | 59 | 1 | 0 | 1 | 0 | FAILED |
| 4 | 57 | 1 | 0 | 1 | 0 | FAILED |
| 5 | 18 | 0 | 0 | 1 | 0 | FAILED |

chunk count は SDK から消費した全メッセージ数（systemイベント含む）。text delta は計16件。tool error は全run 0、最終assistant responseは全run無し。

- 全7 turnで user request の transport write と runtime `command_lifecycle: started` を記録。runtime acknowledgement は provider token arrival と区別した。
- 失敗した5 turnは queueイベント計30件、全て `queued`／`service_available=false`。readyへの変化とfirst model tokenは無し。100秒のabsolute deadlineとbounded cleanup後、約102秒でFAILED。queue heartbeatで無期限延長しない。
- 成功した2 tool turnは first token 約6.1秒／6.8秒。transport→SDKのtext／delta順序、delta結合→final snapshot、snapshot結合→B、B→C→D は一致。重複UUID、重複final snapshot、重複terminalは観測0件。
- 新規5 runに malformed payload は無かった。Bridge側malformed 0、transport/SDK-host側text変形 0。availability failure はBridge failureに計上しない。
- transport側とBridge側で usage token count のsecret masking方式が異なるため、解析では同じmaskを双方に適用してからevent比較する。元ログを書き換えていない。

## Changes

- debug限定の `onDiagnostic` で request ID／sequence／elapsed time とA–Eを記録。B/C/Eはdigestだけでなく全文も保存する。secretは保存前にマスクする。SDK組込みdebugは有効化しない。
- debug時だけpartial messageを観測する。組み立て経路はassistant snapshotのみ。partial delta／terminal result echoを二重連結しない。
- 同一UUIDの完全な再送はdedup、内容が矛盾する再送はstrict error。SDK message IDが同じfinal snapshotの別UUID再送もdedup、矛盾はstrict error。別message IDやテキスト一致だけで推測dedupはしない。
- 別UUIDのfinal再送によるtool二重実行をfixtureで再現（2回→期待1回）、修正後PASS。これは前回Run3のmalformed根因ではなく、lifecycle auditで見つけた別経路。
- `PROVIDER_UNAVAILABLE`／`PROVIDER_QUEUE_TIMEOUT`／`PROVIDER_RESPONSE_TIMEOUT` を分離。可用性の問題でないpost-tool silenceは従来の `POST_TOOL_CONTINUATION_TIMEOUT`。ready／実model token後には古いunavailable判定を引き継がない。

## Verification

`npm test` は76件 PASS（0 fail）。`npm run typecheck` と `git diff --check` も PASS。追加fixtureはsplit JSON、独立した `}`、重複terminal、重複最終chunk、continuation buffer reset、malformed strict error、timeout分類、secret除外を含む。

再現手順（実providerはfixtureと分離、retryなし）:

```text
node scripts/extract-previous-evidence.mjs
node --import tsx scripts/replay-previous-malformed.mjs
node --import tsx scripts/verify-boundary.mjs
node scripts/analyze-boundary.mjs
```

詳細payloadはignoredの `test-artifacts/` と `.log` にのみ保存する。debugログにはrepository内容が含まれるため公開しない。

## Limitations

新規実検証の5 runはprovider availabilityに阻まれ、完全なtool→final往復は確認できなかった。過去の不正出力はSDK境界で確定できるが、モデルとobfuscated worker内部の区別にはprovider側wire telemetryが必要。観測用digestはSHA-256先頭16hexで、厳密なtext比較も併用する。
