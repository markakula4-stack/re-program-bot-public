# Contributing

Use a fork or branch and submit a pull request. Run the commands in README before requesting review.
Include a small regression test for a functional bug; use synthetic identities, balances and tokens.
Payment/refund/provider calls must remain mocked in tests. Never probe the live bot from CI.

Preserve server-authoritative identity, price, subscription ownership and explicit purchase consent.
Keep every authorization freshness proof and the D1 transaction boundary when changing query shape.
Do not increase limits or remove checks merely to make a test pass. Test stale/revoked access as well
as the successful case. Keep offline test expectations aligned with real `/session` responses.

Changing the UI requires preserving the accepted layout and both themes. If UI source changes,
regenerate assets with `node scripts/v1.4.0-rebuild-build-assets.mjs`, then run the asset check.

The owner should enable a main-branch rule requiring the `test` status and owner review, disallow
force pushes/deletion, and require approval for outside contributors' workflow runs. CODEOWNERS
does not enforce those account settings on its own. Fork code must never receive deployment secrets.
