'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HdlLinter, lintTarget } = require('../src/linting');
const { resolveLintExecutable, resolveLintCompanions } = require('../src/lint-process');

class Emitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
}
class Range {
  constructor(line, column, endLine, endColumn) {
    this.start = { line, character: column };
    this.end = { line: endLine, character: endColumn };
  }
}
class Diagnostic {
  constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for test event');
    await sleep(2);
  }
}

async function harness(t, overrides = {}, stateValues = new Map([['lint.enabled', true]])) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-lint-controller-test-'));
  const events = Object.fromEntries(['save', 'change', 'configuration', 'folders', 'activeEditor'].map(name => [name, new Emitter()]));
  // Existing behavior tests explicitly opt in through extension state, not configuration.
  const values = new Map(Object.entries(overrides));
  const h = { root, events, values, stateValues, calls: [], discoveries: [], warnings: [], project: undefined,
    stateUpdates: [], configurationReads: [], choices: [], commands: [], snapshots: [], dialogs: [] };
  const collection = h.collection = { entries: new Map(), clears: 0, disposed: false,
    clear() { this.clears++; this.entries.clear(); },
    set(uri, diagnostics) { assert.equal(this.disposed, false); this.entries.set(uri.fsPath, diagnostics); },
    dispose() { this.disposed = true; this.entries.clear(); }
  };
  const output = h.output = { lines: [], shows: 0, disposed: false,
    appendLine(value) { assert.equal(this.disposed, false); this.lines.push(value); },
    show() { this.shows++; }, dispose() { this.disposed = true; }
  };
  const status = h.status = { text: '', tooltip: '', disposed: false,
    show() { assert.equal(this.disposed, false); }, dispose() { this.disposed = true; }
  };
  const uri = file => ({ scheme: 'file', fsPath: path.resolve(file), toString() { return 'file:///' + this.fsPath.replace(/\\/g, '/'); } });
  const vscode = h.vscode = {
    Uri: { file: uri }, Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    languages: { createDiagnosticCollection() { return collection; } },
    window: {
      activeTextEditor: undefined,
      createOutputChannel() { return output; }, createStatusBarItem() { return status; },
      showWarningMessage(message) { h.warnings.push(message); return Promise.resolve(); },
      onDidChangeActiveTextEditor: events.activeEditor.event,
      showQuickPick(items, options) { h.choices.push({ items, options }); return h.pick(items, options); },
      showOpenDialog(options) { h.dialogs.push(options); return h.openDialog(options); }
    },
    commands: { async executeCommand(...args) { h.commands.push(args); } },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [{ name: 'test', uri: uri(root) }],
      getConfiguration(section, resource) { return {
        get(name, fallback) {
          assert.ok(!['lint.enabled', 'lint.backend', 'lint.iverilogPath', 'lint.vlogPath', 'lint.xvlogPath'].includes(name), 'Legacy tool settings must not be read');
          h.configurationReads.push(name);
          return values.has(name) ? values.get(name) : fallback;
        },
        inspect() { throw Error('Lint must not inspect configuration write targets'); },
        async update() { throw Error('Lint must not write user or workspace configuration'); }
      }; },
      getWorkspaceFolder() { return { uri: uri(root) }; },
      onDidSaveTextDocument: events.save.event,
      onDidChangeTextDocument: events.change.event,
      onDidChangeConfiguration: events.configuration.event,
      onDidChangeWorkspaceFolders: events.folders.event
    }
  };
  h.document = (name = 'rtl/top.sv') => {
    const document = { uri: uri(path.join(root, name)), isDirty: false, version: 1, languageId: name.endsWith('.sv') ? 'systemverilog' : 'verilog' };
    vscode.workspace.textDocuments.push(document);
    vscode.window.activeTextEditor = { document };
    return document;
  };
  h.process = async () => ({ code: 0, output: '' });
  h.pick = async () => undefined;
  h.openDialog = async () => undefined;
  h.resolve = resolveLintExecutable;
  h.companions = resolveLintCompanions;
  h.discovered = [{ backend: 'iverilog', executable: path.join(root, 'tools', 'iverilog.exe'), env: { TEST_LINT: '1' } }];
  h.discover = async () => h.discovered;
  h.state = {
    get(name, fallback) { return stateValues.has(name) ? stateValues.get(name) : fallback; },
    async update(name, value) {
      h.stateUpdates.push({ name, value });
      if (value === undefined) stateValues.delete(name); else stateValues.set(name, value);
    }
  };
  h.linter = new HdlLinter(vscode, () => h.project, {
    delay: 15,
    state: h.state,
    onDidChange: snapshot => h.snapshots.push(snapshot),
    resolveTool: (...args) => h.resolve(...args),
    resolveCompanions: (...args) => h.companions(...args),
    discoverTools: async (...args) => { h.discoveries.push(args); return h.discover(...args); },
    runProcess: async (step, options) => { h.calls.push({ step, options }); return h.process(step, options); }
  });
  h.setProject = docs => (h.project = { name: 'test', root, path: path.join(root, 'test.xpr'),
    sourceFiles: docs.map(doc => doc.uri.fsPath), includeDirs: [path.join(root, 'include')], defines: ['PROJECT=1'], top: 'top' });
  t.after(async () => {
    await h.linter.dispose();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  return h;
}

test('lint stays off without extension state even when a legacy setting enables it', async t => {
  const h = await harness(t, { 'lint.enabled': true }, new Map()), document = h.document();
  assert.equal(h.stateValues.has('lint.enabled'), false);
  assert.match(h.status.text, /已关闭/);
  assert.equal(h.status.command, 'fpgaWorkbench.configureLint');
  h.events.save.fire(document);
  await h.linter.run(document);
  await sleep(25);
  assert.equal(h.discoveries.length, 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.warnings.at(-1), /已关闭/);
});

test('enabling persists to extension state but waits for a save or explicit run', async t => {
  const h = await harness(t, {}, new Map()), document = h.document();
  await h.linter.setEnabled(true);
  assert.deepEqual(h.stateUpdates, [{ name: 'lint.enabled', value: true }]);
  assert.match(h.status.text, /就绪/);
  await sleep(25);
  assert.equal(h.calls.length, 0);
  h.events.save.fire(document);
  await until(() => h.calls.length === 1);
  await h.linter.queue;
  assert.equal(h.linter.lastResult.errors, 0);
});

test('extension state survives reconstruction without changing workspace or global settings', async t => {
  const saved = new Map();
  const first = await harness(t, { 'lint.enabled': false }, saved);
  first.document();
  await first.linter.setEnabled(true);
  await first.linter.dispose();
  const second = await harness(t, { 'lint.enabled': false }, saved);
  second.document();
  second.vscode.workspace.workspaceFolders = [];
  second.vscode.workspace.getWorkspaceFolder = () => undefined;
  assert.match(second.status.text, /就绪/);
  await second.linter.run();
  assert.equal(second.calls.length, 1);
  await second.linter.setEnabled(false);
  assert.deepEqual(second.stateUpdates, [{ name: 'lint.enabled', value: false }]);
  await second.linter.dispose();
  const third = await harness(t, { 'lint.enabled': true }, saved);
  third.document();
  assert.match(third.status.text, /已关闭/);
  await third.linter.run();
  assert.equal(third.calls.length, 0);
  assert.equal(third.values.get('lint.enabled'), true, 'legacy configuration remains untouched');
});

test('disabling clears diagnostics, cancels an active process and prevents later save checks', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => ({ code: 1, output: `${document.uri.fsPath}:5: syntax error` });
  await h.linter.run(document);
  assert.equal(h.collection.entries.size, 1);
  const pending = deferred();
  h.process = () => pending.promise;
  const running = h.linter.run(document);
  await until(() => h.calls.length === 2);
  await h.linter.setEnabled(false);
  assert.equal(h.calls[1].options.signal.aborted, true);
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult, undefined);
  assert.equal(h.linter.lastDocument, undefined);
  assert.match(h.status.text, /已关闭/);
  pending.resolve({ code: 1, output: `${document.uri.fsPath}:9: stale syntax error` });
  await running;
  h.events.save.fire(document);
  await sleep(25);
  assert.equal(h.calls.length, 2);
  assert.equal(h.collection.entries.size, 0);
});

test('configuration menu enables lint and selects only a discovered tool without starting a process', async t => {
  const h = await harness(t, {}, new Map());
  h.document();
  h.discovered.push({ backend: 'modelsim', executable: path.join(h.root, 'EDA Tools', 'vlog.exe'), env: { TEST_LINT: 'modelsim' } });
  h.pick = async items => items.find(item => item.action === 'toggle');
  await h.linter.configure();
  assert.equal(h.stateValues.get('lint.enabled'), true);
  assert.deepEqual(h.stateUpdates[0], { name: 'lint.enabled', value: true });
  h.pick = async items => items.find(item => item.action === 'tools' || item.value === 'modelsim');
  await h.linter.configure();
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'modelsim');
  assert.deepEqual(h.stateUpdates[1], { name: 'lint.preferredBackend', value: 'modelsim' });
  await sleep(25);
  assert.equal(h.calls.length, 0);
  assert.equal(h.discoveries.length, 1);
  assert.equal(h.choices.length, 3);
  assert.ok(h.choices[2].items.some(item => item.value === 'auto'));
  assert.ok(!h.choices[2].items.some(item => item.value === 'xsim'), 'undiscovered tools cannot be selected');
});

test('configuration menu routes manual checks and output without opening settings', async t => {
  const h = await harness(t); h.document();
  h.pick = async items => items.find(item => item.action === 'run');
  await h.linter.configure();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.choices[0].items.map(item => item.action).sort(), ['output', 'run', 'toggle', 'tools']);
  assert.equal(h.commands.length, 0);
  const shows = h.output.shows;
  h.pick = async items => items.find(item => item.action === 'output');
  await h.linter.configure();
  assert.equal(h.output.shows, shows + 1);
  h.pick = async () => undefined;
  await h.linter.configure();
  assert.equal(h.stateUpdates.length, 0);
  assert.equal(h.calls.length, 1);
});

test('a menu selection delivered after disposal cannot update extension state', async t => {
  const h = await harness(t, {}, new Map()), picked = deferred();
  h.document(); h.pick = () => picked.promise;
  const configuring = h.linter.configure();
  await h.linter.dispose();
  picked.resolve({ action: 'toggle' });
  await configuring;
  assert.equal(h.stateUpdates.length, 0);
});

test('normal output summarizes scope while verbose output includes the full compiler command', async t => {
  const h = await harness(t, { extraDefines: ['PRIVATE_VALUE=42'], extraIncludeDirs: ['private_include'] });
  const document = h.document();
  h.process = async () => ({ code: 0, output: `${document.uri.fsPath}:6: warning: implicit wire` });
  await h.linter.run(document);
  const normal = h.output.lines.join('\n');
  assert.match(normal, /\[iverilog\]/);
  assert.match(normal, /1 个源文件/);
  assert.match(normal, /1 个宏/);
  assert.match(normal, /implicit wire/);
  assert.ok(!normal.includes('"executable"'));
  assert.ok(!normal.includes('PRIVATE_VALUE=42'));
  assert.ok(!normal.includes('private_include'));
  h.values.set('lint.verbose', true);
  h.output.lines.length = 0;
  await h.linter.run(document);
  const command = h.output.lines.find(line => line.startsWith('{"executable":'));
  assert.ok(command, 'verbose mode records structured argv');
  assert.ok(JSON.parse(command).args.includes('PRIVATE_VALUE=42'));
  assert.ok(JSON.parse(command).args.includes(path.join(h.root, 'private_include')));
});

test('timescale warning filtering preserves real errors and can be disabled', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => ({ code: 1, output: [
    `${document.uri.fsPath}:2: warning: timescale for top inherited from another file.`,
    `${document.uri.fsPath}:1: ...: The inherited timescale is here.`,
    'warning: Some design elements have no explicit time unit and/or',
    '       : time precision. This may cause confusing timing results.',
    '       : Affected design elements are:',
    `       : -- module top declared here: ${document.uri.fsPath}:1`,
    `${document.uri.fsPath}:6: warning: implicit wire`,
    `${document.uri.fsPath}:7: error: invalid timescale directive`
  ].join('\n') });
  await h.linter.run(document);
  assert.ok(h.calls[0].step.args.includes('-Wno-timescale'));
  assert.equal(h.linter.lastResult.errors, 1);
  assert.equal(h.linter.lastResult.warnings, 1);
  const diagnostics = h.collection.entries.get(document.uri.fsPath);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some(item => item.message === 'invalid timescale directive'));
  let visible = h.output.lines.join('\n');
  assert.ok(!visible.includes('inherited from another file'));
  assert.ok(!visible.includes('Affected design elements'));
  assert.ok(visible.includes('invalid timescale directive'));
  h.values.set('lint.ignoreTimescaleWarnings', false);
  h.output.lines.length = 0;
  await h.linter.run(document);
  assert.ok(!h.calls[1].step.args.includes('-Wno-timescale'));
  assert.equal(h.linter.lastResult.errors, 1);
  assert.equal(h.linter.lastResult.warnings, 2);
  visible = h.output.lines.join('\n');
  assert.ok(visible.includes('inherited from another file'));
  assert.ok(visible.includes('Affected design elements'));
});

test('partial compiler output is also filtered without hiding an incomplete check', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => { throw Object.assign(Error('Compiler timed out'), { output:
    `${document.uri.fsPath}:2: warning: timescale for top inherited from another file.\n${document.uri.fsPath}:6: error: invalid timescale directive` }); };
  await h.linter.run(document);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.status.text, /未完成/);
  const visible = h.output.lines.join('\n');
  assert.ok(!visible.includes('inherited from another file'));
  assert.ok(visible.includes('invalid timescale directive'));
});

test('saving repeatedly debounces into one check and manual command checks the active editor', async t => {
  const h = await harness(t), document = h.document();
  h.events.save.fire(document); h.events.save.fire(document); h.events.save.fire(document);
  await until(() => h.calls.length === 1);
  await h.linter.queue;
  assert.equal(h.output.shows, 0);
  assert.equal(h.linter.lastResult.errors, 0);
  await sleep(25);
  assert.equal(h.calls.length, 1);
  await h.linter.run();
  assert.equal(h.calls.length, 2);
  assert.equal(h.output.shows, 0, 'manual checks keep the output panel closed');
  assert.equal(h.discoveries.length, 2);
  assert.equal(h.linter.lastResult.backend, 'iverilog');
  assert.equal(h.calls[0].options.env.TEST_LINT, '1');
  assert.notEqual(h.calls[0].step.cwd, h.root);
  assert.equal(await fs.stat(h.calls[0].step.cwd).then(() => true, () => false), false, 'private compiler output is cleaned');
});

test('disabled mode, manual-only mode and untrusted workspaces never launch unwanted checks', async t => {
  const h = await harness(t, {}, new Map()), document = h.document();
  h.events.save.fire(document);
  await h.linter.run(document);
  await sleep(25);
  assert.equal(h.calls.length, 0);
  assert.match(h.status.text, /已关闭/);
  await h.linter.setEnabled(true); h.values.set('lint.runOnSave', false);
  h.events.save.fire(document); await sleep(25);
  assert.equal(h.calls.length, 0);
  await h.linter.run(document);
  assert.equal(h.calls.length, 1);
  h.vscode.workspace.isTrusted = false;
  await h.linter.run(document);
  assert.equal(h.calls.length, 1);
  assert.match(h.status.text, /未受信任/);
});

test('single file and project checks use the appropriate file/include/define scope', async t => {
  const h = await harness(t, { extraIncludeDirs: ['common'], extraDefines: ['SINGLE=1'] });
  const top = h.document('rtl/top.sv'), child = h.document('rtl/child.v'), header = h.document('include/defs.svh');
  await h.linter.run(top);
  let args = h.calls[0].step.args;
  assert.ok(args.includes(top.uri.fsPath));
  assert.ok(!args.includes(child.uri.fsPath));
  assert.ok(args.includes('SINGLE=1'));
  assert.ok(args.includes(path.join(h.root, 'common')));
  h.setProject([top, child, header]);
  await h.linter.run(header);
  args = h.calls[1].step.args;
  assert.ok(args.includes(top.uri.fsPath) && args.includes(child.uri.fsPath));
  assert.ok(!args.includes(header.uri.fsPath), 'header is not a compilation unit');
  assert.ok(args.includes(path.dirname(header.uri.fsPath)));
  assert.ok(args.includes('PROJECT=1') && !args.includes('SINGLE=1'));
  const external = h.document('elsewhere/independent.v');
  await h.linter.run(external, false);
  args = h.calls[2].step.args;
  assert.ok(args.includes(external.uri.fsPath) && !args.includes(top.uri.fsPath));
  assert.ok(args.includes('SINGLE=1'));
  const target = lintTarget(header, h.project, h.vscode.workspace.getConfiguration(), h.vscode.workspace.getWorkspaceFolder());
  assert.equal(target.projectPath, h.project.path);
});

test('manual lint uses loaded XPR with no editor or an unrelated dirty editor', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), child = h.document('rtl/child.sv');
  h.setProject([top, child]);
  h.vscode.window.activeTextEditor = undefined;
  await h.linter.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.linter.target.files, [top.uri.fsPath, child.uri.fsPath]);
  const unrelated = h.document('notes.txt'); unrelated.isDirty = true;
  const configurationResources = [], getConfiguration = h.vscode.workspace.getConfiguration;
  h.vscode.workspace.getConfiguration = (section, resource) => {
    configurationResources.push(resource?.fsPath); return getConfiguration(section, resource);
  };
  await h.linter.run();
  assert.equal(h.calls.length, 2);
  assert.equal(h.linter.target.anchor, top.uri.fsPath);
  assert.equal(h.linter.target.projectPath, h.project.path);
  assert.equal(configurationResources[0], h.project.path);
});

test('XPR lint keeps selected VHDL metadata independent of navigation sources', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), vhdl = h.document('rtl/unit.vhdl');
  h.setProject([top]);
  h.project.files = [
    {path: vhdl.uri.fsPath, enabled: true, selected: true, exists: true, type: 'VHDL 2008', library: 'designlib'},
    {path: top.uri.fsPath, enabled: true, selected: true, exists: true, type: 'Verilog', library: 'xil_defaultlib'},
    {path: path.join(h.root, 'disabled.vhd'), enabled: false, selected: true, exists: true},
    {path: path.join(h.root, 'simulation.vhd'), enabled: true, selected: false, exists: true}
  ];
  const target = lintTarget(undefined, h.project, h.vscode.workspace.getConfiguration(), undefined, true);
  assert.equal(target.language, 'all');
  assert.deepEqual(target.files, [vhdl.uri.fsPath, top.uri.fsPath]);
  assert.equal(target.sourceEntries[0].type, 'VHDL 2008');
  assert.equal(target.sourceEntries[0].library, 'designlib');
  assert.deepEqual(h.project.sourceFiles, [top.uri.fsPath]);
  vhdl.isDirty = true;
  h.vscode.window.activeTextEditor = undefined;
  await h.linter.run();
  assert.match(h.status.text, /待保存/);
  assert.equal(h.calls.length, 0);
});

test('Verilog and header entry points check only the project Verilog family with Icarus', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), child = h.document('rtl/child.sv');
  const header = h.document('rtl/defs.vh'), svHeader = h.document('rtl/defs.svh'), vhdl = h.document('rtl/other.vhdl');
  h.setProject([top, child, header, svHeader]);
  h.project.files = [top, child, vhdl].map(document => ({path: document.uri.fsPath, enabled: true, selected: true, exists: true}));
  h.project.files.push({path: path.join(h.root, 'disabled.vhd'), enabled: false, selected: true, exists: false});
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  h.companions = async () => { throw Error('A Verilog-only target must not resolve a VHDL companion'); };
  vhdl.isDirty = true;
  for (const document of [top, child, header, svHeader]) {
    await h.linter.run(document);
    assert.equal(h.linter.target.language, 'verilog');
    assert.deepEqual(h.linter.target.files, [top.uri.fsPath, child.uri.fsPath]);
    assert.deepEqual(h.linter.target.excludedFiles, [vhdl.uri.fsPath]);
    assert.equal(h.linter.lastResult.code, 0);
    const {step} = h.calls.at(-1);
    assert.equal(step.executable, h.discovered[0].executable);
    assert.ok(step.args.includes('PROJECT=1'));
    assert.ok(step.args.includes(path.join(h.root, 'include')));
    assert.ok(!step.args.includes(vhdl.uri.fsPath));
  }
  assert.equal(h.calls.length, 4);
  assert.equal(h.warnings.length, 0);
  assert.ok(h.output.lines.some(line => /检查语言.*Verilog/.test(line)));
  assert.ok(h.output.lines.some(line => /未检查其他语言源文件：1 个/.test(line)));
  assert.ok(h.output.lines.some(line => /不代表整个混合语言工程检查通过/.test(line)));
  assert.ok(!h.output.lines.some(line => /^VHDL 工具：/.test(line)));
});

test('missing VHDL in the project cannot block checking a Verilog member', async t => {
  const h = await harness(t), top = h.document(); h.setProject([top]);
  const missing = path.join(h.root, 'missing.vhd');
  h.project.files = [{path: top.uri.fsPath, enabled: true, selected: true, exists: true},
    {path: missing, enabled: true, selected: true, exists: false}];
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  await h.linter.run(top);
  assert.equal(h.linter.lastResult.code, 0);
  assert.deepEqual(h.linter.target.missingFiles, []);
  assert.deepEqual(h.linter.target.excludedFiles, [missing]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.warnings.length, 0);
});

test('VHDL member checks keep library and standard but exclude dirty Verilog and headers', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), header = h.document('rtl/defs.vh');
  const defs = h.document('rtl/defs.vhd'), unit = h.document('rtl/unit.vhdl');
  h.setProject([top, header]);
  h.project.files = [
    {path: defs.uri.fsPath, enabled: true, selected: true, exists: true, type: 'VHDL 2008', library: 'packetlib'},
    {path: unit.uri.fsPath, enabled: true, selected: true, exists: true, type: 'VHDL 2008', library: 'xil_defaultlib'},
    {path: top.uri.fsPath, enabled: true, selected: true, exists: true, type: 'Verilog', library: 'xil_defaultlib'}
  ];
  h.discovered = [{backend: 'xsim', executable: path.join(h.root, 'xvlog.exe')}];
  const required = [];
  h.companions = async (tool, requirements) => {
    required.push(requirements); return {...tool, vhdlExecutable: path.join(h.root, 'xvhdl.exe')};
  };
  top.isDirty = true; header.isDirty = true;
  await h.linter.run(unit);
  assert.equal(h.linter.target.language, 'vhdl');
  assert.deepEqual(h.linter.target.files, [defs.uri.fsPath, unit.uri.fsPath]);
  assert.deepEqual(h.linter.target.excludedFiles, [top.uri.fsPath]);
  assert.equal(h.linter.lastResult.code, 0);
  assert.ok(required.length > 0 && required.every(value => value.vhdl && !value.verilog));
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(({step}) => step.executable.endsWith('xvhdl.exe') && step.args.includes('--2008')));
  assert.ok(h.calls[0].step.args.includes('packetlib'));
  assert.ok(h.calls[1].step.args.includes('xil_defaultlib'));
  const result = h.linter.lastResult;
  h.events.change.fire({document: header});
  assert.equal(h.linter.lastResult, result, 'a Verilog header does not invalidate VHDL-only diagnostics');
  unit.isDirty = true; h.events.change.fire({document: unit});
  assert.equal(h.linter.lastResult, undefined);
  assert.match(h.status.text, /待保存/);
});

test('saving a Verilog member keeps its language scope while a VHDL editor is active', async t => {
  const h = await harness(t), top = h.document(), vhdl = h.document('rtl/other.vhd');
  h.setProject([top]);
  h.project.files = [top, vhdl].map(document => ({path: document.uri.fsPath, enabled: true, selected: true, exists: true}));
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  h.events.save.fire(top);
  await until(() => h.calls.length === 1);
  await h.linter.queue;
  assert.equal(h.linter.lastResult.code, 0);
  assert.equal(h.linter.target.language, 'verilog');
  assert.ok(!h.calls[0].step.args.includes(vhdl.uri.fsPath));
});

test('editing an excluded language does not cancel a running Verilog check', async t => {
  const h = await harness(t), top = h.document(), vhdl = h.document('rtl/other.vhd'), pending = deferred();
  h.setProject([top]);
  h.project.files = [top, vhdl].map(document => ({path: document.uri.fsPath, enabled: true, selected: true, exists: true}));
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  h.process = () => pending.promise;
  const running = h.linter.run(top);
  await until(() => h.calls.length === 1);
  vhdl.isDirty = true; h.events.change.fire({document: vhdl});
  assert.equal(h.calls[0].options.signal.aborted, false);
  top.isDirty = true; h.events.change.fire({document: top});
  assert.equal(h.calls[0].options.signal.aborted, true);
  pending.resolve({code: 0, output: ''}); await running;
  assert.equal(h.linter.lastResult, undefined);
});

test('no editor, non-HDL or unrelated HDL manual entry points retain the full mixed project', async t => {
  const h = await harness(t), top = h.document(), vhdl = h.document('rtl/other.vhd');
  h.setProject([top]);
  h.project.files = [top, vhdl].map(document => ({path: document.uri.fsPath, enabled: true, selected: true, exists: true}));
  h.discovered = [{backend: 'xsim', executable: path.join(h.root, 'xvlog.exe')}];
  h.companions = async tool => ({...tool, vhdlExecutable: path.join(h.root, 'xvhdl.exe')});
  const notes = h.document('notes.txt'), external = h.document('elsewhere/external.v');
  notes.isDirty = true; external.isDirty = true;
  for (const document of [undefined, notes, external]) {
    h.vscode.window.activeTextEditor = document ? {document} : undefined;
    await h.linter.run();
    assert.equal(h.linter.target.language, 'all');
    assert.deepEqual(h.linter.target.files, [top.uri.fsPath, vhdl.uri.fsPath]);
    assert.deepEqual(h.linter.target.excludedFiles, []);
    assert.equal(h.linter.lastResult.code, 0);
    assert.equal(h.linter.target.anchor, top.uri.fsPath);
  }
  assert.equal(h.calls.length, 6);
});

test('explicit Icarus still reports unsupported when checking the complete mixed project', async t => {
  const h = await harness(t), top = h.document(), vhdl = h.document('rtl/other.vhd');
  h.setProject([top]);
  h.project.files = [top, vhdl].map(document => ({path: document.uri.fsPath, enabled: true, selected: true, exists: true}));
  h.vscode.window.activeTextEditor = undefined;
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  await h.linter.run();
  assert.equal(h.linter.target.language, 'all');
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.linter.lastResult.message, /VHDL/);
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'iverilog');
});

test('missing selected project HDL blocks checks instead of silently passing', async t => {
  const h = await harness(t), top = h.document(); h.setProject([top]);
  h.project.files = [{path: top.uri.fsPath, enabled: true, selected: true, exists: true},
    {path: path.join(h.root, 'missing.vhd'), enabled: true, selected: true, exists: false}];
  h.vscode.window.activeTextEditor = undefined;
  await h.linter.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.linter.lastResult.message, /missing\.vhd/);
});

test('conflicting selected XPR metadata cannot silently choose the last library', async t => {
  const h = await harness(t), top = h.document(); h.setProject([top]);
  h.project.files = ['firstlib', 'secondlib'].map(library => ({path: top.uri.fsPath, enabled: true, selected: true, exists: true, library}));
  await h.linter.run();
  assert.deepEqual(h.linter.target.files, [top.uri.fsPath]);
  assert.equal(h.linter.target.sourceEntries.length, 2);
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.linter.lastResult.message, /逻辑库或语言版本不一致/);
});

test('explicit Icarus selection rejects VHDL and retains the tool choice', async t => {
  const h = await harness(t); h.document('unit.vhd');
  h.stateValues.set('lint.preferredBackend', 'iverilog');
  await h.linter.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.linter.lastResult.message, /VHDL/);
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'iverilog');
});

test('VHDL auto selection skips Icarus and validates companion before compiling', async t => {
  const h = await harness(t), vhdl = h.document('unit.vhd');
  h.discovered.push({backend: 'xsim', executable: path.join(h.root, 'xvlog.exe')});
  const resolved = [];
  h.companions = async (tool, required) => {
    resolved.push({backend: tool.backend, required});
    return {...tool, vhdlExecutable: path.join(h.root, 'xvhdl.exe')};
  };
  await h.linter.run();
  assert.equal(resolved[0].backend, 'xsim');
  assert.equal(resolved[0].required.vhdl, true);
  assert.equal(h.calls.at(-1).step.executable, path.join(h.root, 'xvhdl.exe'));
  assert.ok(h.calls.at(-1).step.args.includes(vhdl.uri.fsPath));
  assert.equal(h.linter.lastResult.unavailable, undefined);
});

test('saving VHDL schedules a check and editing it cancels stale results', async t => {
  const h = await harness(t), vhdl = h.document('unit.vhdl');
  h.discovered = [{backend: 'xsim', executable: path.join(h.root, 'xvlog.exe')}];
  h.companions = async tool => ({...tool, vhdlExecutable: path.join(h.root, 'xvhdl.exe')});
  h.events.save.fire(vhdl);
  await until(() => h.calls.length > 0);
  await h.linter.queue;
  assert.equal(h.linter.lastResult.code, 0);
  vhdl.isDirty = true; h.events.change.fire({document: vhdl});
  assert.equal(h.linter.lastResult, undefined);
  assert.match(h.status.text, /待保存/);
});

test('standalone headers and dirty project sources or headers are not checked from stale disk contents', async t => {
  const h = await harness(t), header = h.document('include/defs.vh');
  await h.linter.run(header);
  assert.equal(h.calls.length, 0);
  assert.match(h.status.text, /缺少编译单元/);
  const top = h.document(), child = h.document('rtl/child.v');
  h.setProject([top, child]);
  child.isDirty = true;
  await h.linter.run(top);
  assert.equal(h.calls.length, 0);
  assert.match(h.status.text, /待保存/);
  assert.match(h.warnings.at(-1), /先保存/);
  child.isDirty = false; header.isDirty = true;
  await h.linter.run(top);
  assert.equal(h.calls.length, 0);
  header.isDirty = false;
  await h.linter.run(top);
  assert.equal(h.calls.length, 1);
});

test('compiler diagnostics map to source positions and disappear after the error is fixed', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => ({ code: 1, output: `${document.uri.fsPath}:7:4: syntax error\n${document.uri.fsPath}:8: warning: implicit wire` });
  await h.linter.run(document);
  const diagnostics = h.collection.entries.get(document.uri.fsPath);
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[0].range.start, { line: 6, character: 3 });
  assert.equal(diagnostics[0].severity, h.vscode.DiagnosticSeverity.Error);
  assert.equal(diagnostics[1].severity, h.vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostics[0].source, 'FPGA Lint (iverilog)');
  assert.equal(h.linter.lastResult.errors, 1);
  assert.equal(h.linter.lastResult.warnings, 1);
  h.process = async () => ({ code: 0, output: '' });
  await h.linter.run(document);
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult.errors, 0);
});

test('nonzero exit and unavailable tools never report a clean result', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => ({ code: 2, output: 'Compiler could not read license server.' });
  await h.linter.run(document);
  assert.equal(h.linter.lastResult.errors, 1);
  assert.equal(h.collection.entries.get(document.uri.fsPath)[0].severity, h.vscode.DiagnosticSeverity.Error);
  assert.match(h.collection.entries.get(document.uri.fsPath)[0].message, /退出码 2/);
  h.discover = async () => { throw Object.assign(Error('iverilog not found'), { code: 'ENOENT' }); };
  await h.linter.run(document);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.status.text, /未完成/);
  assert.equal(h.collection.entries.get(document.uri.fsPath)[0].severity, h.vscode.DiagnosticSeverity.Warning);
  assert.match(h.collection.entries.get(document.uri.fsPath)[0].message, /not found/);
});

test('editing during an in-flight check aborts it and discards its late diagnostics', async t => {
  const h = await harness(t), document = h.document(), pending = deferred();
  h.process = () => pending.promise;
  const running = h.linter.run(document);
  await until(() => h.calls.length === 1);
  document.isDirty = true;
  h.events.change.fire({ document });
  assert.equal(h.calls[0].options.signal.aborted, true);
  pending.resolve({ code: 1, output: `${document.uri.fsPath}:5: syntax error` });
  await running;
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult, undefined);
  assert.match(h.status.text, /待保存/);
  document.isDirty = false;
  h.process = async () => ({ code: 0, output: '' });
  h.events.save.fire(document);
  await until(() => h.calls.length === 2);
  await h.linter.queue;
  assert.equal(h.linter.lastResult.errors, 0);
});

test('newer checks serialize after cancellation and only the latest result is published', async t => {
  const h = await harness(t), document = h.document(), pending = deferred();
  h.process = () => pending.promise;
  const old = h.linter.run(document);
  await until(() => h.calls.length === 1);
  const latest = h.linter.run(document);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.calls.length, 1, 'compiler processes do not overlap');
  h.process = async () => ({ code: 0, output: '' });
  pending.resolve({ code: 1, output: `${document.uri.fsPath}:9: old error` });
  await old; await latest;
  assert.equal(h.calls.length, 2);
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult.errors, 0);
});

test('project index reload holds a saved-file check until the new project is available', async t => {
  const h = await harness(t), document = h.document(), child = h.document('rtl/child.v');
  h.linter.projectChanged(true);
  h.events.save.fire(document);
  await sleep(25);
  assert.equal(h.calls.length, 0);
  h.setProject([document, child]);
  h.linter.projectChanged(false);
  await until(() => h.calls.length === 1);
  await h.linter.queue;
  assert.ok(h.calls[0].step.args.includes(child.uri.fsPath));
  assert.equal(h.linter.lastResult.errors, 0);
});

test('a header beside project RTL uses its compilation units without an explicit include directory', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), header = h.document('rtl/defs.vh');
  h.setProject([top]);
  h.project.includeDirs = [];
  await h.linter.run(header);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].step.args.includes(top.uri.fsPath));
  assert.ok(!h.calls[0].step.args.includes(header.uri.fsPath));
  assert.equal(h.linter.target.projectPath, h.project.path);
});

test('an unlisted root header belongs to the project and blocks checks while dirty', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), header = h.document('defs.vh');
  h.setProject([top]);
  h.project.includeDirs = [];
  header.isDirty = true;
  await h.linter.run(top);
  assert.equal(h.calls.length, 0);
  assert.match(h.status.text, /待保存/);
  header.isDirty = false;
  await h.linter.run(header);
  assert.equal(h.calls.length, 1);
  assert.equal(h.linter.target.projectPath, h.project.path);
  assert.ok(h.linter.target.includeDirs.includes(h.root));
  assert.ok(h.calls[0].step.args.includes(top.uri.fsPath));
  assert.ok(!h.calls[0].step.args.includes(header.uri.fsPath));
});

test('editing an unlisted root header cancels an in-flight project check', async t => {
  const h = await harness(t), top = h.document('rtl/top.v'), header = h.document('defs.vh'), pending = deferred();
  h.setProject([top]);
  h.project.includeDirs = [];
  h.process = () => pending.promise;
  const running = h.linter.run(top);
  await until(() => h.calls.length === 1);
  header.isDirty = true;
  h.events.change.fire({ document: header });
  assert.equal(h.calls[0].options.signal.aborted, true);
  pending.resolve({ code: 1, output: `${top.uri.fsPath}:7: stale error` });
  await running;
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult, undefined);
  assert.match(h.status.text, /待保存/);
});

test('project refresh does not restart checks after selecting manual-only mode', async t => {
  const h = await harness(t, { 'lint.runOnSave': false }), top = h.document();
  await h.linter.run(top);
  assert.equal(h.calls.length, 1);
  h.linter.projectChanged(true);
  h.setProject([top]);
  h.linter.projectChanged(false);
  await sleep(30);
  await h.linter.queue;
  assert.equal(h.calls.length, 1);
});

test('process failures retain partial compiler output and report an incomplete check', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => { throw Object.assign(Error('Compiler timed out'), { output: 'partial compiler diagnostic before timeout' }); };
  await h.linter.run(document);
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.ok(h.output.lines.includes('partial compiler diagnostic before timeout'));
  assert.match(h.status.text, /未完成/);
  assert.match(h.collection.entries.get(document.uri.fsPath)[0].message, /timed out/);
});

test('reset cancels pending timers and invalidates results during PATH discovery', async t => {
  const h = await harness(t), document = h.document();
  h.events.save.fire(document);
  h.linter.reset();
  await sleep(25);
  assert.equal(h.calls.length, 0);
  const pending = deferred();
  h.discover = () => pending.promise;
  const running = h.linter.run(document);
  await until(() => h.discoveries.length === 1);
  h.events.configuration.fire({ affectsConfiguration: section => section === 'fpgaWorkbench' });
  pending.resolve(h.discovered);
  await running;
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult, undefined);
  assert.equal(h.collection.entries.size, 0);
});

test('disposing an active check discards late diagnostics and unregisters automatic events', async t => {
  const h = await harness(t), document = h.document(), pending = deferred();
  h.process = () => pending.promise;
  const running = h.linter.run(document);
  await until(() => h.calls.length === 1);
  const closing = h.linter.dispose();
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.collection.disposed, true);
  pending.resolve({ code: 1, output: `${document.uri.fsPath}:1: syntax error` });
  await running; await closing;
  await sleep(0);
  assert.equal(h.output.disposed, true);
  assert.equal(h.collection.entries.size, 0);
  assert.equal(h.linter.lastResult, undefined);
  h.events.save.fire(document);
  await h.linter.run(document);
  assert.equal(h.calls.length, 1);
  assert.equal(Object.values(h.events).reduce((sum, event) => sum + event.listeners.size, 0), 0);
});

test('a discovered preferred ModelSim tool reaches the process with vlib before vlog', async t => {
  const h = await harness(t, { 'lint.timeoutMs': 4321 }, new Map([['lint.enabled', true], ['lint.preferredBackend', 'modelsim']]));
  const executable = path.join(os.tmpdir(), 'EDA Tools', 'vlog.exe');
  h.discovered.push({ backend: 'modelsim', executable, env: { TEST_LINT: 'modelsim' } });
  const document = h.document();
  await h.linter.run(document);
  assert.equal(h.discoveries.length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(path.basename(h.calls[0].step.executable), 'vlib.exe');
  assert.equal(path.basename(h.calls[1].step.executable), 'vlog.exe');
  assert.equal(h.calls[1].step.executable, executable);
  assert.equal(h.calls[1].options.env.TEST_LINT, 'modelsim');
  assert.equal(h.calls[1].options.timeoutMs, 4321);
  assert.equal(h.linter.lastResult.backend, 'modelsim');
});

test('auto discovery ignores legacy backend and executable settings and is repeated for each run', async t => {
  const h = await harness(t, {
    'lint.enabled': false, 'lint.backend': 'modelsim',
    'lint.iverilogPath': 'C:/do-not-run/iverilog.exe',
    'lint.xvlogPath': 'C:/do-not-run/xvlog.bat',
    'lint.vlogPath': 'C:/do-not-run/vlog.exe'
  });
  h.document();
  await h.linter.run();
  assert.equal(h.linter.lastResult.backend, 'iverilog');
  assert.equal(h.calls[0].step.executable, h.discovered[0].executable);
  h.discovered = [{ backend: 'xsim', executable: path.join(h.root, 'Xilinx Tools', 'xvlog.exe'), env: { TEST_LINT: 'xsim' } }];
  await h.linter.run();
  assert.equal(h.discoveries.length, 2);
  assert.equal(h.linter.lastResult.backend, 'xsim');
  assert.equal(h.calls[1].step.executable, h.discovered[0].executable);
  assert.equal(h.calls[1].options.env.TEST_LINT, 'xsim');
  assert.equal(h.stateUpdates.length, 0);
  assert.ok(h.calls.every(call => !call.step.executable.includes('do-not-run')));
});

test('a persisted tool preference survives reconstruction and falls back when PATH no longer contains it', async t => {
  const saved = new Map([['lint.enabled', true]]);
  const first = await harness(t, {}, saved);
  first.document();
  first.discovered.push({ backend: 'xsim', executable: path.join(first.root, 'xvlog.exe'), env: {} });
  first.pick = async items => items.find(item => item.value === 'xsim');
  await first.linter.selectTool();
  assert.equal(saved.get('lint.preferredBackend'), 'xsim');
  await first.linter.dispose();
  const second = await harness(t, {}, saved);
  second.document();
  second.discovered.push({ backend: 'xsim', executable: path.join(second.root, 'xvlog.exe'), env: {} });
  await second.linter.run();
  assert.equal(second.linter.lastResult.backend, 'xsim');
  second.discovered = second.discovered.filter(tool => tool.backend !== 'xsim');
  await second.linter.run();
  assert.equal(second.linter.lastResult.backend, 'iverilog');
  assert.ok(second.output.lines.some(line => /未找到 xvlog.*使用 iverilog/.test(line)));
  assert.equal(saved.get('lint.preferredBackend'), 'xsim', 'temporary PATH loss does not erase the saved preference');
  second.pick = async items => items.find(item => item.value === 'auto');
  await second.linter.selectTool();
  assert.equal(saved.get('lint.preferredBackend'), 'auto');
});

test('empty PATH discovery reports an incomplete check but still offers automatic and manual tool selection', async t => {
  const h = await harness(t); h.document();
  h.discovered = [];
  await h.linter.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.linter.lastResult.backend, 'auto');
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.match(h.status.text, /未完成/);
  assert.equal(h.collection.entries.size, 1);
  await h.linter.selectTool();
  assert.deepEqual(h.choices[0].items.map(item => item.value), ['auto', 'manual']);
  assert.equal(h.stateUpdates.length, 0);
  assert.match(h.linter.lastResult.message, /PATH/);
});

test('tool discovery returning after disposal cannot show a menu or update state', async t => {
  const h = await harness(t), pending = deferred();
  h.discover = () => pending.promise;
  const selecting = h.linter.selectTool();
  await h.linter.dispose();
  pending.resolve(h.discovered);
  await selecting;
  assert.equal(h.choices.length, 0);
  assert.equal(h.stateUpdates.length, 0);
});

async function manualXvlog(h) {
  const root = path.join(h.root, 'Vivado manual space');
  const executable = process.platform === 'win32' ? path.join(root, 'bin', 'unwrapped', 'win64.o', 'xvlog.exe') : path.join(root, 'bin', 'xvlog');
  await fs.mkdir(path.dirname(executable), {recursive: true});
  await fs.writeFile(executable, 'fixture only; process execution is intercepted');
  const requested = process.platform === 'win32' ? path.join(root, 'bin', 'xvlog.bat') : executable;
  if (requested !== executable) await fs.writeFile(requested, '@echo fixture must not execute');
  return {root, executable, requested};
}

test('manual xvlog selection works with empty PATH discovery and persists without settings writes', async t => {
  const saved = new Map([['lint.enabled', true]]), h = await harness(t, {}, saved);
  const tool = await manualXvlog(h);
  h.discovered = [];
  h.pick = async items => items.find(item => item.value === 'manual') || items.find(item => item.value === 'xsim');
  h.openDialog = async () => [h.vscode.Uri.file(tool.requested)];
  await h.linter.selectTool();
  assert.deepEqual(saved.get('lint.manualTool'), {backend: 'xsim', path: tool.requested});
  assert.equal(h.dialogs[0].canSelectFolders, false);
  assert.equal(h.calls.length, 0, 'selection validates a path without compiling');
  assert.equal(h.snapshots.at(-1).tool, 'xvlog');
  assert.equal(h.snapshots.at(-1).toolPath, tool.requested);
  await h.linter.dispose();
  const restored = await harness(t, {}, saved);
  restored.discover = async () => { throw Error('manual selection must not search PATH'); };
  const document = restored.document();
  await restored.linter.run(document);
  assert.equal(restored.calls[0].step.executable, tool.executable);
  assert.equal(restored.calls[0].step.args[0], '--sv');
  assert.equal(restored.linter.lastResult.backend, 'xsim');
  assert.equal(restored.linter.getSnapshot().toolPath, tool.executable);
  assert.equal(restored.output.shows, 0, 'running from the sidebar must not open the bottom output panel');
  restored.linter.showOutput();
  assert.equal(restored.output.shows, 1);
});

test('invalid or cancelled manual selection preserves the previous tool and never runs a compiler', async t => {
  const manual = {backend: 'iverilog', path: process.execPath};
  const h = await harness(t, {}, new Map([['lint.enabled', true], ['lint.manualTool', manual]]));
  h.pick = async items => items.find(item => item.value === 'xsim');
  h.openDialog = async () => [h.vscode.Uri.file(path.join(h.root, 'missing', 'xvlog.exe'))];
  await h.linter.selectManualTool();
  assert.deepEqual(h.stateValues.get('lint.manualTool'), manual);
  assert.equal(h.stateUpdates.length, 0);
  assert.match(h.warnings.at(-1), /工具路径不可用/);
  h.openDialog = async () => undefined;
  await h.linter.selectManualTool();
  h.pick = async () => undefined;
  await h.linter.selectManualTool();
  assert.equal(h.stateUpdates.length, 0);
  assert.equal(h.calls.length, 0);
});

test('lost manual tool reports incomplete instead of silently using a PATH tool', async t => {
  const manual = {backend: 'xsim', path: path.join(os.tmpdir(), 'missing-manual-vivado', 'xvlog.exe')};
  const h = await harness(t, {}, new Map([['lint.enabled', true], ['lint.manualTool', manual]]));
  h.document();
  await h.linter.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.discoveries.length, 0);
  assert.equal(h.linter.lastResult.backend, 'xsim');
  assert.equal(h.linter.lastResult.unavailable, true);
  assert.equal(h.snapshots.at(-1).unavailable, true);
  assert.equal(h.snapshots.at(-1).diagnostics[0].severity, 'warning');
  const summary = h.output.lines.slice(h.output.lines.lastIndexOf('\n=== 本次检查汇总 ===')).join('\n');
  assert.match(summary, /检查未完成原因/);
  assert.ok(!summary.includes('无错误。') && !summary.includes('无警告。'));
  assert.deepEqual(h.stateValues.get('lint.manualTool'), manual);
});

test('automatic and PATH tool choices clear manual priority without touching old configuration', async t => {
  const h = await harness(t, {}, new Map([['lint.manualTool', {backend: 'iverilog', path: process.execPath}]]));
  h.pick = async items => items.find(item => item.value === 'auto');
  await h.linter.selectTool();
  assert.equal(h.stateValues.has('lint.manualTool'), false);
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'auto');
  assert.equal(h.linter.getSnapshot().tool, '自动选择');
  h.stateValues.set('lint.manualTool', {backend: 'iverilog', path: process.execPath});
  h.pick = async items => items.find(item => item.value === 'iverilog');
  await h.linter.selectTool();
  assert.equal(h.stateValues.has('lint.manualTool'), false);
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'iverilog');
});

test('an older manual file dialog cannot overwrite a newer PATH choice or a disposed controller', async t => {
  const h = await harness(t), dialog = deferred();
  h.pick = async items => items.find(item => item.value === 'iverilog');
  h.openDialog = () => dialog.promise;
  const old = h.linter.selectManualTool();
  await until(() => h.dialogs.length === 1);
  h.pick = async items => items.find(item => item.value === 'auto');
  await h.linter.selectTool();
  const updates = h.stateUpdates.length;
  dialog.resolve([h.vscode.Uri.file(process.execPath)]);
  await old;
  assert.equal(h.stateUpdates.length, updates);
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'auto');
  assert.equal(h.stateValues.has('lint.manualTool'), false);
  const late = deferred(); h.openDialog = () => late.promise;
  h.pick = async items => items.find(item => item.value === 'iverilog');
  const pending = h.linter.selectManualTool();
  await until(() => h.dialogs.length === 2);
  await h.linter.dispose();
  late.resolve([h.vscode.Uri.file(process.execPath)]);
  await pending;
  assert.equal(h.stateUpdates.length, updates);
});

test('side snapshots and final log groups reflect only current diagnostics and clear on edit or disable', async t => {
  const h = await harness(t), document = h.document();
  h.process = async () => ({code: 1, output: [
    `${document.uri.fsPath}:4: warning: implicit wire`,
    `${document.uri.fsPath}:8: syntax error`,
    `${document.uri.fsPath}:2: : It was declared here as a net.`
  ].join('\n')});
  await h.linter.run(document);
  const snapshot = h.linter.getSnapshot();
  assert.deepEqual(snapshot.diagnostics.map(item => item.severity), ['warning', 'error', 'info']);
  const summary = h.output.lines.slice(h.output.lines.lastIndexOf('\n=== 本次检查汇总 ===')).join('\n');
  assert.ok(summary.indexOf('错误（1）') < summary.indexOf('警告（1）'));
  assert.ok(summary.indexOf('syntax error') < summary.indexOf('警告（1）'));
  assert.match(summary, /:8:1: syntax error/);
  assert.match(summary, /:4:1: implicit wire/);
  assert.match(summary, /信息（1）/);
  snapshot.diagnostics[0].message = 'outside mutation';
  assert.notEqual(h.linter.getSnapshot().diagnostics[0].message, 'outside mutation');
  h.events.change.fire({document});
  assert.equal(h.snapshots.at(-1).diagnostics.length, 0);
  h.process = async () => ({code: 0, output: ''});
  await h.linter.run(document);
  const clean = h.output.lines.slice(h.output.lines.lastIndexOf('\n=== 本次检查汇总 ===')).join('\n');
  assert.match(clean, /错误（0）\n无错误。/);
  assert.match(clean, /警告（0）\n无警告。/);
  assert.ok(!clean.includes('syntax error') && !clean.includes('implicit wire'));
  await h.linter.setEnabled(false);
  assert.equal(h.snapshots.at(-1).enabled, false);
  assert.equal(h.snapshots.at(-1).diagnostics.length, 0);
});

test('an accepted automatic choice finishes clearing the manual override when a newer menu is cancelled', async t => {
  const h = await harness(t, {}, new Map([['lint.enabled', true], ['lint.manualTool', {backend: 'iverilog', path: process.execPath}]]));
  const updating = deferred(), release = deferred(), update = h.state.update;
  h.state.update = async (name, value) => {
    await update(name, value);
    if (name === 'lint.preferredBackend') { updating.resolve(); await release.promise; }
  };
  h.pick = async items => items.find(item => item.value === 'auto');
  const accepted = h.linter.selectTool();
  await updating.promise;
  h.pick = async () => undefined;
  await h.linter.selectTool();
  release.resolve();
  await accepted;
  assert.equal(h.stateValues.get('lint.preferredBackend'), 'auto');
  assert.equal(h.stateValues.has('lint.manualTool'), false, 'opening then cancelling a newer menu cannot leave a half-applied choice');
  assert.equal(h.linter.getSnapshot().tool, '自动选择');
});

test('summary separately repeats explicit unlocated errors and warnings without changing source diagnostics', async t => {
  const h = await harness(t), document = h.document();
  const globalError = 'error: Invalid timescale directive', globalWarning = 'warning: global tool warning';
  h.process = async () => ({code: 1, output: [globalError, globalWarning,
    `${document.uri.fsPath}:4: warning: located warning`, `${document.uri.fsPath}:8: error: located error`,
    'warning: Some design elements have no explicit time unit and/or',
    '       : time precision. This may cause confusing timing results.'].join('\n')});
  await h.linter.run(document);
  assert.equal(h.linter.lastResult.errors, 1);
  assert.equal(h.linter.lastResult.warnings, 1);
  assert.equal(h.linter.getSnapshot().diagnostics.length, 2);
  const summary = h.output.lines.slice(h.output.lines.lastIndexOf('\n=== 本次检查汇总 ===')).join('\n');
  assert.match(summary, /未定位错误（1）\nerror: Invalid timescale directive/);
  assert.match(summary, /未定位警告（1）\nwarning: global tool warning/);
  assert.equal(summary.split('located error').length - 1, 1);
  assert.equal(summary.split('located warning').length - 1, 1);
  assert.ok(!summary.includes('no explicit time unit'));
  h.process = async () => { const error = Error('timeout'); error.output = globalWarning; throw error; };
  await h.linter.run(document);
  const failed = h.output.lines.slice(h.output.lines.lastIndexOf('\n=== 本次检查汇总 ===')).join('\n');
  assert.match(failed, /未定位警告（1）/);
  assert.match(failed, /检查未完成原因：/);
  assert.ok(!failed.includes(globalError), 'a failed later run must not copy prior tool output');
  assert.ok(!failed.includes('无错误。'));
});
