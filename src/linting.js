'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {buildLintPlan, parseLintOutput, filterLintOutput, unlocatedLintMessages} = require('./lint-tools');
const {discoverLintTools, resolveLintExecutable, resolveLintCompanions, runLintProcess} = require('./lint-process');

const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const supported = document => document?.uri?.scheme === 'file' && /\.(v|sv|vh|svh|vhd|vhdl)$/i.test(document.uri.fsPath);
const source = file => /\.(v|sv|vhd|vhdl)$/i.test(file);
const languageOf = file => /\.vhdl?$/i.test(file) ? 'vhdl' : 'verilog';
const languageName = language => ({verilog: 'Verilog/SystemVerilog', vhdl: 'VHDL', all: '全部 HDL'})[language] || '全部 HDL';
const unique = values => [...new Map(values.map(value => [canonical(value), value])).values()];
const toolName = backend => ({auto: '自动选择', iverilog: 'iverilog', xsim: 'xvlog', modelsim: 'vlog'})[backend] || backend;
const within = (file, dir) => { const relative = path.relative(dir, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

function targetContains(target, file) {
  return target.files.some(item => canonical(item) === canonical(file)) || canonical(target.anchor) === canonical(file) ||
    (target.language !== 'vhdl' && /\.(vh|svh)$/i.test(file) && target.includeDirs.some(dir => within(file, dir)));
}

function lintTarget(document, project, configuration, workspaceFolder, preferProject = false) {
  const documentPath = supported(document) ? path.resolve(document.uri.fsPath) : undefined;
  // Navigation remains Verilog-only. Lint uses XPR metadata independently so
  // VHDL, its logical library and language revision are not lost.
  const entries = project ? (Array.isArray(project.files)
    ? project.files.filter(file => file.enabled && file.selected && source(file.path || file.rawPath || ''))
    : (project.sourceFiles || []).filter(source).map(file => ({path: file}))) : [];
  const projectPaths = [...entries.map(file => file.path).filter(Boolean), ...(project?.sourceFiles || [])];
  const isMember = project && documentPath && (projectPaths.some(file => canonical(file) === canonical(documentPath)) ||
    (/\.(vh|svh)$/i.test(documentPath) && [project.root, ...(project.includeDirs || []), ...projectPaths.map(file => path.dirname(file))].some(dir => within(documentPath, dir))));
  const useProject = !!project && (preferProject || isMember);
  // Keep project dependencies of the current language. A Verilog editor must
  // not request a VHDL compiler merely because its XPR also contains VHDL.
  // Without a member editor, a manual project check still covers both languages.
  const language = documentPath && (!useProject || isMember) ? languageOf(documentPath) : 'all';
  const candidates = useProject ? entries : documentPath && source(documentPath) ? [{path: documentPath}] : [];
  const selected = candidates.filter(file => language === 'all' || languageOf(file.path || file.rawPath) === language);
  const excludedFiles = unique(candidates.filter(file => language !== 'all' && languageOf(file.path || file.rawPath) !== language).map(file => file.path || file.rawPath));
  // Preserve duplicate metadata so the plan can reject conflicting XPR entries.
  const sourceEntries = selected.filter(file => file.path).map(file => ({...file, path: path.resolve(file.path)}));
  const files = unique(sourceEntries.map(file => file.path));
  const anchor = useProject ? (isMember ? documentPath : files[0] || project.path) : documentPath;
  const base = useProject ? project.root : (workspaceFolder?.uri.fsPath || path.dirname(anchor));
  const includeDirs = unique([
    base,
    ...(useProject ? project.includeDirs || [] : configuration.get('extraIncludeDirs', []).map(dir => path.resolve(base, dir))),
    ...files.map(file => path.dirname(file)), path.dirname(anchor)
  ]);
  return {anchor, files, sourceEntries, language, excludedFiles, includeDirs, defines: useProject ? project.defines || [] : configuration.get('extraDefines', []),
    missingFiles: selected.filter(file => !file.path || file.exists === false).map(file => file.path || file.rawPath),
    cwd: base, projectPath: useProject ? project.path : undefined, top: useProject ? project.top : undefined};
}

class HdlLinter {
  constructor(vscode, getProject, options = {}) {
    this.vscode = vscode;
    this.getProject = getProject;
    this.discoverTools = options.discoverTools || discoverLintTools;
    this.resolveTool = options.resolveTool || resolveLintExecutable;
    this.resolveCompanions = options.resolveCompanions || resolveLintCompanions;
    this.onDidChange = options.onDidChange || (() => {});
    this.selectionRevision = 0;
    this.selectionQueue = Promise.resolve();
    const memory = new Map();
    this.state = options.state || {get: (name, fallback) => memory.has(name) ? memory.get(name) : fallback,
      update: async (name, value) => { memory.set(name, value); }};
    this.runProcess = options.runProcess || runLintProcess;
    this.delay = options.delay ?? 500;
    this.generation = 0;
    this.loading = false;
    this.disposed = false;
    this.queue = Promise.resolve();
    this.diagnostics = vscode.languages.createDiagnosticCollection('fpga-workbench-lint');
    this.output = vscode.window.createOutputChannel('FPGA Workbench · Lint');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 14);
    this.status.command = 'fpgaWorkbench.configureLint';
    this.subscriptions = [
      vscode.workspace.onDidSaveTextDocument(document => {
        if (supported(document) && this.configuration(document).get('lint.runOnSave', true)) this.schedule(document);
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.target && supported(event.document) && targetContains(this.target, event.document.uri.fsPath)) {
          this.invalidate(); this.setStatus('待保存', '编辑后重新保存，更新语法检查结果。');
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('fpgaWorkbench')) this.reset(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset()),
      vscode.window.onDidChangeActiveTextEditor?.(() => {
        if (!this.abortController && !this.timer) this.showIdleStatus();
      })
    ].filter(Boolean);
    this.showIdleStatus();
  }
  configuration(document = this.vscode.window.activeTextEditor?.document) { return this.vscode.workspace.getConfiguration('fpgaWorkbench', document?.uri); }
  isEnabled() { return this.state.get('lint.enabled', false) === true; }
  getSnapshot() {
    const manual = this.state.get('lint.manualTool');
    const tool = this.currentTool || (manual ? {backend: manual.backend, executable: manual.path} : {backend: this.state.get('lint.preferredBackend', 'auto')});
    return {enabled: this.isEnabled(), status: this.displayStatus || (this.isEnabled() ? '就绪' : '已关闭'),
      tool: toolName(tool.backend || 'auto'), toolPath: tool.executable,
      diagnostics: (this.lastResult?.diagnostics || []).map(item => ({...item})), unavailable: !!this.lastResult?.unavailable};
  }
  notify() { if (!this.disposed) this.onDidChange(this.getSnapshot()); }
  showIdleStatus() {
    this.setStatus(this.isEnabled() ? '就绪' : '已关闭', '点击切换语法检查开关。支持 PATH 自动查找和手动路径。');
  }
  async setEnabled(enabled) {
    if (this.disposed) return;
    this.invalidate();
    await this.state.update('lint.enabled', !!enabled);
    if (!this.disposed) this.reset();
  }
  async selectTool() {
    if (this.disposed) return;
    const revision = ++this.selectionRevision;
    const tools = await this.discoverTools();
    if (this.disposed || revision !== this.selectionRevision) return;
    const selected = await this.vscode.window.showQuickPick([
      {label: '自动选择', value: 'auto', description: 'iverilog → xvlog（Vivado）→ vlog（ModelSim）'},
      ...tools.map(tool => ({label: toolName(tool.backend), value: tool.backend, description: tool.executable})),
      {label: '手动选择工具路径', value: 'manual', description: '选择 iverilog、Vivado xvlog 或 ModelSim vlog'}
    ], {title: '选择语法检查工具'});
    if (!selected || this.disposed || revision !== this.selectionRevision) return;
    if (selected.value === 'manual') return this.selectManualTool(revision);
    if (selected.value !== 'auto' && !tools.some(tool => tool.backend === selected.value)) return;
    return this.commitToolSelection(revision, undefined, selected.value);
  }
  async selectManualTool(revision = ++this.selectionRevision) {
    if (this.disposed || revision !== this.selectionRevision) return;
    const selected = await this.vscode.window.showQuickPick([
      {label: 'iverilog', value: 'iverilog', description: 'Icarus Verilog'},
      {label: 'xvlog', value: 'xsim', description: 'Vivado'},
      {label: 'vlog', value: 'modelsim', description: 'ModelSim / Questa'}
    ], {title: '手动选择语法检查工具'});
    if (!selected || this.disposed || revision !== this.selectionRevision || !['iverilog', 'xsim', 'modelsim'].includes(selected.value)) return;
    const picked = await this.vscode.window.showOpenDialog({title: `选择 ${toolName(selected.value)} 工具文件`,
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      ...(process.platform === 'win32' ? {filters: {'工具文件': selected.value === 'xsim' ? ['bat', 'exe'] : ['exe']}} : {})});
    if (!picked?.length || this.disposed || revision !== this.selectionRevision) return;
    const requested = picked[0].fsPath;
    try {
      await this.resolveTool(selected.value, requested);
      if (this.disposed || revision !== this.selectionRevision) return;
      return this.commitToolSelection(revision, {backend: selected.value, path: requested});
    } catch (error) {
      if (!this.disposed && revision === this.selectionRevision) this.vscode.window.showWarningMessage(`工具路径不可用：${error.message}`);
    }
  }
  commitToolSelection(revision, manual, preferred) {
    const commit = async () => {
      const current = () => !this.disposed && revision === this.selectionRevision;
      if (!current()) return;
      this.invalidate();
      if (manual) await this.state.update('lint.manualTool', manual);
      else {
        await this.state.update('lint.preferredBackend', preferred);
        if (this.state.get('lint.manualTool') !== undefined) await this.state.update('lint.manualTool', undefined);
      }
      // Once a queued choice begins, finish both state writes. Opening and then
      // cancelling a newer menu must not leave an old manual override behind.
      if (!this.disposed) this.reset();
    };
    this.selectionQueue = this.selectionQueue.catch(() => {}).then(commit);
    return this.selectionQueue;
  }
  async configure() {
    if (this.disposed) return;
    const enabled = this.isEnabled();
    const selected = await this.vscode.window.showQuickPick([
      {label: enabled ? '关闭语法检查' : '启用语法检查', action: 'toggle', description: enabled ? '取消任务并清除诊断' : '启用后保存文件开始检查'},
      {label: '选择检查工具', action: 'tools', description: this.getSnapshot().tool},
      {label: '检查当前文件或工程', action: 'run'},
      {label: '查看检查输出', action: 'output'}
    ], {title: 'FPGA 语法检查'});
    if (!selected || this.disposed) return;
    if (selected.action === 'toggle') return this.setEnabled(!enabled);
    if (selected.action === 'run') return this.run();
    if (selected.action === 'output') return this.showOutput();
    if (selected.action === 'tools') return this.selectTool();
  }
  setStatus(text, tooltip) {
    if (this.disposed) return;
    this.status.text = `$(checklist) Lint: ${text}`;
    this.displayStatus = text;
    this.status.tooltip = tooltip;
    this.status.show();
    this.notify();
  }
  invalidate() {
    ++this.generation;
    clearTimeout(this.timer); this.timer = undefined;
    this.abortController?.abort();
    this.diagnostics.clear();
    this.lastResult = undefined;
    this.currentTool = undefined;
    this.notify();
  }
  reset() {
    this.invalidate(); this.lastDocument = undefined; this.target = undefined;
    this.showIdleStatus();
  }
  // The workbench temporarily clears its project while rebuilding the index.
  // Resume a pending saved-file check only after the replacement file list is ready.
  projectChanged(loading) {
    if (this.disposed) return;
    this.loading = loading;
    this.invalidate();
    if (!loading && this.lastDocument && !this.lastDocument.isDirty && this.configuration(this.lastDocument).get('lint.runOnSave', true)) this.schedule(this.lastDocument);
  }
  schedule(document) {
    if (this.disposed || !supported(document)) return;
    this.invalidate(); this.lastDocument = document;
    if (!this.isEnabled()) { this.setStatus('已关闭', '点击启用语法检查。'); return; }
    if (this.loading) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) void this.run(document, false);
    }, this.delay);
  }
  async run(document = this.vscode.window.activeTextEditor?.document, manual = true) {
    if (this.disposed) return;
    this.invalidate(); this.lastDocument = document;
    const project = this.getProject();
    const cfg = this.configuration(manual && project ? {uri: this.vscode.Uri.file(project.path)} : document);
    if (!this.isEnabled()) {
      this.setStatus('已关闭', '点击启用语法检查。');
      if (manual) this.vscode.window.showWarningMessage('语法检查已关闭。请在 Lint 视图或状态栏启用。');
      return;
    }
    if (this.vscode.workspace.isTrusted === false) { this.setStatus('工作区未受信任'); return; }
    if (this.loading) { this.setStatus('等待工程索引'); return; }
    if (!(manual && project) && !supported(document)) {
      if (manual) this.vscode.window.showWarningMessage('请先加载 XPR，或打开已保存的 HDL 源文件。');
      return;
    }
    const target = this.target = lintTarget(document, project, cfg, document?.uri ? this.vscode.workspace.getWorkspaceFolder(document.uri) : undefined, manual);
    if (!target.files.length && !target.missingFiles.length) {
      this.setStatus('缺少编译单元');
      this.output.appendLine('检查范围内没有 .v、.sv、.vhd 或 .vhdl 源文件。');
      return;
    }
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file' && targetContains(target, doc.uri.fsPath))) {
      this.setStatus('待保存');
      if (manual) this.vscode.window.showWarningMessage('请先保存本次检查范围内的源文件和头文件。');
      return;
    }
    const generation = this.generation;
    const preferredBackend = this.state.get('lint.preferredBackend', 'auto');
    const manualTool = this.state.get('lint.manualTool');
    const timeoutMs = cfg.get('lint.timeoutMs', 30000);
    const ignoreTimescaleWarnings = cfg.get('lint.ignoreTimescaleWarnings', true);
    const verbose = cfg.get('lint.verbose', false);
    const operation = async () => {
      if (this.disposed || generation !== this.generation) return;
      const abort = this.abortController = new AbortController();
      const current = () => !this.disposed && generation === this.generation && !abort.signal.aborted;
      let temporary, output = '';
      let backend = 'auto';
      this.setStatus(manualTool ? '检查手动工具路径' : '查找 PATH 工具', target.projectPath || target.anchor);
      this.output.appendLine(`\n检查对象：${target.projectPath || target.anchor}`);
      this.appendScope(target);
      try {
        if (target.missingFiles.length) throw new Error(`工程源文件缺失或路径无效：${target.missingFiles.join('、')}`);
        const requirements = {vhdl: target.files.some(file => /\.vhdl?$/i.test(file)), verilog: target.files.some(file => /\.(v|sv)$/i.test(file)),
          libraryMapping: target.sourceEntries.some(file => file.library && file.library.toLowerCase() !== 'work')};
        let tool;
        if (manualTool) {
          if (!['iverilog', 'xsim', 'modelsim'].includes(manualTool.backend) || typeof manualTool.path !== 'string' || !manualTool.path.trim()) throw new Error('手动工具记录无效。请重新选择工具路径。');
          backend = manualTool.backend;
          tool = {backend, ...await this.resolveTool(backend, manualTool.path)};
        } else {
          const tools = await this.discoverTools();
          if (requirements.vhdl && preferredBackend === 'auto') {
            const failures = [];
            for (const candidate of tools.filter(item => item.backend !== 'iverilog')) {
              try { tool = await this.resolveCompanions(candidate, requirements); break; }
              catch (error) { failures.push(error.message); }
            }
            if (!tool) throw new Error(failures.join('\n') || '工程包含 VHDL。请选择 Vivado xvlog 或 ModelSim vlog 工具路径。Icarus 不支持 VHDL。');
          } else tool = tools.find(item => item.backend === preferredBackend) || tools[0];
        }
        if (!current()) return;
        if (!tool) throw new Error('PATH 中未找到检查工具。请在 Lint 视图中选择工具路径。');
        backend = tool.backend;
        if ((requirements.vhdl && !tool.vhdlExecutable) || requirements.libraryMapping) tool = await this.resolveCompanions(tool, requirements);
        if (!current()) return;
        this.currentTool = tool;
        this.setStatus(`${toolName(backend)} 检查中`, tool.executable);
        this.output.appendLine(`\n[${toolName(backend)}] ${target.projectPath || target.anchor}`);
        this.output.appendLine(`工具：${tool.executable}`);
        if (tool.vhdlExecutable) this.output.appendLine(`VHDL 工具：${tool.vhdlExecutable}`);
        if (!manualTool && preferredBackend !== 'auto' && preferredBackend !== backend) this.output.appendLine(`PATH 中未找到 ${toolName(preferredBackend)}，本次自动使用 ${toolName(backend)}。`);
        this.output.appendLine(`检查范围：${target.files.length} 个源文件，${target.includeDirs.length} 个 include 目录，${target.defines.length} 个宏。`);
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-workbench-lint-'));
        if (!current()) return;
        const plan = buildLintPlan({...target, backend, executable: tool.executable, vhdlExecutable: tool.vhdlExecutable,
          mapExecutable: tool.mapExecutable, libraryExecutable: tool.libraryExecutable, workDir: temporary, ignoreTimescaleWarnings});
        for (const note of plan.notes) this.output.appendLine(note);
        let code = 0;
        for (const step of plan.steps) {
          if (!current()) return;
          if (verbose) this.output.appendLine(JSON.stringify({executable: step.executable, args: step.args, cwd: step.cwd}));
          const result = await this.runProcess(step, {signal: abort.signal, timeoutMs, env: tool.env});
          code = result.code; output += result.output + '\n';
          const visibleOutput = filterLintOutput(backend, result.output, {ignoreTimescaleWarnings});
          if (visibleOutput.trim()) this.output.appendLine(visibleOutput);
          if (code !== 0) break;
        }
        if (!current()) return;
        const diagnostics = parseLintOutput(backend, output, {cwd: temporary, files: target.files, ignoreTimescaleWarnings});
        if (code !== 0 && !diagnostics.some(item => item.severity === 'error')) {
          diagnostics.push({file: target.anchor, line: 0, column: 0, severity: 'error',
            message: `${toolName(backend)} 检查未完成（退出码 ${code}）。请查看 Lint 输出。`});
        }
        const grouped = new Map();
        for (const item of diagnostics) {
          const file = path.resolve(item.file || target.anchor);
          const range = new this.vscode.Range(Math.max(0, item.line || 0), Math.max(0, item.column || 0), Math.max(0, item.line || 0), Math.max(0, item.column || 0) + 1);
          const severity = item.severity === 'error' ? this.vscode.DiagnosticSeverity.Error : item.severity === 'warning' ? this.vscode.DiagnosticSeverity.Warning : this.vscode.DiagnosticSeverity.Information;
          const diagnostic = new this.vscode.Diagnostic(range, item.message, severity);
          diagnostic.source = `FPGA Lint (${toolName(backend)})`;
          if (item.code) diagnostic.code = item.code;
          const entry = grouped.get(canonical(file)) || {uri: this.vscode.Uri.file(file), diagnostics: []};
          entry.diagnostics.push(diagnostic); grouped.set(canonical(file), entry);
        }
        this.diagnostics.clear();
        for (const entry of grouped.values()) this.diagnostics.set(entry.uri, entry.diagnostics);
        const errors = diagnostics.filter(item => item.severity === 'error').length;
        const warnings = diagnostics.filter(item => item.severity === 'warning').length;
        this.lastResult = {backend, code, errors, warnings, diagnostics};
        this.setStatus(`${toolName(backend)} ${errors} 错误 / ${warnings} 警告`, `本次检查 ${languageName(target.language)}。此处统计已定位的诊断。无位置消息见 Lint 输出。`);
        this.output.appendLine(`诊断显示：${errors} 个错误，${warnings} 个警告。未定位消息另列于末尾。`);
        this.appendSummary(diagnostics, undefined, unlocatedLintMessages(backend, output, {cwd: temporary, files: target.files, ignoreTimescaleWarnings}));
      } catch (error) {
        if (!current()) return;
        if (error.output) this.output.appendLine(backend === 'auto' ? error.output : filterLintOutput(backend, error.output, {ignoreTimescaleWarnings}));
        const message = `语法检查未完成：${error.message}`;
        this.output.appendLine(message);
        // A missing compiler or timeout must never look like a clean source file.
        const diagnostic = new this.vscode.Diagnostic(new this.vscode.Range(0, 0, 0, 1), message, this.vscode.DiagnosticSeverity.Warning);
        diagnostic.source = `FPGA Lint (${toolName(backend)})`;
        this.diagnostics.set(this.vscode.Uri.file(target.anchor), [diagnostic]);
        const diagnostics = [{file: target.anchor, line: 0, column: 0, severity: 'warning', message}];
        this.lastResult = {backend, unavailable: true, message, diagnostics};
        this.setStatus(`${toolName(backend)} 未完成`, message);
        this.appendSummary(diagnostics, message, backend === 'auto' ? undefined : unlocatedLintMessages(backend, output + '\n' + (error.output || ''), {cwd: temporary, files: target.files, ignoreTimescaleWarnings}));
      } finally {
        if (this.abortController === abort) this.abortController = undefined;
        // mkdtemp owns this directory; never remove project paths or configured paths.
        if (temporary) await fs.rm(temporary, {recursive: true, force: true}).catch(error => this.output.appendLine(`无法清理检查临时目录：${error.message}`));
      }
    };
    this.queue = this.queue.catch(() => {}).then(operation);
    return this.queue;
  }
  appendScope(target = this.target) {
    if (!target) return;
    this.output.appendLine(`检查语言：${languageName(target.language)}。本次包含 ${target.files.length} 个源文件。`);
    if (target.excludedFiles?.length) this.output.appendLine(`本次未检查其他语言源文件：${target.excludedFiles.length} 个。不代表整个混合语言工程检查通过。`);
  }
  appendSummary(diagnostics, incomplete, unlocated = {error: [], warning: []}) {
    this.output.appendLine('\n=== 本次检查汇总 ===');
    this.appendScope();
    for (const [severity, label] of [['error', '错误'], ['warning', '警告'], ['info', '信息']]) {
      const items = diagnostics.filter(item => item.severity === severity);
      if (severity === 'info' && !items.length) continue;
      this.output.appendLine(`${label}（${items.length}）`);
      if (!items.length) this.output.appendLine(incomplete ? `检查未完成，未获得${label}列表。` : unlocated[severity]?.length ? `无已定位${label}。` : `无${label}。`);
      for (const item of items) this.output.appendLine(`${path.resolve(item.file)}:${(item.line || 0) + 1}:${(item.column || 0) + 1}: ${item.code ? '[' + item.code + '] ' : ''}${item.message}`);
    }
    for (const [severity, label] of [['error', '错误'], ['warning', '警告']]) {
      if (!unlocated[severity].length) continue;
      this.output.appendLine(`未定位${label}（${unlocated[severity].length}）`);
      for (const line of unlocated[severity]) this.output.appendLine(line);
    }
    if (incomplete) this.output.appendLine(`检查未完成原因：${incomplete}`);
  }
  showOutput() { this.output.show(true); }
  dispose() {
    if (this.disposed) return this.queue;
    this.invalidate(); this.disposed = true; ++this.selectionRevision;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.diagnostics.dispose(); this.status.dispose();
    // Keep the output channel alive until a cancelled process has closed.
    void this.queue.finally(() => this.output.dispose());
    return this.queue;
  }
}
module.exports = {HdlLinter, lintTarget, targetContains};
