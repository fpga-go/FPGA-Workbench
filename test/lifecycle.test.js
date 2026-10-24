'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { HdlIndex } = require('../src/indexer');

const extensionSource = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
const timeout = { timeout: 4000 };
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Emitter {
  constructor() { this.listeners = new Set(); this.disposed = false; }
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { if (!this.disposed) for (const listener of this.listeners) listener(value); }
  dispose() { this.disposed = true; this.listeners.clear(); }
}

function harness(t) {
  const h = {
    state: new Map(), contexts: new Map(), commands: new Map(), watchers: [], timers: new Map(),
    loadCalls: [], starts: [], backendEvents: [], logs: [], errors: [], timerId: 0, filelistCalls: [], executions: [],
    symbolRegistrations: [], symbolEvents: [],
  };
  const disposable = () => ({ disposed: false, dispose() { this.disposed = true; } });
  const uri = file => ({ scheme: 'file', fsPath: path.resolve(file), toString() { return pathToFileURL(this.fsPath).href; } });
  h.xpr = name => path.resolve('synthetic-lifecycle', name, `${name}.xpr`);
  h.source = name => path.resolve('synthetic-lifecycle', name, `${name}_top.v`);
  h.text = name => `module ${name}_top(input wire clk);\nendmodule\n`;
  h.makeProject = xpr => {
    const name = path.basename(xpr, '.xpr');
    const source = h.source(name);
    return {
      path: xpr, root: path.dirname(xpr), name, top: `${name}_top`, warnings: [],
      sourceFiles: [source], includeDirs: [], defines: [],
      filesets: [{ name: 'sources_1', type: 'DesignSrcs' }],
      files: [{ path: source, fileset: 'sources_1', exists: true, enabled: true }],
    };
  };
  h.document = name => ({ uri: uri(h.source(name)), getText: () => h.text(name), offsetAt: () => 7 });
  h.read = async file => h.text(path.basename(file, '_top.v'));
  h.load = async xpr => h.makeProject(xpr);
  h.start = async () => {};
  h.openDialog = async () => undefined;
  h.definition = async () => [];
  h.parentConnections = async () => [];
  h.reference = async () => [];
  h.hierarchy = async () => [];

  class Backend {
    constructor() { this.running = false; this.status = 'idle'; this.diagnosticsCounts = { errors: 0, warnings: 0 }; }
    async start(options) {
      h.starts.push(options.project.name);
      h.backendEvents.push(`start:${options.project.name}`);
      this.onChange = options.onChange;
      await h.start(options);
      this.running = true; this.status = 'running';
      h.backendEvents.push(`started:${options.project.name}`);
      return true;
    }
    async stop() { h.backendEvents.push('stop'); this.running = false; this.status = 'stopped'; }
    definitions(...args) { return h.definition(...args); }
    parentConnections(...args) { return h.parentConnections(...args); }
    references(...args) { return h.reference(...args); }
    hierarchy(...args) { return h.hierarchy(...args); }
    async changed() {}
    async showHierarchy() {}
  }

  const workspaceRoot = uri(path.resolve('synthetic-lifecycle', 'workspace'));
  const events = Object.fromEntries(['change', 'open', 'close', 'configuration', 'folders', 'activeEditor'].map(name => [name, new Emitter()]));
  const vscode = {
    Uri: { file: uri }, EventEmitter: Emitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Location: class { constructor(locationUri, range) { this.uri = locationUri; this.range = range; } },
    SymbolInformation: class {},
    DocumentSymbol: class {
      constructor(name, detail, kind, range, selectionRange) {
        Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
      }
    },
    SymbolKind: { Module: 2 },
    CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } dispose() {} },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, StatusBarAlignment: { Left: 1 },
    window: {
      onDidChangeActiveTextEditor: events.activeEditor.event,
      createOutputChannel: () => ({ ...disposable(), appendLine: line => h.logs.push(line), show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      createTreeView: () => disposable(),
      withProgress: async (_options, action) => action(),
      showOpenDialog: (...args) => h.openDialog(...args),
      showQuickPick: async () => undefined,
      showSaveDialog: async () => undefined,
      showTextDocument: async () => {},
      showErrorMessage: message => h.errors.push(message),
      showInformationMessage: message => h.logs.push(message),
    },
    workspace: {
      textDocuments: [], workspaceFolders: [{ name: 'workspace', uri: workspaceRoot }],
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (name, fallback) => name === 'watchFiles' ? true : fallback }),
      onDidChangeTextDocument: events.change.event,
      onDidOpenTextDocument: events.open.event,
      onDidCloseTextDocument: events.close.event,
      onDidChangeConfiguration: events.configuration.event,
      onDidChangeWorkspaceFolders: events.folders.event,
      createFileSystemWatcher: pattern => {
        const watcher = { ...disposable(), pattern };
        for (const [name, method] of [['change', 'onDidChange'], ['create', 'onDidCreate'], ['delete', 'onDidDelete']]) {
          const emitter = new Emitter(); watcher[name] = emitter; watcher[method] = emitter.event;
        }
        h.watchers.push(watcher);
        return watcher;
      },
      fs: { writeFile: async () => { throw new Error('Lifecycle tests must not write project files.'); } },
    },
    languages: {
      registerDefinitionProvider: disposable,
      registerReferenceProvider: disposable,
      registerDocumentSymbolProvider: (selector, provider) => {
        h.symbolSelector = selector; h.symbolProvider = provider;
        const registration = { selector, provider, disposed: false, dispose() {
          if (this.disposed) return;
          this.disposed = true; h.symbolEvents.push({ type: 'dispose', provider });
        } };
        h.symbolRegistrations.push(registration); h.symbolEvents.push({ type: 'register', provider });
        return registration;
      },
    },
    commands: {
      registerCommand: (name, callback) => { h.commands.set(name, callback); return disposable(); },
      executeCommand: async (name, ...args) => {
        h.executions.push({ name, args });
        if (name === 'setContext') h.contexts.set(args[0], args[1]);
        else if (h.commands.has(name)) return h.commands.get(name)(...args);
      },
    },
  };
  const context = {
    subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalStorageUri: uri(path.resolve('synthetic-storage')),
    workspaceState: {
      get: name => h.state.get(name),
      update: async (name, value) => { if (value === undefined) h.state.delete(name); else h.state.set(name, value); },
    },
  };
  const module = { exports: {} };
  const imports = {
    vscode, 'node:path': path, 'node:fs/promises': { access: async () => {} },
    './xpr': { loadProject: async (...args) => { h.loadCalls.push(args[0]); return h.load(...args); }, filelist: (...args) => {h.filelistCalls.push(args); return '// synthetic filelist\n';} },
    './indexer': { HdlIndex }, './slang': { SlangBackend: Backend }, './encoding': { readSource: (...args) => h.read(...args) },
    './project-tree': require('../src/project-tree'),
  };
  vm.runInNewContext(extensionSource, {
    module, exports: module.exports, process: { platform: process.platform }, Buffer,
    require: name => { if (!(name in imports)) throw new Error(`Unexpected import: ${name}`); return imports[name]; },
    setTimeout: (callback, delay) => { const id = ++h.timerId; h.timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => h.timers.delete(id),
  }, { filename: 'extension.js' });
  h.app = module.exports.activate(context).workbench;
  h.vscode = vscode; h.context = context; h.events = events;
  h.liveWatchers = () => h.watchers.filter(watcher => !watcher.disposed);
  h.liveSymbols = () => h.symbolRegistrations.filter(registration => !registration.disposed);
  h.moduleNames = () => h.app.index.modules().map(item => item.name).sort().join(',');
  t.after(async () => {
    await h.app.dispose();
    for (const subscription of context.subscriptions) subscription.dispose();
  });
  return h;
}

function assertClosed(h) {
  assert.equal(h.app.project, undefined);
  assert.equal(h.app.loadTarget, undefined);
  assert.equal(h.app.members.size, 0);
  assert.equal(h.app.texts.size, 0);
  assert.equal(h.app.index.modules().length, 0);
  assert.equal(h.app.backend.running, false);
  assert.equal(h.liveWatchers().length, 0);
  assert.equal(h.liveSymbols().length, 0);
  assert.equal(h.app.fileChildren().length, 0);
  assert.equal(h.contexts.get('fpgaWorkbench.loaded'), false);
  assert.equal(h.contexts.get('fpgaWorkbench.hasProject'), false);
  for (const name of ['project', 'fileset', 'top']) assert.equal(h.state.has(name), false, `${name} must not be restored`);
}

test('document symbols supply complete independent module ranges and name selections for native Sticky Scroll', timeout, async t => {
  const h = harness(t);
  const originalText = h.text;
  const source = '// module fake_comment; endmodule\r\n' +
    'module first #(parameter W=8)(input clk);\r\n' +
    '  initial $display("module fake_string; endmodule");\r\n' +
    '  /* endmodule */ wire data;\r\n' +
    'endmodule\r\n' +
    'module second(\r\n  input clk\r\n);\r\nendmodule\r\n';
  h.text = name => name === 'A' ? source : originalText(name);
  await h.app.selectProject(h.xpr('A'));
  const document = h.document('A');
  const symbols = h.symbolProvider.provideDocumentSymbols(document, { isCancellationRequested: false });
  assert.deepEqual(Array.from(symbols, symbol => symbol.name), ['first', 'second']);
  for (const symbol of symbols) {
    assert.ok(symbol instanceof h.vscode.DocumentSymbol);
    assert.equal(symbol.kind, h.vscode.SymbolKind.Module);
    const start = h.app.offset(source, symbol.range.start), end = h.app.offset(source, symbol.range.end);
    const selectedStart = h.app.offset(source, symbol.selectionRange.start), selectedEnd = h.app.offset(source, symbol.selectionRange.end);
    assert.equal(source.slice(start, start + 6), 'module');
    assert.equal(source.slice(end - 9, end), 'endmodule');
    assert.equal(source.slice(selectedStart, selectedEnd), symbol.name);
    assert.ok(selectedStart >= start && selectedEnd <= end);
    assert.equal(symbol.children.length, 0);
  }
  assert.equal(h.app.offset(source, symbols[0].range.end), source.indexOf('\r\nendmodule') + 2 + 9);
  assert.ok(h.app.offset(source, symbols[0].range.end) < h.app.offset(source, symbols[1].range.start));
  assert.ok(symbols[0].range.end.line > symbols[0].selectionRange.end.line);
});

test('module symbol ranges follow unsaved edits and unfinished module text without reading or rewriting disk', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  let source = h.text('A');
  const document = { ...h.document('A'), getText: () => source };
  let reads = 0;
  h.read = async () => { reads++; throw new Error('Symbol requests must use the editor text'); };
  const first = h.symbolProvider.provideDocumentSymbols(document)[0];
  source = '// unsaved heading\nmodule changed(input clk);\n  wire first;\n  wire second;\n';
  h.events.change.fire({ document });
  const editing = h.symbolProvider.provideDocumentSymbols(document)[0];
  assert.equal(editing.name, 'changed');
  assert.equal(editing.range.start.line, 1);
  assert.equal(h.app.offset(source, editing.range.end), source.length);
  assert.ok(editing.range.end.line > first.range.end.line);
  source += 'endmodule\nmodule added;\nendmodule\n';
  const completed = h.symbolProvider.provideDocumentSymbols(document);
  assert.deepEqual(Array.from(completed, symbol => symbol.name), ['changed', 'added']);
  assert.equal(h.app.offset(source, completed[0].range.end), source.indexOf('endmodule') + 9);
  assert.equal(reads, 0);
});

test('document symbol provider respects cancellation, file membership, project switch, close, and disposal', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  const a = h.document('A');
  assert.equal(h.symbolProvider.provideDocumentSymbols(a).length, 1);
  assert.equal(h.symbolProvider.provideDocumentSymbols(h.document('outside')).length, 0);
  assert.equal(h.symbolProvider.provideDocumentSymbols({ ...a, uri: { ...a.uri, scheme: 'untitled' } }).length, 0);
  const cancelled = { ...a, getText: () => { throw new Error('Cancelled provider request read source text'); } };
  assert.equal(h.symbolProvider.provideDocumentSymbols(cancelled, { isCancellationRequested: true }).length, 0);
  await h.app.selectProject(h.xpr('B'));
  assert.equal(h.symbolProvider.provideDocumentSymbols(a).length, 0);
  assert.equal(h.symbolProvider.provideDocumentSymbols(h.document('B'))[0].name, 'B_top');
  await h.app.closeProject();
  assert.equal(h.symbolProvider.provideDocumentSymbols(h.document('B')).length, 0);
  await h.app.selectProject(h.xpr('C'));
  await h.app.dispose();
  assert.equal(h.symbolProvider.provideDocumentSymbols(h.document('C')).length, 0);
});

test('document symbol registration changes identity on refresh and switch and releases on close and context disposal', timeout, async t => {
  const h = harness(t);
  assert.equal(h.liveSymbols().length, 0, 'no project must not advertise document symbols');
  assert.equal(h.symbolEvents.length, 0);
  const subscriptions = h.context.subscriptions.length;
  await h.app.selectProject(h.xpr('A'));
  const first = h.symbolProvider;
  assert.equal(h.liveSymbols().length, 1);
  assert.equal(first.provideDocumentSymbols(h.document('A'))[0].name, 'A_top');
  await h.app.refresh();
  const refreshed = h.symbolProvider;
  assert.notEqual(refreshed, first);
  assert.equal(first.provideDocumentSymbols(h.document('A')).length, 0, 'disposed identity must not serve a later generation');
  assert.equal(h.liveSymbols().length, 1);
  await h.app.selectProject(h.xpr('B'));
  const switched = h.symbolProvider;
  assert.notEqual(switched, refreshed);
  assert.equal(refreshed.provideDocumentSymbols(h.document('B')).length, 0);
  assert.equal(switched.provideDocumentSymbols(h.document('B'))[0].name, 'B_top');
  assert.deepEqual(h.symbolEvents.map(event => event.type), ['register', 'dispose', 'register', 'dispose', 'register']);
  await h.app.closeProject();
  assert.equal(h.liveSymbols().length, 0);
  await h.app.selectProject(h.xpr('C'));
  assert.notEqual(h.symbolProvider, switched);
  assert.equal(h.liveSymbols().length, 1);
  assert.equal(h.context.subscriptions.length, subscriptions, 'reloads must not accumulate subscription handles');
  for (const subscription of h.context.subscriptions) subscription.dispose();
  await h.app.loading;
  assert.equal(h.liveSymbols().length, 0);
  assert.equal(h.app.disposed, true);
  assert.equal(h.symbolEvents.at(-1).type, 'dispose');
});

test('document symbol registry is empty while loading and cancelled or failed loads cannot publish stale providers', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.app.selectProject(h.xpr('A'));
  const first = h.symbolProvider;
  h.load = async xpr => { entered.resolve(); await release.promise; return h.makeProject(xpr); };
  const selecting = h.app.selectProject(h.xpr('B'));
  assert.equal(h.liveSymbols().length, 0, 'starting a load must invalidate the old registry immediately');
  await entered.promise;
  assert.equal(first.provideDocumentSymbols(h.document('A')).length, 0);
  const closing = h.app.closeProject();
  release.resolve();
  await Promise.all([selecting, closing]);
  assert.equal(h.symbolRegistrations.length, 1, 'cancelled generation must never register');
  assertClosed(h);
  h.load = async () => { throw new Error('Synthetic malformed XPR'); };
  await assert.rejects(h.app.selectProject(h.xpr('C')), /Synthetic malformed XPR/);
  assert.equal(h.liveSymbols().length, 0);
  assert.equal(h.symbolRegistrations.length, 1);
  h.load = async xpr => h.makeProject(xpr);
  await h.app.refresh();
  assert.equal(h.liveSymbols().length, 1);
  assert.notEqual(h.symbolProvider, first);
  assert.equal(h.symbolProvider.provideDocumentSymbols(h.document('C'))[0].name, 'C_top');
});

test('project switch replaces source membership, watchers, backend ownership, and saved project', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  const firstWatchers = h.liveWatchers();
  assert.ok(firstWatchers.length);
  await h.commands.get('fpgaWorkbench.switchProject')(h.xpr('B'));
  assert.equal(h.app.project.name, 'B');
  assert.equal(h.moduleNames(), 'B_top');
  assert.equal(h.app.members.has(canonical(h.source('A'))), false);
  assert.equal(h.app.members.has(canonical(h.source('B'))), true);
  assert.ok(firstWatchers.every(watcher => watcher.disposed));
  assert.ok(h.liveWatchers().every(watcher => watcher.pattern.base === path.dirname(h.xpr('B'))));
  assert.deepEqual(h.starts, ['A', 'B']);
  assert.equal(h.state.get('project').absolutePath, h.xpr('B'));
  assert.equal(h.state.get('project').relativePath, path.join('..', 'B', 'B.xpr'));
  assert.equal(h.contexts.get('fpgaWorkbench.loaded'), true);
});

test('cancelling the project picker leaves the current project and overrides intact', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  h.app.fileset = 'custom_sources'; h.app.top = 'custom_top';
  h.state.set('fileset', h.app.fileset); h.state.set('top', h.app.top);
  const revision = h.app.revision, project = h.app.project, index = h.app.index;
  const watchers = h.liveWatchers();
  await h.app.selectProject();
  assert.equal(h.app.revision, revision);
  assert.equal(h.app.project, project);
  assert.equal(h.app.index, index);
  assert.equal(h.app.fileset, 'custom_sources');
  assert.equal(h.app.top, 'custom_top');
  assert.deepEqual(h.liveWatchers(), watchers);
  assert.deepEqual(h.starts, ['A']);
});

test('switch command treats a project TreeItem as context and cancellation keeps the current project', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  const project = h.app.project, index = h.app.index, revision = h.app.revision;
  const saved = h.state.get('project'), watchers = h.liveWatchers();
  const treeItem = h.app.fileChildren()[0];
  assert.equal(treeItem.contextValue, 'fpgaWorkbench.project');
  let pickerCalls = 0;
  h.openDialog = async () => { pickerCalls++; return undefined; };
  await h.commands.get('fpgaWorkbench.switchProject')(treeItem);
  assert.equal(pickerCalls, 1);
  assert.equal(h.app.project, project);
  assert.equal(h.app.index, index);
  assert.equal(h.app.revision, revision);
  assert.equal(h.state.get('project'), saved);
  assert.deepEqual(h.liveWatchers(), watchers);
  assert.deepEqual(h.loadCalls, [h.xpr('A')]);
  assert.deepEqual(h.starts, ['A']);
  assert.equal(h.errors.length, 0);
});

test('close clears project state, timers, watchers, and restoration keys without touching editors', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  const doc = h.document('A'); h.vscode.workspace.textDocuments.push(doc);
  h.app.fileset = 'custom_sources'; h.app.top = 'custom_top';
  h.state.set('fileset', h.app.fileset); h.state.set('top', h.app.top);
  h.app.changedDocument(doc); h.app.scheduleRefresh();
  assert.ok(h.timers.size);
  const oldStatusCallback = h.app.backend.onChange;
  await h.commands.get('fpgaWorkbench.closeProject')();
  oldStatusCallback();
  assertClosed(h);
  assert.equal(h.timers.size, 0);
  assert.equal(h.vscode.workspace.textDocuments[0], doc);
  assert.equal((await h.app.definitions(doc, { line: 0, character: 7 })).length, 0);
  assert.equal((await h.app.hierChildren()).length, 0);
  const loads = h.loadCalls.length;
  await h.app.restore();
  assert.equal(h.loadCalls.length, loads);
});

test('closing during XPR loading prevents a late project and backend from reopening', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  h.load = async xpr => { entered.resolve(); await release.promise; return h.makeProject(xpr); };
  const selecting = h.app.selectProject(h.xpr('A'));
  await entered.promise;
  const closing = h.app.closeProject();
  assert.equal(h.app.project, undefined);
  release.resolve();
  await Promise.all([selecting, closing]);
  assertClosed(h);
  assert.equal(h.starts.length, 0);
});

test('closing during backend startup stops the late backend and never saves its project', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  h.start = async () => { entered.resolve(); await release.promise; };
  const selecting = h.app.selectProject(h.xpr('A'));
  await entered.promise;
  const closing = h.app.closeProject();
  release.resolve();
  await Promise.all([selecting, closing]);
  assertClosed(h);
  assert.ok(h.backendEvents.lastIndexOf('stop') > h.backendEvents.indexOf('started:A'));
});

test('rapid A to B to C selections discard queued stale loads and keep only C', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  h.load = async xpr => {
    if (xpr === h.xpr('A')) { entered.resolve(); await release.promise; }
    return h.makeProject(xpr);
  };
  const first = h.app.selectProject(h.xpr('A'));
  await entered.promise;
  const second = h.app.selectProject(h.xpr('B'));
  const third = h.app.selectProject(h.xpr('C'));
  release.resolve();
  await Promise.all([first, second, third]);
  assert.equal(h.app.project.name, 'C');
  assert.equal(h.moduleNames(), 'C_top');
  assert.deepEqual(h.starts, ['C']);
  assert.deepEqual(h.loadCalls, [h.xpr('A'), h.xpr('C')]);
  assert.equal(h.symbolRegistrations.length, 1, 'only the committed generation may register symbols');
  assert.equal(h.liveSymbols().length, 1);
  assert.equal(h.state.get('project').absolutePath, h.xpr('C'));
  assert.ok(h.liveWatchers().every(watcher => watcher.pattern.base === path.dirname(h.xpr('C'))));
});

for (const outcome of ['resolve', 'reject']) {
  test(`late closed-document ${outcome} cannot modify the next project's index`, timeout, async t => {
    const h = harness(t), entered = deferred(), release = deferred();
    await h.app.selectProject(h.xpr('A'));
    const originalRead = h.read;
    h.read = async file => {
      if (file === h.source('A')) { entered.resolve(); return release.promise; }
      return originalRead(file);
    };
    const closed = h.app.closedDocument(h.document('A'));
    await entered.promise;
    await h.app.selectProject(h.xpr('B'));
    if (outcome === 'resolve') release.resolve('module stale_module; endmodule');
    else release.reject(new Error('Synthetic deleted source'));
    await closed;
    assert.equal(h.moduleNames(), 'B_top');
    assert.equal(h.app.texts.has(canonical(h.source('A'))), false);
    assert.equal(h.app.members.size, 1);
  });
}

function reverseNavigationFixture(h) {
  const originalMakeProject = h.makeProject;
  const text = h.text;
  h.text = name => name === 'A'
    ? 'module A_top; wire sys_clk; wire other_clk; child first(.clk(sys_clk)), second(.clk(other_clk)); endmodule\n'
    : name === 'child'
      ? 'module child(input wire clk); wire local; assign local = clk; endmodule\n'
      : text(name);
  h.makeProject = xpr => {
    const project = originalMakeProject(xpr);
    if (project.name === 'A') {
      project.sourceFiles.push(h.source('child'));
      project.files.push({ path: h.source('child'), fileset: 'sources_1', exists: true, enabled: true });
    }
    return project;
  };
  return marker => {
    const document = h.document('child');
    const offset = document.getText().indexOf(marker);
    assert.notEqual(offset, -1);
    document.offsetAt = () => offset;
    return { document, position: h.app.position(document.getText(), offset) };
  };
}

test('pure port definitions stay local while the mouse peek menu adds actual parent-side signal expressions', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const target = h.app.location({ path: h.source('A'), start: h.text('A').indexOf('(sys_clk)') + 1, end: h.text('A').indexOf('(sys_clk)') + 8 });
  const local = h.app.location({ path: h.source('child'), start: h.text('child').indexOf('clk'), end: h.text('child').indexOf('clk') + 3 });
  let parentCalls = 0, definitionCalls = 0;
  h.parentConnections = async (_doc, _position, request, _token, options) => {
    parentCalls++;
    assert.equal(request.declaration.name, 'clk');
    assert.equal(request.module.name, 'child');
    assert.equal(options.target, 'expression');
    return [target];
  };
  h.definition = async () => { definitionCalls++; return [local]; };
  const declared = query('clk');
  const declaredLocal = await h.app.definitionTargets(declared.document, declared.position);
  assert.equal(declaredLocal.length, 1);
  assert.equal(declaredLocal[0].uri.fsPath, local.uri.fsPath);
  assert.equal(declaredLocal[0].range.start.character, local.range.start.character);
  assert.equal(parentCalls, 0);
  assert.equal(definitionCalls, 0);
  const use = query('clk;');
  assert.equal((await h.app.definitionTargets(use.document, use.position))[0], local);
  assert.equal(parentCalls, 0);
  assert.equal(definitionCalls, 1);
  const preview = await h.app.peekDefinitions(use.document, use.position);
  assert.equal(preview.length, 2);
  assert.equal(preview[0], local);
  assert.equal(preview[1], target);
  assert.equal(parentCalls, 1);
});

test('empty semantic parent lookup leaves local preview and never borrows lexical connections', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const { document, position } = query('clk');
  assert.equal(h.app.index.parentConnections(document.uri.fsPath, document.offsetAt(position)).connections.length, 2);
  const result = await h.app.peekDefinitions(document, position);
  assert.equal(result.length, 1);
  assert.equal(result[0].uri.fsPath, h.source('child'));
});

test('builtin pure port definition stays local and the mouse peek menu adds distinct actual parent expressions', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  h.app.backend.running = false;
  const { document, position } = query('clk');
  const results = await h.app.definitionTargets(document, position);
  assert.equal(results.length, 1);
  assert.equal(results[0].uri.fsPath, h.source('child'));
  const preview = await h.app.peekDefinitions(document, position);
  assert.equal(preview.length, 3);
  assert.equal(preview[0].uri.fsPath, h.source('child'));
  const text = h.text('A');
  assert.deepEqual(Array.from(preview.slice(1), item => text.slice(item.range.start.character, item.range.end.character)), ['sys_clk', 'other_clk']);
  const references = await h.app.references(document, position, false);
  assert.equal(references.length, 3, 'two parent connections plus one child-module use');
});

function fixtureLocation(h, name, marker, delta = 0, length = 3) {
  const text=h.text(name),start=text.indexOf(marker)+delta;
  assert(start>=0);
  return h.app.location({path:h.source(name),start,end:start+length});
}

test('signal definitions combine only current-module uses and confirmed upper named-port labels', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h),previous=h.text;
  h.text=name=>name==='child' ? previous(name)+'module unrelated(input wire clk); wire x; assign x = clk; endmodule\n' : previous(name);
  await h.app.selectProject(h.xpr('A'));
  const local=fixtureLocation(h,'child','input wire clk','input wire '.length);
  const use=fixtureLocation(h,'child','clk;');
  const unrelated=fixtureLocation(h,'child','unrelated(input wire clk)','unrelated(input wire '.length);
  const first=fixtureLocation(h,'A','.clk',1);
  const second=fixtureLocation(h,'A','second(.clk','second(.'.length);
  const rhs=fixtureLocation(h,'A','sys_clk)');
  let definitions=0,references=0,parents=0;
  h.definition=async()=>{definitions++;return [local];};
  h.reference=async()=>{references++;return [local,use,unrelated,first,rhs];};
  h.parentConnections=async(_doc,_pos,_query,_token,options)=>{
    parents++;assert.equal(options.target,'port');return [first,second,first];
  };
  const declared=query('clk');
  const locations=await h.app.definitions(declared.document,declared.position);
  assert.deepEqual(Array.from(locations),[local,use,first,second]);
  assert.equal(definitions,1);assert.equal(references,1);assert.equal(parents,1);
  const body=query('clk;');
  assert.deepEqual(Array.from(await h.app.definitions(body.document,body.position)),[local,use,first,second]);
  assert.equal(definitions,2,'ordinary signal use does not query its definition twice');
});

test('ordinary internal signals list local uses without querying upper ports', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h),previous=h.text;
  h.text=name=>name==='child' ? previous(name).replace(/\blocal\b/g,'local_wire') : previous(name);
  await h.app.selectProject(h.xpr('A'));
  const local=fixtureLocation(h,'child','wire local_wire','wire '.length,10);
  const use=fixtureLocation(h,'child','assign local_wire','assign '.length,10);
  h.definition=async()=>[local];h.reference=async()=>[use];
  h.parentConnections=async()=>{throw new Error('Internal wire has no module port');};
  const selected=query('local_wire =');
  assert.deepEqual(Array.from(await h.app.definitions(selected.document,selected.position)),[local,use]);
});

test('builtin Ctrl+definition lists local uses and upper port labels while the mouse peek menu uses expressions', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));h.app.backend.running=false;
  const selected=query('clk;');
  const locations=await h.app.definitions(selected.document,selected.position);
  assert.equal(locations.length,4);
  assert.equal(locations.filter(item=>item.uri.fsPath===h.source('child')).length,2);
  for(const item of locations.filter(item=>item.uri.fsPath===h.source('A'))) {
    assert.equal(h.text('A').slice(item.range.start.character,item.range.end.character),'clk');
    assert.equal(h.text('A')[item.range.start.character-1],'.');
  }
  const preview=await h.app.peekDefinitions(selected.document,selected.position);
  assert.equal(preview.length,3);
  assert.deepEqual(Array.from(preview.slice(1),item=>h.text('A').slice(item.range.start.character,item.range.end.character)),['sys_clk','other_clk']);
});

test('empty or unconfirmed semantic signal queries never borrow builtin uses or upper labels', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const local=fixtureLocation(h,'child','input wire clk','input wire '.length);
  const selected=query('clk');
  let references=0,parents=0;
  h.reference=async()=>{references++;return [];};
  h.parentConnections=async()=>{parents++;return [];};
  assert.deepEqual(Array.from(await h.app.definitions(selected.document,selected.position)).map(item=>item.uri.fsPath),[h.source('child')]);
  assert.equal(references,0);assert.equal(parents,0);
  h.definition=async()=>[local];
  const result=await h.app.definitions(selected.document,selected.position);
  assert.equal(result.length,1);
  assert.equal(result[0].uri.fsPath,local.uri.fsPath);
  assert.equal(result[0].range.start.character,local.range.start.character);
  assert.equal(references,1);assert.equal(parents,1);
});

test('implicit connections list the containing module signal instead of the child formal endpoint', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h),previous=h.text;
  h.text=name=>name==='A' ? 'module A_top; wire clk; child first(.clk); wire sink; assign sink = clk; endmodule\n' : previous(name);
  await h.app.selectProject(h.xpr('A'));h.app.backend.running=false;
  const document=h.document('A'),offset=document.getText().indexOf('.clk')+1;
  document.offsetAt=()=>offset;
  const position=h.app.position(document.getText(),offset);
  assert.equal(h.app.index.definitions(document.uri.fsPath,offset).length,2,'implicit token has both HDL endpoints');
  const locations=await h.app.definitions(document,position);
  assert.equal(locations.length,3,'local declaration, implicit use, assignment use');
  assert(locations.every(item=>item.uri.fsPath===h.source('A')));
  const canonical=fixtureLocation(h,'A','wire clk','wire '.length);
  h.app.backend.running=true;
  h.definition=async()=>[fixtureLocation(h,'child','input wire clk','input wire '.length),canonical];
  h.reference=async()=>locations.slice(1);
  const semantic=await h.app.definitions(document,position);
  assert.equal(semantic.length,3);assert(semantic.every(item=>item.uri.fsPath===h.source('A')));
});

test('signal reference queries discard edits, project changes, and cancelled requests', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  h.definition=async()=>[fixtureLocation(h,'child','input wire clk','input wire '.length)];
  let started=deferred(),release=deferred();
  h.reference=()=>{started.resolve();return release.promise;};
  const selected=query('clk;');
  const pending=h.app.definitions(selected.document,selected.position);
  await started.promise;
  const parent=h.document('A');parent.getText=()=>'// changed\n'+h.text('A');h.events.change.fire({document:parent});
  release.resolve([fixtureLocation(h,'child','clk;')]);
  assert.equal((await pending).length,0);
  started=deferred();release=deferred();
  const next=h.app.definitions(selected.document,selected.position);
  await started.promise;await h.app.selectProject(h.xpr('B'));release.resolve([]);
  assert.equal((await next).length,0);
  await h.app.selectProject(h.xpr('A'));
  assert.equal((await h.app.definitions(selected.document,selected.position,{isCancellationRequested:true})).length,0);
});

test('FPGA goto explicitly lists signal candidates and leaves module navigation in goto mode', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));h.app.backend.running=false;
  const signal=query('clk;');
  h.vscode.window.activeTextEditor={document:signal.document,selection:{active:signal.position}};
  await h.commands.get('fpgaWorkbench.gotoDefinition')();
  let navigation=h.executions.findLast(item=>item.name==='editor.action.goToLocations');
  assert.equal(navigation.args[2].length,4);assert.equal(navigation.args[3],'peek');assert.equal(navigation.args[5],true);
  const module=query('child');
  h.vscode.window.activeTextEditor={document:module.document,selection:{active:module.position}};
  await h.commands.get('fpgaWorkbench.gotoDefinition')();
  navigation=h.executions.findLast(item=>item.name==='editor.action.goToLocations');
  assert.equal(navigation.args[2].length,2);assert.equal(navigation.args[3],'goto');assert.equal(navigation.args[5],false);
});

test('peek parent lookup discards stale project and edited document results, and honors cancellation', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  let request = deferred(), calls = 0;
  h.parentConnections = () => { calls++; return request.promise; };
  const first = query('clk');
  const stale = h.app.peekDefinitions(first.document, first.position);
  await Promise.resolve();
  await h.app.selectProject(h.xpr('B'));
  request.resolve(['stale-parent']);
  assert.equal((await stale).length, 0);
  await h.app.selectProject(h.xpr('A'));
  const second = query('clk');
  request = deferred();
  const edited = h.app.peekDefinitions(second.document, second.position);
  await Promise.resolve();
  second.document.getText = () => 'module edited; endmodule';
  request.resolve(['old-document-parent']);
  assert.equal((await edited).length, 0);
  const cancelled = query('clk');
  assert.equal((await h.app.peekDefinitions(cancelled.document, cancelled.position, { isCancellationRequested: true })).length, 0);
  assert.equal(calls, 2);
});

test('module default reverse navigation remains intact and module peek stays at its definition', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const { document, position } = query('child');
  const target = h.app.location({ path: h.source('A'), start: h.text('A').indexOf('first'), end: h.text('A').indexOf('first') + 5 });
  let calls = 0;
  h.parentConnections = async (_document, _position, request) => { calls++; assert.equal(request.declaration.kind, 'module'); return [target]; };
  assert.equal((await h.app.definitions(document, position))[0], target);
  const peek = await h.app.peekDefinitions(document, position);
  assert.equal(peek.length, 1);
  assert.equal(peek[0].uri.fsPath, h.source('child'));
  assert.equal(calls, 1);
});

test('parent document edits invalidate a pending peek even when the origin document is unchanged', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const pending = deferred();
  h.parentConnections = () => pending.promise;
  const { document, position } = query('clk');
  const preview = h.app.peekDefinitions(document, position);
  await Promise.resolve();
  const parent = h.document('A');
  parent.getText = () => '// inserted before parent connections\n' + h.text('A');
  h.events.change.fire({ document: parent });
  pending.resolve([h.app.location({ path: h.source('A'), start: 1, end: 2 })]);
  assert.equal((await preview).length, 0);
  assert.equal(document.getText(), h.text('child'));
});

test('mouse peek menu keeps the local location first without contributing an Alt+F12 binding', timeout, async t => {
  const manifest=require('../package.json');
  assert(!(manifest.contributes.keybindings || []).some(binding=>/alt\+f12/i.test(binding.key || '')));
  assert(manifest.contributes.menus['editor/context'].some(item=>item.command==='fpgaWorkbench.peekDefinition'));
  const h = harness(t), query = reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  h.app.backend.running = false;
  const { document, position } = query('clk');
  h.vscode.window.activeTextEditor = { document, selection: { active: position } };
  h.events.activeEditor.fire(h.vscode.window.activeTextEditor);
  assert.equal(h.contexts.get('fpgaWorkbench.editorInProject'), true);
  await h.commands.get('fpgaWorkbench.peekDefinition')();
  const navigation = h.executions.findLast(item => item.name === 'editor.action.goToLocations');
  assert.equal(navigation.args[2].length, 3);
  assert.equal(navigation.args[2][0].uri.fsPath, document.uri.fsPath);
  assert.equal(navigation.args[3], 'peek');
  assert.equal(navigation.args[5], true);
  const outsider = h.document('outside');
  h.vscode.window.activeTextEditor = { document: outsider, selection: { active: position } };
  h.events.activeEditor.fire(h.vscode.window.activeTextEditor);
  assert.equal(h.contexts.get('fpgaWorkbench.editorInProject'), false);
  await h.commands.get('fpgaWorkbench.peekDefinition')();
  assert.equal(h.executions.at(-1).name, 'editor.action.peekDefinition');
  await h.app.closeProject();
  assert.equal(h.contexts.get('fpgaWorkbench.editorInProject'), false);
});

test('Filelist skill command exposes the installed self-contained skill without requiring a project', timeout, async t => {
  const h = harness(t);
  let opened;
  h.vscode.window.showTextDocument = async (uri, options) => { opened = { uri, options }; };
  const uri = await h.commands.get('fpgaWorkbench.openFilelistSkill')();
  assert.equal(uri.fsPath, path.join(h.context.extensionPath, 'skills', 'fpga-workbench-filelist', 'SKILL.md'));
  assert.equal(opened.uri, uri);
  assert.equal(opened.options.preview, false);
  assert.equal(h.loadCalls.length, 0);
});

test('Filelist export passes the actual output filename and effective selected top', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  const output = h.vscode.Uri.file(path.resolve('synthetic-exports', 'chosen.f'));
  h.vscode.window.showSaveDialog = async () => output;
  let written;
  h.vscode.workspace.fs.writeFile = async (uri, data) => { written = { uri, text: data.toString('utf8') }; };
  h.app.top = 'selected_top';
  await h.app.exportFilelist();
  assert.equal(h.filelistCalls.length, 1);
  const [project, directory, options] = h.filelistCalls[0];
  assert.equal(project, h.app.project);
  assert.equal(directory, path.dirname(output.fsPath));
  assert.equal(options.outputPath, output.fsPath);
  assert.equal(options.top, 'selected_top');
  assert.equal(written.uri, output);
  assert.match(written.text, /synthetic filelist/);
  h.vscode.window.showSaveDialog = async () => h.vscode.Uri.file(h.source('A'));
  await assert.rejects(h.app.exportFilelist(), /工程输入文件/);
  assert.equal(h.filelistCalls.length, 1, 'protected inputs are rejected before serialization');
  const netlist = path.join(h.app.project.root, 'A.gen', 'sources_1', 'ip', 'fifo', 'fifo_sim_netlist.v');
  h.app.project.ipReferences = [{ artifactPaths: [netlist] }];
  h.vscode.window.showSaveDialog = async () => h.vscode.Uri.file(netlist);
  await assert.rejects(h.app.exportFilelist(), /工程输入文件/);
  assert.equal(h.filelistCalls.length, 1, 'comment-only generated IP paths are protected too');
});

test('late definitions, references, and hierarchy results are discarded after switching projects', timeout, async t => {
  const h = harness(t), definition = deferred(), reference = deferred(), hierarchy = deferred();
  await h.app.selectProject(h.xpr('A'));
  h.definition = () => definition.promise; h.reference = () => reference.promise; h.hierarchy = () => hierarchy.promise;
  const document = h.document('A'), position = { line: 0, character: 7 };
  const pending = [h.app.definitions(document, position), h.app.references(document, position, true), h.app.hierChildren()];
  await h.app.selectProject(h.xpr('B'));
  definition.resolve([{ uri: document.uri }]);
  reference.resolve([{ uri: document.uri }]);
  hierarchy.resolve([{ kind: 'Instance', instName: 'stale_instance', declName: 'A_top' }]);
  for (const result of await Promise.all(pending)) assert.equal(result.length, 0);
  assert.equal(h.app.project.name, 'B');
  assert.equal(h.moduleNames(), 'B_top');
});

test('a project picker opened before close cannot reopen a project when it returns', timeout, async t => {
  const h = harness(t), picker = deferred();
  await h.app.selectProject(h.xpr('A'));
  h.openDialog = () => picker.promise;
  const selecting = h.app.selectProject();
  await h.app.closeProject();
  picker.resolve([h.vscode.Uri.file(h.xpr('B'))]);
  await selecting;
  assertClosed(h);
  assert.deepEqual(h.starts, ['A']);
});

test('failed XPR selection clears the view and remains retryable and closable', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  h.load = async () => { throw new Error('Synthetic malformed XPR'); };
  await assert.rejects(h.app.selectProject(h.xpr('B')), /Synthetic malformed XPR/);
  assert.equal(h.app.project, undefined);
  assert.equal(h.app.loadTarget, h.xpr('B'));
  assert.equal(h.app.members.size, 0);
  assert.equal(h.app.index.modules().length, 0);
  assert.equal(h.liveWatchers().length, 0);
  assert.equal(h.app.backend.running, false);
  assert.equal(h.liveSymbols().length, 0);
  assert.match(h.app.status.text, /读取失败/);
  assert.equal(h.contexts.get('fpgaWorkbench.hasProject'), true);
  h.load = async xpr => h.makeProject(xpr);
  await h.app.refresh();
  assert.equal(h.app.project.name, 'B');
  await h.app.closeProject();
  assertClosed(h);
});

test('dispose during startup cannot revive the backend or accept a later load', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  h.start = async () => { entered.resolve(); await release.promise; };
  const selecting = h.app.selectProject(h.xpr('A'));
  await entered.promise;
  const disposing = h.app.dispose();
  release.resolve();
  await Promise.all([selecting, disposing]);
  assert.equal(h.app.disposed, true);
  assert.equal(h.app.backend.running, false);
  assert.equal(h.liveWatchers().length, 0);
  assert.equal(h.liveSymbols().length, 0);
  assert.equal(h.state.has('project'), false);
  assert.equal(await h.app.load(h.xpr('B')), false);
  assert.deepEqual(h.starts, ['A']);
  assert.ok(h.backendEvents.lastIndexOf('stop') > h.backendEvents.indexOf('started:A'));
});
