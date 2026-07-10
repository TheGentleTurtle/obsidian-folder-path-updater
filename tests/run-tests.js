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
eq('folder key override', h(['folder'], 'daily-notes.json'), 'Folder');
eq('template key', h(['template'], 'daily-notes.json'), 'Template');
eq('attachmentFolderPath', h(['attachmentFolderPath'], 'app.json'), 'Attachment folder');
eq('camelCase split (sentence case)', h(['recentFiles', 0, 'path'], 'data.json'), 'Recent file #1');
eq('redundant leaf falls back to parent', h(['templates', 'path'], 'data.json'), 'Template');
eq('all-numeric path', h([0], 'data.json'), 'Item #1');
eq('empty keyPath', h([], 'data.json'), 'value');
eq('non-redundant leaf keeps its own name', h(['feeds', 5, 'folder'], 'data.json'), 'Folder');
eq('singularize ies', ctx.singularize('Categories'), 'Category');
eq('singularize plain s', ctx.singularize('Notes'), 'Note');
eq('no singularize ss', ctx.singularize('Address'), 'Address');
eq('singularize ses', ctx.singularize('Statuses'), 'Status');

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
