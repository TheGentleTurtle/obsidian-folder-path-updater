# Folder Path Updater: Test Plan

For each test: do the action, write your feedback under it.

**Setup:** copy the latest `main.js` and `styles.css` into your vault's plugin folder, reload Obsidian, open the plugin settings.

Items marked **(machine checked)** are already covered by automated tests (`node tests/run-tests.js`, 58 passing). Everything else needs you to click through it, because only a live Obsidian can prove it.

---

## 1. Notice format
- [ ] Rename any folder with references. The notice has the **bold quoted rename on top** (`"Daily Notes" → "Daily"`), the plain status sentence below (`4 references across 2 settings.`), no X button, default Obsidian font.
- [ ] The notice is Obsidian's normal width and long names wrap onto the next line instead of truncating.
- [ ] Spacing feels comfortable: clear gaps between the rename, the status, and the buttons. Nothing cramped.
- [ ] Hover the rename line. Full paths show in a tooltip.
- [ ] Click the notice body. It dismisses (default Obsidian behavior).

> Feedback:

---

## 2. Three modes
Settings, "When you rename something". Try each with a folder that has references (e.g. your Daily Notes folder).

- [ ] **Ask me each time:** notice shows `[Review] [Apply all]`. Both work. Notice stays until you act.
- [ ] **Automatically apply (with notification):** changes happen instantly, notice shows what was updated, has a `[View]` button.
- [ ] **Notify (no action taken):** notice shows count, nothing changes on disk, `[View]` opens history.

> Feedback:

---

## 3. "0 references" notice
- [ ] Rename a **folder** nothing references. You see `0 references to update` for about 10 seconds.
- [ ] Rename a **file** (note) nothing references. **Nothing appears.** (New: file renames stay quiet unless something references them.)
- [ ] Rename a file that IS referenced (e.g. a template file). You get the normal reference notice.
- [ ] Toggle off "Notify on every rename". Rename a folder again. No notice.

> Feedback:

---

## 4. Template file rename (the big fix)
Your `daily-notes.json` stores the template without `.md` (e.g. `System/Templates/(TEMPLATE) Daily`).

- [ ] Rename that template file (e.g. add a word to its name). The plugin now catches it and offers to update the Daily Notes template setting. **(machine checked, but confirm live)**
- [ ] Rename a folder that has a same-named `.md` file next to it. The file reference is NOT touched. **(machine checked)**

> Feedback:

---

## 5. Already in sync
- [ ] Rename `A → B`, don't approve. Rename `B → A`. You get `Already in sync (no action needed)`.

> Feedback:

---

## 6. Chain rename
- [ ] Rename `A → B`, skip it. Rename `B → C`. The plugin finds references to A and offers to rewrite them to C.
- [ ] The original `A → B` entry shows SUPERSEDED in history.
- [ ] Rename `A → B` and leave its notice open. Rename `B → C`: the first notice disappears on its own; only the new `A → C` notice remains, and approving it applies the right change.

> Feedback:

---

## 7. Undo and Re-apply
- [ ] Apply a rename. Click **Undo** in history. The folder renames back AND the settings revert, one click.
- [ ] Click **Re-apply**. Both redo.
- [ ] Undo a **redirect** entry (see test 10). Settings revert, but the redirect target folder does NOT get renamed. (New fix.)
- [ ] Manually edit a setting the plugin wrote, then click Undo on it. A native Obsidian dialog asks before overwriting your edit. (Was a raw system popup before.)

> Feedback:

---

## 8. Revert everything (danger zone)
- [ ] Apply 2+ renames. Click **Revert everything**, confirm in the native dialog. Everything reverts, folders rename back.
- [ ] After a reload (so past sessions exist): the button only counts and reverts THIS session's changes. (New fix.)

> Feedback:

---

## 9. Delete detection
- [ ] Delete a file nothing references. Silence.
- [ ] Delete a folder/file something references. Notice with `[Redirect]` appears.
- [ ] Also try deleting a folder with several files inside it that are referenced. Note how many notices you get (one or several?). Tell me, this one I cannot verify from code.
- [ ] Click Redirect, type a path. Autocomplete suggests vault paths.
- [ ] **Apply** follows your mode: in manual it opens review, in notify it only logs (new fix), in auto it writes.
- [ ] **View details** opens the review modal regardless of mode.

> Feedback:

---

## 10. History
- [ ] Each rename is a card: name on top, one plain sentence under it like `3 settings updated · 2m ago`. No pill row, no monospace. (New look.)
- [ ] Expand a card: each row reads like the actual settings field, label left and red/green diff right on one line. For Daily Notes the row says **New file location** (not "Folder"); Templates says **Template folder location**; attachments say **Default location for new attachments**.
- [ ] No duplicate rows: rename a folder, revert it, rename it again the same way — the card shows each change once, not stacked copies.
- [ ] The card's single Undo / Re-apply button does the work (per-row buttons are gone).
- [ ] A pill only appears on a row when its result differs from the rest (e.g. one skipped among applied).
- [ ] Click **↗** on a row. The right settings tab opens and the field briefly highlights. Also try it on a Bookmarks entry and tell me what happens (Bookmarks has no settings tab; I could not verify this from code).
- [ ] Click **↗** on a frontmatter row. The note opens.
- [ ] **Clear history** asks: this session, or everything including past sessions.

> Feedback:

---

## 11. Past sessions
- [ ] Do renames, reload Obsidian, reopen settings. `Previous sessions` divider appears below.
- [ ] Expand one: one-line summaries like `Daily Notes → Daily · 4 places · Jun 5`, read-only, no buttons.

> Feedback:

---

## 12. Glob ignore **(machine checked, confirm one live)**
- [ ] Ignore paths: add `**/Drafts`. Rename something inside any `Drafts` folder. Silence.

> Feedback:

---

## 13. Frontmatter scanning
- [ ] Toggle on "Also scan note frontmatter", add `template` to the allowlist.
- [ ] Make a note with `template: Templates/Daily.md` in frontmatter. Rename `Templates → Cool Templates`. The property rewrites, entry shows a NOTE pill.
- [ ] Apply a frontmatter change, then immediately Undo it. No false "manually edited" warning. (New fix: it used to race the cache.)

> Feedback:

---

## 14. Reload toggle
- [ ] Toggle OFF "Reload affected community plugins". Apply a rename touching a community plugin. Notice includes `[Reload Obsidian]`, and the settings tab shows the reload banner.

> Feedback:

---

## 15. Manual rewrite command
- [ ] Cmd-P, "Rewrite a path manually". Enter an old path from settings and a new one. It queues/applies like a rename.
- [ ] Enter a path with zero references. You still get the `0 references` notice (explicit commands always answer).
- [ ] Undo a manual-rewrite entry. Settings revert; no folder gets moved. (New.)

> Feedback:

---

## 16. Broken paths scan
- [ ] Cmd-P, "Scan settings for paths pointing to missing files/folders". Notice with results.

> Feedback:

---

## Overall
- [ ] Anything ugly, confusing, or annoying?
- [ ] Anything not working at all?

> Feedback:
