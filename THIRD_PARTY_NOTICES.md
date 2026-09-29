# Third-party notices and publication review

This repository's own extension and documentation are MIT-licensed (see [LICENSE](LICENSE)). Portions of the initial bridge implementation were adapted from [pi-qoder-account-provider](https://github.com/liush2yuxjtu/pi-qoder-account-provider), MIT, copyright © 2026 liush2yuxjtu; its copyright notice is retained in LICENSE. This package does **not** vendor or bundle Qoder's SDK/runtime or Pi. npm resolves dependencies separately when installing.

| Package | Role | Published license / terms checked |
| --- | --- | --- |
| `@qoder-ai/qoder-agent-sdk@1.0.32` | runtime dependency | `SEE LICENSE IN LICENSE`; installed `LICENSE` refers to [Qoder Product Service Terms](https://qoder.com/product-service), **not MIT**. Its postinstall downloads a proprietary Worker runtime. |
| `@modelcontextprotocol/sdk` | transitive SDK dependency | MIT (npm metadata). |
| `zod` | SDK peer dependency | MIT (npm metadata). |
| `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` | host-supplied peers | MIT (npm metadata). |
| `lru-cache`, `minimatch` under Pi's peer dependency | transitive peer dependencies | BlueOak-1.0.0 (npm lockfile metadata), a permissive licence; see [official text](https://blueoakcouncil.org/license/1.0.0). |
| `@types/node`, `tsx` | development only | MIT (npm metadata). |
| `typescript` | development only | Apache-2.0 (npm metadata). |

**Not a legal clearance:** MIT applies to this repository, not to the Qoder SDK, its Worker, the Qoder name/trademarks, or Qoder's service. The Product Service Terms do not expressly grant a third-party SDK redistribution or brand licence. Because the SDK is an external npm dependency rather than included in our tarball, users install it under Qoder's own terms, but the right to distribute and use a Qoder-branded integration still merits review of the then-current terms or permission from Qoder before public release. This project is independent and not affiliated with Qoder or Pi. Do not publish the downloaded Worker or copy SDK source into this package.

A lockfile scan of 322 non-dev/peer dependency entries found MIT/ISC/Apache-2.0/BSD/0BSD/CC0/Unlicense entries, two BlueOak-1.0.0 entries, and the SDK's `SEE LICENSE IN LICENSE`; no copyleft licence was reported in that snapshot. This is metadata-level due diligence, not a complete legal audit or guarantee of current transitive packages. Check exact installed dependency versions and their upstream licence files again before release. No legal opinion is provided here.
