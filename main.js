'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFolder, TFile, normalizePath } = obsidian;

const DEFAULT_SETTINGS = {
  mode: 'manual',                  // 'auto' | 'manual' | 'notify'
  reloadPluginsAfterUpdate: true,  // disable/enable plugin so it picks up the new path
  ignorePaths: [],
};

// Always-on internal behavior
const ALWAYS_ON = {
  scanCore: true,
  scanPluginData: true,
  backupBeforeWrite: true,
  notifyOnNoChanges: false,
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

class PathTrackerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.session = [];          // all entries this session (applied/skipped/pending/reverted)
    this.pending = [];          // entries with status==='pending'
    this.pluginsNeedingReload = new Set(); // populated only when auto-reload is OFF
    this.entryIdCounter = 0;
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
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
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
  }

  onunload() {
    if (this.renameBatchTimer) {
      window.clearTimeout(this.renameBatchTimer);
      this.renameBatchTimer = null;
    }
    this.renameBatch = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateRibbon() { /* ribbon removed — kept as a no-op so existing call sites are harmless */ }

  // ---------------------------------------------------------------------------
  // Rename batch handler — coalesces all renames in a short window into ONE notification
  // ---------------------------------------------------------------------------
  async handleRenameBatch(rawBatch) {
    // Filter out ignored paths
    let batch = rawBatch.filter((b) =>
      !this.settings.ignorePaths.some((p) => p === b.oldPath || b.oldPath.startsWith(p + '/'))
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
          });
        }
      }
    }

    if (proposals.length === 0) {
      if (autoCancelled > 0) {
        const summaryLine = batch.length === 1
          ? `"${batch[0].oldPath}" → "${batch[0].newPath}"`
          : `${batch.length} renames`;
        const n = new Notice('', 8000);
        n.noticeEl.empty();
        n.noticeEl.addClass('fpu-notice');
        const title = n.noticeEl.createDiv();
        title.style.cssText = 'font-weight:600;margin-bottom:2px;';
        title.setText(`Folder Path Updater: ${summaryLine}`);
        n.noticeEl.createDiv({ text: 'Already in sync — no action needed.' });
        this.settingTab.refreshIfOpen();
      } else if (ALWAYS_ON.notifyOnNoChanges) {
        const labels = batch.map((b) => `"${b.oldPath}"`).slice(0, 2).join(', ');
        const extra = batch.length > 2 ? ` (+${batch.length - 2} more)` : '';
        new Notice(`Folder Path Updater: no settings references found for ${labels}${extra}`);
      }
      return;
    }

    const summaryLine = batch.length === 1
      ? `"${batch[0].oldPath}" → "${batch[0].newPath}"`
      : `${batch.length} renames`;

    if (this.settings.mode === 'auto') {
      // Apply automatically AND show a notice with what was changed
      const summary = await this.applyProposals(proposals);
      const groupKeys = new Set(batch.map((b) => `${b.oldPath}→${b.newPath}`));
      this.notifySummary(summaryLine, summary, groupKeys);
    } else if (this.settings.mode === 'notify') {
      // No action — just log everything as skipped and show a View notice
      const groupKeys = new Set();
      for (const p of proposals) {
        p.status = 'skipped';
        p.note = 'notify-only mode';
        this.session.push(p);
        groupKeys.add(`${p.oldPath}→${p.newPath}`);
      }
      this.settingTab.refreshIfOpen();

      const n = new Notice('', 12000);
      n.noticeEl.empty();
      const title = n.noticeEl.createDiv();
      title.style.cssText = 'font-weight:600;margin-bottom:2px;';
      title.setText(`Folder Path Updater: ${summaryLine}`);
      const sub = n.noticeEl.createDiv();
      sub.style.cssText = 'opacity:0.85;';
      sub.setText(`${proposals.length} reference${proposals.length === 1 ? '' : 's'} found. Nothing changed — no action taken.`);
      const btns = n.noticeEl.createDiv();
      btns.style.cssText = 'margin-top:8px;display:flex;gap:6px;';
      const view = btns.createEl('button', { text: 'View' });
      view.onclick = () => {
        n.hide();
        const tab = this.settingTab;
        if (tab) {
          if (!tab.expandedGroups) tab.expandedGroups = new Set();
          for (const k of groupKeys) tab.expandedGroups.add(k);
        }
        this.app.setting.open();
        this.app.setting.openTabById('folder-path-updater');
      };
    } else {
      for (const p of proposals) {
        this.pending.push(p);
        this.session.push(p);
      }
      this.updateRibbon();

      const places = new Set(proposals.map((p) => this.friendlyLabel(p))).size;
      const n = new Notice('', 12000);
      n.noticeEl.empty();
      const title = n.noticeEl.createDiv();
      title.style.cssText = 'font-weight:600;margin-bottom:2px;';
      title.setText(`Folder Path Updater: ${summaryLine}`);
      const sub = n.noticeEl.createDiv();
      sub.style.cssText = 'opacity:0.85;';
      sub.setText(`${proposals.length} reference${proposals.length === 1 ? '' : 's'} across ${places} setting${places === 1 ? '' : 's'}.`);

      const btns = n.noticeEl.createDiv();
      btns.style.cssText = 'margin-top:8px;display:flex;gap:6px;';
      const review = btns.createEl('button', { text: 'Review' });
      review.onclick = () => { n.hide(); this.openPendingModal(); };
      const apply = btns.createEl('button', { text: 'Apply all' });
      apply.classList.add('mod-cta');
      apply.onclick = async () => {
        n.hide();
        const summary = await this.applyProposals(proposals);
        const groupKeys = new Set(proposals.map((p) => `${p.oldPath}→${p.newPath}`));
        this.notifySummary(summaryLine, summary, groupKeys);
      };
      this.settingTab.refreshIfOpen();
    }
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
      if (!this.session.includes(p)) this.session.push(p);
    }
    this.updateRibbon();
    this.settingTab.refreshIfOpen();
    return summary;
  }

  async applyAllPending() {
    if (this.pending.length === 0) {
      new Notice('Folder Path Updater: nothing pending.');
      return;
    }
    const items = this.pending.slice();
    const summary = await this.applyProposals(items);
    new Notice(`Folder Path Updater: applied ${summary.applied}, failed ${summary.failed}.`);
  }

  async revertAllSession() {
    const applied = this.session.filter((e) => e.status === 'applied');
    if (applied.length === 0) {
      new Notice('Folder Path Updater: nothing applied this session.');
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
    new Notice(`Folder Path Updater: reverted ${ok}${fail ? ` (${fail} failed)` : ''}.`);
    this.updateRibbon();
    this.settingTab.refreshIfOpen();
  }

  // Inverse of undo: re-write the new value (used to re-apply a reverted entry)
  async reapplyEntry(entry, opts) {
    opts = opts || {};
    if (entry.status !== 'reverted') {
      if (!opts.silent) new Notice('Only reverted changes can be re-applied.');
      return;
    }
    try {
      const adapter = this.app.vault.adapter;
      const raw = await adapter.read(entry.sourceFile);
      const data = JSON.parse(raw);
      this.setByKeyPath(data, entry.keyPath, entry.newValue);
      await adapter.write(entry.sourceFile, JSON.stringify(data, null, 2));
      entry.status = 'applied';
      this.settingTab.refreshIfOpen();
      if (!opts.silent) new Notice(`Re-applied ${this.friendlyLabel(entry)}.`);
    } catch (e) {
      if (!opts.silent) new Notice(`Re-apply failed: ${e.message}`);
    }
  }

  async undoEntry(entry, opts) {
    opts = opts || {};
    if (entry.status !== 'applied' || !entry.originalFileContent) {
      if (!opts.silent) new Notice('Cannot undo: no backup available.');
      return;
    }
    try {
      const adapter = this.app.vault.adapter;
      const raw = await adapter.read(entry.sourceFile);
      const data = JSON.parse(raw);
      this.setByKeyPath(data, entry.keyPath, entry.oldValue);
      await adapter.write(entry.sourceFile, JSON.stringify(data, null, 2));
      entry.status = 'reverted';
      this.settingTab.refreshIfOpen();
      if (!opts.silent) new Notice(`Reverted ${this.friendlyLabel(entry)}.`);
    } catch (e) {
      if (!opts.silent) new Notice(`Undo failed: ${e.message}`);
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

  setByKeyPath(obj, keyPath, value) {
    let cur = obj;
    for (let i = 0; i < keyPath.length - 1; i++) cur = cur[keyPath[i]];
    cur[keyPath[keyPath.length - 1]] = value;
  }

  notifySummary(summaryLine, summary, groupKeys) {
    const needsReload = summary.pluginsNeedingReload && summary.pluginsNeedingReload.size > 0;
    const n = new Notice('', needsReload ? 15000 : 10000);
    n.noticeEl.empty();
    n.noticeEl.addClass('fpu-notice');
    const title = n.noticeEl.createDiv();
    title.style.cssText = 'font-weight:600;margin-bottom:2px;';
    title.setText(`Folder Path Updater: ${summaryLine}`);
    let subText;
    if (needsReload) {
      const plugins = Array.from(summary.pluginsNeedingReload);
      let list;
      if (plugins.length === 1) list = plugins[0];
      else if (plugins.length === 2) list = `${plugins[0]} and ${plugins[1]}`;
      else list = `${plugins.slice(0, 2).join(', ')}, and ${plugins.length - 2} other${plugins.length - 2 === 1 ? '' : 's'}`;
      const verb = plugins.length === 1 ? 'uses' : 'use';
      subText = `${list} still ${verb} the old path until you reload.`;
    } else {
      subText = `Updated in ${summary.applied} place${summary.applied === 1 ? '' : 's'}${summary.failed ? ` (${summary.failed} failed)` : ''}.`;
    }
    n.noticeEl.createDiv({ text: subText });
    // Buttons row: View (+ Reload Obsidian if a community plugin needs reload)
    const btns = n.noticeEl.createDiv({ cls: 'fpu-notice-btns' });
    const view = btns.createEl('button', { text: 'View' });
    view.onclick = () => {
      n.hide();
      const tab = this.settingTab;
      if (tab && groupKeys) {
        if (!tab.expandedGroups) tab.expandedGroups = new Set();
        for (const k of groupKeys) tab.expandedGroups.add(k);
      }
      this.app.setting.open();
      this.app.setting.openTabById('folder-path-updater');
    };
    if (needsReload) {
      const reload = btns.createEl('button', { text: 'Reload Obsidian', cls: 'mod-cta' });
      reload.onclick = () => { n.hide(); this.triggerReload(); };
    }
  }

  openPendingModal() {
    new PendingModal(this.app, this).open();
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
      new Notice('Folder Path Updater: every settings path resolves.');
      return;
    }
    new Notice(`Folder Path Updater: ${missing.length} setting${missing.length === 1 ? '' : 's'} point at missing files/folders. See console.`, 8000);
    console.log('[Folder Path Updater] Broken settings paths:');
    for (const m of missing) {
      console.log(`  ${this.friendlyLabel({ scope: m.source.scope, sourceFile: m.source.path })}: ${humanizeKeyPath(m.keyPath)} = ${JSON.stringify(m.value)}`);
    }
  }

  // Friendly name for a target entry, e.g. "Calendar" or "Daily Notes (core)"
  friendlyLabel(entry) {
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
  if (category === 'Community plugin') {
    return parent.createSpan({ cls: 'pt-pill plugin', text: 'PLUGIN' });
  }
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
      .setName('Ignore paths (one per line)')
      .setDesc('Renames of these vault paths (or their children) are skipped entirely.')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.ignorePaths.join('\n'));
        t.inputEl.rows = 4;
        t.inputEl.style.width = '100%';
        t.onChange(async (v) => {
          this.plugin.settings.ignorePaths = v.split('\n').map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    // ---- History (one row per rename event)
    if (!this.expandedGroups) this.expandedGroups = new Set();

    const sorted = this.plugin.session.slice().sort((a, b) => b.ts - a.ts);
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
      g.counts = { applied: 0, skipped: 0, reverted: 0, failed: 0, pending: 0 };
      for (const e of g.entries) if (g.counts[e.status] !== undefined) g.counts[e.status]++;
    }
    const groupList = Array.from(groups.values()).sort((a, b) => b.latestTs - a.latestTs);
    const totalApplied = this.plugin.session.filter((e) => e.status === 'applied').length;

    const head = containerEl.createDiv({ cls: 'path-tracker-history-head' });
    head.createEl('h3', { text: 'History' });
    const headBtns = head.createDiv({ cls: 'path-tracker-history-head-btns' });
    if (this.plugin.pending.length > 0) {
      const apply = headBtns.createEl('button', { text: `Review ${this.plugin.pending.length} waiting`, cls: 'mod-cta' });
      apply.onclick = () => this.plugin.openPendingModal();
    }
    if (this.plugin.session.length > 0) {
      const clear = headBtns.createEl('button', { text: 'Clear history' });
      clear.title = 'Removes log entries from the list (does not change anything on disk).';
      clear.onclick = () => {
        this.plugin.session = this.plugin.session.filter((e) => e.status === 'pending');
        this.display();
      };
    }

    if (this.plugin.session.length === 0) {
      containerEl.createDiv({ cls: 'path-tracker-empty', text: 'No renames tracked yet.' });
      return;
    }

    for (const g of groupList) this.renderHistoryGroup(containerEl, g);

    // ---- Danger zone
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
    const order = ['applied', 'reverted', 'pending', 'skipped', 'failed'];
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
        for (const e of g.entries) {
          if (e.status !== 'applied') continue;
          await this.plugin.undoEntry(e, { silent: true });
          if (e.status === 'reverted') ok++; else fail++;
        }
        new Notice(`Reverted ${ok}${fail ? ` (${fail} failed)` : ''}.`);
        this.display();
      };
    }
    if (g.counts.reverted > 0) {
      const reapply = actions.createEl('button', { text: 'Re-apply' });
      reapply.title = 'Re-apply the reverted changes.';
      reapply.onclick = async (ev) => {
        ev.stopPropagation();
        let ok = 0, fail = 0;
        for (const e of g.entries) {
          if (e.status !== 'reverted') continue;
          await this.plugin.reapplyEntry(e, { silent: true });
          if (e.status === 'applied') ok++; else fail++;
        }
        new Notice(`Re-applied ${ok}${fail ? ` (${fail} failed)` : ''}.`);
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

module.exports = PathTrackerPlugin;
