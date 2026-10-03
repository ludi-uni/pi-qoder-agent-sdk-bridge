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

## feature flag

`QODER_UNVERIFIED_NATIVE_FALLBACK=1` は現在**SDK queryを開始する前に拒否する安全gate**。native fallbackを動かす設定ではない。SDK起動前にはnative eventがあるか判断できず、起動後ではSDK側実行を防いだ証明にならないため、このflagではtext-only requestも含む全Qoder queryを止める。

- 未指定／`0`：従来のproduction挙動を維持。
- `1`：`SDK_AMBIENT_EXECUTION_CLOSURE_UNVERIFIED` の通常provider errorを返す。SDK query、toolCall emission、approval要求、executor起動、continuation retryは行わない。
- per-call `options.env` は既存env設定と同様にprocess環境より優先。

既定経路を今回新たに安全認定していない。`tools: []`／`dontAsk`／`maxTurns: 1`、有限のdisallowedTools一覧はambient execution closureの保証ではない。

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
