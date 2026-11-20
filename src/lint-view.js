'use strict';

const path = require('node:path');

const fileApi = file => /^(?:[a-z]:[\\/]|\\\\)/i.test(file) ? path.win32 : path;
const fileKey = file => {
  const api = fileApi(file), normalized = api.normalize(file);
  return api === path.win32 || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const coordinate = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const severityOf = value => value === 'error' || value === 'warning' ? value : 'info';

class LintView {
  constructor(vscode) {
    this.vscode = vscode;
    this.disposed = false;
    this.generation = 0;
    this.change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.change.event;
    this.roots = [];
    this.view = vscode.window.createTreeView('fpgaWorkbench.lint', {treeDataProvider: this});
    this.update({enabled: false, status: '已关闭', tool: '自动选择', diagnostics: []});
  }

  item(label, id, kind, children = [], expanded = false) {
    const states = this.vscode.TreeItemCollapsibleState;
    const item = new this.vscode.TreeItem(label, children.length ? expanded ? states.Expanded : states.Collapsed : states.None);
    Object.assign(item, {id, kind, children, generation: this.generation});
    return item;
  }

  icon(severity) {
    const kind = severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info';
    const color = severity === 'error' ? 'problemsErrorIcon.foreground'
      : severity === 'warning' ? 'problemsWarningIcon.foreground' : 'problemsInfoIcon.foreground';
    return new this.vscode.ThemeIcon(kind, new this.vscode.ThemeColor(color));
  }

  update(snapshot = {}) {
    if (this.disposed) return;
    ++this.generation;
    const enabled = snapshot.enabled === true;
    const status = this.item('状态', 'lint:status', 'status');
    status.description = snapshot.status || (enabled ? '就绪' : '已关闭');
    status.tooltip = '点击切换语法检查开关。';
    status.iconPath = snapshot.unavailable ? this.icon('warning') : new this.vscode.ThemeIcon(enabled ? 'checklist' : 'circle-slash');
    status.command = {command: 'fpgaWorkbench.configureLint', title: '语法检查开关与工具'};
    const tool = this.item('工具', 'lint:tool', 'tool');
    tool.description = snapshot.tool || '自动选择';
    tool.tooltip = snapshot.toolPath ? `${tool.description}\n${snapshot.toolPath}` : '点击选择语法检查工具。';
    tool.iconPath = new this.vscode.ThemeIcon('tools');
    tool.command = {command: 'fpgaWorkbench.selectLintTool', title: '选择语法检查工具'};
    const diagnostics = (snapshot.diagnostics || []).map(item => ({...item, severity: severityOf(item.severity)}));
    const groups = ['error', 'warning', 'info'].filter(severity => severity !== 'info' || diagnostics.some(item => item.severity === 'info')).map(severity => {
      const items = diagnostics.filter(item => item.severity === severity);
      const files = new Map();
      for (const diagnostic of items) {
        const file = typeof diagnostic.file === 'string' && diagnostic.file ? diagnostic.file : '';
        const identity = file ? fileKey(file) : 'unlocated';
        if (!files.has(identity)) files.set(identity, {file, diagnostics: []});
        files.get(identity).diagnostics.push(diagnostic);
      }
      const children = [...files.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([identity, file]) => {
        const fileId = `lint:${severity}:file:${identity}`;
        const leaves = file.diagnostics.slice().sort((a, b) => coordinate(a.line) - coordinate(b.line) || coordinate(a.column) - coordinate(b.column)).map((diagnostic, index) => {
          const line = coordinate(diagnostic.line), column = coordinate(diagnostic.column);
          const message = String(diagnostic.message || '未提供诊断文本。');
          const leaf = this.item(message.replace(/[\r\n]+/g, ' '), `${fileId}:${index}`, 'diagnostic');
          leaf.severity = severity;
          leaf.description = file.file ? `${line + 1}:${column + 1}${diagnostic.code ? ` · ${diagnostic.code}` : ''}` : '未定位';
          leaf.tooltip = file.file ? `${message}\n\n${file.file}\n第 ${line + 1} 行，第 ${column + 1} 列` : `${message}\n\n未提供源文件位置。`;
          leaf.iconPath = this.icon(severity);
          if (file.file) {
            const selection = new this.vscode.Range(line, column, line, column + 1);
            leaf.command = {command: 'vscode.open', title: '打开诊断位置',
              arguments: [this.vscode.Uri.file(file.file), {selection, preview: true}]};
          }
          return leaf;
        });
        const node = this.item(file.file ? fileApi(file.file).basename(file.file) : '未定位', fileId, 'file', leaves, true);
        node.severity = severity;
        node.file = file.file;
        node.description = String(leaves.length);
        node.tooltip = file.file || '未提供源文件位置。';
        if (file.file) node.resourceUri = this.vscode.Uri.file(file.file);
        node.iconPath = new this.vscode.ThemeIcon('file-code');
        return node;
      });
      const label = severity === 'error' ? '错误' : severity === 'warning' ? '警告' : '信息';
      const group = this.item(`${label} (${items.length})`, `lint:${severity}`, 'severity', children, severity === 'error');
      group.severity = severity;
      group.count = items.length;
      group.iconPath = this.icon(severity);
      return group;
    });
    this.roots = [status, tool, ...groups];
    this.change.fire(undefined);
  }

  getTreeItem(element) { return element; }
  getChildren(element) {
    if (this.disposed) return [];
    return element ? element.generation === this.generation ? element.children || [] : [] : this.roots;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.roots = [];
    this.view.dispose();
    this.change.dispose();
  }
}

module.exports = {LintView};
