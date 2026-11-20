'use strict';
const path = require('node:path');

// Definition queries return a virtual location without opening UI. Only an
// explicit navigation opens this read-only page, including native Ctrl+click.
class CandidatePages {
  constructor(vscode, app) {
    this.vscode = vscode; this.app = app; this.pages = new Map(); this.serial = 0;
    const selector = {scheme: 'fpga-candidates'};
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(selector.scheme, {provideTextDocumentContent: uri =>
        this.pages.get(uri.toString())?.text || '// 候选列表已过期，请从源码重新查询。'}),
      vscode.languages.registerDefinitionProvider(selector, {provideDefinition: (doc, pos) => this.target(doc.uri, pos.line)}),
      vscode.languages.registerCodeLensProvider(selector, {provideCodeLenses: doc => {
        const page = this.pages.get(doc.uri.toString());
        return page ? page.rows.map((row, i) => new vscode.CodeLens(this.range(i + 2), {
          title: `跳转到源码 · ${row.description}`, command: 'fpgaWorkbench.openCandidate', arguments: [doc.uri.toString(), i + 2]
        })) : [];
      }}),
      vscode.commands.registerCommand('fpgaWorkbench.openCandidate', async (id, line) => {
        const target = this.target(vscode.Uri.parse(id), line);
        if (target) await vscode.window.showTextDocument(target.uri, {selection: target.range, preview: true});
        else vscode.window.showInformationMessage('候选列表已过期，请从源码重新查询。');
      })
    ];
  }
  range(line) { const p = new this.vscode.Position(line, 0); return new this.vscode.Range(p, p); }
  target(uri, line) {
    const page = this.pages.get(uri.toString());
    if (!page || !this.app.isCurrent(page.revision) || this.app.sourceRevision !== page.sources) return undefined;
    return page.rows[line - 2]?.target;
  }
  location(items) {
    const app = this.app, vscode = this.vscode, rows = [], seen = new Set();
    let contextual = false;
    for (const item of items || []) {
      const uri = item.targetUri || item.uri, range = item.targetSelectionRange || item.range || item.targetRange;
      if (!uri || !range) continue;
      const source = app.candidateText(uri);
      const summaries = source === undefined ? [] : app.index.candidateSummaries(uri.fsPath, app.offset(source, range.start), app.offset(source, range.end));
      contextual ||= summaries.length > 0;
      const candidates = summaries.length ? summaries.map(summary => ({label: summary.label, target: app.location(summary)}))
        : [{label: source === undefined ? path.basename(uri.fsPath || uri.path || '定义')
          : source.split(/\r\n|\n|\r/)[range.start.line]?.trim() || '定义', target: new vscode.Location(uri, range)}];
      for (const row of candidates) {
        const identity = JSON.stringify([row.target.uri.toString(), row.target.range, row.label]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        rows.push({...row, label: row.label.replace(/[\r\n]/g, ' '),
          description: `${path.basename(row.target.uri.fsPath || row.target.uri.path)}:${row.target.range.start.line + 1}`});
      }
    }
    if (!rows.length || (rows.length === 1 && !contextual)) return undefined;
    const identity = JSON.stringify([app.revision, app.sourceRevision, rows.map(row => [row.label, row.target.uri.toString(), row.target.range])]);
    for (const page of this.pages.values()) if (page.identity === identity) return new vscode.Location(page.uri, this.range(2));
    const uri = vscode.Uri.parse(`fpga-candidates:/FPGA-candidates-${++this.serial}.v`);
    const text = '// FPGA 候选列表：点击“跳转到源码”，或 Ctrl+左键点击候选行。\n// 此页只读。源码变更后请重新查询。\n' + rows.map(row => row.label).join('\n') + '\n';
    this.pages.set(uri.toString(), {uri, text, rows, identity, revision: app.revision, sources: app.sourceRevision});
    while (this.pages.size > 64) this.pages.delete(this.pages.keys().next().value);
    return new vscode.Location(uri, this.range(2));
  }
  dispose() { for (const subscription of this.subscriptions) subscription.dispose(); this.pages.clear(); }
}
module.exports = {CandidatePages};
