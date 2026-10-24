# Live normalization acceptance

## objective

実qoder-bridge/Qwen3.8-Flashで、ツール要求→Piによる実行→結果返却→必要な継続→最終回答の経路を検証する。runtimeのcompleteやモデルの自己申告だけでは合格にしない。SDK-native schema利用は実証前に可能と断定しない。実行・承認の所有者はPiのまま維持する。

## ordered_steps

1. この合格条件を固定する。
2. プロンプトと履歴を整理し、変更前後を実モデルで比較する。
3. native schemaを提示しつつSDKに実処理をさせず、Piへ要求を受け渡せるか最小実証する。
4. 上位の検証側に未完了検出を実装する。Bridgeに自然言語の完了を推測させない。
5. 選んだ経路で4ケース各10回、fresh contextの実モデル検証を行う。

## case_contracts

| case | mandatory tool-call groups | required tool results |
|---|---|---|
| basic | [read(package.json)] | name=pi-qoder-agent-sdk-bridge、versionは試験開始時の実ファイル値 |
| sequential | [read(package.json)] → [grep(終了タグ, extensions/index.ts)] → [ls(root,limit=10)] | 順序を守り、3結果とも成功。grepは実ソースと一致、lsは実ディレクトリと一致 |
| batch | [read(package.json), ls(root,limit=10)] を同一assistant messageで、この順序で発行 | 両方の結果を受け取ってから最終回答 |
| error-recovery | [read(事前確認した存在しないパス)] → [read(package.json)] | 最初はisError=true/ENOENT、次は成功。最初のreadは再試行しない |

すべてのケースで、ツール名・引数・grouping・回数・順序・対応result IDを検証する。未知の呼出し・範囲外パス・重複・予定外の再実行は実行前に拒否する。ソースは読むだけで、ツールに書込・外部操作・再委譲を許可しない。

## completion

- 必須groupをすべて実行し、対応する結果を返却するまでは合格にしない。
- モデルが通常text/stopを返しても、必須groupが残っていればINCOMPLETE_PLANとして失敗。自動の追加指示や暗黙のモデル再試行で成功へ置き換えない。
- 最終回答は結果を取得した後で、観測したpackage nameを含むこと。error-recoveryは最初のENOENTを報告すること。
- 完了マーカーは最終回答に印字する固定文字列であって、ファイル名・検索条件・観測対象ではない、とタスクに明記する。
- マーカーは独立した最終行に完全一致していることを検査する。本文に「マーカーが存在しない」と書くだけでは不合格。
- ツール経路の合否と、最終回答の指示追従の合否を分けて保存する。full passは両方が合格した場合のみ。

## transport_safety

不正JSON、欠けたタグ、未知ツール、schema違反を修復して推測実行しない。承認・実行をSDKへ無条件に移譲しない。native実証用handlerは呼出しを捕捉するだけで、ファイルを操作しない。native経路が不可なら制約と証拠を記録し、既存の厳格テキスト経路を維持する。

## sampling

- 比較試験は変更前後で同じplan/完了条件を使い、fresh historyにする。prompt変更とsystem history重複除去を区別できる形で記録する。
- 最終試験は各caseを10回、計40 case attempts。失敗を除外・置換せず、attempt/round/case/provider request IDを保存する。
- provider queueは既存の有限待機とabsolute deadlineに従う。PROVIDER_UNAVAILABLE、queue timeout等はservice failureとして別集計し、合格にはしない。予定された40 attemptsを超えて合格数が揃うまで無限に続けない。
- 各caseの失敗はそのcase内の追加呼出しを止める。format/model/service failureと実行・承認の安全性違反を区別し、安全性違反ならcampaign全体を止める。
- full pass=40/40を目標とするが、40回無失敗でも将来の完全保証とは表現しない。

## evidence

変更前の原証拠: test-artifacts/restart-qwen-audit.json（tool flow 3/4、full instruction success 1/4、7 executions）。各試験でsource hash、実モデル名、要求・応答、call/result、最終回答、失敗分類、所要時間を保存する。payloadログはprivate ignored test-artifacts内に保持し、packageに含めない。

## stage4_usage

段階4の上位gateは `scripts/live-verification.ts` (純粋関数・IO注入) と `scripts/verify-normalization.ts` (live CLI) に実装した。

```
node --import tsx scripts/verify-normalization.ts --live --rounds 10
```

- `--live` 無しでは計画とmarker一覧のみ出力し、SDKは起動しない。`--rounds` は1..10。4 cases x 10 rounds = 40 planned attempts。
- 待機診断などの限定試験では `--case basic|sequential|batch|error-recovery` を指定できる（例: `--live --case basic --rounds 1`）。未指定は従来の4cases。限定試験を40件の受入campaignと混同しない。
- 各turnの `providerTrace.sdkObservation` にSDK init・command開始・queue status・SDK内部retry・model eventの受信時刻と集計を保存する。新観測は本文を含まない構造フィールドのみで、timeline上限256件とdrop/capture error数を記録。initだけでreadyとは扱わない。既存のprivate `sdkResponses` は別途保持し、記録全体を公開・配布しない。
- gateは strict 引数検証を完了するまで工具を実行しない。許可対象は read=root package.jsonと事前確認absent sentinel、grep=extensions/index.tsの固定終了タグ文字列、ls=root limit=10のみ。範囲外・未知・重複・予定外呼出しはSAFETY_VIOLATIONでcampaign全体を停止する。
- 判定は生のattempt record (turns/executed results/observed package name) から `evaluateAttempt` が再導出する。自己申告やsnapshotだけではPASSにしない。toolFlowPass/responsePass/fullPassは別フィールド。
- attempt毎の全recordは `test-artifacts/normalization-campaign/attempts-*.jsonl`、総合summaryは `summary-*.json` に保存 (ignored)。stdoutは進捗行とsummaryのみ。終了コードは全planned attemptがfull passのときのみ0。
- service failure (PROVIDER_* timeout、deadline、abort、および観測済みSDK busy終端コード10605) は別集計でPASSにしない。SDK busyは安定した `SDK_TERMINAL_ERROR:` prefixと末尾の構造化 `error_code` を厳密照合し、本文の「busy」や未知コードだけでは昇格させない。全必須groupのcall/result対応・成功条件が確認済みの場合に限り、最終回答でservice failureとなっても `toolFlowPass=true` を保持する。source hashとpackage versionはcampaign開始時に固定し、attempt前にdriftを再検査して変更時は停止する。

## followup_campaign

前campaignの40試行（150秒deadline、full pass30/40）は原record/summaryを保持する。追加campaignは失敗を置き換える再試行ではなく、改善後の別40 planned attemptsとして記録する。

- production contractに、指定された独立callのsame-turn grouping、結果依存callの逐次継続、exact final line/token/error codeの逐字・大小文字保持を明記する。受信textの修復、ENOENT/marker判定の緩和はしない。
- CLIはexportされた `DEFAULT_TOTAL_DEADLINE_MS` を再利用する。このfollowup campaign当時は300000msだった。後続のqueue待機対策ではproduction既定を900000ms（15分）へ変更し、CLIも同じ値を使用する。旧campaignの期限・hash・失敗記録は書き換えない。queue silence・post-tool silenceの設定は変更しない。
- deadlineとCLI/gate moduleのSHA256をdry-run/各attempt/summaryに保存する。既存source/package確認に加え、harnessファイルのrealpathとhashを実行境界で再確認し、drift時はcampaignを停止する。
- 実行方式はユーザー承認によりMain直接へ切り替えた。SDK/tool承認所有、read-only allowlist、40予定試行、失敗保持の条件は同じ。
- 前campaignとはpromptと試験deadlineの両方が異なるため、結果の差を単一変更の因果効果と断定しない。保存したhash/期限が一致するコードで判定を再導出する。

## release

npm test、typecheck、安全性の回帰テスト、実モデル試験結果を親が統合して判断する。この手順の承認だけでversion bump、commit、push、npm publishは実行しない。
