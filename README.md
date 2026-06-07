# Folder Path Updater

Automatically updates folder and file path references in Obsidian's settings and community plugins when you rename or move things.

<p align="center">
  <img src="assets/notification.png" alt="Folder Path Updater notification: Daily Notes renamed to Daily, 4 references across 2 settings, with Review and Apply all buttons" width="540" style="border-radius: 24px;">
</p>

When you rename or move your daily notes folder, Obsidian updates `[[wikilinks]]` in your notes automatically, but the **Daily Notes** core plugin still points at the old folder and the same goes for the settings of every core and community plugin you have installed. Folder Path Updater updates those settings automatically.

## What it does

- Watches for rename and move events on any folder or file in your vault.
- Scans Obsidian's core feature settings and every community plugin's `data.json` for references to the old path.
- Rewrites those references to point at the new path: either silently, with a notification, or only with your approval.
- Keeps a session history allowing you to view and revert changes.
- If it's a folder/file path you can edit in **Settings**, this plugin tracks it.

## Modes

Set in the plugin's settings page:

- **Ask me each time:** A notification appears with the option to apply all changes at once or review them individually, or dismiss everything. *Default.*
- **Automatically apply (with notification):** applies every match and shows a summary notice.
- **Notify (no action taken):** finds matches, logs them to history, shows a notification with a *View* button to view the log. Nothing is changed; you can still apply later from history if you want.

<p align="center">
  <img src="assets/settings.png" alt="Folder Path Updater settings: mode dropdown, Reload affected community plugins toggle, Ignore paths textarea, History with one Undo entry, and a red Revert everything danger zone" width="820">
</p>

The settings tab houses three things: how the plugin should behave (mode + the reload toggle + an ignore list), a **History** of every rename it has touched this session with one-click **Undo** per group, and a **Revert everything**  button at the bottom for when you want to roll back the whole session in one shot.

## Safety

The matcher is careful by design — it only changes a value when it's clearly a real path:

- **Folder prefix matches:** (e.g. `Daily Notes/2026/foo.md` → `Daily/2026/foo.md`) always safe.
- **Exact value matches:** only when the field name looks like a path field (`folder`, `path`, `template`, `dir`, etc.) **or** the value has a slash.
- Simple word matches in unknown fields are skipped to prevent mistakes like a plugin saving `"Notes"` as a tag name.

Before every change, a backup is saved in `.obsidian/plugins/folder-path-updater/backups/`. You can see every change in the session history with a full diff and can undo each one. There's also a red danger-zone button to undo all changes from this session.

## What it does **not** cover

- Markdown body content (Obsidian's built-in updater handles `[[wikilinks]]` and `[markdown links](path)`; hardcoded paths inside code blocks or plain text are not touched).
- Frontmatter properties that store paths.
- `.canvas`, `.base`, or `.excalidraw` file internals.
- CSS snippets and themes.
- Plugin state stored in files other than `data.json`.
- Renames performed while Obsidian was closed (Finder, Explorer, `git`). Use the **Rewrite a path manually** command for these.
- Plugin in-memory caches that don't refresh on disable/enable.

## Installation

### From the Community Plugins directory

Once approved by Obsidian, you'll be able to install it from **Settings → Community plugins → Browse** and search for *Folder Path Updater*.

### Manually

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub release](https://github.com/TheGentleTurtle/obsidian-folder-path-updater/releases).
2. Copy them into `<vault>/.obsidian/plugins/folder-path-updater/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

### Via BRAT

Add `TheGentleTurtle/obsidian-folder-path-updater` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## License

MIT — see [LICENSE](LICENSE).
