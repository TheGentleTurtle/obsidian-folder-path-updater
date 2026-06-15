'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFolder, TFile, normalizePath } = obsidian;
// AbstractInputSuggest may not exist in very old Obsidian builds; fall back gracefully.
const AbstractInputSuggest = obsidian.AbstractInputSuggest || null;

const DEFAULT_SETTINGS = {
  mode: 'manual',                  // 'auto' | 'manual' | 'notify'
  reloadPluginsAfterUpdate: true,  // disable/enable plugin so it picks up the new path
  notifyOnNoChanges: true,         // show a brief Notice on renames where nothing references the path
  backupRetentionDays: 30,         // 0 = never delete
  scanFrontmatter: false,          // also scan note frontmatter properties for path values
  frontmatterAllowlist: [],        // property names (lowercased) that may hold paths
  ignorePaths: [],
};

// Always-on internal behavior
const ALWAYS_ON = {
  scanCore: true,
  scanPluginData: true,
  backupBeforeWrite: true,
};

// Only the core configs that hold user-visible file/folder paths.
// (workspace.json, hotkeys.json, types.json, etc. don't and aren't scanned.)
const CORE_FILE_LABELS = {
  'daily-notes.json':   'Daily Notes',
  'templates.json':     'Templates',
  'bookmarks.json':     'Bookmarks',
  'zk-prefixer.json':   'Unique note creator',
  'note-composer.json': 'Note Composer',
  'graph.json':         'Graph',
  'app.json':           'Files & Links',
};

const KNOWN_CORE_FILES = Object.keys(CORE_FILE_LABELS);

// Key names that strongly suggest a path-typed value
const PATH_KEY_RE = /folder|directory|^dir$|path|template|file|location|attachment/i;

// Convert a glob pattern to a regex that matches the literal path and any
// descendant. Supports * (single segment), ** (any depth incl. zero), ? (one char),
// and treats other regex specials as literals.
function globToRegex(pattern) {
  if (typeof pattern !== 'string') return null;
  pattern = pattern.trim().replace(/^\/+|\/+$/g, '');
  if (!pattern) return null;
  let r = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** followed by / collapses to zero-or-more directories
      if (pattern[i + 2] === '/') {
        r += '(?:[^/]*/)*';
        i += 3;
      } else {
        r += '.*';
        i += 2;
      }
    } else if (c === '*') {
      r += '[^/]*';
      i++;
    } else if (c === '?') {
      r += '[^/]';
      i++;
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      r += '\\' + c;
      i++;
    } else {
      r += c;
      i++;
    }
  }
  try {
    return new RegExp(`^${r}(?:/.*)?$`);
  } catch (e) {
    console.warn('[Folder Path Updater] invalid ignore pattern:', pattern, e);
    return null;
  }
}

// Resolve the Obsidian settings tab id for a given history entry.
// Community plugins use their plugin id; core configs use the basename minus
// '.json' (with one rename: app.json → 'file' for Files & Links).
function tabIdForEntry(entry) {
  if (entry && typeof entry.scope === 'string' && entry.scope.startsWith('plugin:')) {
    return entry.scope.slice('plugin:'.length);
  }
  const base = ((entry && entry.sourceFile) || '').split('/').pop().replace(/\.json$/, '');
  if (base === 'app') return 'file';
  return base;
}

// Look through the rendered settings tab DOM for a .setting-item whose name
// matches our humanized field label. Loose matching: case-insensitive contains
// either direction so e.g. 'Folder' matches 'Folder' or 'Folder to create new notes in'.
function findSettingItemByLabel(root, label) {
  if (!root || !label) return null;
  const target = label.toLowerCase();
  const items = root.querySelectorAll('.setting-item');
  let best = null;
  for (const item of items) {
    const nameEl = item.querySelector('.setting-item-name');
    if (!nameEl) continue;
    const text = (nameEl.textContent || '').trim().toLowerCase();
    if (!text) continue;
    if (text === target) return item; // exact match wins
    if (text.includes(target) || target.includes(text)) {
      if (!best) best = item;
    }
  }
  return best;
}

// Render a rename pair as basenames only when both share the same parent directory,
// otherwise show the full paths. Caller is responsible for adding a title= tooltip.
function formatPathPair(oldPath, newPath) {
  const oldParts = String(oldPath || '').split('/');
  const newParts = String(newPath || '').split('/');
  const oldBase = oldParts[oldParts.length - 1] || oldPath;
  const newBase = newParts[newParts.length - 1] || newPath;
  const oldDir = oldParts.slice(0, -1).join('/');
  const newDir = newParts.slice(0, -1).join('/');
  if (oldDir === newDir) return `${oldBase} → ${newBase}`;
  return `${oldPath} → ${newPath}`;
}

class PathTrackerPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    delete this.settings._history; // never let persisted history leak into settings
    this.currentSessionId = Date.now();
    // Load past-session entries from disk. Anything still 'pending' at last
    // reload becomes 'skipped' (the user reloaded without acting on it).
    const persisted = Array.isArray(data._history) ? data._history : [];
    this.session = persisted.map((e) => {
      if (e.status === 'pending') {
        return { ...e, status: 'skipped', note: 'pending at last reload' };
      }
      return e;
    });
    this.pending = []; // pending entries don't survive a reload
    this.pluginsNeedingReload = new Set(); // populated only when auto-reload is OFF
    this.entryIdCounter = this.session.reduce((m, e) => Math.max(m, e.id || 0), 0);
    this.settingTab = new PathTrackerSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: 'open-pending',
      name: 'Open pending path updates',
      callback: () => this.openPendingModal(),
    });
    this.addCommand({
      id: 'open-session-log',
      name: 'Open session log (settings)',
      callback: () => {
        this.app.setting.open();
        this.app.setting.openTabById('folder-path-updater');
      },
    });
    this.addCommand({
      id: 'apply-all-pending',
      name: 'Apply all pending updates',
      callback: () => this.applyAllPending(),
    });

    this.addCommand({
      id: 'manual-rewrite',
      name: 'Rewrite a path manually (find references to a path that was renamed externally)',
      callback: () => new ManualRewriteModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'scan-broken-paths',
      name: 'Scan settings for paths pointing to missing files/folders',
      callback: () => this.scanBrokenPaths(),
    });

    this.renameBatch = [];
    this.renameBatchTimer = null;
    this.suppressRenameEvents = false;

    // Delete events: scan for orphan references; if any, surface a Redirect notice.
    // No notice when zero references — deletes are common and shouldn't be noisy.
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.suppressRenameEvents) return;
      this.handleDelete(file).catch((err) => {
        console.error('[Folder Path Updater] delete handler failed:', err);
      });
    }));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.suppressRenameEvents) return; // we triggered this rename ourselves (undo/reapply)
      if (!oldPath || !file || oldPath === file.path) return;
      this.renameBatch.push({ file, oldPath, newPath: file.path, isFolder: file instanceof TFolder });
      if (this.renameBatchTimer) window.clearTimeout(this.renameBatchTimer);
      this.renameBatchTimer = window.setTimeout(() => {
        this.renameBatchTimer = null;
        const batch = this.renameBatch.slice();
        this.renameBatch = [];
        this.handleRenameBatch(batch).catch((err) => {
          console.error('[Folder Path Updater] batch handler failed:', err);
          new Notice(`Folder Path Updater error: ${err.message}`);
        });
      }, 400);
    }));

    // Prune old backup snapshots a couple seconds after startup so we don't
    // race the rest of plugin load.
    setTimeout(() => { this.pruneBackups().catch((e) => console.warn('[Folder Path Updater] prune failed:', e)); }, 2000);
  }

  onunload() {
    if (this.renameBatchTimer) {
      window.clearTimeout(this.renameBatchTimer);
      this.renameBatchTimer = null;
    }
    this.renameBatch = [];
  }

  async saveSettings() {
    const out = Object.assign({}, this.settings);
    out._history = this.serializeHistory();
    await this.saveData(out);
  }

  // Strip non-persistable fields, prune by age, cap at 1000 most recent.
  serializeHistory() {
    const cutoff = Date.now() - 30 * 86400000; // 30 days
    const kept = [];
    for (const e of this.session) {
      if ((e.ts || 0) < cutoff) continue;
      const { originalFileContent, ...rest } = e;
      // Ensure every entry carries its sessionId so reloads can split them
      rest.sessionId = rest.sessionId || this.currentSessionId;
      kept.push(rest);
    }
    // Cap to 1000 newest entries
    kept.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return kept.slice(-1000);
  }

  // Debounced history persistence — call after any session mutation
  markHistoryDirty() {
    if (this._historySaveTimer) window.clearTimeout(this._historySaveTimer);
    this._historySaveTimer = window.setTimeout(() => {
      this._historySaveTimer = null;
      this.saveSettings().catch((e) => console.warn('[Folder Path Updater] history save failed:', e));
    }, 800);
  }

  updateRibbon() { /* ribbon removed — kept as a no-op so existing call sites are harmless */ }

  // ---------------------------------------------------------------------------
  // Rename batch handler — coalesces all renames in a short window into ONE notification
  // ---------------------------------------------------------------------------
  async handleRenameBatch(rawBatch) {
    // Filter out ignored paths (supports * and ** glob wildcards)
    const ignoreRegexes = this.settings.ignorePaths.map(globToRegex).filter(Boolean);
    let batch = rawBatch.filter((b) =>
      !ignoreRegexes.some((re) => re.test(b.oldPath))
    );
    if (batch.length === 0) return;

    // Dedupe: if a folder rename is in the batch, drop any child file renames
    // (the folder's prefix-match will catch all of them).
    const folders = batch.filter((b) => b.isFolder);
    batch = batch.filter((b) => {
      if (b.isFolder) return true;
      return !folders.some((f) => b.oldPath.startsWith(f.oldPath + '/'));
    });
    // Also dedupe nested folder renames (parent absorbs child)
    batch = batch.filter((b) =>
      !batch.some((other) => other !== b && other.isFolder && b.oldPath.startsWith(other.oldPath + '/'))
    );

    // --- Chain-rename detection ---
    // If a previous rename A→B was skipped/pending and the user now does B→C,
    // settings still reference A (not B). Walk the skipped/pending entries
    // backwards from b.oldPath to discover any earlier names that still need
    // rewriting to b.newPath.
    const chainSources = this.session.filter(
      (e) => e.status === 'skipped' || e.status === 'pending'
    );
    const chainedExtras = [];
    const supersededByChain = new Set();
    for (const b of batch) {
      const origins = new Set();
      const visited = new Set([b.newPath]);
      const queue = [b.oldPath];
      while (queue.length) {
        const path = queue.shift();
        if (visited.has(path)) continue;
        visited.add(path);
        for (const e of chainSources) {
          if (e.newPath === path) {
            origins.add(e.oldPath);
            supersededByChain.add(e.id);
            queue.push(e.oldPath);
          }
        }
      }
      origins.delete(b.oldPath);
      origins.delete(b.newPath);
      for (const origin of origins) {
        chainedExtras.push({ oldPath: origin, newPath: b.newPath, isFolder: b.isFolder, chained: true });
      }
    }
    if (chainedExtras.length) batch = batch.concat(chainedExtras);
    // Mark superseded chain-source entries so they don't haunt the history.
    if (supersededByChain.size) {
      for (const e of this.session) {
        if (supersededByChain.has(e.id) && (e.status === 'skipped' || e.status === 'pending')) {
          e.status = 'superseded';
          e.note = (e.note ? e.note + '; ' : '') + 'superseded by later rename';
        }
      }
      this.pending = this.pending.filter((p) => !supersededByChain.has(p.id));
    }

    // --- Auto-cancel pending entries that this rename inverts ---
    // If a pending entry says "A -> B" and now the user has renamed B back to A,
    // applying the pending would point configs at a folder that no longer exists.
    let autoCancelled = 0;
    const cancelledLabels = [];
    for (const b of batch) {
      const inverses = this.pending.filter(
        (p) => p.oldPath === b.newPath && p.newPath === b.oldPath
      );
      for (const p of inverses) {
        p.status = 'skipped';
        p.note = 'rename reverted before applying';
        this.pending = this.pending.filter((q) => q.id !== p.id);
        autoCancelled++;
        cancelledLabels.push(this.friendlyLabel(p));
      }
    }
    if (autoCancelled > 0) this.updateRibbon();

    const targets = await this.collectTargets();
    const proposals = [];

    for (const t of targets) {
      let data, raw;
      try {
        raw = await this.app.vault.adapter.read(t.path);
        data = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      for (const b of batch) {
        const matches = [];
        this.scanForPaths(data, b.oldPath, b.newPath, b.isFolder, [], '', matches);
        for (const m of matches) {
          proposals.push({
            id: ++this.entryIdCounter,
            ts: Date.now(),
            oldPath: b.oldPath,
            newPath: b.newPath,
            sourceFile: t.path,
            sourceLabel: t.label,
            scope: t.scope,
            keyPath: m.keyPath,
            oldValue: m.oldValue,
            newValue: m.newValue,
            matchKind: m.kind,
            status: 'pending',
            originalFileContent: null,
            sessionId: this.currentSessionId,
          });
        }
      }
    }

    // ---- Frontmatter scan (opt-in) ----
    if (this.settings.scanFrontmatter && this.settings.frontmatterAllowlist.length) {
      const allow = new Set(this.settings.frontmatterAllowlist.map((s) => s.toLowerCase()));
      for (const file of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache && cache.frontmatter;
        if (!fm) continue;
        for (const key of Object.keys(fm)) {
          if (key === 'position') continue; // internal field
          if (!allow.has(key.toLowerCase())) continue;
          const value = fm[key];
          const stringMatches = (val, keyPathSegments) => {
            if (typeof val !== 'string') return;
            for (const b of batch) {
              const m = this.matchPath(val, b.oldPath, b.newPath, b.isFolder, key);
              if (!m) continue;
              proposals.push({
                id: ++this.entryIdCounter,
                ts: Date.now(),
                oldPath: b.oldPath,
                newPath: b.newPath,
                sourceFile: file.path,
                sourceLabel: file.path,
                scope: 'frontmatter',
                keyPath: keyPathSegments,
                oldValue: val,
                newValue: m.newValue,
                matchKind: m.kind,
                status: 'pending',
                originalFileContent: null,
                sessionId: this.currentSessionId,
              });
            }
          };
          if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) stringMatches(value[i], [key, i]);
          } else {
            stringMatches(value, [key]);
          }
        }
      }
    }

    if (proposals.length === 0) {
      if (autoCancelled > 0) {
        this.fpuNotice({
          status: 'Already in sync (no action needed)',
          paths: batch.map((b) => ({ oldPath: b.oldPath, newPath: b.newPath })),
          timeout: 16000,
        });
        this.settingTab.refreshIfOpen();
      } else if (this.settings.notifyOnNoChanges) {
        this.fpuNotice({
          status: '0 references to update',
          paths: batch.map((b) => ({ oldPath: b.oldPath, newPath: b.newPath })),
          timeout: 10000,
        });
      }
      return;
    }

    const paths = batch.map((b) => ({ oldPath: b.oldPath, newPath: b.newPath }));
    const groupKeys = new Set(batch.map((b) => `${b.oldPath}→${b.newPath}`));
    const openHistoryView = () => {
      const tab = this.settingTab;
      if (tab) {
        if (!tab.expandedGroups) tab.expandedGroups = new Set();
        for (const k of groupKeys) tab.expandedGroups.add(k);
      }
      this.app.setting.open();
      this.app.setting.openTabById('folder-path-updater');
    };

    if (this.settings.mode === 'auto') {
      const summary = await this.applyProposals(proposals);
      this.notifySummary(summary, groupKeys, batch);
    } else if (this.settings.mode === 'notify') {
      for (const p of proposals) {
        p.status = 'skipped';
        p.note = 'notify-only mode';
        this.session.push(p);
      }
      this.settingTab.refreshIfOpen();
      this.fpuNotice({
        status: `${proposals.length} reference${proposals.length === 1 ? '' : 's'} found (no action taken)`,
        paths,
        persistent: true,
        buttons: [{ text: 'View', onClick: openHistoryView }],
      });
    } else {
      for (const p of proposals) {
        this.pending.push(p);
        this.session.push(p);
      }
      this.updateRibbon();

      const places = new Set(proposals.map((p) => this.friendlyLabel(p))).size;
      this.fpuNotice({
        status: `${proposals.length} reference${proposals.length === 1 ? '' : 's'} in ${places} setting${places === 1 ? '' : 's'}`,
        paths,
        persistent: true,
        buttons: [
          { text: 'Review', onClick: () => this.openPendingModal() },
          { text: 'Apply all', cta: true, onClick: async () => {
            const summary = await this.applyProposals(proposals);
            this.notifySummary(summary, groupKeys, batch);
          }},
        ],
      });
      this.settingTab.refreshIfOpen();
    }
    this.markHistoryDirty();
  }

  // ---------------------------------------------------------------------------
  // Target collection
  // ---------------------------------------------------------------------------
  async collectTargets() {
    const targets = [];
    const cfg = this.app.vault.configDir; // usually ".obsidian"
    const adapter = this.app.vault.adapter;

    if (ALWAYS_ON.scanCore) {
      for (const f of KNOWN_CORE_FILES) {
        const p = `${cfg}/${f}`;
        if (await adapter.exists(p)) targets.push({ path: p, label: f, scope: 'core' });
      }
    }
    if (ALWAYS_ON.scanPluginData) {
      try {
        const dir = `${cfg}/plugins`;
        const listing = await adapter.list(dir);
        for (const sub of listing.folders) {
          const pluginId = sub.split('/').pop();
          if (pluginId === 'folder-path-updater') continue; // never rewrite our own settings
          const p = `${sub}/data.json`;
          if (await adapter.exists(p)) {
            targets.push({ path: p, label: `plugins/${pluginId}/data.json`, scope: `plugin:${pluginId}` });
          }
        }
      } catch (e) { /* no plugins dir */ }
    }
    return targets;
  }

  // ---------------------------------------------------------------------------
  // JSON scanning
  // ---------------------------------------------------------------------------
  scanForPaths(node, oldPath, newPath, isFolder, keyPath, parentKey, out) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (typeof child === 'string') {
          const m = this.matchPath(child, oldPath, newPath, isFolder, parentKey);
          if (m) out.push({ keyPath: keyPath.concat(i), oldValue: child, newValue: m.newValue, kind: m.kind });
        } else {
          this.scanForPaths(child, oldPath, newPath, isFolder, keyPath.concat(i), parentKey, out);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string') {
          const m = this.matchPath(v, oldPath, newPath, isFolder, k);
          if (m) out.push({ keyPath: keyPath.concat(k), oldValue: v, newValue: m.newValue, kind: m.kind });
        } else {
          this.scanForPaths(v, oldPath, newPath, isFolder, keyPath.concat(k), k, out);
        }
      }
    }
  }

  // Safer matcher: only fires when there's strong evidence the value is a real
  // path reference. This is what replaces the old confidence rating — we just
  // never surface the noisy "bare word inside an unknown field" cases.
  matchPath(value, oldPath, newPath, isFolder, keyName) {
    if (!value || typeof value !== 'string') return null;

    const keyLooksLikePath = keyName && PATH_KEY_RE.test(keyName);
    const valueHasSlash = value.includes('/');

    // Prefix match under a folder — always safe (the slash makes it unambiguous)
    if (isFolder && value.startsWith(oldPath + '/')) {
      return { newValue: newPath + value.slice(oldPath.length), kind: 'prefix' };
    }
    // Exact match — only if the field name OR the value itself signals "path"
    if (value === oldPath && (keyLooksLikePath || valueHasSlash)) {
      return { newValue: newPath, kind: 'exact' };
    }
    // "<oldPath>.md" — same gating
    if (value === oldPath + '.md' && (keyLooksLikePath || valueHasSlash)) {
      return { newValue: newPath + '.md', kind: 'exact' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Apply / undo
  // ---------------------------------------------------------------------------
  async applyProposals(proposals) {
    const byFile = new Map();
    for (const p of proposals) {
      if (!byFile.has(p.sourceFile)) byFile.set(p.sourceFile, []);
      byFile.get(p.sourceFile).push(p);
    }
    const summary = { applied: 0, failed: 0, scopes: new Set(), pluginsNeedingReload: new Set() };
    const adapter = this.app.vault.adapter;

    for (const [file, props] of byFile) {
      // Frontmatter proposals follow a different write path
      if (props[0].scope === 'frontmatter') {
        await this.applyFrontmatterFile(file, props, summary);
        continue;
      }
      let raw;
      try { raw = await adapter.read(file); }
      catch (e) {
        for (const p of props) { p.status = 'failed'; p.error = `read failed: ${e.message}`; summary.failed++; }
        continue;
      }
      let data;
      try { data = JSON.parse(raw); }
      catch (e) {
        for (const p of props) { p.status = 'failed'; p.error = `parse failed: ${e.message}`; summary.failed++; }
        continue;
      }

      // Apply each mutation individually so one bad keyPath doesn't sink the file
      const ok = [];
      for (const p of props) {
        try { this.setByKeyPath(data, p.keyPath, p.newValue); ok.push(p); }
        catch (e) { p.status = 'failed'; p.error = `key path missing: ${e.message}`; summary.failed++; }
      }
      if (ok.length === 0) continue;

      for (const p of ok) p.originalFileContent = raw;
      if (ALWAYS_ON.backupBeforeWrite) {
        try { await this.writeBackup(file, raw, ok[0].id); }
        catch (e) { console.warn('[Folder Path Updater] backup failed', e); }
      }

      const scope = ok[0].scope || '';
      const isPluginFile = scope.startsWith('plugin:');
      const pluginId = isPluginFile ? scope.slice('plugin:'.length) : null;
      const reloadPlugin = this.settings.reloadPluginsAfterUpdate && isPluginFile && pluginId !== 'folder-path-updater';
      const wasEnabled = reloadPlugin && this.app.plugins?.enabledPlugins?.has(pluginId);

      // Disable BEFORE writing so the plugin's onunload doesn't overwrite our change
      if (wasEnabled) {
        try { await this.app.plugins.disablePlugin(pluginId); }
        catch (e) { console.warn('[Folder Path Updater] disable failed', e); }
      }

      try {
        await adapter.write(file, JSON.stringify(data, null, 2));
        for (const p of ok) {
          p.status = 'applied';
          this.pending = this.pending.filter((q) => q.id !== p.id);
          summary.applied++;
          summary.scopes.add(this.friendlyLabel(p));
        }
        // When auto-reload is OFF, surface the manual reload button system.
        if (isPluginFile && pluginId !== 'folder-path-updater' && !this.settings.reloadPluginsAfterUpdate) {
          const label = this.friendlyLabel(ok[0]);
          summary.pluginsNeedingReload.add(label);
          this.pluginsNeedingReload.add(label);
        }
      } catch (e) {
        for (const p of ok) { p.status = 'failed'; p.error = `write failed: ${e.message}`; summary.failed++; }
      } finally {
        if (wasEnabled) {
          try { await this.app.plugins.enablePlugin(pluginId); }
          catch (e) { console.warn('[Folder Path Updater] re-enable failed', e); }
        }
      }
    }

    for (const p of proposals) {
      p.sessionId = p.sessionId || this.currentSessionId;
      if (!this.session.includes(p)) this.session.push(p);
    }
    this.updateRibbon();
    this.settingTab.refreshIfOpen();
    this.markHistoryDirty();
    return summary;
  }

  // Apply a batch of frontmatter proposals targeting one note. Uses
  // app.fileManager.processFrontMatter so the YAML formatter and property
  // ordering Obsidian uses elsewhere are preserved.
  async applyFrontmatterFile(filePath, props, summary) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      for (const p of props) { p.status = 'failed'; p.error = 'note not found'; summary.failed++; }
      return;
    }
    let raw;
    try { raw = await this.app.vault.read(file); }
    catch (e) {
      for (const p of props) { p.status = 'failed'; p.error = `read failed: ${e.message}`; summary.failed++; }
      return;
    }
    for (const p of props) p.originalFileContent = raw;
    if (ALWAYS_ON.backupBeforeWrite) {
      try { await this.writeBackup(filePath, raw, props[0].id); }
      catch (e) { console.warn('[Folder Path Updater] backup failed', e); }
    }
    const succeeded = [];
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const p of props) {
          try {
            this.setByKeyPath(fm, p.keyPath, p.newValue);
            succeeded.push(p);
          } catch (e) {
            p.status = 'failed';
            p.error = `key path missing: ${e.message}`;
            summary.failed++;
          }
        }
      });
    } catch (e) {
      for (const p of props) { p.status = 'failed'; p.error = `write failed: ${e.message}`; summary.failed++; }
      return;
    }
    for (const p of succeeded) {
      p.status = 'applied';
      this.pending = this.pending.filter((q) => q.id !== p.id);
      summary.applied++;
      summary.scopes.add(this.friendlyLabel(p));
    }
  }

  async applyAllPending() {
    if (this.pending.length === 0) {
      this.fpuNotice({ status: 'Nothing pending', timeout: 8000 });
      return;
    }
    const items = this.pending.slice();
    const summary = await this.applyProposals(items);
    this.fpuNotice({
      status: this.formatRevertStatus('Applied', summary.applied, summary.failed),
      paths: this.groupPathsByRename(items, (e) => e.status === 'applied'),
    });
  }

  async revertAllSession() {
    const applied = this.session.filter((e) => e.status === 'applied');
    if (applied.length === 0) {
      this.fpuNotice({ status: 'Nothing applied this session', timeout: 8000 });
      return;
    }
    let ok = 0, fail = 0;
    for (const e of applied) {
      try {
        await this.undoEntry(e, { silent: true });
        if (e.status === 'reverted') ok++; else fail++;
      } catch (err) {
        fail++;
      }
    }
    this.fpuNotice({
      status: this.formatRevertStatus('Reverted', ok, fail),
      paths: this.groupPathsByRename(applied, (e) => e.status === 'reverted'),
    });
    this.updateRibbon();
    this.settingTab.refreshIfOpen();
  }

  // Build "Reverted 3" or "Reverted 3 of 5 (2 failed)" header text.
  formatRevertStatus(verb, ok, fail) {
    if (fail === 0) return `${verb} ${ok}`;
    return `${verb} ${ok} of ${ok + fail} (${fail} failed)`;
  }

  // Group entries by (oldPath, newPath) into path rows with [ok/total] counts.
  // pred: function that returns true for successful entries.
  groupPathsByRename(entries, pred) {
    const groups = new Map();
    for (const e of entries) {
      const key = `${e.oldPath}→${e.newPath}`;
      if (!groups.has(key)) groups.set(key, { oldPath: e.oldPath, newPath: e.newPath, ok: 0, total: 0 });
      const g = groups.get(key);
      g.total++;
      if (pred(e)) g.ok++;
    }
    return Array.from(groups.values()).map((g) => ({
      oldPath: g.oldPath,
      newPath: g.newPath,
      count: g.ok === g.total ? (g.total > 1 ? `[${g.total}]` : '') : `[${g.ok}/${g.total}]`,
    }));
  }

  // Inverse of undo: re-write the new value (used to re-apply a reverted entry)
  // Rename a vault path back, but only if it still lives at `from`. No-op if
  // someone else (an earlier undo in the same batch) already moved it, or if
  // the target name is occupied.
  async maybeRenameVaultPath(from, to) {
    if (!from || !to || from === to) return { skipped: true };
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!file) return { skipped: true }; // already moved by earlier action, or never existed
    const collision = this.app.vault.getAbstractFileByPath(to);
    if (collision) {
      this.fpuNotice({ status: `Cannot restore '${to}' (path already exists)`, timeout: 12000 });
      return { skipped: true, collision: true };
    }
    this.suppressRenameEvents = true;
    try {
      await this.app.fileManager.renameFile(file, to);
    } catch (e) {
      console.warn('[Folder Path Updater] rename-back failed:', e);
      this.suppressRenameEvents = false;
      return { skipped: true, error: e.message };
    }
    // Clear the suppression flag on the next tick so any deferred rename
    // event has a chance to fire while it's still set.
    await new Promise((r) => setTimeout(r, 50));
    this.suppressRenameEvents = false;
    return { renamed: true };
  }

  async reapplyEntry(entry, opts) {
    opts = opts || {};
    if (entry.status !== 'reverted') {
      if (!opts.silent) this.fpuNotice({ status: 'Only reverted changes can be re-applied', timeout: 8000 });
      return;
    }
    try {
      if (entry.scope === 'frontmatter') {
        const file = this.app.vault.getAbstractFileByPath(entry.sourceFile);
        if (!file || !(file instanceof TFile)) throw new Error('note not found');
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          this.setByKeyPath(fm, entry.keyPath, entry.newValue);
        });
      } else {
        const adapter = this.app.vault.adapter;
        const raw = await adapter.read(entry.sourceFile);
        const data = JSON.parse(raw);
        this.setByKeyPath(data, entry.keyPath, entry.newValue);
        await adapter.write(entry.sourceFile, JSON.stringify(data, null, 2));
      }
      entry.status = 'applied';
      // Also rename the folder/file forward (once per group; subsequent calls no-op)
      await this.maybeRenameVaultPath(entry.oldPath, entry.newPath);
      this.settingTab.refreshIfOpen();
      this.markHistoryDirty();
      if (!opts.silent) this.fpuNotice({
        status: 'Re-applied',
        paths: [{ oldPath: entry.oldPath, newPath: entry.newPath }],
      });
    } catch (e) {
      if (!opts.silent) this.fpuNotice({ status: `Re-apply failed: ${e.message}`, timeout: 10000 });
    }
  }

  async undoEntry(entry, opts) {
    opts = opts || {};
    if (entry.status !== 'applied' || !entry.originalFileContent) {
      if (!opts.silent) this.fpuNotice({ status: 'Cannot undo (no backup available)', timeout: 8000 });
      return;
    }
    try {
      if (entry.scope === 'frontmatter') {
        const file = this.app.vault.getAbstractFileByPath(entry.sourceFile);
        if (!file || !(file instanceof TFile)) throw new Error('note not found');
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          this.setByKeyPath(fm, entry.keyPath, entry.oldValue);
        });
      } else {
        const adapter = this.app.vault.adapter;
        const raw = await adapter.read(entry.sourceFile);
        const data = JSON.parse(raw);
        this.setByKeyPath(data, entry.keyPath, entry.oldValue);
        await adapter.write(entry.sourceFile, JSON.stringify(data, null, 2));
      }
      entry.status = 'reverted';
      // Also rename the folder/file back (once per group; subsequent calls no-op)
      await this.maybeRenameVaultPath(entry.newPath, entry.oldPath);
      this.settingTab.refreshIfOpen();
      this.markHistoryDirty();
      if (!opts.silent) this.fpuNotice({
        status: 'Reverted',
        paths: [{ oldPath: entry.newPath, newPath: entry.oldPath }],
      });
    } catch (e) {
      if (!opts.silent) this.fpuNotice({ status: `Undo failed: ${e.message}`, timeout: 10000 });
    }
  }

  async writeBackup(filePath, raw, idStamp) {
    const cfg = this.app.vault.configDir;
    const dir = `${cfg}/plugins/folder-path-updater/backups`;
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const safeName = filePath.replace(/[\/\\]/g, '__');
    const stamp = `${idStamp}-${Date.now()}`;
    const out = `${dir}/${stamp}__${safeName}`;
    await this.app.vault.adapter.write(out, raw);
  }

  // Delete backup snapshots older than backupRetentionDays. Filenames are
  // `<id>-<unixMs>__<safe>` so we can parse the timestamp directly.
  async pruneBackups() {
    const days = this.settings.backupRetentionDays;
    if (!days || days <= 0) return; // 0 = never
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const cfg = this.app.vault.configDir;
    const dir = `${cfg}/plugins/folder-path-updater/backups`;
    if (!(await this.app.vault.adapter.exists(dir))) return;
    const listing = await this.app.vault.adapter.list(dir);
    let removed = 0;
    for (const f of listing.files) {
      const base = f.split('/').pop();
      const match = base && base.match(/^\d+-(\d+)__/);
      if (!match) continue;
      const ts = parseInt(match[1], 10);
      if (!ts || ts >= cutoff) continue;
      try {
        await this.app.vault.adapter.remove(f);
        removed++;
      } catch (e) {
        console.warn('[Folder Path Updater] could not remove old backup', f, e);
      }
    }
    if (removed > 0) {
      console.log(`[Folder Path Updater] pruned ${removed} backup snapshot${removed === 1 ? '' : 's'} older than ${days} days`);
    }
  }

  setByKeyPath(obj, keyPath, value) {
    let cur = obj;
    for (let i = 0; i < keyPath.length - 1; i++) cur = cur[keyPath[i]];
    cur[keyPath[keyPath.length - 1]] = value;
  }

  notifySummary(summary, groupKeys, batch) {
    const needsReload = summary.pluginsNeedingReload && summary.pluginsNeedingReload.size > 0;
    let status, subText;
    if (needsReload) {
      const plugins = Array.from(summary.pluginsNeedingReload);
      status = plugins.length === 1
        ? `${plugins[0]} still uses the old path`
        : `${plugins.length} plugins still use old paths`;
      if (plugins.length > 1) subText = plugins.join(', ');
    } else {
      status = `Updated in ${summary.applied} place${summary.applied === 1 ? '' : 's'}`;
      if (summary.failed) status += ` (${summary.failed} failed)`;
    }
    const buttons = [{
      text: 'View',
      onClick: () => {
        const tab = this.settingTab;
        if (tab && groupKeys) {
          if (!tab.expandedGroups) tab.expandedGroups = new Set();
          for (const k of groupKeys) tab.expandedGroups.add(k);
        }
        this.app.setting.open();
        this.app.setting.openTabById('folder-path-updater');
      },
    }];
    if (needsReload) {
      buttons.push({ text: 'Reload Obsidian', cta: true, onClick: () => this.triggerReload() });
    }
    this.fpuNotice({
      status,
      paths: (batch || []).map((b) => ({ oldPath: b.oldPath, newPath: b.newPath })),
      subText,
      buttons,
      persistent: needsReload,
      timeout: 20000,
    });
  }

  // ---------------------------------------------------------------------------
  // Notice helper (minimal styling — bold status line, default font everywhere).
  // opts: { status, paths?, subText?, buttons?, persistent?, timeout? }
  // - paths: array of { oldPath, newPath, count? } rendered as basename pairs
  //   with full paths in the tooltip; same parent dir collapses to basenames.
  // - persistent: timeout = 0 (stays until a button is clicked or the notice
  //   body is clicked, which is Obsidian's default dismiss behavior).
  // ---------------------------------------------------------------------------
  fpuNotice(opts) {
    const timeout = opts.persistent ? 0 : (opts.timeout != null ? opts.timeout : 16000);
    const n = new Notice('', timeout);
    n.noticeEl.empty();
    n.noticeEl.addClass('fpu-notice');

    // Bold status line (same as the older notices)
    const status = n.noticeEl.createDiv();
    status.style.cssText = 'font-weight:600;margin-bottom:2px;';
    status.setText(opts.status || '');

    // Path rows in default font, with full paths in the tooltip
    if (opts.paths && opts.paths.length) {
      for (const p of opts.paths) {
        const row = n.noticeEl.createDiv();
        const text = row.createSpan({ text: formatPathPair(p.oldPath, p.newPath) });
        text.setAttr('title', `${p.oldPath}\n  →\n${p.newPath}`);
        if (p.count) {
          const c = row.createSpan({ text: ' ' + p.count });
          c.style.cssText = 'opacity:0.7;';
        }
      }
    }

    // Optional plain sub-text (e.g., plugin list when multiple need reload)
    if (opts.subText) {
      const sub = n.noticeEl.createDiv({ text: opts.subText });
      sub.style.cssText = 'opacity:0.85;margin-top:2px;';
    }

    // Buttons
    if (opts.buttons && opts.buttons.length) {
      const btns = n.noticeEl.createDiv();
      btns.style.cssText = 'margin-top:8px;display:flex;gap:6px;';
      for (const b of opts.buttons) {
        const btn = btns.createEl('button', { text: b.text });
        if (b.cta) btn.classList.add('mod-cta');
        btn.onclick = (e) => {
          e.stopPropagation();
          n.hide();
          if (b.onClick) b.onClick();
        };
      }
    }

    return n;
  }

  openPendingModal() {
    new PendingModal(this.app, this).open();
  }

  // Open the Obsidian settings tab where this entry was applied, then try to
  // scroll to and highlight the matching field. If the field can't be located
  // (label changed in a newer version, etc.), gracefully degrade to just
  // showing the tab. Frontmatter entries open the note instead.
  async openSettingsForEntry(entry) {
    if (entry.scope === 'frontmatter') {
      const leaf = this.app.workspace.getLeaf(true);
      const file = this.app.vault.getAbstractFileByPath(entry.sourceFile);
      if (file && file instanceof TFile) await leaf.openFile(file);
      return;
    }
    const tabId = tabIdForEntry(entry);
    try {
      this.app.setting.open();
      if (tabId) this.app.setting.openTabById(tabId);
    } catch (e) {
      console.warn('[Folder Path Updater] could not open settings tab:', tabId, e);
      return;
    }
    // Wait for the tab content to render
    await new Promise((r) => setTimeout(r, 250));
    const tabContent = document.querySelector('.modal.mod-settings .vertical-tab-content');
    if (!tabContent) return;
    const targetLabel = humanizeKeyPath(entry.keyPath || []);
    if (!targetLabel) return;
    const target = findSettingItemByLabel(tabContent, targetLabel);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('fpu-setting-highlight');
    setTimeout(() => target.classList.remove('fpu-setting-highlight'), 2500);
  }

  // User-initiated reload of the Obsidian window. Invoked only from explicit
  // button clicks — this is the path used when auto-reload is turned off.
  triggerReload() {
    try {
      if (this.app.commands && this.app.commands.executeCommandById) {
        if (this.app.commands.executeCommandById('app:reload')) return;
      }
    } catch (e) { /* fall through */ }
    window.location.reload();
  }

  // Build the standard reload footer used in the auto-apply Notice and modal
  // success state. parent is a DOM element; footer = static line + button.
  appendReloadFooter(parent, onClicked) {
    parent.createDiv({ cls: 'fpu-reload-line', text: 'Reload Obsidian for the changes to take effect.' });
    const btnRow = parent.createDiv({ cls: 'fpu-reload-btn-row' });
    const btn = btnRow.createEl('button', { cls: 'fpu-reload-btn mod-cta', text: 'Reload Obsidian' });
    btn.onclick = () => {
      if (onClicked) onClicked();
      this.triggerReload();
    };
    return btn;
  }

  // Manual rewrite: user types an old path and a new path; we scan and queue
  // matching changes exactly as if a rename had fired.
  async runManualRewrite(oldPath, newPath, treatAsFolder) {
    const fakeBatch = [{ file: { path: newPath }, oldPath, newPath, isFolder: !!treatAsFolder }];
    await this.handleRenameBatch(fakeBatch);
  }

  // Delete-event entry point. Find references to the deleted path; if any,
  // show a notice with a Redirect button. Silent when nothing references it.
  async handleDelete(file) {
    if (!file || !file.path) return;
    const deletedPath = file.path;
    if (this.settings.ignorePaths.some((p) => {
      const re = globToRegex(p);
      return re && re.test(deletedPath);
    })) return;
    const isFolder = file instanceof TFolder;
    const refs = await this.findReferencesToPath(deletedPath, isFolder);
    if (refs.length === 0) return; // silent
    const baseName = deletedPath.split('/').pop();
    this.fpuNotice({
      status: `${refs.length} reference${refs.length === 1 ? '' : 's'} still point${refs.length === 1 ? 's' : ''} to "${baseName}"`,
      subText: deletedPath,
      persistent: true,
      buttons: [{
        text: 'Redirect',
        cta: true,
        onClick: () => new RedirectModal(this.app, this, deletedPath, isFolder, refs).open(),
      }],
    });
  }

  // Scan known settings + (optionally) frontmatter for any value that matches
  // `path` as an exact reference or a folder-prefix. Returns a list of refs:
  // { target, keyPath, value, matchKind }.
  async findReferencesToPath(path, isFolder) {
    const refs = [];
    const placeholder = '__FPU_REDIRECT_PLACEHOLDER__';
    const targets = await this.collectTargets();
    for (const t of targets) {
      let data;
      try { data = JSON.parse(await this.app.vault.adapter.read(t.path)); }
      catch (e) { continue; }
      const matches = [];
      this.scanForPaths(data, path, placeholder, isFolder, [], '', matches);
      for (const m of matches) {
        refs.push({ target: t, keyPath: m.keyPath, value: m.oldValue, matchKind: m.kind });
      }
    }
    if (this.settings.scanFrontmatter && this.settings.frontmatterAllowlist.length) {
      const allow = new Set(this.settings.frontmatterAllowlist.map((s) => s.toLowerCase()));
      for (const f of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(f);
        const fm = cache && cache.frontmatter;
        if (!fm) continue;
        for (const key of Object.keys(fm)) {
          if (key === 'position') continue;
          if (!allow.has(key.toLowerCase())) continue;
          const val = fm[key];
          const check = (v, kp) => {
            if (typeof v !== 'string') return;
            const m = this.matchPath(v, path, placeholder, isFolder, key);
            if (m) refs.push({ target: { path: f.path, label: f.path, scope: 'frontmatter' }, keyPath: kp, value: v, matchKind: m.kind });
          };
          if (Array.isArray(val)) val.forEach((v, i) => check(v, [key, i]));
          else check(val, [key]);
        }
      }
    }
    return refs;
  }

  // Re-target the previously discovered refs at `newPath` and run them through
  // the user's current Mode (or force manual review if opts.forceManual).
  async runRedirect(oldPath, newPath, isFolder, refs, opts) {
    opts = opts || {};
    if (!newPath || newPath === oldPath) return;
    const proposals = [];
    for (const ref of refs) {
      const m = this.matchPath(ref.value, oldPath, newPath, isFolder, ref.keyPath[ref.keyPath.length - 1] || '');
      if (!m) continue;
      proposals.push({
        id: ++this.entryIdCounter,
        ts: Date.now(),
        oldPath,
        newPath,
        sourceFile: ref.target.path,
        sourceLabel: ref.target.label,
        scope: ref.target.scope,
        keyPath: ref.keyPath,
        oldValue: ref.value,
        newValue: m.newValue,
        matchKind: m.kind,
        status: 'pending',
        originalFileContent: null,
        sessionId: this.currentSessionId,
        note: 'redirect after delete',
      });
    }
    if (proposals.length === 0) return;
    const mode = opts.forceManual ? 'manual' : this.settings.mode;
    if (mode === 'manual') {
      for (const p of proposals) {
        this.pending.push(p);
        this.session.push(p);
      }
      this.markHistoryDirty();
      this.openPendingModal();
      return;
    }
    const summary = await this.applyProposals(proposals);
    this.fpuNotice({
      status: this.formatRevertStatus('Redirected', summary.applied, summary.failed),
      paths: [{ oldPath, newPath }],
    });
  }

  // Broken path scanner: walk known settings and surface values that look like
  // vault paths but no longer exist on disk.
  async scanBrokenPaths() {
    const targets = await this.collectTargets();
    const findings = [];
    for (const t of targets) {
      let data;
      try { data = JSON.parse(await this.app.vault.adapter.read(t.path)); }
      catch (e) { continue; }
      const visit = (node, kp) => {
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) visit(node[i], kp.concat(i));
        } else if (node && typeof node === 'object') {
          for (const k of Object.keys(node)) visit(node[k], kp.concat(k));
        } else if (typeof node === 'string') {
          const lastK = kp[kp.length - 1];
          if (typeof lastK === 'string' && PATH_KEY_RE.test(lastK)) {
            if (node && (node.includes('/') || /\.(md|canvas|base)$/i.test(node))) {
              findings.push({ source: t, keyPath: kp, value: node });
            }
          }
        }
      };
      visit(data, []);
    }
    const missing = [];
    for (const f of findings) {
      const exists = await this.app.vault.adapter.exists(f.value);
      if (!exists) missing.push(f);
    }
    if (missing.length === 0) {
      this.fpuNotice({ status: 'Every settings path resolves', timeout: 10000 });
      return;
    }
    this.fpuNotice({
      status: `${missing.length} setting${missing.length === 1 ? '' : 's'} point at missing files/folders`,
      subText: 'See developer console for details.',
      timeout: 16000,
    });
    console.log('[Folder Path Updater] Broken settings paths:');
    for (const m of missing) {
      console.log(`  ${this.friendlyLabel({ scope: m.source.scope, sourceFile: m.source.path })}: ${humanizeKeyPath(m.keyPath)} = ${JSON.stringify(m.value)}`);
    }
  }

  // Friendly name for a target entry, e.g. "Calendar" or "Daily Notes (core)"
  friendlyLabel(entry) {
    if (entry.scope === 'frontmatter') return entry.sourceFile;
    if (entry.scope && entry.scope.startsWith('plugin:')) {
      const id = entry.scope.slice('plugin:'.length);
      try {
        const m = this.app.plugins && this.app.plugins.manifests && this.app.plugins.manifests[id];
        if (m && m.name) return m.name;
      } catch (e) {}
      return id;
    }
    const base = entry.sourceFile.split('/').pop();
    return CORE_FILE_LABELS[base] || base;
  }

  // A one-line, user-readable explanation of where the value lives
  friendlyKeyHint(entry) {
    return humanizeKeyPath(entry.keyPath || []);
  }

  // Category for the header tag: "Community plugin", "Built-in", etc.
  categoryFor(entry) {
    if (entry.scope === 'frontmatter') return 'Note frontmatter';
    if (entry.scope && entry.scope.startsWith('plugin:')) return 'Community plugin';
    return 'Built-in feature';
  }

}

// Plain-language title for the row, e.g. "Folder location" or "Bookmark #1"
function entryTitle(entry) {
  const key = humanizeKeyPath(entry.keyPath || []);
  return key || 'Path reference';
}

// Human-friendly relative time, e.g. "just now", "5m ago", "2h ago", "yesterday"
function formatRelativeTime(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 30)    return 'just now';
  if (sec < 60)    return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)    return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)     return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1)   return 'yesterday';
  if (day < 7)     return `${day}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Render a small colored pill that says what kind of source this is
function appendCategoryPill(parent, category) {
  if (category === 'Community plugin') return parent.createSpan({ cls: 'pt-pill plugin', text: 'PLUGIN' });
  if (category === 'Note frontmatter') return parent.createSpan({ cls: 'pt-pill frontmatter', text: 'NOTE' });
  return parent.createSpan({ cls: 'pt-pill core', text: 'CORE' });
}

// Render a small status pill — "APPLIED", "REVERTED", etc. with the count prefix.
function appendStatusPill(parent, status, count) {
  const text = count != null ? `${count} ${status.toUpperCase()}` : status.toUpperCase();
  return parent.createSpan({ cls: `pt-status-pill ${status}`, text });
}

// ---------------------------------------------------------------------------
// Key humanizer — turns JSON key paths into something a normal person can read
// ---------------------------------------------------------------------------
const REDUNDANT_LEAF_KEYS = new Set(['file', 'path', 'name', 'value', 'src', 'href', 'url', 'location']);
const KEY_OVERRIDES = {
  // bookmarks.json
  'items': 'Bookmark',
  // daily notes / templates / other core
  'folder': 'Folder',
  'template': 'Template',
  'templates_folder': 'Templates folder',
  'templateFolder': 'Templates folder',
  // app.json — Files & Links
  'attachmentFolderPath': 'Attachment folder',
  'newFileLocation': 'New note location',
  'newFileFolderPath': 'New note folder',
};

function humanizeKeyToken(k) {
  if (KEY_OVERRIDES[k]) return KEY_OVERRIDES[k];
  // split camelCase, snake_case, kebab-case
  const words = String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return String(k);
  // capitalize first word
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

function singularize(label) {
  if (/ies$/i.test(label)) return label.replace(/ies$/i, 'y');
  if (/ses$/i.test(label)) return label.replace(/es$/i, '');
  if (/s$/i.test(label) && !/ss$/i.test(label)) return label.replace(/s$/i, '');
  return label;
}

function humanizeKeyPath(keyPath) {
  if (!keyPath || keyPath.length === 0) return 'value';
  // Find the last string segment and any index that follows it
  let lastStr = null;
  let lastStrIdx = -1;
  for (let i = keyPath.length - 1; i >= 0; i--) {
    if (typeof keyPath[i] === 'string') { lastStr = keyPath[i]; lastStrIdx = i; break; }
  }
  // Collect any trailing numeric indices (after the last string segment)
  let idxSuffix = '';
  if (lastStrIdx !== -1) {
    const after = keyPath.slice(lastStrIdx + 1).filter((k) => typeof k === 'number');
    if (after.length) idxSuffix = ' #' + (after[0] + 1);
  } else {
    // all numeric: just use first index
    idxSuffix = ' #' + (keyPath[0] + 1);
    return 'Item' + idxSuffix;
  }

  // If the last string is a generic leaf (file/path/name/value/...) and there
  // is a meaningful parent, describe via the parent.
  if (REDUNDANT_LEAF_KEYS.has(lastStr)) {
    // Walk backwards for a non-numeric, non-redundant parent
    for (let i = lastStrIdx - 1; i >= 0; i--) {
      const seg = keyPath[i];
      if (typeof seg === 'string' && !REDUNDANT_LEAF_KEYS.has(seg)) {
        return singularize(humanizeKeyToken(seg)) + idxSuffix;
      }
    }
    // No parent: fall back to the leaf word
    return humanizeKeyToken(lastStr) + idxSuffix;
  }

  // If there is an index suffix, singularize (e.g. "Bookmarks" → "Bookmark")
  if (idxSuffix) return singularize(humanizeKeyToken(lastStr)) + idxSuffix;
  return humanizeKeyToken(lastStr);
}

// ---------------------------------------------------------------------------
// Inline diff renderer — highlights only the characters that actually change
// ---------------------------------------------------------------------------
function renderInlineDiff(container, oldVal, newVal) {
  const a = String(oldVal);
  const b = String(newVal);
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p++;
  let so = a.length;
  let sn = b.length;
  while (so > p && sn > p && a[so - 1] === b[sn - 1]) { so--; sn--; }
  const commonStart = a.slice(0, p);
  const removedMid  = a.slice(p, so);
  const addedMid    = b.slice(p, sn);
  const commonEnd   = a.slice(so);

  if (commonStart) container.createSpan({ cls: 'pt-d-eq', text: commonStart });
  if (removedMid)  container.createSpan({ cls: 'pt-d-del', text: removedMid });
  if (addedMid)    container.createSpan({ cls: 'pt-d-add', text: addedMid });
  if (commonEnd)   container.createSpan({ cls: 'pt-d-eq', text: commonEnd });
}

// ============================================================================
// Pending review modal
// ============================================================================
class PendingModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.selected = new Set();
    this.chooseMode = false;       // false = no checkboxes; true = pick individually
    this.expanded = new Set();     // group keys currently expanded
  }
  onOpen() {
    this.titleEl.setText('Path updates');
    this.contentEl.addClass('path-tracker-pending-modal');
    // Default: all selected (used if user enters Choose mode)
    for (const p of this.plugin.pending) this.selected.add(p.id);
    this.render();
  }
  onClose() { this.contentEl.empty(); }

  renderAppliedSuccess(summary) {
    const { contentEl, plugin } = this;
    const card = contentEl.createDiv({ cls: 'fpu-modal-success' });
    const head = card.createDiv({ cls: 'fpu-modal-success-head' });
    head.setText(`Applied ${summary.applied} change${summary.applied === 1 ? '' : 's'}`);
    plugin.appendReloadFooter(card, () => this.close());
    const closeRow = contentEl.createDiv({ cls: 'fpu-modal-success-close' });
    const closeBtn = closeRow.createEl('button', { text: 'Close' });
    closeBtn.onclick = () => { this.lastAppliedSummary = null; this.close(); };
  }

  render() {
    const { contentEl, plugin } = this;
    contentEl.empty();
    // After a successful apply that needs a reload (auto-reload off), show the
    // success-with-reload state instead of the normal pending view.
    if (this.lastAppliedSummary && this.lastAppliedSummary.applied > 0 &&
        this.lastAppliedSummary.pluginsNeedingReload &&
        this.lastAppliedSummary.pluginsNeedingReload.size > 0) {
      this.renderAppliedSuccess(this.lastAppliedSummary);
      return;
    }
    const pending = plugin.pending.slice();
    if (pending.length === 0) {
      contentEl.createDiv({ cls: 'path-tracker-empty', text: 'No path updates waiting.' });
      return;
    }

    // ---- Plain-English summary line
    const renames = new Map();   // "old → new" → entries[]
    for (const p of pending) {
      const k = `${p.oldPath} → ${p.newPath}`;
      if (!renames.has(k)) renames.set(k, []);
      renames.get(k).push(p);
    }
    const summary = contentEl.createDiv({ cls: 'path-tracker-summary' });
    if (renames.size === 1) {
      const [k, entries] = renames.entries().next().value;
      summary.createDiv({ cls: 'path-tracker-summary-line', text: `Renamed:  ${k}` });
      summary.createDiv({ cls: 'path-tracker-summary-sub', text: `${entries.length} setting${entries.length === 1 ? '' : 's'} still reference the old name.` });
    } else {
      summary.createDiv({ cls: 'path-tracker-summary-line', text: `${renames.size} renames pending` });
      summary.createDiv({ cls: 'path-tracker-summary-sub', text: `${pending.length} setting${pending.length === 1 ? '' : 's'} still reference old names.` });
    }

    // ---- Three buttons
    const bar = contentEl.createDiv({ cls: 'path-tracker-toolbar primary' });
    const applyAll = bar.createEl('button', { text: 'Apply all', cls: 'mod-cta' });
    applyAll.onclick = async () => {
      const summary = await plugin.applyProposals(pending.slice());
      this.lastAppliedSummary = summary;
      this.selected.clear();
      this.render();
    };
    const noneBtn = bar.createEl('button', { text: 'Apply none' });
    noneBtn.title = 'Skip everything. Nothing is changed on disk.';
    noneBtn.onclick = () => {
      for (const p of pending) {
        p.status = 'skipped';
        plugin.pending = plugin.pending.filter((q) => q.id !== p.id);
      }
      this.selected.clear();
      plugin.updateRibbon();
      plugin.settingTab.refreshIfOpen();
      this.render();
    };
    const chooseBtn = bar.createEl('button', { text: this.chooseMode ? 'Done choosing' : 'Choose' });
    chooseBtn.title = 'Pick which changes to apply individually.';
    chooseBtn.onclick = () => {
      this.chooseMode = !this.chooseMode;
      this.render();
    };

    // ---- "Choose" mode adds an Apply-selected button
    if (this.chooseMode) {
      const subBar = contentEl.createDiv({ cls: 'path-tracker-toolbar' });
      const applySel = subBar.createEl('button', { text: `Apply selected (${this.selected.size})`, cls: 'mod-cta' });
      applySel.disabled = this.selected.size === 0;
      applySel.onclick = async () => {
        const chosen = pending.filter((p) => this.selected.has(p.id));
        const summary = await plugin.applyProposals(chosen);
        this.lastAppliedSummary = summary;
        this.selected.clear();
        this.render();
      };
    }

    // ---- Group by source (one row per plugin/feature)
    const groups = new Map();    // groupKey → { label, category, sourceFile, scope, entries[] }
    for (const p of pending) {
      const key = `${p.sourceFile}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: plugin.friendlyLabel(p),
          category: plugin.categoryFor(p),
          entries: [],
        });
      }
      groups.get(key).entries.push(p);
    }

    for (const g of groups.values()) {
      const isOpen = this.expanded.has(g.key);
      const card = contentEl.createDiv({ cls: 'path-tracker-group-card' });

      // Header row
      const head = card.createDiv({ cls: 'path-tracker-group-head' });
      if (this.chooseMode) {
        const gcb = head.createEl('input', { type: 'checkbox' });
        const allSelected = g.entries.every((p) => this.selected.has(p.id));
        gcb.checked = allSelected;
        gcb.onclick = (ev) => ev.stopPropagation();
        gcb.onchange = () => {
          for (const p of g.entries) {
            if (gcb.checked) this.selected.add(p.id);
            else this.selected.delete(p.id);
          }
          this.render();
        };
      }
      const caret = head.createSpan({ cls: `pt-caret ${isOpen ? 'open' : ''}` });
      const titleCol = head.createDiv({ cls: 'path-tracker-group-title' });
      const nameLine = titleCol.createDiv({ cls: 'path-tracker-group-name' });
      nameLine.createSpan({ text: g.label });
      appendCategoryPill(nameLine, g.category);
      titleCol.createDiv({ cls: 'path-tracker-group-sub', text: plainEnglishSummary(g.entries) });
      head.onclick = () => {
        if (this.expanded.has(g.key)) this.expanded.delete(g.key);
        else this.expanded.add(g.key);
        this.render();
      };

      // Body (expanded)
      if (isOpen) {
        const body = card.createDiv({ cls: 'path-tracker-group-body' });
        for (const p of g.entries) {
          const line = body.createDiv({ cls: 'path-tracker-line' });
          if (this.chooseMode) {
            const cb = line.createEl('input', { type: 'checkbox' });
            cb.checked = this.selected.has(p.id);
            cb.onchange = () => {
              if (cb.checked) this.selected.add(p.id);
              else this.selected.delete(p.id);
              this.render();
            };
          }
          const what = line.createDiv({ cls: 'path-tracker-line-what' });
          what.setText(entryTitle(p));
          const diff = line.createDiv({ cls: 'path-tracker-line-diff' });
          diff.title = `${p.oldValue}\n→\n${p.newValue}`;
          renderInlineDiff(diff, p.oldValue, p.newValue);
        }
      }
    }
  }
}

// Build the plain-English subtitle for a group of changes in one source.
function plainEnglishSummary(entries) {
  if (entries.length === 1) {
    return `${entryTitle(entries[0]).toLowerCase()} updated`;
  }
  // Up to two distinct titles, plus an "others" suffix
  const titles = Array.from(new Set(entries.map((e) => entryTitle(e).toLowerCase())));
  if (titles.length === 1) return `${entries.length} ${titles[0]}s updated`;
  if (titles.length === 2) return `${titles[0]} and ${titles[1]} updated`;
  return `${titles.slice(0, 2).join(', ')} and ${entries.length - 2} more`;
}

// Used by the settings-tab history expansion (no checkboxes, no per-row buttons —
// the group card on top carries Undo)
function renderEntryRow(parent, entry, plugin) {
  const row = parent.createDiv({ cls: 'path-tracker-line' });
  row.createDiv({ cls: 'path-tracker-line-what', text: `${entryTitle(entry)}  ·  ${plugin.friendlyLabel(entry)}` });
  const diff = row.createDiv({ cls: 'path-tracker-line-diff' });
  diff.title = `${entry.oldValue}\n→\n${entry.newValue}`;
  renderInlineDiff(diff, entry.oldValue, entry.newValue);
  if (entry.status && entry.status !== 'pending') {
    const tag = row.createSpan({ cls: `path-tracker-status ${entry.status}`, text: entry.status });
    tag.style.marginLeft = '6px';
  }
}

// ============================================================================
// Settings tab
// ============================================================================
class PathTrackerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.isOpen = false;
  }
  refreshIfOpen() { if (this.isOpen) this.display(); }
  hide() { this.isOpen = false; }
  display() {
    this.isOpen = true;
    const { containerEl } = this;
    containerEl.empty();

    // ---- Reload banner: only when auto-reload is OFF and a community plugin's
    // data.json was edited this session and the user hasn't reloaded or dismissed.
    if (!this.plugin.settings.reloadPluginsAfterUpdate &&
        this.plugin.pluginsNeedingReload && this.plugin.pluginsNeedingReload.size > 0) {
      const list = Array.from(this.plugin.pluginsNeedingReload);
      const count = list.length;
      const banner = containerEl.createDiv({ cls: 'fpu-reload-banner' });
      const title = banner.createDiv({ cls: 'fpu-reload-banner-title' });
      title.setText(`${count} plugin${count === 1 ? '' : 's'} use${count === 1 ? 's' : ''} an old path: ${list.join(', ')}`);
      banner.createDiv({ cls: 'fpu-reload-banner-sub', text: 'Reload Obsidian for the changes to take effect.' });
      const btns = banner.createDiv({ cls: 'fpu-reload-banner-btns' });
      const reload = btns.createEl('button', { text: 'Reload Obsidian', cls: 'mod-cta' });
      reload.onclick = () => this.plugin.triggerReload();
      const dismiss = btns.createEl('button', { text: 'Dismiss' });
      dismiss.onclick = () => { this.plugin.pluginsNeedingReload.clear(); this.display(); };
    }

    containerEl.createEl('p', {
      text: 'Automatically updates folder and file path references across Obsidian’s core settings and community plugin data when you rename or move things.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('When you rename something')
      .setDesc('Choose how the plugin should behave when references to a renamed folder or file are found.')
      .addDropdown((d) => d
        .addOption('manual', 'Ask me each time')
        .addOption('auto', 'Automatically apply (with notification)')
        .addOption('notify', 'Notify (no action taken)')
        .setValue(this.plugin.settings.mode)
        .onChange(async (v) => { this.plugin.settings.mode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Reload affected community plugins')
      .setDesc('After editing a plugin\'s data.json, disable then re-enable it so the new path takes effect without restarting Obsidian.')
      .addToggle((t) => t.setValue(this.plugin.settings.reloadPluginsAfterUpdate).onChange(async (v) => { this.plugin.settings.reloadPluginsAfterUpdate = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Notify on every rename')
      .setDesc('Show a brief notice even when nothing references the renamed folder, so you know the plugin ran. Turn off if it becomes noisy during large reorganizations.')
      .addToggle((t) => t.setValue(this.plugin.settings.notifyOnNoChanges).onChange(async (v) => { this.plugin.settings.notifyOnNoChanges = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Also scan note frontmatter')
      .setDesc('Look for path references inside YAML frontmatter properties of your notes. Only property names on the allowlist below are checked, so unrelated properties like tags or labels are never touched.')
      .addToggle((t) => t.setValue(this.plugin.settings.scanFrontmatter).onChange(async (v) => { this.plugin.settings.scanFrontmatter = v; await this.plugin.saveSettings(); }));

    const fmSetting = new Setting(containerEl)
      .setName('Frontmatter property allowlist (one per line)')
      .setDesc('Properties whose value can be rewritten when a folder or file is renamed. Empty by default — add only properties you know hold paths.')
      .addTextArea((t) => {
        t.setValue((this.plugin.settings.frontmatterAllowlist || []).join('\n'));
        t.inputEl.rows = 4;
        t.inputEl.style.width = '100%';
        t.inputEl.setAttr('placeholder', 'template\ntemplates_folder\nattachmentFolderPath');
        t.onChange(async (v) => {
          this.plugin.settings.frontmatterAllowlist = v.split('\n').map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });
    const fmHint = fmSetting.descEl.createDiv({ cls: 'fpu-setting-hint' });
    fmHint.setText('Property names are matched case-insensitively.');

    new Setting(containerEl)
      .setName('Backup retention')
      .setDesc('Snapshots of every modified settings file live in .obsidian/plugins/folder-path-updater/backups/. Older files are deleted automatically on plugin load.')
      .addDropdown((d) => d
        .addOption('7', '7 days')
        .addOption('30', '30 days (recommended)')
        .addOption('90', '90 days')
        .addOption('0', 'Never delete')
        .setValue(String(this.plugin.settings.backupRetentionDays))
        .onChange(async (v) => { this.plugin.settings.backupRetentionDays = parseInt(v, 10) || 0; await this.plugin.saveSettings(); }));

    const ignoreSetting = new Setting(containerEl)
      .setName('Ignore paths (one per line)')
      .setDesc('Renames of these vault paths (or their children) are skipped entirely.')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.ignorePaths.join('\n'));
        t.inputEl.rows = 4;
        t.inputEl.style.width = '100%';
        t.inputEl.setAttr('placeholder', 'Archive\n**/Drafts');
        t.onChange(async (v) => {
          this.plugin.settings.ignorePaths = v.split('\n').map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });
    const ignoreHint = ignoreSetting.descEl.createDiv({ cls: 'fpu-setting-hint' });
    ignoreHint.setText('Supports * (one segment) and ** (any depth) wildcards.');

    // ---- History (current session: full cards; past sessions: collapsed one-liners)
    if (!this.expandedGroups) this.expandedGroups = new Set();
    if (!this.expandedPastSessions) this.expandedPastSessions = new Set();

    const sid = this.plugin.currentSessionId;
    const currentEntries = this.plugin.session.filter((e) => (e.sessionId || sid) === sid);
    const pastEntries = this.plugin.session.filter((e) => (e.sessionId || sid) !== sid);

    // Group current session by rename pair (existing behavior)
    const sorted = currentEntries.slice().sort((a, b) => b.ts - a.ts);
    const groups = new Map();
    for (const e of sorted) {
      const key = `${e.oldPath}→${e.newPath}`;
      if (!groups.has(key)) {
        groups.set(key, { key, oldPath: e.oldPath, newPath: e.newPath, entries: [], latestTs: e.ts });
      }
      const g = groups.get(key);
      g.entries.push(e);
      if (e.ts > g.latestTs) g.latestTs = e.ts;
    }
    for (const g of groups.values()) {
      g.counts = { applied: 0, skipped: 0, reverted: 0, failed: 0, pending: 0, superseded: 0 };
      for (const e of g.entries) if (g.counts[e.status] !== undefined) g.counts[e.status]++;
    }
    const groupList = Array.from(groups.values()).sort((a, b) => b.latestTs - a.latestTs);
    const totalApplied = currentEntries.filter((e) => e.status === 'applied').length;

    const head = containerEl.createDiv({ cls: 'path-tracker-history-head' });
    head.createEl('h3', { text: 'History' });
    const headBtns = head.createDiv({ cls: 'path-tracker-history-head-btns' });
    if (this.plugin.pending.length > 0) {
      const apply = headBtns.createEl('button', { text: `Review ${this.plugin.pending.length} waiting`, cls: 'mod-cta' });
      apply.onclick = () => this.plugin.openPendingModal();
    }
    if (this.plugin.session.length > 0) {
      const clear = headBtns.createEl('button', { text: 'Clear history' });
      clear.title = 'Drops everything except pending entries. Does not change anything on disk.';
      clear.onclick = () => {
        this.plugin.session = this.plugin.session.filter((e) => e.status === 'pending');
        this.plugin.markHistoryDirty();
        this.display();
      };
    }

    if (currentEntries.length === 0 && pastEntries.length === 0) {
      containerEl.createDiv({ cls: 'path-tracker-empty', text: 'No renames tracked yet.' });
      return;
    }

    if (currentEntries.length === 0) {
      containerEl.createDiv({ cls: 'path-tracker-empty', text: 'No renames yet this session.' });
    } else {
      for (const g of groupList) this.renderHistoryGroup(containerEl, g);
    }

    // ---- Danger zone (current session only)
    if (totalApplied > 0) {
      const dz = containerEl.createDiv({ cls: 'path-tracker-danger-zone' });
      dz.createEl('h4', { text: 'Revert everything' });
      const desc = dz.createDiv({ cls: 'path-tracker-danger-desc' });
      desc.setText(`Undo every change Folder Path Updater has applied this session (${totalApplied}). Each setting goes back to its original value. Use this if something broke and you want to start over.`);
      const btn = dz.createEl('button', { text: `Revert ${totalApplied} change${totalApplied === 1 ? '' : 's'}`, cls: 'path-tracker-danger-btn' });
      btn.onclick = async () => {
        const ok = window.confirm(`Revert ${totalApplied} change${totalApplied === 1 ? '' : 's'}?`);
        if (!ok) return;
        await this.plugin.revertAllSession();
        this.display();
      };
    }

    // ---- Past sessions (read-only, collapsible)
    if (pastEntries.length > 0) this.renderPastSessions(containerEl, pastEntries);
  }

  renderPastSessions(containerEl, pastEntries) {
    // Group by sessionId
    const bySession = new Map();
    for (const e of pastEntries) {
      const sid = e.sessionId || 0;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(e);
    }
    const sessions = Array.from(bySession.entries()).map(([sid, entries]) => ({
      sid,
      entries,
      latestTs: entries.reduce((m, e) => Math.max(m, e.ts || 0), 0),
    }));
    sessions.sort((a, b) => b.latestTs - a.latestTs);

    const divider = containerEl.createDiv({ cls: 'fpu-past-divider' });
    divider.createSpan({ text: 'Previous sessions' });

    for (const s of sessions) {
      const card = containerEl.createDiv({ cls: 'fpu-past-session-card' });
      const isOpen = this.expandedPastSessions.has(s.sid);

      // Group its entries by rename pair to summarize
      const renames = new Map();
      for (const e of s.entries) {
        const key = `${e.oldPath}→${e.newPath}`;
        if (!renames.has(key)) renames.set(key, { oldPath: e.oldPath, newPath: e.newPath, entries: [], latestTs: e.ts });
        const r = renames.get(key);
        r.entries.push(e);
        if (e.ts > r.latestTs) r.latestTs = e.ts;
      }
      const renameList = Array.from(renames.values()).sort((a, b) => b.latestTs - a.latestTs);

      const head = card.createDiv({ cls: 'fpu-past-session-head' });
      head.createSpan({ cls: `pt-caret ${isOpen ? 'open' : ''}` });
      const headDate = new Date(s.latestTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      head.createSpan({ cls: 'fpu-past-session-date', text: headDate });
      head.createSpan({ cls: 'fpu-past-session-count', text: `${renameList.length} rename${renameList.length === 1 ? '' : 's'}` });
      head.onclick = () => {
        if (this.expandedPastSessions.has(s.sid)) this.expandedPastSessions.delete(s.sid);
        else this.expandedPastSessions.add(s.sid);
        this.display();
      };

      if (isOpen) {
        const body = card.createDiv({ cls: 'fpu-past-session-body' });
        for (const r of renameList) {
          const row = body.createDiv({ cls: 'fpu-past-session-row' });
          const pathText = row.createSpan({ cls: 'fpu-past-session-path', text: formatPathPair(r.oldPath, r.newPath) });
          pathText.setAttr('title', `${r.oldPath}\n  →\n${r.newPath}`);
          const applied = r.entries.filter((e) => e.status === 'applied').length;
          const total = r.entries.length;
          const placesText = applied === total
            ? `${total} place${total === 1 ? '' : 's'}`
            : `${applied}/${total} place${total === 1 ? '' : 's'}`;
          const dateText = new Date(r.latestTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          row.createSpan({ cls: 'fpu-past-session-meta', text: ` · ${placesText} · ${dateText}` });
        }
      }
    }
  }

  renderHistoryGroup(containerEl, g) {
    const expanded = this.expandedGroups.has(g.key);
    const card = containerEl.createDiv({ cls: 'path-tracker-history-card' });

    // Headline row
    const sum = card.createDiv({ cls: 'path-tracker-history-summary' });
    const caret = sum.createSpan({ cls: `pt-caret ${expanded ? 'open' : ''}` });
    const title = sum.createDiv({ cls: 'path-tracker-history-title' });
    const line1 = title.createDiv({ cls: 'path-tracker-history-rename' });
    line1.createSpan({ text: `${g.oldPath}  →  ${g.newPath}` });
    const ts = line1.createSpan({ cls: 'path-tracker-history-ts', text: formatRelativeTime(g.latestTs) });
    ts.title = new Date(g.latestTs).toLocaleString();
    const line2 = title.createDiv({ cls: 'path-tracker-history-status' });
    // Status pills for each non-zero status
    const order = ['applied', 'reverted', 'pending', 'skipped', 'superseded', 'failed'];
    let any = false;
    for (const k of order) {
      if (g.counts[k]) { appendStatusPill(line2, k, g.counts[k]); any = true; }
    }
    if (!any) line2.setText('no changes');
    const targets = new Set(g.entries.map((e) => e.sourceFile)).size;
    const tail = line2.createSpan({ cls: 'path-tracker-history-tail' });
    tail.setText(`  across ${targets} place${targets === 1 ? '' : 's'}`);

    // Right-side action: Undo if applied exists, Re-apply if reverted exists
    const actions = sum.createDiv({ cls: 'path-tracker-history-actions' });
    if (g.counts.applied > 0) {
      const undoAll = actions.createEl('button', { text: 'Undo' });
      undoAll.title = 'Revert the changes from this rename.';
      undoAll.onclick = async (ev) => {
        ev.stopPropagation();
        let ok = 0, fail = 0;
        const targets = g.entries.filter((e) => e.status === 'applied');
        for (const e of targets) {
          await this.plugin.undoEntry(e, { silent: true });
          if (e.status === 'reverted') ok++; else fail++;
        }
        this.plugin.fpuNotice({
          status: this.plugin.formatRevertStatus('Reverted', ok, fail),
          paths: [{ oldPath: g.newPath, newPath: g.oldPath, count: g.entries.length > 1 ? (fail ? `[${ok}/${ok + fail}]` : `[${ok}]`) : '' }],
        });
        this.display();
      };
    }
    if (g.counts.reverted > 0) {
      const reapply = actions.createEl('button', { text: 'Re-apply' });
      reapply.title = 'Re-apply the reverted changes.';
      reapply.onclick = async (ev) => {
        ev.stopPropagation();
        let ok = 0, fail = 0;
        const targets = g.entries.filter((e) => e.status === 'reverted');
        for (const e of targets) {
          await this.plugin.reapplyEntry(e, { silent: true });
          if (e.status === 'applied') ok++; else fail++;
        }
        this.plugin.fpuNotice({
          status: this.plugin.formatRevertStatus('Re-applied', ok, fail),
          paths: [{ oldPath: g.oldPath, newPath: g.newPath, count: g.entries.length > 1 ? (fail ? `[${ok}/${ok + fail}]` : `[${ok}]`) : '' }],
        });
        this.display();
      };
    }
    if (g.counts.skipped > 0 && g.counts.applied === 0 && g.counts.reverted === 0) {
      const apply = actions.createEl('button', { text: 'Apply', cls: 'mod-cta' });
      apply.title = 'Apply the skipped changes from this rename.';
      apply.onclick = async (ev) => {
        ev.stopPropagation();
        const skipped = g.entries.filter((e) => e.status === 'skipped');
        await this.plugin.applyProposals(skipped);
        this.display();
      };
    }

    sum.onclick = () => {
      if (this.expandedGroups.has(g.key)) this.expandedGroups.delete(g.key);
      else this.expandedGroups.add(g.key);
      this.display();
    };

    if (expanded) {
      const body = card.createDiv({ cls: 'path-tracker-history-body' });
      // Group by source for nicer reading
      const bySource = new Map();
      for (const e of g.entries) {
        const k = this.plugin.friendlyLabel(e);
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(e);
      }
      for (const [label, entries] of bySource) {
        const block = body.createDiv({ cls: 'path-tracker-history-block' });
        const heading = block.createDiv({ cls: 'path-tracker-history-block-head' });
        heading.createSpan({ text: label });
        appendCategoryPill(heading, this.plugin.categoryFor(entries[0]));
        for (const e of entries) {
          const line = block.createDiv({ cls: 'path-tracker-line' });
          const top = line.createDiv({ cls: 'path-tracker-line-top' });
          top.createSpan({ cls: 'path-tracker-line-what', text: entryTitle(e) });
          if (e.status && e.status !== 'pending') {
            appendStatusPill(top, e.status);
          }
          if (e.ts) {
            const ts = top.createSpan({ cls: 'path-tracker-line-ts', text: formatRelativeTime(e.ts) });
            ts.title = new Date(e.ts).toLocaleString();
          }
          // Per-row Undo / Re-apply / Apply (for skipped)
          if (e.status === 'applied') {
            const u = top.createEl('button', { cls: 'path-tracker-line-btn', text: 'Undo' });
            u.onclick = async () => { await this.plugin.undoEntry(e); this.display(); };
          } else if (e.status === 'reverted') {
            const r = top.createEl('button', { cls: 'path-tracker-line-btn', text: 'Re-apply' });
            r.onclick = async () => { await this.plugin.reapplyEntry(e); this.display(); };
          } else if (e.status === 'skipped') {
            const a = top.createEl('button', { cls: 'path-tracker-line-btn', text: 'Apply' });
            a.onclick = async () => { await this.plugin.applyProposals([e]); this.display(); };
          }
          // Small "open in settings" arrow
          const goto = top.createEl('button', { cls: 'fpu-goto-btn', text: '↗' });
          goto.setAttr('aria-label', 'Open the related setting');
          goto.title = 'Open the related setting';
          goto.onclick = () => this.plugin.openSettingsForEntry(e);
          const diff = line.createDiv({ cls: 'path-tracker-line-diff' });
          diff.title = `${e.oldValue}\n→\n${e.newValue}`;
          renderInlineDiff(diff, e.oldValue, e.newValue);
        }
      }
    }
  }
}


// ============================================================================
// Manual rewrite modal — for renames done outside Obsidian (e.g. in Finder)
// or before the plugin was installed.
// ============================================================================
class ManualRewriteModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.titleEl.setText('Manually rewrite a path');
    const { contentEl } = this;
    contentEl.createEl('p', {
      text: 'Use this if you renamed or moved a folder/file outside Obsidian (or before installing Folder Path Updater). The plugin will scan all settings for references to the old path and queue them just like an in-app rename.',
      cls: 'setting-item-description',
    });
    let oldP = '', newP = '', asFolder = true;
    new Setting(contentEl).setName('Old path').setDesc('The path as it appears in your settings now.').addText((t) => t.onChange((v) => { oldP = v.trim(); }));
    new Setting(contentEl).setName('New path').setDesc('What the references should point to.').addText((t) => t.onChange((v) => { newP = v.trim(); }));
    new Setting(contentEl).setName('Treat as folder').setDesc('On: every child path under the old folder is rewritten too. Off: only exact matches of the old path.').addToggle((t) => t.setValue(true).onChange((v) => { asFolder = v; }));
    const go = contentEl.createEl('button', { text: 'Scan & queue', cls: 'mod-cta' });
    go.style.marginTop = '12px';
    go.onclick = async () => {
      if (!oldP || !newP) { new Notice('Both paths required.'); return; }
      if (oldP === newP)  { new Notice('Old and new paths are identical.'); return; }
      this.close();
      await this.plugin.runManualRewrite(oldP, newP, asFolder);
    };
  }
  onClose() { this.contentEl.empty(); }
}

// ============================================================================
// Redirect-after-delete modal — opens from a delete notice's "Redirect" button.
// User picks a new path; we rewrite the orphan references to point there.
// ============================================================================
const PathSuggest = AbstractInputSuggest ? class extends AbstractInputSuggest {
  constructor(app, inputEl) { super(app, inputEl); }
  getSuggestions(query) {
    const q = (query || '').toLowerCase();
    const files = this.app.vault.getAllLoadedFiles();
    return files
      .filter((f) => f && f.path && f.path !== '/' && f.path.toLowerCase().includes(q))
      .slice(0, 30);
  }
  renderSuggestion(file, el) { el.setText(file.path); }
  selectSuggestion(file) {
    this.setValue(file.path);
    this.close();
    // Fire an input event so the modal's preview updates
    const evt = new Event('input', { bubbles: true });
    this.inputEl && this.inputEl.dispatchEvent(evt);
  }
} : null;

class RedirectModal extends Modal {
  constructor(app, plugin, deletedPath, isFolder, refs) {
    super(app);
    this.plugin = plugin;
    this.deletedPath = deletedPath;
    this.isFolder = isFolder;
    this.refs = refs;
    this.newPath = '';
  }
  onOpen() {
    this.titleEl.setText('Redirect references');
    const { contentEl } = this;
    contentEl.addClass('fpu-redirect-modal');

    const intro = contentEl.createDiv({ cls: 'fpu-redirect-intro' });
    intro.createDiv({ text: 'Deleted:' }).addClass('fpu-redirect-label');
    const deletedRow = intro.createDiv({ cls: 'fpu-redirect-deleted' });
    deletedRow.setText(this.deletedPath);
    intro.createDiv({ cls: 'fpu-redirect-count', text: `${this.refs.length} reference${this.refs.length === 1 ? '' : 's'} still point here.` });

    contentEl.createDiv({ cls: 'fpu-redirect-label', text: 'Redirect to:' });
    const input = contentEl.createEl('input', { type: 'text', cls: 'fpu-redirect-input' });
    input.placeholder = 'Type or pick a path…';
    input.style.width = '100%';
    if (PathSuggest) new PathSuggest(this.app, input);

    const preview = contentEl.createDiv({ cls: 'fpu-redirect-preview' });
    const updatePreview = () => {
      this.newPath = input.value.trim();
      preview.empty();
      if (!this.newPath) {
        preview.setText('Pick a path above to see what will be updated.');
        preview.addClass('fpu-redirect-preview-muted');
        return;
      }
      preview.removeClass('fpu-redirect-preview-muted');
      preview.setText(`${this.refs.length} reference${this.refs.length === 1 ? '' : 's'} will be updated.`);
    };
    input.addEventListener('input', updatePreview);
    updatePreview();
    setTimeout(() => input.focus(), 50);

    const btns = contentEl.createDiv({ cls: 'fpu-redirect-buttons' });
    const apply = btns.createEl('button', { text: 'Apply', cls: 'mod-cta' });
    apply.onclick = async () => {
      if (!this.newPath || this.newPath === this.deletedPath) return;
      this.close();
      await this.plugin.runRedirect(this.deletedPath, this.newPath, this.isFolder, this.refs);
    };
    const view = btns.createEl('button', { text: 'View details' });
    view.title = 'Open the review modal regardless of your current Mode.';
    view.onclick = async () => {
      if (!this.newPath || this.newPath === this.deletedPath) return;
      this.close();
      await this.plugin.runRedirect(this.deletedPath, this.newPath, this.isFolder, this.refs, { forceManual: true });
    };
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = PathTrackerPlugin;
