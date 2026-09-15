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

## Checkpoint 2 — implementation saved, final CI pending

- Hash-router placement corrected; Fair limited filter is mutually exclusive with native statuses.
- Feature disable restores native badges; native list metadata supports non-owner viewers.
- SQL tests cover separate users, disabled groups, quota resets and host/node/core isolation.
- Added a real VLESS upload/download test for aggregate pacing, user isolation and policy removal.
- Independent Host enforcement requires a dedicated inbound on one node. HS-enabled Xray and the node agent must share the policy directory.

## Checkpoint 3 — release verification

- Checkpoint 2 saved as `d56ef0398e9e4b0e10f0ddf5c4c8976fb7b4a354`.
- 49 Python tests pass locally, including Certbot-only discovery and the policy/acknowledgement boundary.
- Native browser and migration tests passed in run `34960462737`; its network test exposed an HTTP completion-versus-VLESS idle-timeout issue in the test harness, corrected without weakening byte or pacing assertions.
- CLI apply/restart now activates the native services integration before restarting. Installer validation covers every new script.

## Remaining release gate

- Run the new network and browser checks in CI, resolve any failures, then merge PR #8.
- Server installation is separate: no production node or panel has been accessed by this task.
