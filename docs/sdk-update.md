# Qoder Agent SDK 更新記録（1.0.51 / 1.0.56 / 1.0.59）

## 背景

依存を `@qoder-ai/qoder-agent-sdk` 1.0.32 から 1.0.51 に更新した（package.json / package-lock.json は `npm install --ignore-scripts` で更新）。その後 `npm rebuild @qoder-ai/qoder-agent-sdk --foreground-scripts --no-audit --no-fund` で Worker をダウンロードし、チェックサム検証と `runtime-info.json` の `1.1.66` を確認した。本ドキュメントはブリッジ側の対応範囲・実装結果・未検証の境界を記録する。

## 実施した変更

### SDK 失敗の構造化分類（`SDK_ERROR_CODE`）

SDK が `query()` またはイテレータから送出する既知のエラークラスを、安定した接頭辞コード付きの `errorMessage` に分類する。いずれも分類のみであり、再試行可否を主張せず自動リトライも行わない。

| コード | 対応する SDK エラー / 意味 |
| --- | --- |
| `SDK_PROTOCOL_VERSION_MISMATCH` | `ProtocolVersionMismatchError` — CLI が通知したワイヤプロトコルのメジャー版がこの SDK ビルドと不整合 |
| `SDK_UNSUPPORTED_CLI_CAPABILITY` | `UnsupportedCliCapabilityError` — 実行中の qodercli が必要 capability を advertise していない |
| `SDK_CONTROL_REQUEST_TIMEOUT` | `ControlRequestError` で `code === CONTROL_REQUEST_TIMEOUT_CODE` — 外向き制御要求がローカルタイムアウトを超過 |
| `SDK_CONTROL_REQUEST_REJECTED` | `ControlRequestError` のその他の runtime code — 実行環境が制御要求を拒否 |
| `SDK_MODEL_POLICY_TIMEOUT` | `ModelPolicyTimeoutError` — `resolveModel` が `resolveModelTimeoutMs` 内に返らない |
| `SDK_HOOK_STOPPED` | 終端 result の `terminal_reason === "hook_stopped"` と保留ツール呼び出し — Hook がターンを終了 |
| `SDK_TERMINAL_ERROR` | 非 `success` subtype または `is_error` の終端 result |

`ControlRequestError.retryable` は SDK 自身の保証値として `errorMessage` 末尾の `[sdk-reported-retryable]` と `sdk_error_classification` 診断イベントにそのまま転記する。`error.details` は資格情報を含み得るため一切表面化しない。`AbortError`（SDK 側・ブリッジ側とも `name === "AbortError"`）は既存の aborted 分類を維持し、SDK 失敗分類より優先する。

### errorMessage と診断の秘匿

供給された `apiKey`（PAT）の完全一致、`Bearer <token>`、`api_key=`/`token:`/`secret=`/`password=`/`authorization:` 形式の代入値は `errorMessage`・`onWarning`・診断ペイロードで `<redacted>` に置換する。`assistant` メッセージの `message.error` や result の `errors[]` も同じ経路を通る。

### 終端 result メタデータ

- `error_code`：診断情報として扱い、値だけで成功・失敗を推測しない。判定の基準は `subtype` / `is_error`。成功結果の未知コードも互換性を保持する。`sdk_terminal_metadata` は失敗結果にも通知する。有限数と64文字以内の識別子形式の文字列のみを保持し、自由形式の値は省略、秘密情報は秘匿する。
- `terminal_reason`：モデルの `stop_reason` とは独立した「agent の終了理由」。文書化済みの `hook_stopped` のみ特別扱いする。
  - 保留ツール呼び出し（envelope または native tool_use）がある場合：Hook が停止したターンのツールを Pi に解放すると停止済みの処理を実行してしまうため `SDK_HOOK_STOPPED` で fail closed。
  - テキストのみの場合：通常どおり完了し、`hook_stopped_result` 診断を記録。`stop_reason=tool_use` とテキストの不一致は STOP_REASON_CONTRADICTION としない（誤解を招く分類を避ける）。
  - 未知 / 欠落した値は `terminal_reason_observed` / `sdk_terminal_result` に記録するだけで、互換性を保つ。

### agents_md_size_warning / onWarning

`system` / `agents_md_size_warning` メッセージは、宣言済みの構造フィールド（kind・code・severity・total_bytes・threshold_bytes・load_status・file_count）のみを切り出して `options.onWarning` へ通知する。モデル本文・ツール実行・ファイル内容・任意のイベントフィールドは転送しない。`QODER_BRIDGE_DEBUG` / `onDiagnostic` とは独立して動作し、コールバックの例外は飲み込んで provider 結果を変えない。`commands_changed` / `available_models_update` は無視してよい（ツールやコマンドに昇格しない）。

### /qoder-bridge-status

インストール済み SDK のバージョンを package メタデータから表示する。qodercli が PATH に無くても動作し、Worker やランタイムは起動しない。CLI ログインファイルの有無（独立した `qoder login` の結果）と SDK Worker とのペアリングは別物である旨を明示する。

## 互換性レジストリ

解析 / identity の監査済みバージョンは 1.0.32 のみ。1.0.51 は全 capability が **UNVERIFIED** のまま。`installedQoderSdkVersion()` が実インストール版を返すテストを 1.0.51 に更新し、UNVERIFIED 状態を断言した。capability の自動昇格はしない。

## 保留（未実装）機能

- ライブモデルカタログ / `available_models_update` による動的モデル一覧
- BYOK 設定管理 UI（daemon 経由の `byok_config_management_v1` capability）
- daemon / セッション永続化、追加の認証モード（serviceAccount / jobToken）
- SDK 側ツール実行、画像入出力、persistent goals / plan mode の活用
- SDK tool_use のネイティブ実行境界（`QODER_UNVERIFIED_NATIVE_FALLBACK` は引き続き起動前ブロック）

## 検証と限界

- 独立レビューで新規テスト5件の不備を検出し、実 SDK エラークラスの生成と有効なツール定義に修正した。成功結果の未知 `error_code` を誤って失敗扱いする処理も修正した。
- SDK対応差分の独立レビュー判定は `OK`。その後の期限表示修正を含む最終検証では `npm run typecheck` 通過、`npm test` は223件通過・失敗0件・3件skip（計226件）。skipは未証明のnative実行境界であり、合格数に含めない。SDK診断の集中テストは18件、queue/timeoutの集中テストは10件。fake Queryによるオフライン検証で、実通信の成功を示すものではない。
- `git diff --check` と `npm pack --dry-run --json --ignore-scripts` 通過。配布対象に `node_modules` / Worker は含まれない。既存の未コミット変更8ファイルは退避コピーとのハッシュ一致で保持を確認した。
- 1.0.51 の実挙動（terminal_reason の実値集合、error_code の意味、Worker の握手）は実通信で未検証。ライブ確認には Qoder 認証済み環境での `scripts/verify-provider.mjs` / `scripts/verify-boundary.mjs` の再実行が必要。
- `docs/unsupported-native-fallback.md` の監査表は 1.0.32 基準のまま。1.0.51 の公開契約再確認でもnative実行境界は未証明で、capabilityの昇格は行っていない。

## live_revalidation

2026-10-11、SDK `1.0.51` / Worker `1.1.66`、既存CLI認証、モデル `Qwen3.8-Flash` のみで再検証した。コマンドは `node --import tsx scripts/verify-normalization.ts --live --rounds 1 --out-dir test-artifacts/sdk51-revalidation`。対象はリポジトリ内のallowlist読み取りのみ、各turnの絶対期限300秒、外側の実行上限1200秒。失敗の置換・追加リトライはしていない。

| case | 保存済み結果 | 観測 |
|---|---|---|
| basic | SERVICE_FAILURE | 約302秒で `PROVIDER_UNAVAILABLE`。ツール実行0回 |
| sequential | SERVICE_FAILURE | read→grep→lsの3実行・結果返却は成功。最終回答の継続で `POST_TOOL_CONTINUATION_TIMEOUT`。ケース全体約649秒 |
| batch | FULL PASS | 同一応答のread+ls、2結果返却、package nameと固定最終行まで成功。約177秒 |
| error-recovery | 未保存・中断 | 外側1200秒の上限でcampaign停止。成功・provider failureのどちらにも数えない |

4予定中、完全記録3件、full pass1件、service failure2件。保存済み全recordを `evaluateAttempt` で再評価し、元の判定と一致した。SDK受信textに余分な `}` 等の不正envelopeは保存済みrecordでは観測しなかったが、少数標本なので修正済みとは断定しない。可用性と継続停止は再発し、解消確認はできなかった。40回の受入campaignを完了したという主張ではない。

原record: `test-artifacts/sdk51-revalidation/attempts-1791696380489.jsonl`。中断状態を含む派生集計: `test-artifacts/sdk51-revalidation/partial-summary.json`。原recordは変更していない。証跡はignored領域に保存し、配布しない。

検証中のsource SHA256は `e025695511ff42dfcae99440dddff677d7ebbba27ef5c1c34db804a0fec81365`。実測後に、絶対期限到達を残り時間だけの「no provider message for 約1秒」と表示していた診断を修正した。修正後は既存の分類コードを保持しつつ `total deadline 300000ms reached (elapsed ...ms)` と表示する。待機時間・実行権限・リトライ条件は変更していない。この表示修正は当時オフライン回帰テストのみで確認した。後日の新sourceでの実通信は次節に記録する。

## live_revalidation_2026_10_22

ユーザー承認により `Qwen3.8-Flash` で4ケース各1回を実行した。コマンドは `node --import tsx scripts/verify-normalization.ts --live --rounds 1 --out-dir test-artifacts/qwen38flash-smoke-20261022-224855`。SDK `1.0.51`、Node `24.19.0`、package `0.4.0`、各turnの絶対期限300秒。4予定を全件記録し、失敗の置換・追加リトライは行っていない。全体約21分15秒、CLI終了コード1。

| case | 結果 | 観測 |
|---|---|---|
| basic | SERVICE_FAILURE | 約302秒。`PROVIDER_UNAVAILABLE: total deadline 300000ms reached`、ツール実行0回 |
| sequential | SERVICE_FAILURE | 約302秒。初回応答で同じ期限到達、ツール実行0回。逐次継続の成否は未検証 |
| batch | FULL PASS | 約371秒。read+lsを同一応答で要求し、2結果返却後にpackage nameと固定最終行を含む最終回答。期限は各turn単位のためケース合計は300秒を超え得る |
| error-recovery | PROTOCOL_FAILURE | 約300秒。SDK受信textが閉じタグ位置で `</pi_tool_call>` ではなく `<pi_tool_call>` を出力。不完全envelopeとして拒否、ツール実行0回。ENOENTからの回復には到達しなかった |

full pass **1/4**、service failure **2/4**、protocol failure **1/4**。実ツール実行は許可されたread/lsの計2回のみ、予定外実行0回。原4recordを現行 `evaluateAttempt` で再評価し、保存済みverdictと全件一致した。source/harness hashも実行前後と再評価時に一致した。

- source SHA256: `a9cf18e41652a37f9d9cbc2354faf7df135bc3daf1f1e6dc12758f2ce46d93d0`
- CLI SHA256: `8daf7bdbd84a1225cd94c9017ebfe5edffe01231491393d80416ed3950a407e4`
- gate SHA256: `1ed993e079543314b776e548c3351bf4520230ca54e6a95f0bb922019fd5675b`

原record、summary、再評価結果は同じignoredディレクトリの `attempts-1792676936645.jsonl`、`summary-1792676936645.json`、`offline-verdict-audit.json` に保存した。配布対象には含めない。

期限表示の修正は実通信でも確認できた。一方、可用性の問題と不正なツール要求形式は再発した。SDK/provider内部の原因は未確定。今回post-tool timeoutや完了済みcallの再要求が観測されなかったことは、解消の証明ではない。native probe・capability昇格・parser修復・自動retryは行わず、native fallbackは無効のまま維持する。40試行の受入は未達であり、この4件を成功試行へ置換して継続しない。

## queue_diagnostic_2026_10_22

旧harnessはsystem/init・queue・command lifecycleを保存していなかったため、待機箇所を切り分けられなかった。`scripts/live-verification.ts` に構造情報のみのSDK観測を追加し、`scripts/verify-normalization.ts` の各turnの `providerTrace.sdkObservation` に保存するようにした。本文・tool input・任意のSDKフィールドは新しい観測に含めず、識別子文字列、有限数値、boolean等を選別する。monotonic受信時刻付きtimelineは最大256件、超過件数と集計は別保存。SDK iterator/closeが終了しなくてもsnapshotを取得できる。既存のprivate `sdkResponses` は従来どおり別に保持する。

CLIに `--case basic|sequential|batch|error-recovery` を追加した。未指定は従来の4cases、指定時は対象caseのみ。productionのモデル・query options・期限・承認・parser・retry条件は変更していない。型チェック通過、全テスト **243成功・失敗0・3 skip（計246）**。SDK next/closeが両方終了しないfixtureでもqueue証拠を保存できることを回帰検証した。

ユーザー承認により `Qwen3.8-Flash` のbasicのみ1回を実行した:

```sh
node --import tsx scripts/verify-normalization.ts --live --case basic --rounds 1 --out-dir test-artifacts/qwen38flash-queue-diagnostic-20261022-232614
```

約302秒で `PROVIDER_UNAVAILABLE`、ツール実行0回、追加retryなし。観測32件・drop0件・capture error0件。受信時系列:

| 経過 | 観測 |
|---|---|
| 3.380秒 | SDK init。Worker `1.1.66`、protocol `1.5.0`、model `Qwen3.8-Flash`、tools数0 |
| 3.569秒 | command lifecycle `started` |
| 3.874秒〜297.194秒 | queue通知20件、すべて `queued / service_available=false`。同じrequest_set_id内でrequest_idは10種類。約32秒周期の進行通知が届いた |
| 300秒 | bridgeの絶対期限到達。最後のqueue_wait_elapsed_msは291098、ready/model eventは未観測 |

**今回の失敗点は、SDK初期化・コマンド開始後、モデル応答前のqueue/availability待機に限定できた。** Piのtool executorやtool結果後の継続へは到達していない。SDKは `wait_time_ms=30000`、`queue_max_wait_ms=3600000` を通知したが、bridgeは従来どおり300秒で停止した。queue_count=0は供給能力がある証拠ではない。request_idの変化は記録できたが、対応するHTTP要求を観測していないため実ネットワーク試行回数とは断定しない。`api_retry` と `control_request_progress/api_retry` は0件であり、queue内部の再要求とこれら明示retryイベントは区別する。

内部の容量不足・アカウント条件・transport等の根本原因は未確定で、サービス全体の障害とも断言しない。起動時hookの構造イベントも届いたが、今回その後command開始とqueue通知へ到達した。secretを含み得るhook本文や設定ファイルは収集・変更していない。init receiptだけで認証成功やprovider-readyを推測しない。

原record `attempts-1792679175228.jsonl`、summary `summary-1792679175228.json`、`offline-verdict-audit.json` を上記ignoredディレクトリに保存した。現行gateによる再判定は保存verdictと一致し、source/harness hashも一致した:

- source: `a9cf18e41652a37f9d9cbc2354faf7df135bc3daf1f1e6dc12758f2ce46d93d0`（production変更なし）
- CLI: `5e0725269fede813e8d2a19da5aa80fa0e4c23e85a421182ef616a01b2b5422c`
- gate: `c49875d8824c1fea2ee1aa6574938efe1e7252941ea3204042c169e9c2c42588`

同条件の連続試行や40件campaignはこの時点で停止した。以降、利用可能状態について追加確認を実施した結果を次節に記録する。native fallbackや別モデルでの自動救済は行わない。

## availability_confirmation_2026_10_22

ユーザーの「使えるはず」という指摘を受け、モデル一覧とツールなしの最小応答で追加確認した。**Qwen3.8-Flashが実際に利用可能であることをSDK標準Worker経路で確認した。** 以前の `service_available=false` は各試行中のqueue状態であり、モデル自体の恒常的な利用不可やアカウント不備を意味しない。

- 独立CLI `1.1.64` の `qodercli --list-models` に `Qwen3.8-Flash` が掲載された。CLIとSDK Worker `1.1.66` は別バージョンのruntimeである。
- [公式無料案内](https://docs.qoder.com/events/flashoffer)は、Qoder Internationalの個人ユーザー向け無料期間の延長（Free/残高0も対象、Teams/Enterpriseは対象外）を明記し、混雑時は応答が遅くなると説明している。これは一般提供条件であって、アカウント種別を検査した証拠ではない。
- SDK `1.0.51`、既存 `qodercliAuth()`、標準Worker、`Qwen3.8-Flash` 固定で、ファイル・ツール操作を求めない `Reply exactly QWEN_AVAILABILITY_OK. Do not use tools.` を1回送信した。productionコード・設定・既存期限は変更していない。診断専用probeは300秒を上限とし、自動retryや別モデルへのfallbackを追加していない。
- initは3.175秒、command開始は3.691秒。その後は約33秒周期の `queued / service_available=false`。268.292秒で `ready / service_available=true`（queue_wait_elapsed_ms=259211）へ変化し、268.706秒で最初のmodel eventが到達。約269.298秒でsuccess終端と完全一致の `QWEN_AVAILABILITY_OK` を確認した。native tool要求は0回。
- 同queryで `initializationResult()` を待ってから公開 `getAvailableModels({fetchStrategy:'live'})` を呼ぶ読み取り専用の確認も試したが、45秒の診断用待機上限で未完了だった。どちらの待機段階で止まったかはこのprobeでは区別していない。モデルの有効/無料フラグをAPIから確認できたとは主張せず、モデル一覧の確認未完了と推論の成功を別結果として記録した。

原観測はignored `test-artifacts/model-availability-20261022/worker-result.json`、実行用probeは同ディレクトリの `probe.mjs` に保存した。SDK init・queue・model eventは33件、drop/capture errorは0件。アカウント識別情報・credentialファイルは読み取らず、モデル本文は固定応答の一致判定のみを保存した。

**結論:** モデル指定とSDK標準経路は成立する。今回の長い待機はqueue解放前に集中しており、前回の300秒停止と整合する。ただし混雑・優先度・アカウント条件等の内部原因や、prompt差の影響は断定できない。最小応答の成功はツール4cases/40試行の受入合格ではなく、300秒以上待つ別の試行や不正envelopeが解消した証拠でもない。

## queue_deadline_fix_2026_10_23

ユーザーの修正依頼により `DEFAULT_TOTAL_DEADLINE_MS` を **300000msから900000ms（15分）**へ変更した。これは各stream/turnの固定上限であり、queue heartbeatでは延長しない。明示された `options.totalDeadlineMs` は優先し、abortは従来どおり即時適用する。通常応答のsilence bound120秒・post-tool15秒・queue120秒、ready/model event後の通常監視への復帰、parser・実行所有・retry条件は変更していない。15分は混雑への有限の許容で、SDKの最大queue時間1時間や利用成功を保証するものではない。

### offline_verification

- `npm run typecheck` 通過。`npm test` は **246成功・失敗0・3 skip（計249）**。
- fake clockで初回/continuationの両方について310秒以上のqueueからready→最終textへ進めることを検証。さらに900秒上限ではheartbeatが続いていても停止・closeすることを検証した。
- private隔離コピーだけで定数を旧300000msに戻すと、新規の初回/continuation回帰2件が両方 `total deadline 300000ms reached` で失敗した。production sourceは変更せず、実時間5分を待たずにred/greenを確認した。
- 明示的な短い期限、queue silence、ready後の短い継続silence、abortの既存回帰も通過。
- READMEとCLI dry-runの期待を新しい既定値に整合。旧campaignの期限・記録は保持した。

### live_verification

JST 2026-10-23（UTC 2026-10-22）、`Qwen3.8-Flash` / SDK `1.0.51`でbasicケースを1回実行し **FULL PASS**。

```sh
node --import tsx scripts/verify-normalization.ts --live --case basic --rounds 1 --out-dir test-artifacts/qwen38flash-deadline-fix-20261023-012037
```

- turn1は330897msでqueue ready、331770msでモデル応答開始。**旧300000ms上限を超えた後に**有効なread要求を受信し、Pi側allowlistでpackage.jsonを1回読んだ。
- turn2は298813msでready、299475msでモデル応答開始。package nameと独立最終行 `QWEN_LIVE_BASIC_1` を含む最終回答を得た。
- case全体632740ms（約10分33秒）。1予定1実行1成功、実tool execution1回、予定外実行・追加retry・format修復なし。15分はcase全体ではなく各turnの上限。
- SDK観測のdrop/capture errorは両turnとも0件。原recordから現行 `evaluateAttempt` で再判定して全verdictが一致し、source/harness hashも一致した。

証跡（ignored）: 同ディレクトリの `attempts-1792686038974.jsonl`、`summary-1792686038974.json`、`offline-verdict-audit.json`。source SHA256は `261804672b59cad91f94f800dbf05daac92011930f41612e101599b6b0e3566f`、CLI `5e0725269fede813e8d2a19da5aa80fa0e4c23e85a421182ef616a01b2b5422c`、gate `c49875d8824c1fea2ee1aa6574938efe1e7252941ea3204042c169e9c2c42588`。

今回の修正で、実際に旧5分を超えるqueue待機からツール結果後の最終回答まで完了できた。ただし4cases/40試行全体の受入は未実施で、不正envelopeの再発・サービスの混雑・15分を超える待機は依然あり得る。

## ordered_cases_2026_10_23

ユーザー指定順に `Qwen3.8-Flash` のsequential→batch→error-recoveryを各1回、`--live --case <case> --rounds 1` で実行した。各turnの上限900000ms、source/harnessは前節と同じhash。失敗の置換・追加retryは行わず、安全ゲート違反はなかった。

| case | 所要時間 | 観測・結果 |
|---|---|---|
| sequential | 331079ms | 最初のtool要求前にSDK busy終端。実行0回、手順遵守は未検証 |
| batch | 666717ms | 約331秒でready。同一応答のread+ls要求を受け2回実行・結果返却。その後の最終回答継続でSDK busy終端。ケース全体は不合格 |
| error-recovery | 331688ms | 最初のtool要求前にSDK busy終端。実行0回、ENOENT回復には未到達 |

3件とも `SDK_TERMINAL_ERROR: The model is busy and could not complete the request. Please try again later. [error_code=10605]`。bridgeの900秒期限到達でも、不正JSONでもない。現行gateの生分類は `PROTOCOL_FAILURE` で、batchも `toolFlowPass=false` になるが、実際にはbatchの2件のtool resultが返却済みである。この分類上の限界を隠さず記録し、原verdictを事後変更しない。今後、SDKのサービス起因終端とプロトコル違反を区別する分類・部分成功の保持を改善する余地がある。

総所要1329484ms（約22分9秒）、full pass0/3、予定外tool execution0。SDK観測のdrop/capture errorは全turnで0件。原recordから `evaluateAttempt` を再実行して全verdict一致、実行後source/harness hashも一致した。追加試行や40件campaignは行っていない。

原証跡（ignored、各directory内にattempt/summaryあり）:
- `test-artifacts/qwen38flash-ordered-sequential-20261023-014939/`
- `test-artifacts/qwen38flash-ordered-batch-20261023-015531/`
- `test-artifacts/qwen38flash-ordered-error-recovery-20261023-020656/`
- 再評価集計: `test-artifacts/qwen38flash-ordered-summary-20261023/offline-verdict-audit.json`

先行basic成功と合わせても4casesの受入合格には達していない。15分化で旧5分超のqueueから応答できる点は確認済みだが、今回のSDK busy終端は解消していない。

## sdk_busy_classification_fix_2026_10_23

前節で観測したbusy終端 `10605` を、検証側 `classifyStreamError` で `SERVICE_FAILURE` とする厳密allowlistを追加した。`SDK_TERMINAL_ERROR: ` prefixと末尾の ` [error_code=10605]`、任意の直後の短い識別子形式 ` [terminal_reason=...]` を照合する。自由文の「busy」、単なる10605の言及、106050、未知code、区切り不正、末尾以外のcodeはこの新規ルールではサービス分類へ昇格しない。安全違反の優先と既存timeout/abort分類は維持した。

評価器・runner自体は変更しない。既存のservice failure経路は、すべての必須call/groupと対応resultのID・名前・件数・isError/ENOENT・実測package nameを検証した場合だけ `toolFlowPass=true` を保持する。不正resultや自己申告で部分成功にはしない。`responsePass` / `fullPass` は失敗のままで、成功化や自動retryの許可にはならない。production bridgeのSDKエラー接頭辞・実行・期限・parserにも変更はない。

- `npm run typecheck` 通過、`npm test` **252成功・失敗0・3 skip（計255）**。
- exact code/suffix、lookalike拒否、安全違反優先、busy前/途中/完了後、破損result、runAttemptの実行件数と追加retryなしをオフライン検証。
- 保存した旧gateから前節の3原recordを再評価すると旧verdictに全件一致。新gateの派生結果は次のとおり。

| case | 旧分類 | 新分類 | 新toolFlowPass | 新fullPass |
|---|---|---|---|---|
| sequential | PROTOCOL_FAILURE | SERVICE_FAILURE | false | false |
| batch | PROTOCOL_FAILURE | SERVICE_FAILURE | true（2結果の対応検証済み） | false |
| error-recovery | PROTOCOL_FAILURE | SERVICE_FAILURE | false | false |

元の3attempt/3summaryはSHA256一致で未変更を確認。新分類は別の派生比較 `test-artifacts/sdk-busy-classification-20261023/classification-comparison.json` に保存し、過去campaignの原集計を書き換えていない。追加SDK queryは0回。

旧gate SHA256 `c49875d8824c1fea2ee1aa6574938efe1e7252941ea3204042c169e9c2c42588`、新gate `08d26d7eaed3bc4b24afa258013bc1656ef98b45ed1726c8c56e1b5d8fecd7d1`。production sourceは `261804672b59cad91f94f800dbf05daac92011930f41612e101599b6b0e3566f` のまま。これは診断・集計の修正であり、提供元のbusy状態や4cases/40試行の受入未達を解消したものではない。

## ordered_recheck_2026_10_24

ユーザー承認によりsequential→batch→error-recoveryを各1回、新規試験として `Qwen3.8-Flash` で再確認した。前回の失敗は保持し、置換・追加retryは行っていない。source/CLI/gate hashは前節の修正後と一致し、各turnの絶対期限は900000ms。

| case | 所要時間 | 結果 |
|---|---|---|
| sequential | 940006ms（約15分40秒） | read→grep→lsを指定どおり逐次実行し3結果を返却。最終回答のturn4でbusy。toolFlowPass=true、fullPass=false |
| batch | 330705ms（約5分31秒） | 最初のtool要求前にbusy。tool実行0回、fullPass=false |
| error-recovery | 604751ms（約10分5秒） | sentinel readのENOENTを受けてpackage.jsonのreadに継続し、2結果を返却。最終回答のturn3でbusy。toolFlowPass=true、fullPass=false |

3件すべてSDK終端コード10605（model busy）による `SERVICE_FAILURE`。bridge期限到達や不正JSONではない。caseの合計時間は複数turnのため15分を超え得る。完全成功0/3、tool flowのみ成功2/3、実tool execution計5回、予定外実行・安全ゲート違反なし。最終回答まで含めた受入は未達。

原recordを現行 `evaluateAttempt` で再評価し、保存verdictと全件一致。source/harness hash一致、観測drop/capture errorは全turnで0件。実通信以外の補助PowerShellで `Get-FileHash` 不在とinline Node引用符の問題があったが、試験CLIはそれぞれ完了して原JSONを保存した。事後検証は別ファイルのNode scriptで実施し、モデル試験の再実行はしていない。

証跡（ignored）:
- `test-artifacts/qwen38flash-recheck-sequential-20261024-125652/`
- `test-artifacts/qwen38flash-recheck-batch-20261024-131248/`
- `test-artifacts/qwen38flash-recheck-error-recovery-20261024-131832/`
- 統合集計と検証script: `test-artifacts/qwen38flash-recheck-summary-20261024/offline-verdict-audit.json` / `audit.mjs`

試験時間合計1875462ms（約31分15秒）。3ケースが完全成功していないため、40件campaignには進んでいない。

## sdk_1_0_56_update_2026_10_24

ユーザー承認により依存を `@qoder-ai/qoder-agent-sdk` **1.0.51→1.0.56**へ更新した。`npm install @qoder-ai/qoder-agent-sdk@1.0.56 --save-exact --ignore-scripts --no-audit --no-fund` の後、対象SDKだけを `npm rebuild @qoder-ai/qoder-agent-sdk --foreground-scripts --no-audit --no-fund` で再構築。postinstallによるWorker取得・SHA256検証が成功し、`runtime-info.json` と実通信initで **Worker1.1.78 / protocol1.5.0** を確認した。ブリッジversionは0.5.0のまま、Node要件・Pi設定・認証情報は変更していない。

### changes_and_limits

- [公式SDKリリースノート](https://docs.qoder.com/release-notes/agent-sdk)では1.0.54のセッション終了処理改善、1.0.55の期限切れcredentialによる失敗修正を確認。調査時点で1.0.56の独立した記載はなく、queue/busy10605の解消も明記されていない。
- query/auth/queue/resultの公開契約は型互換。追加の `FrameTooLargeError` / `QoderCliInitializationError` は既存の汎用エラー経路で終端し、秘密情報の秘匿・tool emissionなし・追加retryなしを実クラスのfixtureで検証した。新しいSDKエラーコードへの個別分類は今回追加していない。
- native capabilityは1.0.56でもすべてUNVERIFIED。version awarenessテストを更新し、semverによる昇格をしない。native fallbackは無効のまま。

### live_catalog

推論を送らないAsyncIterableをpromptに指定して `getAvailableModels({fetchStrategy:'live'})` を実行し、モデル一覧を取得できた。送信user message0、assistant/stream event0、tool要求0。catalog取得は成功したが、3秒の終了待機上限内に `close()` はsettleしなかった。終了したと偽らず `closeUnsettled=true` を原証拠に残した（推論成功とは別の観測）。

| SDK表示名 | canonical value | 利用可能 | 現時点の無料フラグ/料金倍率 | 出力上限 |
|---|---|---|---|---|
| DeepSeek-V4-Pro | dmodel | true | isFree=false / 0.5 | 32000 |
| DeepSeek-Flash | dfmodel | true | isFree=true / 0 | 32000 |

この2表示名は既存の静的カタログにも存在しており、新モデル名を推測追加していない。実測メタデータに合わせ、DeepSeek2行の `maxTokens` のみ65536→32000へ修正。ID・contextWindow1000000・reasoning・effort mapは保持した。コスト欄は従来のplaceholderのまま、無料状態の将来保証や自動選択は導入しない。SDK一覧にはKimi/MiniMax等の表示変化もあったが、今回の依頼外の全モデル再編は行っていない。

原一覧: ignored `test-artifacts/sdk-1056-update/catalog-result.json`。credentialや個人のアカウント情報は記録せず、system modelの許可したメタデータだけを保存した。

### verification

- `npm run typecheck` 通過。全テスト **255成功・失敗0・3 skip（計258）**。DeepSeek登録メタデータ、SDK実version/UNVERIFIED、新SDK例外2種の汎用終端・秘匿を検証。
- `npm pack --dry-run --json --ignore-scripts` 通過。Worker/node_modules/原記録は配布しない。
- 無料フラグを取得できた2モデルでbasicのみ各1回。各turnの期限900000ms、SDK built-in tools無効・Pi側allowlist read1件・自動retryなし。DeepSeek-V4-Proにはリクエストを送っていない。

| model | 所要時間 | 結果 |
|---|---|---|
| Qwen3.8-Flash | 330598ms（約5分31秒） | SDK busy10605、SERVICE_FAILURE。tool実行0回 |
| DeepSeek-Flash | 469140ms（約7分49秒） | FULL PASS。read(package.json)を1回実行し、結果返却後にpackage nameと固定最終行を含む最終回答 |

DeepSeekのturn1は167637ms、turn2は298112msでqueue readyに到達した。共通basic planの固定marker `QWEN_LIVE_BASIC_1` を使ったが、実要求model・SDK initは両turnともDeepSeek-Flashであり、Qwenへfallbackしたものではない。両モデルともdrop/capture error0件。原記録から現行gateで再判定し、verdictとsource/harness hashが一致した。

証跡（ignored）: `test-artifacts/sdk-1056-update/smoke-Qwen3.8-Flash-1792827665123.json`、`smoke-DeepSeek-Flash-1792828148915.json`、`verification-summary.json`。source SHA256 `5a9210989810102cdd4f1f793cb00b01abc273de1df6523e4209bd045ee78edd`。

SDK/Workerの更新とDeepSeek-Flashのbasic往復は確認できた。一方、Qwen混雑は再発し、DeepSeekの逐次/batch/ENOENT回復や40件campaignは未検証。今回commit・push・version bump・npm公開は行っていない。

## sdk_1_0_59_update

npm registryの`latest`を確認し、作業開始時のSDK **1.0.56→1.0.59**へ更新した（直近commitの固定値は1.0.51）。既存の未commit変更は保持した。

### upstream_changes

公式の説明と配布物からの観測を分ける。

| 対象 | 確認できた変更 | 根拠・制限 |
|---|---|---|
| 1.0.54 / 1.0.55 | セッション終了時のcleanup改善／期限切れcredentialによる継続失敗の修正 | 公式リリースノート。既存1.0.56更新に含まれる |
| 1.0.57 | 同梱CLI 1.1.78→1.1.81 | 公式リリースノート |
| 現在の1.0.59 | Worker/CLI **1.1.83** | `dist/runtime-manifest.json`と取得済み`dist/_worker/runtime-info.json`。1.0.58/1.0.59個別の公式説明は取得ページにないため、以下を特定patchの修正と断定しない |
| 1.0.56→1.0.59 | 既定`query()`がプロセス内共有daemon上のsessionを利用 | `types/options.d.ts`、`daemon/global-daemon.d.ts`と配布実装。packageの既定launch modeはWorkerのまま |
| 同上 | `query.close()`はsession終了。daemonは次のqueryにも共有される。`closeGraceMs`は互換入力として残るが無視される | `daemon/daemon-session-transport.d.ts`と実装、`types/options.d.ts`。ブリッジは`closeGraceMs`を設定していない |
| 同上 | daemonのpermission modeは`default`/`acceptEdits`/`auto`/`bypassPermissions`。`dontAsk`は公開unionに残るが既定daemon経路では拒否される | `query/daemon-permission-mode.d.ts`と実装のvalidator。`yolo`はbypassのalias、`plan`は独立planModeを案内するエラー |
| 同上 | 共有daemonの認証・起動設定が競合すると`DaemonConfigurationConflictError` | 配布実装。異なるPAT、PAT↔CLI認証の切替は競合。既存daemonを別認証へ自動置換しない |
| 同上 | `Options.business`/`extraHeaders`、`generateSessionTitle()`の`sourceUserMessageId`/`customContext`を追加 | `types/options.d.ts`。extraHeadersは最初のqueryable inputの最初のmain-model requestとそのnetwork retryのみ。後続request/subagentへ継承されない。ブリッジでは未使用 |
| 同上 | `initDaemon()`の戻り値が`Promise<DaemonInitResult>`→`Promise<Daemon>`へ変更、`DaemonInitResult`/`DaemonFallbackReason`を削除 | `daemon/global-daemon.d.ts`。daemon初期化失敗時に旧直接CLIへfallbackせず失敗する。ブリッジはこれらのAPIを直接使用していない |
| 同上 | `StartDaemonOptions`にbusiness/launchMode/Worker path/heartbeat設定を追加、Process/Worker transportは共有daemonへの互換shimへ変更 | daemon heartbeat watchdogは既定120秒、capability交渉時のみ。既存のブリッジ側queue/absolute deadlineとは別の仕組み。ブリッジから設定は追加していない |
| 同上 | host-tool use/result、CodeMode host result、hook diagnosticsの型を公開。compact-boundaryにusage/modelRequestIds/agent_id、resultに`error_message`を追加 | `types/messages.d.ts`。新しいhost-tool経路のPi統合やnative実行許可は追加していない。resultの成功判定は従来通りsubtype/is_errorに従う |

公式資料: <https://docs.qoder.com/release-notes/agent-sdk>。配布version: <https://registry.npmjs.org/@qoder-ai/qoder-agent-sdk/1.0.59>。

混雑10605の解消、実通信の高速化、native request-only/handoffの成立は確認していない。Workerのversionだけでこれらの改善を主張しない。

### bridge_adaptations

- `package.json`/lockfileを1.0.59にexact pin。`npm install @qoder-ai/qoder-agent-sdk@1.0.59 --save-exact --ignore-scripts --no-audit --no-fund`の後、対象SDKだけ`npm rebuild @qoder-ai/qoder-agent-sdk --foreground-scripts --no-audit --no-fund`。Worker1.1.83の取得とSHA256照合が成功した。
- 非対応の`dontAsk`を`default`＋拒否専用`canUseTool`へ変更。**`bypassPermissions`は使わない**。`tools: []`、既存disallowedTools、`maxTurns: 1`、`persistSession: false`を保持。callbackは事前許可済み実行等の全経路を捕捉する保証ではなく、native安全性の昇格根拠にはしない。
- 非公開entrypointをimportせず、公開entrypointからexportされない競合classは`error.name`で`SDK_DAEMON_CONFIGURATION_CONFLICT`へ分類。retry・自動daemon停止・別認証での救済はしない。**PAT変更やPAT↔CLI切替後はPiプロセスを再起動する**。他queryが共有するdaemonを勝手に停止しない。
- READMEのライフサイクル説明とthird-party noticeのSDK版を更新。ライセンスは引き続きQoder Product Service Terms参照でMITではない。
- 既存DeepSeek出力上限32000を保持。今回モデル一覧の再取得・再編はしていない。
- native全capabilityは1.0.59でもUNVERIFIED。起動前gateと3件のskipを維持。

### verification

- `npm run typecheck`通過。
- `npm test`: **257成功・失敗0・3 skip（計260）**。daemon向けpermission設定、SDK承認要求のdeny、設定競合時のretryなし/tool emissionなし/秘密値の秘匿を回帰検証。queryFactory fixtureによる検証であり、実Workerの実行所有を証明する試験ではない。
- `npm pack --dry-run --json --ignore-scripts`でWorker/node_modules/原記録が配布対象外であることを確認。
- 実推論・catalog照会・live handoff試験は実施していない。1.0.56のDeepSeek成功結果を1.0.59の成功証拠として流用しない。サービス混雑・終了挙動・共有daemonの実通信互換性は未検証。
- ブリッジversionは0.5.0のまま。Node要件・Pi設定・保存credentialは変更せず、commit・push・公開も行っていない。

### live_recheck_1_0_59

ユーザー依頼により、更新後に推論なしの実通信を行った。

- `node --import tsx test-artifacts/sdk-1059-live/runner.mjs`：live catalog取得成功（16 system models、推論イベント0・送信user message0）。initでWorker1.1.83 / protocol1.5.0を確認。catalog取得まで3435ms（close時間は含まない）、closeは3秒以内にresolve、daemon shutdownは1173msでresolve。
- ただしQwen3.8-FlashとDeepSeek-Flashは両方とも`isEnabled=true / isFree=false / priceFactor=0.1`。無料と確認できるモデルがなく、予定したDeepSeekのbasic/sequential/batch/error-recoveryとQwen basicの**5件はすべてskip**。推論のfull passやtool flow passとして数えない。過去catalogから値は変わったが、SDK更新が料金変更の原因だとは断定しない。この段階では有料推論の承認待ちとして停止した。
- `node --import tsx test-artifacts/sdk-1059-live/probe-tools.mjs`：同じNodeプロセスで推論なしsession A→close→session B→closeが成功。closeはそれぞれ798ms / 792ms、最後のshutdownは1190msでresolve。前回1.0.56の`closeUnsettled=true`はこの条件では再現しなかった。ただし状態・終了条件の異なる少数観測であり、不具合の恒久解消やSDK単独の因果効果は証明しない。
- session Bのinitは193ms（Aは3142ms）。後続queryの起動成功とwarm pathの証拠だが、公開daemon identityの比較はしておらず、同一daemon再利用そのものを実証したとは言わない。
- **新たな注意点**：`tools: []`と既存deny list指定でもinitのtoolsに`mcp_call` / `mcp_get` / `mcp_list`の3件が両sessionで表示された。これらはSDK実装中でもreserved exposedNameとして扱われる。登録の観測と実行可否は別である。全probeは推論なしでtool要求・permission callbackとも0件のため、**callbackが実際に拒否したこと、MCP proxy実行の閉鎖、SDK executor=0の一般保証は検証していない**。「全SDKツールが確実に無効」との安全認定は行わない。
- native新公開`host_tool_use` / `host_tool_result`は公開型のコメント上host通知／output-only通知。これだけでPiへの実行所有移譲・approval・結果再注入を証明できない。native fallbackは引き続きBLOCKED、capabilityはUNVERIFIED。

原証拠（すべてignored）: `test-artifacts/sdk-1059-live/catalog-result.json`、`verification-summary.json`、`probe-tools-1794531823602.json`。各runnerと製品source/gateのSHA256を原証拠に保持。今回tracked sourceの挙動変更やcredential変更は行っていない。この時点でQwenのbusy10605改善とDeepSeekの4ケースの実推論互換性は**未検証**のまま。

### deepseek_live_inference_1_0_59

その後ユーザーがDeepSeek Flashの使用を指定したため、**DeepSeek-Flashのみ**を対象に実推論を行った。無料という説明はcatalogで確認できないため、`isFree=false / priceFactor=0.1`という取得値と、ユーザー指定による同モデル限定の推論承認を別々に証拠へ記録した。Qwenや別モデルへのfallbackは行っていない。

実行command: `node --import tsx test-artifacts/sdk-1059-deepseek-live/runner.mjs`。4ケース各1回、最大11 turnを計画し、SDK queryごとの期限900秒・campaign上限45分・自動retryなし。最後のqueryはcampaign残時間に合わせ期限を短縮した。標準production設定のまま、`maxTokens=2048 / reasoning=low`、許可するhost実行は既存planのread/grep/lsのみとした。

| case | 実測所要時間 | 結果 |
|---|---|---|
| basic | 901426ms（約15分） | SERVICE_FAILURE / PROVIDER_QUEUE_TIMEOUT。最初のturnで終了、応答・call・実行resultなし |
| sequential | 901036ms（約15分） | 同上。逐次呼出しの検証段階に到達していない |
| batch | 864361ms（約14分24秒） | 同上。残時間対応の期限863401msで終了。一括呼出しの検証段階に到達していない |
| error-recovery | 未実施 | campaign残時間不足で停止。ENOENT回復は未検証 |

- 計2672075ms（約44分32秒）、3 queryを送信。全queryでrequested/initのmodelはDeepSeek-Flash、Worker1.1.83 / protocol1.5.0が一致。init後にSDKが`queued / service_available=true / queue_count=1`を継続通知したが、ready・model event・terminal resultは受信しなかった。SDK内部api retryの観測も0。busy10605ではなく、ブリッジの有限期限によるqueue timeoutで終了した。
- この観測はSDKからのqueue status受信を証明するが、**実際のサーバー待ち行列の状態や、サービス／Worker／daemonのどこが原因かまでは特定しない**。1.0.56ではDeepSeek basic成功の証拠があるものの、今回の失敗だけでSDK更新によるregressionだと断定しない。
- query closeは1422ms / 1032ms / 959msでresolve。最後の`shutdownDaemon()`も1111msでresolveし、プロセスは終了した。旧版で見た終了待ち未完了は、このtimeout終了条件では再現していない。
- Pi側tool要求・実行はすべて0。permission callbackも0。実行に到達していないため、承認拒否・native ownership・MCP proxyの閉鎖を実証したとは扱わない。既知のMCP関連3件の登録は残る。native fallbackはBLOCKED/UNVERIFIEDのまま。
- source/package/gate/runnerのhash固定と各caseの原記録を保持。親が`node --import tsx test-artifacts/sdk-1059-deepseek-live/audit.mjs`で再監査し、hash一致・3件の派生verdict一致・model応答とtool実行なしを確認した。判定を成功へ緩和したり失敗を再試行で置換したりしていない。

原証拠（ignored）: `test-artifacts/sdk-1059-deepseek-live/verification-summary.json`、`case-DeepSeek-Flash-{basic,sequential,batch}-*.json`、`catalog-result.json`、親監査`parent-audit.json`。

**結論：初期化・catalog取得・有限timeout・session/daemon終了は動作したが、モデル応答を受信できず、未対応だった逐次／batch／ENOENT回復が正常化したとは確認できない。** 追加の長時間推論や期限延長は行わず、失敗証拠を保存して停止した。
