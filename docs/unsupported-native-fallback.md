# Unsupported native fallback

## status

**BLOCKED — 利用可能なnative fallbackはまだ実装・有効化していない。**

SDK 1.0.32で確認済みのnative tool_use parse／single identity／parallel identityと、未確認のexecution ownershipを区別するregistryを追加した。

| Capability | SDK 1.0.32 |
|---|---|
| native_tool_use_parse | SUPPORTED |
| native_single_identity | SUPPORTED |
| native_parallel_identity | SUPPORTED |
| native_host_owned_execution | UNVERIFIED |
| native_pretooluse_defer | UNVERIFIED |
| native_pi_approval_integration | UNVERIFIED |
| native_ambient_execution_closure | UNVERIFIED |
| native_sequential_production_path | UNVERIFIED |

未監査versionはすべてUNVERIFIED。semverでの自動昇格はしない。installed packageのversionを参照し、取得できなければUNKNOWNとして未確認扱いにする。

## sdk_1_0_51_recheck

2026-10-11にSDK `1.0.51` の公開型と公式permission/user-input契約を再確認した。新versionは引き続き全capabilityを **UNVERIFIED** とし、既存監査表の `SUPPORTED` を引き継がない。

- [Approval and User Input](https://docs.qoder.com/cli/sdk/user-input) は、事前許可済みツールは `canUseTool` を呼ばずに実行され、callbackは全ツール呼び出しを受け取らないと明記している。callbackの存在だけでPiのみの実行所有は証明できない。同文書は全tool callの観測にはhooksを案内しており、hooks自体が使えないと判断したわけではない。
- [Permission Control](https://docs.qoder.com/cli/sdk/permissions) と公開型には `PreToolUse.permissionDecision: 'defer'` が存在する。一方、公開型の `deferred_tool_use?: unknown` から、正確なcall ID/argsのhandoff・host実行結果の再注入・継続の安定した契約は確認できていない。
- 全built-in/MCP/plugin/agent/backgroundと起動時hook等を含め、SDK executor=0を保証するrequest-only境界は今回の調査でも未確認。機能が存在しない／最新版に必ず不具合があるという断定ではなく、受入条件に足りる証拠がない。
- 通常の厳格テキスト経路は `Qwen3.8-Flash` で実通信を行ったが、native schema/defer probeは実行していない。text往復の成功をnative実行所有の証拠にはしない。実通信結果と残る停止問題は `docs/sdk-update.md` の `live_revalidation` に記録した。

従って **READY_FOR_USE=NO** を維持する。提供元のrequest-only/handoff契約確認と、SDK executor=0 / real Pi executor=1 / Pi approval→continuationの独立した実証が再開条件。

## sdk_1_0_56_update

2026-10-24に依存SDKを1.0.56、Workerを1.1.78へ更新した。公開型のdefer/permission契約に実行所有を証明する変更は確認できず、1.0.56の全capabilityもUNVERIFIEDとする。DeepSeek-Flashのstrict text経路でbasic往復が成功したことは、native request-only/approval境界の実証ではない。起動前gateと3件のskipを維持する。更新・回帰・実通信の詳細は `docs/sdk-update.md` の `sdk_1_0_56_update_2026_10_24` を参照。

## sdk_1_0_59_update

依存SDKを1.0.59、Workerを1.1.83へ更新した。既定queryの共有daemon化はnative request-only境界の実証ではない。1.0.59も全capabilityをUNVERIFIEDとし、起動前gateと3件のskipを維持する。実推論・native handoffの実通信試験は今回行っていない。後続の推論なし実通信では、`tools: []`でもinitに`mcp_call` / `mcp_get` / `mcp_list`の登録が残ることを確認した。実行は観測しておらず、未実行のprobeからcallbackによる拒否やambient closureの成立を推定しない。新公開host-toolメッセージも通知用の型であり実行所有の移譲契約ではない。詳細は `docs/sdk-update.md` の `sdk_1_0_59_update` / `live_recheck_1_0_59` を参照。

## feature flag

`QODER_UNVERIFIED_NATIVE_FALLBACK=1` は現在**SDK queryを開始する前に拒否する安全gate**。native fallbackを動かす設定ではない。SDK起動前にはnative eventがあるか判断できず、起動後ではSDK側実行を防いだ証明にならないため、このflagではtext-only requestも含む全Qoder queryを止める。

- 未指定／`0`：従来のproduction挙動を維持。
- `1`：`SDK_AMBIENT_EXECUTION_CLOSURE_UNVERIFIED` の通常provider errorを返す。SDK query、toolCall emission、approval要求、executor起動、continuation retryは行わない。
- per-call `options.env` は既存env設定と同様にprocess環境より優先。

既定経路を今回新たに安全認定していない。1.0.59ではdaemonが`dontAsk`を拒否するため`permissionMode: "default"`と拒否専用`canUseTool`を使用する。`tools: []`／callback／`maxTurns: 1`、有限のdisallowedTools一覧はambient execution closureの保証ではない。事前許可済みの実行がcallbackを通らない制限も残る。

## normalization boundary

既存 `normalizeProviderResponse` はvalid native blockを既存の `{id,name,arguments}` へ変換する。ID／name／argumentsを保持し、unknown tool、malformed block、schema違反、coercion、duplicate IDを拒否する。parser cascadeやtext protocolの変更は行っていない。

この**pure mapping**ができることと、SDK eventを安全にPiへhandoffできることは別の条件。受信済みeventの変換は、それ以前のSDK executionを取り消せない。

既存同一message内duplicate guardとhistory ID再利用guardは保持した。production guardは同一IDの衝突を `DUPLICATE_ID` として拒否し、`CALL_ID_CONFLICT` を個別に分類していない。異なるIDでのcompleted semantic replay policyは今回新設・証明していない。過去offline evaluatorのguardをproduction guardと混同しない。

## observability

reason codesはhost execution／defer／approval／sequential／ambient closureを個別に保持する。reason classification自体はfallback／executionの許可ではない。

debug有効時、pre-query gateは `native_fallback_blocked` を記録する。SDK versionとreasonに加え、取得前のgenerationId／nativeCallId／normalizedCallId／toolNameはnull、approvalOutcomeはNOT_REQUESTED、executionOutcomeはNOT_STARTED。arguments、履歴、credentialをこのeventに含めない。未観測IDやapproval outcomeを推測しない。

有効なfallbackのmetadataや実approval/execution outcome連携は未実装。正常処理時のユーザー通知は新設しない。

## acceptance

新規testsにはT1–T14を明示するが、T6／T7／T14は根拠がなくskipとして残す。fake SDK streamやfake approval/executorのcountを実runtime ownershipの証拠にしない。T8／T9は既存拒否境界の検証であり、1回executionや完全なreplay policyの受入証明ではない。

`SDK executor=0 AND Pi executor=1` とPi approval→existing continuationの証明が未成立のため、**READY_FOR_USE=NO**。pre-query gateのquery count=0／tool emission=0はT14成功ではない。

再開条件は、SDK提供元がsupportedなrequest-only boundaryとambient execution closureを示すこと。その契約を再監査してcapabilityを個別に昇格し、Pi approval／execution／continuationを実際の統合境界で検証するまではfallbackを有効化しない。未確認defer、worker interception、SDK内部変更、JSON修復、別queryによる自動救済を導入しない。
