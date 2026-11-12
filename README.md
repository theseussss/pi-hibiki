# Pi Models · Model Manager

[简体中文](README.zh-CN.md)

A third-party [Pi](https://pi.dev) extension for selecting models, managing custom providers/models, and controlling the current session's Fast request policy. The interface is primarily Chinese.

**0.1.9** renames Hibiki to **Pi Models** and adds Pi 1.5.2 compatibility. Favorites/order/preferences no longer disappear merely because credential-write compatibility is unverified. The dense home, add flow, native context/output overrides and separate save confirmation are retained. Source delivery, local installation/loading and GitHub publication remain separate steps; editing this repository does not upgrade already-open windows.

The package name is now `pi-models`. Existing commands, entry/config filenames, favorite/order paths and protected-record identifiers remain compatible; no user-data migration is needed. Merely opening a partial catalog no longer prunes preferences for absent providers/models.

## Installation and entry points

This is an ordinary editable TypeScript Pi package with one declared entry: `extensions/hibiki-models.ts`. No build, snapshot or source reconstruction is required. Do not load internal `extensions/model-pick.ts` separately, or stack the old standalone picker/Fast extensions with it.

After reviewing a local source package, use `pi install /absolute/path/to/checkout` if desired. This repair does not automatically change existing loading configuration or reload windows. The repository/install address remains `git:github.com/theseussss/pi-hibiki`; the product rename does not rename that remote, and unpublished local changes are not present there.

Verified host targets are **Node.js 24 and Pi 1.4.0 / 1.5.2**. Shared credential locking and native metadata editing retain an explicit reviewed-version/API boundary. With an exact file-backed profile binding, saved favorites, order, palette and defaults remain readable even when writes are disabled on an unverified Pi version. Unverifiable SDK storage bindings still never fall back to a guessed HOME profile.

## Everyday controls

`/models` opens the matrix. `/models manage` and `/models providers` focus the visible action strip. `/models fast` opens current-session policy; `/models status` and `/models help` provide version/help information. `/hibiki` remains an exact legacy alias with the same subcommands; Ctrl+L and `/fast` are unchanged.

- **Home Tab/Shift+Tab** switches between the selected object and actions. Arrows navigate; Enter selects a model. Candidate, current session and global default are separate identities.
- **Alt+digits** invoke visible numbered actions: 1 favorite, 2 edit/view, 3 full checks, 4 default, 5/6 reorder, 7 add model, 8 remove confirmation, 9 new provider, 0 removed items. Unmodified digits remain text.
- Provider actions have their own template. Inapplicable digits are not reassigned. Two deliberate Left presses at the first model enter its provider column; Right returns.
- Tasks use continuous arrow navigation and ordinary sequential Tab traversal, not mandatory region switching. Candidate/selected lists have independent cursors; selections survive search changes.
- Alt+N/X/E/V/D, Alt+arrows, Alt+Z undo, Alt+L explicit locate, Alt+T six palettes, Alt+M/F6 actions and F1/Alt+H help remain. Saving does not silently clear a query, locate additions, change the current model or set a default.
- Wider terminals admit more action columns; state changes at the same width do not move commands. The home catalog retains one provider per row, middle ellipsis, a row-local horizontal window and `‹`/`+N`. Only provider rows page/scroll; title/search/details/actions remain visible. It is neither independent full-width row justification nor a provider-wrapping long list. Narrow/short screens retain reading gates and keyboard paths.

Ctrl+L may collide with Pi's native model picker. To assign it to Pi Models, merge `"app.model.select": []` into the existing keybindings file; do not overwrite the entire file. Commands work without that change.

## Add, check and confirm

```text
Name / endpoint / API / masked direct key
  → authorize this provider's model list, or enter exact IDs manually
  → search / multi-select / adjust parameters
  → authorize bounded checks, reuse applicable history, or skip
  → real item progress, cancellation and reports
  → separate final reviewed commit
  → return to the matrix
```

Adding to an existing provider starts with its saved connection but no automatic request. Not read, successful empty response, all returned IDs already configured, failed/cancelled reads and no filter matches are distinct states. A filter is shown only when a candidate list exists.

**Filtering is not discovery or manual addition.** Enter in the filter never turns the keyword into a picked ID. Exact manual IDs use a separate small form; joining selected drafts sends no request and writes no enabled configuration. Multiple exact IDs can be comma-separated. Reading this provider's upstream list still requires its own authorization.

An unsaved provider draft can read its own list without first publishing an empty provider or entering a model ID. Listing and capability checks are separate operations. A successful empty list is authoritative; failures retain a manual-entry path.

Draft keys stay in memory until final commit. Clearing a **new draft** withdraws its key; a blank key while editing a **saved provider** means keep existing credentials. Changing endpoint/API/key invalidates old list/report applicability. Name-only changes preserve the connection.

Parameters resolve per field from applicable evidence, manual confirmation, same-provider information, exact-ID templates and explicitly unconfirmed defaults. Cross-provider maps are suggestions, not channel measurements, and must be shown before adoption.

The implemented suite supports OpenAI Chat Completions and Responses: 8 requests/model, or 9 with an optional synthetic image, at most 64 output tokens/request. One authorization covers at most 3 supported models/27 requests; the remainder is explicitly untested, not automatically continued. Each model has at most 10 seconds of auth resolution plus a 90-second suite, with no retries. Price and input-token count are unknown, so there is no claimed monetary ceiling.

Only fixed synthetic samples are sent, never the current conversation or user files. A small response does not prove a maximum context window; parameter acceptance does not prove internal reasoning; one image does not prove general vision. Esc stops into a partial report; Ctrl+C abandons the task. Cancellation/timeouts do not launch subsequent requests or revive finished views. Record failures are disclosed without plaintext fallback.

Existing models also have full checks. Finishing/report-only does not modify enabled configuration; applying parameter differences requires a separate review. Read-only models cannot be modified. Thinking maps retain off/minimal/low/medium/high/xhigh/max and distinguish absent defaults, explicit empty maps, null unsupported entries and literal empty strings. The `=` prefix escapes literal values. Resetting an existing map to true absence is an explicit reviewed edit, not accidental omission; unknown fields remain intact.

## Local limits for native models

Select a native/extension chat model such as `openai-codex`, then use the same **Edit [2]** action:

- Only **context window and maximum output** are editable here. Effective values, directory references and explicit local overrides are distinct. Account/dynamic bases that cannot be established reliably remain unknown.
- Inputs contain explicit overrides only. **Blank restores inheritance for that field.** Reset clears these two overrides rather than pinning a snapshot of the directory; other manual overrides survive.
- A diff and separate confirmation precede writing `providers[exactProvider].modelOverrides[exactID]` in the verified profile's `models.json`. Cancel/no-op writes nothing; the native catalog is not replaced.
- Names, reasoning/input capabilities, maps, OAuth, keys, endpoints and protocols retain their existing protection. Virtual routing aliases do not receive ineffective overrides. Unknown SDK/storage bindings remain read-only.
- These are local Pi budgets, not an expansion of upstream capacity or recovery of compacted history. Excessive values can still exceed server limits. No discovery or paid capability test is started automatically.
- An offline refresh updates the canonical current same-ID object only while it remains current, preserving intervening selections and the global default. Saved-but-not-refreshed outcomes are explicit.

## Credentials, commit outcomes and recovery

- Direct keys share Pi's **`auth.json`** with `/login`. It is **0600 plaintext**, not an extra encrypted credential vault. New keys are not added to `models.json`. Dollar signs/leading exclamation are encoded for Pi's literal config-value syntax without executing pasted input.
- Existing OAuth/non-API-key entries are not overwritten; unrelated providers and unknown API-key metadata are preserved. No master password or parallel active-key store is introduced.
- Provider/auth changes use coordinated commit, native-compatible leases, revision checks and protected pending recovery data. **This is not a cross-file atomic transaction.** Outcomes distinguish unchanged/compensated, pending, committed and saved-but-not-refreshed. Partial work is not presented as nothing having happened.
- Unresolved or unreadable pending state blocks Pi Models' relevant mutation, selection and discovery/probe effects until explicit recovery. External login changes are not blindly overwritten.
- Endpoint/API/key changes for the **current provider are refused** until switching away; name-only edits are allowed. Saving current-model metadata refreshes its canonical object only while it is still current, preserving an intervening model selection.
- This is not a global request lock across processes. Pi Models cannot freeze/rebind other windows, other extensions or direct file editors. Local coordination does not guarantee cross-window endpoint/key binding or absolute filesystem CAS.
- Removal archives rather than permanently deletes. Affected current/default references require replacement confirmation and then separate removal confirmation. Undo/restore never silently switch current/default; conflicts do not overwrite, and legacy data is not automatically migrated/deleted.

## Platform and scope limits

Protected management records/archives depend on Windows DPAPI, with WSL native synthetic tests. Linux/macOS protection backends are not implemented; unavailable protection refuses the relevant operation. Full native-Windows plugin acceptance remains outstanding.

Paths derive from verified host storage, including explicit `PI_CODING_AGENT_DIR` profiles. Unknown SDK bindings allow viewing/selection without reading or writing a guessed default profile. Ultrafast configuration is read only from the verified profile's `pi-hibiki.json`.

The native lease has upstream version/long-pause limitations. Old nonempty custom locks are not deleted on an age heuristic; back up and inspect ownership before repair. Abnormal termination may leave pending work or safety locks. Do not bypass them with plaintext writes.

Reports are scoped to provider/model/endpoint/API/credential generation and revalidated on reuse/adoption; the current default TTL is one hour. Saving a report, synchronizing channel references and applying enabled configuration are separate actions. Configurable AI analysis/automatic sync policies and a complete per-field history comparison/rollback UI are not implemented; ledger events do not constitute those product capabilities. Other API suites remain explicitly untested.

Protected archives are account-bound; copying ciphertext alone does not guarantee recovery on another machine. Extensions run with host permissions, not isolation against malicious same-user code.

## Fast

`/fast [on|off|ultrafast|status|check]` retains session/branch history semantics. Home Fast applies only to an eligible **current** model, never the highlighted candidate. Status/check only observe; they send no probe. Requested tier, upstream echo, actual acceleration and billing are separate facts.

Ultrafast is opt-in, disabled by default in the verified profile's `pi-hibiki.json`:

```json
{ "fast": { "enableUltrafast": false } }
```

## Development and verification

Use installed Pi/TypeScript; no automatic dependency installation:

```sh
export HIBIKI_PI_ROOT=/path/to/pi-coding-agent
export HIBIKI_TYPESCRIPT_ROOT=/path/to/typescript
npm run verify
```

Verification uses disposable synthetic profiles and network/filesystem accident guards, not real credentials/providers. Native protection tests require WSL + Windows DPAPI. Actual Pi PTY routing, rasterized character previews, native WezTerm appearance and author acceptance are recorded separately and must not be conflated. The guards are not an OS sandbox.

## License and acknowledgements

[MIT](LICENSE), Copyright (c) 2026 Wang Jiacong (theseussss).

Thanks to Pi, pi-sakura-cyberdeck and its pi-zentui upstream. See [NOTICE](NOTICE.md) for scope and preserved licenses.
