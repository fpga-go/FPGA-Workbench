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
    symbolRegistrations: [], symbolEvents: [], lintEvents: [], reveals: [], backendChanges: [],
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
  h.instancePaths = async () => [];

  class Backend {
    constructor() { this.running = false; this.status = 'idle'; this.diagnosticsCounts = { errors: 0, warnings: 0 }; }
    async start(options) {
      h.lastStartOptions = options;
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
    instancePaths(...args) { return h.instancePaths(...args); }
    async changed(...args) { h.backendChanges.push(args); }
    async showHierarchy() {}
  }

  const workspaceRoot = uri(path.resolve('synthetic-lifecycle', 'workspace'));
  const events = Object.fromEntries(['change', 'open', 'close', 'configuration', 'folders', 'activeEditor', 'selection', 'hierVisibility'].map(name => [name, new Emitter()]));
  const vscode = {
    Uri: { file: uri, parse: value => {const parsed=new URL(value); return {scheme:parsed.protocol.slice(0,-1), path:parsed.pathname, toString:()=>value};} }, EventEmitter: Emitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Location: class { constructor(locationUri, range) { this.uri = locationUri; this.range = range; } },
    CodeLens: class {constructor(range,command) {Object.assign(this,{range,command});}},
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
      onDidChangeTextEditorSelection: events.selection.event,
      createOutputChannel: () => ({ ...disposable(), appendLine: line => h.logs.push(line), show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      createTreeView: (id, options) => {
        const view = {
          ...disposable(), id, options, visible: true, selection: [],
          onDidChangeVisibility: events.hierVisibility.event,
          reveal: async (item, revealOptions) => {
            if (revealOptions?.select !== false) view.selection = [item];
            h.reveals.push({ item, options: revealOptions });
          },
        };
        if (id === 'fpgaWorkbench.hierarchy') h.hierView = view;
        else if (id === 'fpgaWorkbench.files') h.fileView = view;
        return view;
      },
      withProgress: async (_options, action) => action(),
      showOpenDialog: (...args) => h.openDialog(...args),
      showQuickPick: async () => undefined,
      showSaveDialog: async () => undefined,
      showTextDocument: async () => {},
      showErrorMessage: message => h.errors.push(message),
      showInformationMessage: message => h.logs.push(message),
    },
    workspace: {
      registerTextDocumentContentProvider: (_scheme, provider) => {h.candidateProvider=provider;return disposable();},
      textDocuments: [], workspaceFolders: [{ name: 'workspace', uri: workspaceRoot }],
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (name, fallback) => name === 'watchFiles' ? true : name === 'navigation.candidateList' ? (h.candidateMode ?? fallback) : fallback }),
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
      registerDefinitionProvider: (selector, provider) => {if(selector.scheme==='fpga-candidates')h.candidateDefinitionProvider=provider;else h.definitionProvider = provider; return disposable(); },
      registerCodeLensProvider: (_selector,provider) => {h.candidateLensProvider=provider;return disposable();},
      registerReferenceProvider: (_selector, provider) => { h.referenceProvider = provider; return disposable(); },
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
    './candidates': require('../src/candidates'),
    './indexer': { HdlIndex }, './slang': { SlangBackend: Backend }, './encoding': { readSource: (...args) => h.read(...args) },
    './project-tree': require('../src/project-tree'),
    './highlighting': { HdlHighlighter: class { dispose() {} } },
    './lint-view': { LintView: class {
      update(snapshot) { h.lintSnapshot = snapshot; }
      dispose() {}
    } },
    './linting': { HdlLinter: class {
      constructor(_vscode, _getProject, options) { h.lintState = options.state; h.publishLint = options.onDidChange; }
      dispose() {}
      projectChanged(loading) { h.lintEvents.push({ type: 'projectChanged', loading }); }
      reset() { h.lintEvents.push({ type: 'reset' }); }
      run() {}
      showOutput() {}
      setEnabled(enabled) { h.lintEvents.push({ type: 'setEnabled', enabled }); }
      configure() { h.lintEvents.push({ type: 'configure' }); }
      selectTool() { h.lintEvents.push({ type: 'selectTool' }); }
      selectManualTool() { h.lintEvents.push({ type: 'selectManualTool' }); }
    } },
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

test('lint pending state survives same-project refresh and resets on a different project', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  assert.equal(h.lintEvents.filter(event => event.type === 'reset').length, 1);
  h.lintEvents.length = 0;
  await h.app.refresh();
  assert.deepEqual(h.lintEvents, [{ type: 'projectChanged', loading: true }, { type: 'projectChanged', loading: false }]);
  await h.app.selectProject(h.xpr('B'));
  assert.deepEqual(h.lintEvents.slice(2), [
    { type: 'reset' }, { type: 'projectChanged', loading: true }, { type: 'projectChanged', loading: false }
  ]);
});

test('refresh during an in-flight project load keeps its lint request without treating it as a project switch', timeout, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.app.selectProject(h.xpr('A'));
  h.lintEvents.length = 0;
  h.load = async xpr => { entered.resolve(); await release.promise; return h.makeProject(xpr); };
  const switching = h.app.selectProject(h.xpr('B'));
  await entered.promise;
  assert.equal(h.app.project, undefined);
  assert.equal(h.app.loadTarget, h.xpr('B'));
  const refreshing = h.app.refresh();
  release.resolve();
  await Promise.all([switching, refreshing]);
  assert.equal(h.app.project.name, 'B');
  assert.equal(h.lintEvents.filter(event => event.type === 'reset').length, 1);
  assert.equal(h.lintEvents.at(-1).loading, false);
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

function connectionPreviewFixture(h) {
  const previous = h.text;
  const connections = ['.o_data(w_bus)', '.i_data                    ( w_bus )', '.i_tabs\t\t\t(w_bus)',
    '.i_same(w_bus)', '.o_same(w_bus)', '.i_pair({w_bus,w_bus})'];
  h.text = name => name === 'A' ? [
    'module A_top;',
    'wire w_bus;',
    'endpoint u0(',
    `  ${connections[0]},`,
    `  ${connections[1]},`,
    `  ${connections[2]},`,
    `  ${connections[3]}, ${connections[4]},`,
    `  ${connections[5]}`,
    ');',
    'endmodule',
    'module endpoint(output wire o_data, input wire i_data, input wire i_tabs,',
    '  input wire i_same, output wire o_same, input wire [1:0] i_pair);',
    'endmodule',
    '',
  ].join('\n') : previous(name);
  const select = marker => {
    const document = h.document('A'), offset = document.getText().indexOf(marker);
    assert(offset >= 0, `fixture marker exists: ${marker}`);
    document.offsetAt = position => position ? h.app.offset(document.getText(), position) : offset;
    const position = h.app.position(document.getText(), offset);
    h.vscode.window.activeTextEditor = { document, selection: { active: position } };
    return { document, position };
  };
  return { connections, select };
}

function selectedLocationText(h, item) {
  const uri = item.targetUri || item.uri;
  const range = item.targetSelectionRange || item.range || item.targetRange;
  const text = h.app.texts.get(canonical(uri.fsPath));
  return text.slice(h.app.offset(text, range.start), h.app.offset(text, range.end));
}

for (const backend of ['builtin', 'semantic']) {
  test(`${backend} definition provider shows complete aligned connections while raw signal references stay exact`, timeout, async t => {
    const h = harness(t), fixture = connectionPreviewFixture(h);
    await h.app.selectProject(h.xpr('A'));
    h.app.backend.running = false;
    const selected = fixture.select('w_bus;');
    const raw = await h.app.definitions(selected.document, selected.position);
    assert.equal(raw.length, 8, 'declaration and seven signal occurrences');
    assert(raw.every(item => selectedLocationText(h, item) === 'w_bus'));
    const originalRanges = JSON.stringify(raw);
    if (backend === 'semantic') {
      const linked = raw.map(item => ({ targetUri: item.uri, targetSelectionRange: item.range,
        targetRange: new h.vscode.Range(h.app.position(selected.document.getText(), 0), h.app.position(selected.document.getText(), selected.document.getText().length)) }));
      h.app.backend.running = true;
      h.definition = async () => [linked[0]];
      h.reference = async () => linked.slice(1);
    }
    const displayed = await h.definitionProvider.provideDefinition(selected.document, selected.position, { isCancellationRequested: false });
    assert.deepEqual(Array.from(displayed, item => selectedLocationText(h, item)), ['w_bus', ...fixture.connections]);
    assert.equal(JSON.stringify(raw), originalRanges, 'display conversion never mutates raw positions');
    const after = await h.app.definitions(selected.document, selected.position);
    assert.equal(after.length, 8, 'two occurrences inside one connection remain distinct internally');
    assert(after.every(item => selectedLocationText(h, item) === 'w_bus'));
    const displayedReferences = await h.referenceProvider.provideReferences(selected.document, selected.position,
      { includeDeclaration: false }, { isCancellationRequested: false });
    assert.deepEqual(Array.from(displayedReferences, item => selectedLocationText(h, item)), fixture.connections);
  });
}

test('mouse goto and reference commands use the same complete connection list without merging adjacent ports', timeout, async t => {
  const h = harness(t), fixture = connectionPreviewFixture(h);
  await h.app.selectProject(h.xpr('A'));
  h.app.backend.running = false;
  fixture.select('w_bus;');
  await h.commands.get('fpgaWorkbench.gotoDefinition')();
  const goto = h.executions.findLast(item => item.name === 'editor.action.goToLocations');
  assert.equal(goto.args[3], 'peek');
  assert.deepEqual(Array.from(goto.args[2], item => selectedLocationText(h, item)), ['w_bus', ...fixture.connections]);
  await h.commands.get('fpgaWorkbench.parentConnections')();
  const references = h.executions.findLast(item => item.name === 'editor.action.showReferences');
  assert.deepEqual(Array.from(references.args[2], item => selectedLocationText(h, item)), ['w_bus', ...fixture.connections]);
  const sameLine = goto.args[2].filter(item => ['.i_same(w_bus)', '.o_same(w_bus)'].includes(selectedLocationText(h, item)));
  assert.equal(sameLine.length, 2);
  assert.equal(sameLine[0].range.start.line, sameLine[1].range.start.line);
  assert.notEqual(sameLine[0].range.start.character, sameLine[1].range.start.character);
  const selected = fixture.select('endpoint u0');
  const module = await h.definitionProvider.provideDefinition(selected.document, selected.position, { isCancellationRequested: false });
  assert.deepEqual(Array.from(module, item => selectedLocationText(h, item)), ['endpoint']);
  await h.commands.get('fpgaWorkbench.gotoDefinition')();
  const moduleGoto = h.executions.findLast(item => item.name === 'editor.action.goToLocations');
  assert.equal(moduleGoto.args[3], 'goto');
  assert.deepEqual(Array.from(moduleGoto.args[2], item => selectedLocationText(h, item)), ['endpoint']);
});

test('mouse peek expands confirmed upper connections but keeps the child port local target exact', timeout, async t => {
  const h = harness(t), query = reverseNavigationFixture(h), previous = h.text;
  h.text = name => name === 'A' ? previous(name).replace('.clk(sys_clk)', '.clk                    (sys_clk)').replace('.clk(other_clk)', '.clk\t\t(other_clk)') : previous(name);
  await h.app.selectProject(h.xpr('A'));
  h.app.backend.running = false;
  const selected = query('clk');
  const raw = await h.app.peekDefinitions(selected.document, selected.position);
  assert.deepEqual(Array.from(raw, item => selectedLocationText(h, item)), ['clk', 'sys_clk', 'other_clk']);
  h.vscode.window.activeTextEditor = { document: selected.document, selection: { active: selected.position } };
  await h.commands.get('fpgaWorkbench.peekDefinition')();
  const peek = h.executions.findLast(item => item.name === 'editor.action.goToLocations');
  assert.deepEqual(Array.from(peek.args[2], item => selectedLocationText(h, item)), ['clk', '.clk                    (sys_clk)', '.clk\t\t(other_clk)']);
  assert.deepEqual(Array.from(raw, item => selectedLocationText(h, item)), ['clk', 'sys_clk', 'other_clk']);
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

test('lint commands route persistent switches and the status configuration menu', timeout, async t => {
  const h = harness(t);
  assert.equal(h.lintState, h.context.workspaceState);
  await h.vscode.commands.executeCommand('fpgaWorkbench.enableLint');
  await h.vscode.commands.executeCommand('fpgaWorkbench.disableLint');
  await h.vscode.commands.executeCommand('fpgaWorkbench.configureLint');
  await h.vscode.commands.executeCommand('fpgaWorkbench.selectLintTool');
  await h.vscode.commands.executeCommand('fpgaWorkbench.selectManualLintTool');
  assert.deepEqual(h.lintEvents, [
    { type: 'setEnabled', enabled: true },
    { type: 'setEnabled', enabled: false },
    { type: 'configure' },
    { type: 'selectTool' },
    { type: 'selectManualTool' }
  ]);
  const snapshot = {enabled: true, status: '完成', tool: 'xvlog', diagnostics: []};
  h.publishLint(snapshot);
  assert.equal(h.lintSnapshot, snapshot, 'controller changes reach the sidebar');
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


test('multiline parameterized module reverse candidates include the module type for both backends', timeout, async t => {
  for (const semantic of [false, true]) {
    const h = harness(t), query = reverseNavigationFixture(h), previous = h.text;
    h.text = name => name === 'A' ? 'module A_top;\nchild #(\n .W(f(2, (3)))) first(.clk(sys_clk));\nchild #(\n .W(8)\n) second(.clk(other_clk));\nendmodule' : previous(name);
    await h.app.selectProject(h.xpr('A'));
    h.app.backend.running = semantic;
    if (semantic) h.app.backend.parentConnections = async () =>
      h.app.index.modules().find(mod => mod.name === 'A_top').instances.map(instance => { const loc = h.app.location(instance); return {targetUri:loc.uri, targetRange:loc.range, targetSelectionRange:loc.range}; });
    const {document, position} = query('child');
    const results = await h.app.definitions(document, position);
    assert.equal(results.length, 2);
    const text = h.text('A');
    const spans = results.map(item => text.slice(h.app.offset(text, (item.targetSelectionRange || item.range).start), h.app.offset(text, (item.targetSelectionRange || item.range).end)));
    assert(spans.every(value => value.startsWith('child #(')));
    assert(spans[0].endsWith('first')); assert(spans[1].endsWith('second'));
    assert.deepEqual(h.app.previewLocations(results).map(item => item.range), results.map(item => item.range));
  }
});


test('summary definition provider returns a read-only page without opening UI during hover', timeout, async t => {
  const h=harness(t), query=reverseNavigationFixture(h), previous=h.text;
  h.text=name=>name==='A' ? 'module A_top; child #(\n.W(8)) first(.clk(sys_clk)), second(.clk(other_clk)); endmodule' : previous(name);
  h.candidateMode='summary'; await h.app.selectProject(h.xpr('A')); h.app.backend.running=false;
  let opens=0; h.vscode.window.showTextDocument=async()=>{opens++;};
  const {document,position}=query('child');
  const result=await h.definitionProvider.provideDefinition(document,position);
  assert.equal(result.length,1); assert.equal(result[0].uri.scheme,'fpga-candidates'); assert.equal(opens,0);
  const content=h.candidateProvider.provideTextDocumentContent(result[0].uri);
  assert(content.includes('child #() first (\nchild #() second ('));
  assert(!content.includes('.W(8)'));
  const again=await h.definitionProvider.provideDefinition(document,position);
  assert.equal(again[0].uri.toString(),result[0].uri.toString());
  const lenses=h.candidateLensProvider.provideCodeLenses({uri:result[0].uri}); assert.equal(lenses.length,2);
  const target=h.candidateDefinitionProvider.provideDefinition({uri:result[0].uri},{line:3,character:2});
  assert.equal(target.uri.fsPath,h.source('A'));
  const source=h.text('A');assert.equal(source.slice(h.app.offset(source,target.range.start),h.app.offset(source,target.range.end)),'second');
  await h.commands.get('fpgaWorkbench.openCandidate')(...lenses[0].command.arguments);assert.equal(opens,1);
  h.app.sourceRevision++;
  assert.equal(h.candidateDefinitionProvider.provideDefinition({uri:result[0].uri},{line:3}),undefined);
  await h.commands.get('fpgaWorkbench.openCandidate')(...lenses[0].command.arguments);assert.equal(opens,1);
  assert(h.logs.some(line=>line.includes('候选列表已过期')));
  h.candidateMode='native';
  const native=await h.definitionProvider.provideDefinition(document,position);assert.equal(native.length,2);assert(native.every(item=>item.uri.scheme==='file'));
});

test('summary port rows omit parameter lists and project closure invalidates candidate jumps', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h);h.candidateMode='summary';
  await h.app.selectProject(h.xpr('A'));h.app.backend.running=false;
  const {document,position}=query('clk');const result=await h.definitionProvider.provideDefinition(document,position);
  const content=h.candidateProvider.provideTextDocumentContent(result[0].uri);
  assert(content.includes('child first (.clk(sys_clk))'));assert(content.includes('child second (.clk(other_clk))'));
  assert(!content.includes('#()'));
  await h.app.closeProject();
  assert.equal(h.candidateDefinitionProvider.provideDefinition({uri:result[0].uri},{line:3}),undefined);
});

test('summary parameters include named instance overrides and keep native mode available', timeout, async t => {
  const h=harness(t),query=reverseNavigationFixture(h),previous=h.text;
  h.text=name=>name==='child' ? 'module child #(parameter W=8)(input wire clk); endmodule'
    : name==='A' ? 'module A_top; child #(.W(11)) a(.clk(clk)); child #(.W(12)) b(.clk(clk)); endmodule' : previous(name);
  h.candidateMode='summary';await h.app.selectProject(h.xpr('A'));h.app.backend.running=false;
  const {document,position}=query('W');
  const result=await h.definitionProvider.provideDefinition(document,position);
  const content=h.candidateProvider.provideTextDocumentContent(result[0].uri);
  assert(content.includes('child #(.W(11)) a'));assert(content.includes('child #(.W(12)) b'));
  const manifest=require('../package.json');assert.equal(manifest.contributes.configuration.properties['fpgaWorkbench.navigation.candidateList'].default,'native');
});

test('single-step adaptive project picker accepts .xpr, .lpf, .ldf and arbitrary filelists without type pre-selection', timeout, async t => {
  const manifest = require('../package.json');
  assert.ok(!manifest.activationEvents.includes('onStartupFinished'), 'extension must not activate eagerly on unrelated workspaces');
  assert.ok(!manifest.contributes.commands.some(cmd => cmd.command === 'fpgaWorkbench.selectProjectType'));
  assert.equal(manifest.contributes.configuration.properties['fpgaWorkbench.projectType'], undefined);
  assert.equal(manifest.contributes.viewsWelcome.length, 1);
  assert.equal(manifest.contributes.viewsWelcome[0].when, '!fpgaWorkbench.hasProject');

  const h = harness(t);
  assert.equal(h.commands.has('fpgaWorkbench.selectProjectType'), false);
  let dialogOptions;
  const chosenLpf = path.resolve('synthetic-lifecycle', 'lat', 'top.lpf');
  h.load = async file => ({
    path: file, root: path.dirname(file), name: path.basename(file, path.extname(file)),
    projectType: file.endsWith('.lpf') ? 'lattice' : 'vivado',
    top: 'lat_top', warnings: [], sourceFiles: [h.source('A')], includeDirs: [], defines: [],
    filesets: [{ name: 'impl1', type: 'DesignSrcs' }],
    files: [{ path: h.source('A'), fileset: 'impl1', exists: true, enabled: true }],
  });
  h.openDialog = async options => { dialogOptions = options; return [h.vscode.Uri.file(chosenLpf)]; };
  await h.app.selectProject();
  const filterEntries = Object.entries(dialogOptions.filters);
  assert.deepEqual(Array.from(filterEntries[0][1]), ['xpr', 'lpf', 'ldf', 'f']);
  assert.ok(filterEntries.some(([, exts]) => Array.from(exts).includes('*')));
  assert.equal(h.app.project.path, chosenLpf);
  assert.equal(h.app.project.projectType, 'lattice');
  assert.equal(h.lastStartOptions.texts?.size, 1, 'decoded source texts are passed to backend without duplicate disk I/O');
});

test('saving a member HDL file updates backend incrementally without restarting slang-server while config edits reload', timeout, async t => {
  const h = harness(t);
  await h.app.selectProject(h.xpr('A'));
  assert.equal(h.starts.length, 1);
  const watcher = h.liveWatchers()[0];
  assert.ok(watcher);
  const sourceUri = h.vscode.Uri.file(h.source('A'));
  const xprUri = h.vscode.Uri.file(h.xpr('A'));
  const revBefore = h.app.sourceRevision;
  watcher.change.fire(sourceUri);
  assert.ok(h.app.sourceRevision > revBefore);
  assert.equal(h.backendChanges.length, 1);
  assert.equal(h.backendChanges[0][1], 2);
  assert.equal(h.app.refreshTimer, undefined, 'saving an HDL member file must not schedule a full project restart');
  assert.equal(h.starts.length, 1);

  watcher.change.fire(xprUri);
  assert.notEqual(h.app.refreshTimer, undefined, 'modifying the project file schedules a full project reload');
});

test('selecting an instantiated module in editor reveals and highlights the corresponding node in hierarchy view for builtin and semantic modes', timeout, async t => {
  const h = harness(t);
  reverseNavigationFixture(h);
  await h.app.selectProject(h.xpr('A'));
  const getParent = h.hierView.options.treeDataProvider.getParent;
  assert.equal(typeof getParent, 'function');

  const flushSelectionTimer = async () => {
    for (const [id, entry] of [...h.timers.entries()]) {
      if (entry.delay === 80) { h.timers.delete(id); entry.callback(); }
    }
    await new Promise(resolve => setImmediate(resolve));
  };

  // 1. Builtin mode: selecting second(.clk(other_clk)) in A_top reveals 'second : child' with select:true, focus:false
  h.app.backend.running = false;
  h.reveals.length = 0;
  h.hierView.selection = [];
  const topDoc = h.document('A');
  const topText = topDoc.getText();
  const secondOffset = topText.indexOf('second(.clk');
  const secondPos = h.app.position(topText, secondOffset);
  const editor = { document: topDoc, selection: { active: secondPos, anchor: secondPos, start: secondPos, end: secondPos } };
  h.vscode.window.activeTextEditor = editor;
  h.events.selection.fire({ textEditor: editor });
  await flushSelectionTimer();

  assert.equal(h.reveals.length, 1);
  assert.equal(h.reveals[0].item.label, 'second : child');
  assert.deepEqual({ ...h.reveals[0].options }, { select: true, focus: false, expand: false });
  assert.equal(getParent(h.reveals[0].item).label, 'A_top');
  assert.equal(getParent(getParent(h.reveals[0].item)), undefined);

  // Jumping into child.v keeps 'second : child' selected rather than jumping back to 'first : child'
  const childDoc = h.document('child');
  const childPos = h.app.position(childDoc.getText(), childDoc.getText().indexOf('child'));
  const childEditor = { document: childDoc, selection: { active: childPos, anchor: childPos } };
  h.vscode.window.activeTextEditor = childEditor;
  h.events.activeEditor.fire(childEditor);
  await flushSelectionTimer();
  assert.equal(h.hierView.selection[0].label, 'second : child');

  // Hidden hierarchy view never calls reveal until made visible again
  h.hierView.visible = false;
  h.reveals.length = 0;
  const firstPos = h.app.position(topText, topText.indexOf('first(.clk'));
  editor.selection = { active: firstPos, anchor: firstPos };
  h.vscode.window.activeTextEditor = editor;
  h.events.selection.fire({ textEditor: editor });
  await flushSelectionTimer();
  assert.equal(h.reveals.length, 0, 'hidden TreeView must not force sidebar open');

  h.hierView.visible = true;
  h.events.hierVisibility.fire({ visible: true });
  await flushSelectionTimer();
  assert.equal(h.reveals.length, 1);
  assert.equal(h.reveals[0].item.label, 'first : child');

  // 2. Semantic (slang) mode: walks nested generate/scope instance path and highlights exact instance
  h.app.backend.running = true;
  h.app.fireTreeChange();
  h.instancePaths = async modName => modName === 'child' ? ['A_top.gen_blk[0].first', 'A_top.gen_blk[0].second'] : ['A_top'];
  h.hierarchy = async scope => {
    if (scope === '') return [{ kind: 'Instance', instName: 'A_top', declName: 'A_top' }];
    if (scope === 'A_top') return [{ kind: 'GenerateBlockArray', instName: 'gen_blk', declName: 'gen_blk' }];
    if (scope === 'A_top.gen_blk') return [{ kind: 'GenerateBlock', instName: '[0]', declName: 'gen_blk' }];
    if (scope === 'A_top.gen_blk[0]') return [
      { kind: 'Instance', instName: 'first', declName: 'child', hasChildren: false },
      { kind: 'Instance', instName: 'second', declName: 'child', hasChildren: false },
    ];
    return [];
  };
  h.reveals.length = 0;
  h.hierView.selection = [];
  editor.selection = { active: secondPos, anchor: secondPos };
  h.events.selection.fire({ textEditor: editor });
  await flushSelectionTimer();

  assert.equal(h.reveals.length, 1);
  assert.equal(h.reveals[0].item.hierPath, 'A_top.gen_blk[0].second');
  assert.deepEqual({ ...h.reveals[0].options }, { select: true, focus: false, expand: false });
  assert.equal(getParent(h.reveals[0].item).hierPath, 'A_top.gen_blk[0]');
  assert.equal(getParent(getParent(h.reveals[0].item)).hierPath, 'A_top.gen_blk');
  assert.equal(getParent(getParent(getParent(h.reveals[0].item))).hierPath, 'A_top');
});
