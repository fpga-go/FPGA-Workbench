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
    loadCalls: [], starts: [], backendEvents: [], logs: [], errors: [], timerId: 0,
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
    references(...args) { return h.reference(...args); }
    hierarchy(...args) { return h.hierarchy(...args); }
    async changed() {}
    async showHierarchy() {}
  }

  const workspaceRoot = uri(path.resolve('synthetic-lifecycle', 'workspace'));
  const events = Object.fromEntries(['change', 'open', 'close', 'configuration', 'folders'].map(name => [name, new Emitter()]));
  const vscode = {
    Uri: { file: uri }, EventEmitter: Emitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Location: class { constructor(locationUri, range) { this.uri = locationUri; this.range = range; } },
    SymbolInformation: class {}, SymbolKind: { Module: 2 },
    CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } dispose() {} },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, StatusBarAlignment: { Left: 1 },
    window: {
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
      registerDocumentSymbolProvider: disposable,
    },
    commands: {
      registerCommand: (name, callback) => { h.commands.set(name, callback); return disposable(); },
      executeCommand: async (name, ...args) => {
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
    './xpr': { loadProject: async (...args) => { h.loadCalls.push(args[0]); return h.load(...args); }, filelist: () => '' },
    './indexer': { HdlIndex }, './slang': { SlangBackend: Backend }, './encoding': { readSource: (...args) => h.read(...args) },
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
  assert.equal(h.app.fileChildren().length, 0);
  assert.equal(h.contexts.get('fpgaWorkbench.loaded'), false);
  assert.equal(h.contexts.get('fpgaWorkbench.hasProject'), false);
  for (const name of ['project', 'fileset', 'top']) assert.equal(h.state.has(name), false, `${name} must not be restored`);
}

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
  assert.equal(h.state.has('project'), false);
  assert.equal(await h.app.load(h.xpr('B')), false);
  assert.deepEqual(h.starts, ['A']);
  assert.ok(h.backendEvents.lastIndexOf('stop') > h.backendEvents.indexOf('started:A'));
});
