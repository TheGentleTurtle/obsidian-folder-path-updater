'use strict';
// Unit tests for the pure logic in main.js. Run with: node tests/run-tests.js
//
// Class methods are tested through the exported plugin prototype; module-level
// functions are extracted verbatim from the source and evaluated, so the tests
// always exercise the shipped code, never a copy.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const Module = require('module');

// Route require('obsidian') to the local stub before loading main.js.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js');
  return origResolve.call(this, request, ...args);
};

const MAIN = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');
const PluginClass = require(MAIN);
const proto = PluginClass.prototype;

// --- extract a top-level `function name(...) {...}` / `const NAME = {...}` block ---
function extractBlock(startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('marker not found: ' + startMarker);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const ctx = { console };
vm.createContext(ctx);
{ // REDUNDANT_LEAF_KEYS is a one-liner `new Set([...])`
  const s = src.indexOf('const REDUNDANT_LEAF_KEYS');
  const e = src.indexOf(');', s);
  vm.runInContext(src.slice(s, e + 2), ctx);
}
for (const p of [
  'const KEY_OVERRIDES',
  'const SCOPED_KEY_OVERRIDES',
  'function globToRegex',
  'function formatPathPair',
  'function changeKey',
  'function humanizeKeyToken',
  'function singularize',
  'function humanizeKeyPath',
  'function tabIdForEntry',
  'function statusSentence',
]) {
  let code = extractBlock(p);
  if (p.startsWith('const')) code += ';';
  vm.runInContext(code, ctx);
}

const matchPath = proto.matchPath.bind({});
const setByKeyPath = proto.setByKeyPath.bind({});
const scanHost = { matchPath, scanForPaths: proto.scanForPaths };
const scanForPaths = (node, oldPath, newPath, isFolder) => {
  const out = [];
  scanHost.scanForPaths(node, oldPath, newPath, isFolder, [], '', out);
  return out;
};

let pass = 0, fail = 0;
const failures = [];
function eq(desc, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; failures.push(`FAIL ${desc}\n  got:  ${g}\n  want: ${w}`); }
}

// ============================== matchPath ==============================
eq('folder prefix rewrite', matchPath('Templates/Daily Note.md', 'Templates', 'Cool Templates', true, 'template'),
  { newValue: 'Cool Templates/Daily Note.md', kind: 'prefix' });
eq('different filename untouched (Daily Notes vs Daily Note.md)',
  matchPath('Templates/Daily Note.md', 'Daily Notes', 'Daily', true, 'template'), null);
eq('prefix boundary: Daily does not match Daily Notes/x',
  matchPath('Daily Notes/2026/a.md', 'Daily', 'D2', true, 'folder'), null);
eq('prefix boundary: Daily Notes does not match DailyNotes2/x',
  matchPath('DailyNotes2/a.md', 'Daily Notes', 'Daily', true, 'folder'), null);
eq('exact folder match with pathy key', matchPath('Daily Notes', 'Daily Notes', 'Daily', true, 'folder'),
  { newValue: 'Daily', kind: 'exact' });
eq('exact match rejected: non-path key, no slash', matchPath('Notes', 'Notes', 'N2', true, 'category'), null);
eq('exact match allowed: non-path key but slash in value', matchPath('a/Notes', 'a/Notes', 'a/N2', true, 'category'),
  { newValue: 'a/N2', kind: 'exact' });
eq('file exact match (value stores extension)',
  matchPath('templates/Unique Note Template.md', 'templates/Unique Note Template.md', 'templates/unique.md', false, 'template'),
  { newValue: 'templates/unique.md', kind: 'exact' });
// Extensionless settings (daily-notes.json style: "template": "System/Templates/Daily")
eq('extensionless setting updated on file rename',
  matchPath('templates/daily', 'templates/daily.md', 'templates/day.md', false, 'template'),
  { newValue: 'templates/day', kind: 'exact' });
eq('extensionless branch requires .md new path',
  matchPath('templates/daily', 'templates/daily.md', 'templates/day.txt', false, 'template'), null);
eq('extensionless branch never fires for folder renames',
  matchPath('templates/daily', 'templates/daily.md', 'templates/day.md', true, 'template'), null);
eq('folder rename must NOT rewrite same-named .md file reference',
  matchPath('Daily.md', 'Daily', 'Cool', true, 'folder'), null);
eq('manual rewrite: extensionless old path matches value with extension',
  matchPath('X.md', 'X', 'Y', false, 'file'), { newValue: 'Y.md', kind: 'exact' });
eq('unicode path prefix', matchPath('📁 Notes/x.md', '📁 Notes', '📂 N', true, 'folder'),
  { newValue: '📂 N/x.md', kind: 'prefix' });
eq('regex-special chars in path', matchPath('A (1)/x.md', 'A (1)', 'B+', true, 'folder'),
  { newValue: 'B+/x.md', kind: 'prefix' });
// Cosmetic tolerance: users type case variants, leading "/" or "./", trailing "/"
eq('case-insensitive exact match',
  matchPath('02 daily notes', '02 Daily Notes', 'daily', true, 'folder'), { newValue: 'daily', kind: 'exact' });
eq('case-insensitive prefix match',
  matchPath('02 DAILY NOTES/x.md', '02 Daily Notes', 'daily', true, 'file'), { newValue: 'daily/x.md', kind: 'prefix' });
eq('trailing slash tolerated and preserved',
  matchPath('02 Daily Notes/', '02 Daily Notes', 'daily', true, 'folder'), { newValue: 'daily/', kind: 'exact' });
eq('leading slash tolerated and preserved',
  matchPath('/02 Daily Notes', '02 Daily Notes', 'daily', true, 'folder'), { newValue: '/daily', kind: 'exact' });
eq('leading ./ tolerated and preserved',
  matchPath('./02 Daily Notes', '02 Daily Notes', 'daily', true, 'folder'), { newValue: './daily', kind: 'exact' });
eq('case tolerance is not fuzzy matching',
  matchPath('02 Daily Notes Extra', '02 Daily Notes', 'daily', true, 'folder'), null);
eq('case-insensitive boundary still enforced',
  matchPath('02 DAILY NOTESX/a.md', '02 Daily Notes', 'daily', true, 'folder'), null);
eq('slash-decorated value counts as path-like even with generic key',
  matchPath('Notes/', 'Notes', 'N2', true, 'category'), { newValue: 'N2/', kind: 'exact' });

// ============================== globToRegex ==============================
const g = (pat, s) => { const re = ctx.globToRegex(pat); return re ? re.test(s) : null; };
eq('literal matches itself', g('Archive', 'Archive'), true);
eq('literal matches children', g('Archive', 'Archive/x/y.md'), true);
eq('literal does not match prefix-sibling', g('Archive', 'Archives/x.md'), false);
eq('**/Drafts matches root Drafts', g('**/Drafts', 'Drafts'), true);
eq('**/Drafts matches nested', g('**/Drafts', 'Projects/Eng/Drafts'), true);
eq('**/Drafts matches descendants', g('**/Drafts', 'Projects/Drafts/x.md'), true);
eq('**/Drafts does not match Drafts2', g('**/Drafts', 'Projects/Drafts2'), false);
eq('Archive/* matches child', g('Archive/*', 'Archive/2020'), true);
eq('Archive/* matches grandchild (descendant rule)', g('Archive/*', 'Archive/2020/notes.md'), true);
eq('Archive/* does not match Archive itself', g('Archive/*', 'Archive'), false);
eq('*-old suffix', g('*-old', 'Notes-old'), true);
eq('*-old does not cross segments', g('*-old', 'a/Notes-old'), false);
eq('? single char', g('V?', 'V1'), true);
eq('? not slash', g('V?', 'V/'), false);
eq('regex specials literal', g('A (1)', 'A (1)/x'), true);
eq('dot literal not wildcard', g('a.md', 'aXmd'), false);
eq('** alone matches everything', g('**', 'any/thing'), true);
eq('empty pattern -> null', ctx.globToRegex('   '), null);

// ============================== formatPathPair ==============================
eq('same parent collapses to basenames', ctx.formatPathPair('A/B/Daily', 'A/B/Daily Notes'), 'Daily → Daily Notes');
eq('different parent keeps full paths', ctx.formatPathPair('A/Daily', 'B/Daily'), 'A/Daily → B/Daily');
eq('root rename', ctx.formatPathPair('Daily', 'Daily Notes'), 'Daily → Daily Notes');
eq('move shows full paths', ctx.formatPathPair('Daily', 'Archive/Daily'), 'Daily → Archive/Daily');
eq('quoted headline style', ctx.formatPathPair('Daily Notes', 'Daily', true), '"Daily Notes" → "Daily"');
eq('quoted move keeps full paths', ctx.formatPathPair('Daily', 'Archive/Daily', true), '"Daily" → "Archive/Daily"');

// ============================== humanizeKeyPath ==============================
const h = (kp, srcFile) => ctx.humanizeKeyPath(kp, srcFile);
eq('bookmarks items[0].path scoped', h(['items', 0, 'path'], 'bookmarks.json'), 'Bookmark #1');
eq('other plugin items[0].path', h(['items', 0, 'path'], 'data.json'), 'Item #1');
eq('items[2] direct', h(['items', 2], 'bookmarks.json'), 'Bookmark #3');
eq('nested bookmarks group uses inner index', h(['items', 1, 'items', 3, 'path'], 'bookmarks.json'), 'Bookmark #4');
// Core files use the EXACT labels from Obsidian's settings UI
eq('daily-notes folder = settings label', h(['folder'], 'daily-notes.json'), 'New file location');
eq('daily-notes template = settings label', h(['template'], 'daily-notes.json'), 'Template file location');
eq('daily-notes format = settings label', h(['format'], 'daily-notes.json'), 'Date format');
eq('templates folder = settings label', h(['folder'], 'templates.json'), 'Template folder location');
eq('zk-prefixer folder = settings label', h(['folder'], 'zk-prefixer.json'), 'New file location');
eq('app attachments = settings label', h(['attachmentFolderPath'], 'app.json'), 'Default location for new attachments');
eq('app new-note folder = settings label', h(['newFileFolderPath'], 'app.json'), 'Folder to create new notes in');
eq('app excluded files array', h(['userIgnoreFilters', 0], 'app.json'), 'Excluded file #1');
// Community plugins keep the generic humanizer
eq('community folder stays generic', h(['folder'], 'data.json'), 'Folder');
eq('community template stays generic', h(['template'], 'data.json'), 'Template');
eq('community attachmentFolderPath generic', h(['attachmentFolderPath'], 'data.json'), 'Attachment folder');
eq('camelCase split (sentence case)', h(['recentFiles', 0, 'path'], 'data.json'), 'Recent file #1');
eq('redundant leaf falls back to parent', h(['templates', 'path'], 'data.json'), 'Template');
eq('all-numeric path', h([0], 'data.json'), 'Item #1');
eq('empty keyPath', h([], 'data.json'), 'value');
eq('non-redundant leaf keeps its own name', h(['feeds', 5, 'folder'], 'data.json'), 'Folder');
eq('singularize ies', ctx.singularize('Categories'), 'Category');
eq('singularize plain s', ctx.singularize('Notes'), 'Note');
eq('no singularize ss', ctx.singularize('Address'), 'Address');
eq('singularize ses', ctx.singularize('Statuses'), 'Status');

// ============================== changeKey ==============================
const e1 = { sourceFile: 'a.json', keyPath: ['folder'], oldValue: 'A', newValue: 'B' };
eq('changeKey equal for identical changes', ctx.changeKey(e1) === ctx.changeKey({ ...e1 }), true);
eq('changeKey differs by keyPath', ctx.changeKey(e1) === ctx.changeKey({ ...e1, keyPath: ['template'] }), false);
eq('changeKey differs by file', ctx.changeKey(e1) === ctx.changeKey({ ...e1, sourceFile: 'b.json' }), false);
eq('changeKey differs by value', ctx.changeKey(e1) === ctx.changeKey({ ...e1, newValue: 'C' }), false);
eq('changeKey no ambiguity across fields', ctx.changeKey({ ...e1, oldValue: 'A1', newValue: '' }) === ctx.changeKey({ ...e1, oldValue: 'A', newValue: '1' }), false);

// ============================== statusSentence ==============================
const zero = { applied: 0, skipped: 0, reverted: 0, failed: 0, pending: 0, superseded: 0 };
eq('all applied', ctx.statusSentence({ ...zero, applied: 3 }), '3 settings updated');
eq('single applied', ctx.statusSentence({ ...zero, applied: 1 }), '1 setting updated');
eq('mixed applied + skipped', ctx.statusSentence({ ...zero, applied: 2, skipped: 1 }), '2 settings updated, 1 skipped');
eq('pending only', ctx.statusSentence({ ...zero, pending: 4 }), '4 waiting for review');
eq('superseded', ctx.statusSentence({ ...zero, superseded: 2 }), 'replaced by a later rename');
eq('empty counts', ctx.statusSentence(zero), 'no changes');

// ============================== tabIdForEntry ==============================
eq('plugin scope -> plugin id', ctx.tabIdForEntry({ scope: 'plugin:calendar', sourceFile: 'x/data.json' }), 'calendar');
eq('app.json -> file', ctx.tabIdForEntry({ scope: 'core', sourceFile: '.obsidian/app.json' }), 'file');
eq('daily-notes.json -> daily-notes', ctx.tabIdForEntry({ scope: 'core', sourceFile: '.obsidian/daily-notes.json' }), 'daily-notes');

// ============================== action-notice housekeeping ==============================
{
  const mkNotice = () => ({ hidden: false, hide() { this.hidden = true; } });
  const host = { activeActionNotices: [] };
  const reg = proto.registerActionNotice.bind(host);
  const refresh = proto.refreshActionNotices.bind(host);
  const p1 = { status: 'pending' }, p2 = { status: 'pending' };
  const n1 = mkNotice();
  reg(n1, [p1, p2], ['pending']);
  refresh();
  eq('notice stays while proposals pending', n1.hidden, false);
  p1.status = 'superseded';
  refresh();
  eq('notice stays while one proposal still pending', n1.hidden, false);
  p2.status = 'applied';
  refresh();
  eq('notice hides once all proposals resolved elsewhere', n1.hidden, true);
  eq('resolved notice record pruned', host.activeActionNotices.length, 0);
  const n2 = mkNotice();
  const s1 = { status: 'skipped' };
  reg(n2, [s1], ['skipped']);
  refresh();
  eq('notify notice stays while entries skipped', n2.hidden, false);
  s1.status = 'superseded';
  refresh();
  eq('notify notice hides when entries superseded', n2.hidden, true);
}

// ============================== scanForPaths / setByKeyPath ==============================
const data = { folder: 'Daily Notes', nested: { list: ['Daily Notes/a.md', 'Other/b.md'] }, tag: 'Daily Notes' };
const found = scanForPaths(data, 'Daily Notes', 'Daily', true);
eq('scan finds folder key + prefix in array, skips bare tag', found.map((m) => m.keyPath),
  [['folder'], ['nested', 'list', 0]]);
setByKeyPath(data, ['nested', 'list', 0], 'Daily/a.md');
eq('setByKeyPath array index', data.nested.list[0], 'Daily/a.md');

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures) console.log('\n' + f);
process.exit(fail ? 1 : 0);
