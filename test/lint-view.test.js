'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {LintView} = require('../src/lint-view');

function harness(t) {
  const h = {changes: 0, viewsDisposed: 0, eventsDisposed: 0};
  const vscode = {
    EventEmitter: class {
      constructor() { this.event = () => ({dispose() {}}); }
      fire() { h.changes++; }
      dispose() { h.eventsDisposed++; }
    },
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, {label, collapsibleState}); } },
    TreeItemCollapsibleState: {None: 0, Collapsed: 1, Expanded: 2},
    ThemeIcon: class { constructor(id, color) { Object.assign(this, {id, color}); } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Range: class { constructor(line, column, endLine, endColumn) {
      this.start = {line, character: column}; this.end = {line: endLine, character: endColumn};
    } },
    Uri: {file: file => ({scheme: 'file', fsPath: file})},
    window: {createTreeView(id, options) {
      h.id = id; h.provider = options.treeDataProvider;
      return {dispose() { h.viewsDisposed++; }};
    }}
  };
  h.view = new LintView(vscode);
  h.group = severity => h.view.getChildren().find(item => item.severity === severity);
  t.after(() => h.view.dispose());
  return h;
}

test('Lint is a separate FPGA view with discoverable status and tool controls', t => {
  const h = harness(t), roots = h.view.getChildren();
  assert.equal(h.id, 'fpgaWorkbench.lint');
  assert.equal(h.provider, h.view);
  assert.deepEqual(roots.map(item => item.label), ['状态', '工具', '错误 (0)', '警告 (0)']);
  assert.equal(roots[0].description, '已关闭');
  assert.equal(roots[0].command.command, 'fpgaWorkbench.configureLint');
  assert.equal(roots[1].description, '自动选择');
  assert.equal(roots[1].command.command, 'fpgaWorkbench.selectLintTool');
  assert.equal(h.group('error').collapsibleState, 0);
  assert.equal(h.group('warning').collapsibleState, 0);
  assert.equal(h.view.getTreeItem(roots[0]), roots[0]);
});

test('errors and warnings remain separate, with file grouping and optional information', t => {
  const h = harness(t);
  h.view.update({enabled: true, status: 'xvlog 2 错误 / 1 警告', tool: 'xvlog', toolPath: 'C:/Vivado/bin/xvlog.bat', diagnostics: [
    {file: 'C:/rtl/a/top.v', line: 8, column: 2, severity: 'error', message: 'Undefined signal'},
    {file: 'C:/rtl/b/top.v', line: 3, column: 0, severity: 'warning', message: 'Implicit wire'},
    {file: 'C:/rtl/a/top.v', line: 1, column: 4, severity: 'error', message: 'Syntax error'},
    {file: 'C:/rtl/a/top.v', line: 0, column: 0, severity: 'info', message: 'Original declaration'}
  ]});
  assert.deepEqual(h.view.getChildren().map(item => item.label), ['状态', '工具', '错误 (2)', '警告 (1)', '信息 (1)']);
  assert.equal(h.group('error').collapsibleState, 2);
  assert.equal(h.group('warning').collapsibleState, 1);
  assert.equal(h.group('error').iconPath.color.id, 'problemsErrorIcon.foreground');
  assert.equal(h.group('warning').iconPath.color.id, 'problemsWarningIcon.foreground');
  const errorFile = h.view.getChildren(h.group('error'))[0];
  const warningFile = h.view.getChildren(h.group('warning'))[0];
  assert.equal(errorFile.label, warningFile.label);
  assert.notEqual(errorFile.id, warningFile.id);
  assert.equal(errorFile.tooltip, 'C:/rtl/a/top.v');
  assert.equal(errorFile.description, '2');
  assert.deepEqual(h.view.getChildren(errorFile).map(item => item.label), ['Syntax error', 'Undefined signal']);
  assert.match(h.view.getChildren()[1].tooltip, /C:\/Vivado\/bin\/xvlog\.bat/);
});

test('diagnostic clicks open the original file at zero-based compiler location', t => {
  const h = harness(t), file = 'C:/RTL 中文/top.v';
  h.view.update({enabled: true, status: '完成', tool: 'xvlog', diagnostics: [
    {file, line: 14, column: 6, severity: 'error', code: 'VRFC 10-2989', message: 'Unknown identifier\nCheck spelling'}
  ]});
  const node = h.view.getChildren(h.view.getChildren(h.group('error'))[0])[0];
  assert.equal(node.description, '15:7 · VRFC 10-2989');
  assert.equal(node.label, 'Unknown identifier Check spelling');
  assert.equal(node.command.command, 'vscode.open');
  assert.equal(node.command.arguments[0].fsPath, file);
  assert.deepEqual(node.command.arguments[1].selection.start, {line: 14, character: 6});
  assert.deepEqual(node.command.arguments[1].selection.end, {line: 14, character: 7});
  assert.equal(node.command.arguments[1].preview, true);
  assert.match(node.tooltip, /第 15 行，第 7 列/);
});

test('clearing replaces all groups and rejects children from an obsolete result', t => {
  const h = harness(t);
  const input = {file: 'C:/rtl/top.v', line: 0, column: 0, severity: 'error', message: 'Old error'};
  h.view.update({enabled: true, status: '完成', tool: 'iverilog', diagnostics: [input, {...input}]});
  const oldGroup = h.group('error'), oldFile = h.view.getChildren(oldGroup)[0];
  const oldNodes = h.view.getChildren(oldFile);
  assert.equal(oldNodes.length, 2);
  assert.notEqual(oldNodes[0].id, oldNodes[1].id, 'duplicate diagnostics need distinct tree identities');
  input.message = 'Changed elsewhere';
  assert.equal(oldNodes[0].label, 'Old error', 'snapshot data is not held by reference');
  h.view.update({enabled: false, status: '已关闭', tool: 'iverilog', diagnostics: []});
  assert.equal(h.group('error').count, 0);
  assert.equal(h.group('warning').count, 0);
  assert.deepEqual(h.view.getChildren(oldGroup), []);
  assert.deepEqual(h.view.getChildren(oldFile), []);
  assert.equal(h.view.getChildren()[0].description, '已关闭');
  assert.equal(h.changes, 3);
});

test('unavailable tools stay visibly incomplete and unlocated diagnostics cannot navigate', t => {
  const h = harness(t);
  h.view.update({enabled: true, status: 'xvlog 未完成', tool: 'xvlog', unavailable: true, diagnostics: [
    {severity: 'warning', message: '未找到检查工具。'}
  ]});
  const state = h.view.getChildren()[0];
  assert.equal(state.description, 'xvlog 未完成');
  assert.equal(state.iconPath.id, 'warning');
  assert.equal(h.group('error').count, 0);
  assert.equal(h.group('warning').count, 1);
  const unlocated = h.view.getChildren(h.view.getChildren(h.group('warning'))[0])[0];
  assert.equal(unlocated.description, '未定位');
  assert.equal(unlocated.command, undefined);
});

test('disposing releases the view and emitter once and ignores later updates', t => {
  const h = harness(t);
  const previous = h.view.getChildren()[0], changes = h.changes;
  h.view.dispose(); h.view.dispose();
  h.view.update({enabled: true, diagnostics: [{file: 'C:/rtl/top.v', severity: 'error', message: 'Late result'}]});
  assert.equal(h.viewsDisposed, 1);
  assert.equal(h.eventsDisposed, 1);
  assert.equal(h.changes, changes);
  assert.deepEqual(h.view.getChildren(), []);
  assert.deepEqual(h.view.getChildren(previous), []);
});
