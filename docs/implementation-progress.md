# Implementation checkpoints

Repository: PEDIHS/HS-PG — PR #8, branch `feat/hs-native-integration`.
Recovery baseline: `7390611`; changes are applied on top of `3d897eee` without rewriting main history.

## Checkpoint 1 — saved and verified

- Firewall removed, including upgrade cleanup of HS units, assets, Python hooks and owned nftables tables.
- Certbot-only inventory, renewal and redesigned certificate cards.
- WARP in native Core Outbounds; MTProxy in native Inbounds; uniform feature switches.
- Per-Host Fair Use UI, separate user accounting, derived status and custom Xray pacing adapter.
- GitHub commit `b6219bbdf44352cbe5645acf6409b3f31525bf5d`.
- GitHub Actions run `34959623935`: all three jobs passed (backend/browser/migration, native patch compatibility, Xray race tests and build).

## Checkpoint 2 — implementation saved

- Hash-router placement corrected; Fair limited filter is mutually exclusive with native statuses.
- Feature disable restores native badges; native list metadata supports non-owner viewers.
- SQL tests cover separate users, disabled groups, quota resets and host/node/core isolation.
- Added a real VLESS upload/download test for aggregate pacing, user isolation and policy removal.
- Fair Use is keyed by the effective inbound: Hosts sharing an inbound share one synchronized policy. Group policies support always-on or per-user threshold limits; Host/Group overlap uses the strictest active cap and node ACK gating remains mandatory.

## Checkpoint 3 — release verification

- Checkpoint 2 saved as `d56ef0398e9e4b0e10f0ddf5c4c8976fb7b4a354`.
- 49 Python tests pass locally, including Certbot-only discovery and the policy/acknowledgement boundary.
- Native browser and migration tests passed in run `34960462737`. The network fixture was corrected to stop on a complete HTTP body and explicitly allow its exact loopback endpoint; the pinned Xray version blocks private destinations from VLESS by default. Production routing was not changed for this test.
- CLI apply/restart now activates the native services integration before restarting. Installer validation covers every new script.

## Final verification — passed

- Tested code commit: `55605c4302274a5c9e2c7cb4b985165a7665d689`.
- [GitHub Actions run 34961099959](https://github.com/PEDIHS/HS-PG/actions/runs/34961099959): all three jobs passed.
- 49 Python tests; DOM and Chromium scenarios; firewall removal migration; native patch compile/idempotence.
- Xray build and race tests, including policy changes on an existing session.
- Real VLESS test: concurrent upload/download shared one budget (2.02 s); the other user and policy-reset transfer completed below the two-decimal timing resolution.
- Built node binary: `xray-hs-fair-linux-amd64` artifact in the verified workflow run.
- All implementation and diagnostic stages are committed on PR #8. This final entry changes documentation only.

Server installation is separate: no production node or panel has been accessed by this task. Activate the HS node agent and custom Xray as documented in `hs-services.md`; saving a Host policy alone does not install the adapter.
