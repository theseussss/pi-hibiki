# Changelog

## 0.1.8 — 2026-11-03

This release includes the improvements developed since the initial public 0.1.0 release.

### Native model limits

- Edit builtin/native and extension-provided physical chat models from the existing **Edit [2]** action.
- Override only **context window** and **maximum output** through Pi's exact-provider/exact-model `modelOverrides`; no copied or replacement native catalog.
- Distinguish current effective values, trustworthy directory references and explicit local overrides. Dynamic/account-dependent bases remain unknown when they cannot be established reliably.
- Blank restores inheritance for one field; reset clears these two overrides without deleting unrelated fields. A diff and separate confirmation precede saving.
- Keep OAuth, credentials, endpoints, protocols, full-model editing and add/remove protection unchanged. Virtual aliases do not receive ineffective overrides.
- Refresh the canonical current model without restoring an intervening selection or changing the global default.

### Dense home and task navigation

- Retain one provider per row, middle ellipsis, row-local horizontal windows and persistent search/details/actions. Only provider rows scroll.
- Home Tab/Shift+Tab moves between objects and actions; Alt+digits execute visible commands. Task pages use ordinary field/list/action navigation.
- Responsive shared action columns preserve positions across same-width state changes. Fast remains scoped to an eligible current model.

### Adding models and credentials

- Separate not-read, successful-empty, all-already-configured, failed/cancelled and no-filter-match states.
- Filtering never creates IDs or sends discovery requests. Exact manual IDs use a separate form and join drafts only; final saving remains independent.
- Supplier discovery uses that supplier's endpoint/API, not the first model's override.
- Direct keys share Pi's `auth.json` with `/login`, with coordinated config/auth outcomes, compatible native locking and protected pending recovery. OAuth and unrelated metadata are preserved.
- Harden cancellation, live target/revision guards, same-current metadata refresh and pending-state request barriers.

### Compatibility and upgrade notes

- Tested compatibility target: **Pi 1.4.0 and Node.js 24**. Unknown SDK/storage bindings remain fail-closed.
- Protected management records require the supported Windows DPAPI backend (including the reviewed WSL path). A Linux/macOS protection backend is not implemented; full native-Windows acceptance is not claimed.
- Context/output overrides are local budgets, not an expansion of upstream capacity or recovery of compacted history. No paid capability test runs automatically.
- New `model-limits` protected history is understood by 0.1.8. After using this editor, older Hibiki may refuse relevant management because the new history kind is unknown. Reverting code does **not** roll back model values/history; do not delete or rewrite protected records to bypass this safeguard.
- Do not load the internal picker separately or stack legacy picker/Fast entries with the single public extension entry. Existing windows do not automatically adopt an updated package.

### Verification

- Strict source verification: **906/906** tests, no failures/skips/cancellations, plus typecheck and package checks.
- Package-equivalent entry/production/native-host/installed-SDK verification: **27/27**.
- Seven isolated installed-Pi proofs cover builtin models, newer offline directory inheritance, static/native extensions, OAuth projection, unknown IDs and virtual aliases.
- Actual Pi terminal routes verify native-limit editing, separate save/reset confirmation, current-model metadata and clean exit using synthetic profiles with denied transport.
- Same 104-model home fixtures at 120/80 columns retain identical rendering to the preceding dense-home version.

These gates use synthetic data and do not claim real-provider capacity, universal platform support or native WezTerm acceptance.

## 0.1.0

Initial public release of Hibiki's model workspace and session Fast policy.
