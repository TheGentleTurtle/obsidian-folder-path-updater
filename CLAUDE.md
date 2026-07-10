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
3. **Never cut a GitHub release unless explicitly asked.** Normal flow: commit → push to `main` → copy `main.js` + `styles.css` to `/Users/milolipman/Downloads/Milo's Vault/.obsidian/plugins/folder-path-updater/` so the owner can test.
4. **No em-dashes in notification text** (use parentheses). For other copy, ask first.
5. **Removed features stay removed:** ribbon icon, `workspace.json`/generic `.obsidian` config scanning, confidence ratings, the custom `×` close button on notices, custom notice fonts.
6. **Ask taste questions as a short numbered list** with a marked recommendation; do not decide taste unilaterally to "finish."

## Behavior invariants (user-approved contracts)

- Matching (`matchPath`): folder-prefix matches need the `/` boundary (`Daily` must not match `Daily Notes/x`); exact matches require a path-like key name or a slash in the value; extensionless values (`template: "Templates/Daily"`) update when `Templates/Daily.md` is renamed; a folder rename never rewrites a reference to a same-named `.md` file.
- Modes: default `manual` ("Ask me each time"); Notify mode never writes anything, including redirects.
- Undo/Re-apply is full reversal (settings + rename the folder/file back) for direct rename entries only; entries with `origin` of `chain`, `manual`, or `redirect` restore settings values only.
- "Revert everything" and per-group Undo operate on the current session only; past sessions are read-only history (30-day window, 1000-entry cap, persisted in `data.json` under `_history`).
- One coalesced notice per rename batch (400 ms window). Notices: bold status line, basename path rows with full-path tooltips, buttons persistent (timeout 0), passive notices timed. The "0 references" notice fires for folder renames and manual rewrites only.
- Never rewrite this plugin's own `data.json` (`collectTargets` skips `folder-path-updater`).
- The `disablePlugin`/`enablePlugin` reload dance is undocumented API and is under an Obsidian review appeal; do not remove or "fix" it without the owner's say-so.

## Checks before committing

```
node --check main.js
node tests/run-tests.js   # 58+ tests, must all pass
```

Grep-checks that must stay clean in user-facing strings/CSS: no `—` in notice text, no `!important`, no `addRibbonIcon`, no `localStorage`.
