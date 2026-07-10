# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Folder Path Updater, an Obsidian community plugin. It watches vault rename/move/delete events and rewrites path references in Obsidian's core settings files (`daily-notes.json`, `templates.json`, `app.json`, etc.) and every community plugin's `data.json`, plus (opt-in) note frontmatter properties. Plain JavaScript, no build step: `main.js`, `styles.css`, `manifest.json` are the shipped artifacts.

## Layout

- `main.js` — everything. Order: imports/settings/constants → pure helpers (`globToRegex`, `tabIdForEntry`, `formatPathPair`) → `PathTrackerPlugin` (event handlers, scanning, apply/undo, notices) → humanizer (`humanizeKeyPath` and friends) → modals (`PendingModal`, `ManualRewriteModal`, `ConfirmModal`, `RedirectModal`) → `PathTrackerSettingTab`.
- `styles.css` — all styling. No `!important`, ever (Obsidian review flags it).
- `tests/run-tests.js` — unit tests for the pure logic. They load the real `main.js` (via `tests/obsidian-stub.js`), never copies. Run with `node tests/run-tests.js`; keep them green and extend them when touching the matcher, globs, or humanizer.
- `TEST.md` — the owner's manual click-through plan. Update it when behavior changes.
- The `*.txt` conversation transcripts are gitignored on purpose: they contain the owner's real name and email, which must never be findable in this public repo.

## Hard rules from the owner

1. **Verify Obsidian APIs against the real docs before relying on them.** Local clone: `/Users/milolipman/Downloads/obsidian-developer-docs-main/en/Reference/TypeScript API/`. If unreachable, say so and stop; never work from memory.
2. **No Claude attribution.** No `Co-Authored-By` trailers, no Claude in contributors. Commit as `TheGentleTurtle <153253062+TheGentleTurtle@users.noreply.github.com>`.
3. **Always release after changes** (owner's standing instruction, 2026-07: "release always release"). Flow: bump `manifest.json` + `versions.json` → commit `vX.Y.Z` → push to `main` → `gh release create X.Y.Z main.js manifest.json styles.css` (three assets, never a zip) → confirm the attestation workflow succeeds → copy `main.js`, `styles.css`, `manifest.json` to `/Users/milolipman/Downloads/Milo's Vault/.obsidian/plugins/folder-path-updater/`.
4. **No em-dashes in notification text** (use parentheses). For other copy, ask first.
5. **Removed features stay removed:** ribbon icon, `workspace.json`/generic `.obsidian` config scanning, confidence ratings, the custom `×` close button on notices, custom notice fonts.
6. **Ask taste questions as a short numbered list** with a marked recommendation; do not decide taste unilaterally to "finish."

## Behavior invariants (user-approved contracts)

- Matching (`matchPath`): folder-prefix matches need the `/` boundary (`Daily` must not match `Daily Notes/x`); exact matches require a path-like key name or a slash in the value; extensionless values (`template: "Templates/Daily"`) update when `Templates/Daily.md` is renamed; a folder rename never rewrites a reference to a same-named `.md` file. Comparisons are case-insensitive and tolerate a leading `/` or `./` and a trailing `/` typed into settings values (vault paths are case-insensitive on macOS/Windows); rewrites preserve the user's decorations.
- Renames the plugin performs itself (undo/re-apply restoring a name) are recorded in `selfRenames` before calling `fileManager.renameFile` and consumed by the rename handler, so they never re-enter the pipeline regardless of event timing.
- Modes: default `manual` ("Ask me each time"); Notify mode never writes anything, including redirects.
- Undo/Re-apply is full reversal (settings + rename the folder/file back) for direct rename entries only; entries with `origin` of `chain`, `manual`, or `redirect` restore settings values only.
- "Revert everything" and per-group Undo operate on the current session only; past sessions are read-only history (30-day window, 1000-entry cap, persisted in `data.json` under `_history`).
- One coalesced notice per rename batch (400 ms window). Notice layout (user decision, 2026-07, matches the README screenshot): **bold quoted rename pair on top** (`"Daily Notes" → "Daily"`, basenames when the parent dir is unchanged, full paths in tooltip), plain status sentence below (`4 references across 2 settings.`), buttons last. Notice width is Obsidian's default (no custom width CSS, user decision 2026-07: 480px was "too wide"); long names wrap via `word-break`. Buttons persistent (timeout 0), passive notices timed. The "0 references" notice fires for folder renames and manual rewrites only. No plugin-name prefix in notices (user decision, 2026-07).
- **No monospace anywhere in the plugin UI** (user decision, 2026-07): paths, diffs, and modals all use the default interface font. Spacing uses Obsidian's documented `--size-*` variables (4px grid).
- History cards: plain-language status line (`3 settings updated, 1 skipped · 2m ago`), no pill row on the headline, no per-row Undo/Re-apply buttons (the card-level buttons do the work); row pills appear only when a row's status differs from the card's dominant status.
- History rows are settings-style (label left, inline diff right, `↗` opens the setting) and use the **exact setting labels from Obsidian's settings UI** for core files via `SCOPED_KEY_OVERRIDES` (e.g. daily-notes `folder` → "New file location"); community plugins fall back to the generic de-camelCase humanizer.
- No duplicate rows for the same concrete change (`changeKey`: file + keyPath + old/new value): duplicate rename pairs collapse in the batch, identical proposals dedupe, a fresh proposal replaces stale (skipped/superseded/pending) copies of itself in history, and the renderer collapses identical rows left over from pre-v0.1.12 saved history.
- Never rewrite this plugin's own `data.json` (`collectTargets` skips `folder-path-updater`).
- The `disablePlugin`/`enablePlugin` reload dance is undocumented API and is under an Obsidian review appeal; do not remove or "fix" it without the owner's say-so.

## Checks before committing

```
node --check main.js
node tests/run-tests.js   # 58+ tests, must all pass
```

Grep-checks that must stay clean in user-facing strings/CSS: no `—` in notice text, no `!important`, no `addRibbonIcon`, no `localStorage`.
