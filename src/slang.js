'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { StdioLsp } = require('./lsp');
const { HdlIndex, connectionExpression } = require('./indexer');

const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hdl = file => /\.(sv|v|svh|vh)$/i.test(file);
const uriKey = uri => { try { return canonical(fileURLToPath(uri)); } catch (_) { return uri; } };
const offsetAt = (text, position) => {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf('\n', offset);
    if (end < 0) return text.length;
    offset = end + 1;
  }
  return Math.min(text.length, offset + position.character);
};
const positionAt = (text, offset) => {
  const before = text.slice(0, offset);
  const newline = before.lastIndexOf('\n');
  return { line: (before.match(/\n/g) || []).length, character: offset - newline - 1 };
};
const samePosition = (a, b) => a.line === b.line && a.character === b.character;
const childPath = (parent, name) => parent ? `${parent}${name.startsWith('[') ? '' : '.'}${name}` : name;

/** Supplement an upstream empty answer using locations from an elaborated instance.
 * The lexical parser identifies only the clicked source token. It never chooses
 * the destination module by name; every destination comes from Slang's design.
 */
async function resolveElaboratedDefinition({ uri, text, position, execute, readText }) {
  const lexical = new HdlIndex();
  const filePath = uriKey(uri);
  lexical.update(filePath, text);
  const offset = offsetAt(text, position);
  const within = (start, end) => offset >= start && offset < end;
  const owner = lexical.modules().find(mod => offset >= mod.bodyStart && offset <= mod.bodyEnd);
  if (!owner) return [];
  const candidates = owner.instances.flatMap(instance => {
    if (within(instance.typeStart, instance.typeEnd) || within(instance.start, instance.end)) return [{ instance }];
    const connection = [...instance.ports, ...instance.parameters].find(item => within(item.start, item.end));
    return connection ? [{ instance, connection }] : [];
  });
  if (!candidates.length) return [];
  const parents = await execute('slang.getInstancesOfModule', [owner.name]);
  const results = [];
  const visited = new Set();
  const walk = async (scope, children, depth = 0) => {
    if (depth > 64 || visited.has(scope)) return;
    visited.add(scope);
    for (const item of children || []) {
      const itemPath = childPath(scope, item.instName);
      if (item.kind === 'Scope' || item.kind === 'ScopeArray' || item.kind === 'InstanceArray') {
        await walk(itemPath, item.children?.length ? item.children : await execute('slang.getScope', [itemPath]), depth + 1);
      }
      if (item.kind !== 'Instance' || !item.instLoc || !item.declLoc || uriKey(item.instLoc.uri) !== filePath) continue;
      for (const { instance, connection } of candidates) {
        // Inactive ifdef/generate branches and same-name instances in other scopes
        // cannot pass this exact source-position and elaborated-type comparison.
        if (item.declName !== instance.type || !samePosition(item.instLoc.range.start, positionAt(text, instance.start))) continue;
        let target = item.declLoc;
        let selection = target.range;
        if (connection) {
          const members = item.children?.length ? item.children : await execute('slang.getScope', [itemPath]);
          const match = members.find(member => member.instName === connection.name &&
            member.kind === (connection.kind === 'parameter' ? 'Param' : 'Port') && member.instLoc);
          if (!match) continue;
          target = match.instLoc; selection = target.range;
        } else {
          const targetText = await readText(target.uri);
          if (targetText !== undefined) {
            const targetIndex = new HdlIndex(); targetIndex.update(uriKey(target.uri), targetText);
            const module = targetIndex.modules().find(mod => mod.name === item.declName &&
              samePosition(positionAt(targetText, mod.bodyStart), target.range.start));
            if (module) selection = { start: positionAt(targetText, module.start), end: positionAt(targetText, module.end) };
          }
        }
        if (!target.uri || target.uri === 'file://') continue;
        const tokenStart = connection?.start ?? (within(instance.start, instance.end) ? instance.start : instance.typeStart);
        const tokenEnd = connection?.end ?? (within(instance.start, instance.end) ? instance.end : instance.typeEnd);
        results.push({ targetUri: target.uri, targetRange: target.range, targetSelectionRange: selection,
          originSelectionRange: { start: positionAt(text, tokenStart), end: positionAt(text, tokenEnd) } });
      }
    }
  };
  for (const parent of parents || []) {
    if (!parent.instPath) continue;
    await walk(parent.instPath, await execute('slang.getScope', [parent.instPath]));
  }
  return [...new Map(results.map(result => [JSON.stringify([uriKey(result.targetUri), result.targetSelectionRange]), result])).values()];
}

/** Reverse navigation uses the elaborated instance graph, not LSP references:
 * Slang's source references can also include inactive branches and local uses.
 * The structural index supplies token positions only after an actual instance
 * has been matched to this exact module declaration in Slang's design.
 */
async function resolveElaboratedParentConnections({ uri, text, position, query, execute, readText, token, options = {} }) {
  const { declaration, module: owner } = query || {};
  if (!owner || !declaration || !['module', 'port'].includes(declaration.kind) || token?.isCancellationRequested) return [];
  const filePath = uriKey(uri);
  if (canonical(owner.path) !== filePath) return [];
  const active = await execute('slang.getInstancesOfModule', [owner.name]);
  if (token?.isCancellationRequested) return [];
  const paths = new Set((active || []).map(item => item.instPath).filter(Boolean));
  if (!paths.size) return [];
  const results = [];
  const visited = new Set();
  const sources = new Map([[filePath, { text, index: new HdlIndex() }]]);
  sources.get(filePath).index.update(filePath, text);
  const sourceAt = async targetUri => {
    const key = uriKey(targetUri);
    if (!sources.has(key)) {
      const source = await readText(targetUri);
      if (source === undefined) return undefined;
      const index = new HdlIndex(); index.update(key, source);
      sources.set(key, { text: source, index });
    }
    return sources.get(key);
  };
  const hasDescendant = scope => [...paths].some(candidate => candidate.startsWith(`${scope}.`) || candidate.startsWith(`${scope}[`));
  const walk = async (scope, items, depth = 0) => {
    if (depth > 64 || visited.has(scope) || token?.isCancellationRequested) return;
    visited.add(scope);
    for (const item of items || []) {
      if (token?.isCancellationRequested) return;
      const itemPath = childPath(scope, item.instName || '');
      if (paths.has(itemPath) && item.kind === 'Instance' && item.declName === owner.name && item.declLoc && item.instLoc &&
          uriKey(item.declLoc.uri) === filePath && samePosition(item.declLoc.range.start, positionAt(text, owner.bodyStart))) {
        let portMatches = true;
        if (declaration.kind === 'port') {
          const members = item.children?.length ? item.children : await execute('slang.getScope', [itemPath]);
          portMatches = (members || []).some(member => member.kind === 'Port' && member.instName === declaration.name && member.instLoc &&
            uriKey(member.instLoc.uri) === filePath && samePosition(member.instLoc.range.start, positionAt(text, declaration.start)));
        }
        if (portMatches) {
          const source = await sourceAt(item.instLoc.uri);
          // Root instances have the module's own source range rather than an
          // instantiation token, so they intentionally have no parent target.
          const instance = source?.index.modules().flatMap(mod => mod.instances).find(instance => instance.type === owner.name &&
            samePosition(positionAt(source.text, instance.start), item.instLoc.range.start));
          const ports = instance?.ports.filter(port => port.name === declaration.name) || [];
          // The elaborated graph confirms the instance, but exposes no source
          // location for its parent-side port connection. LSP definitions also
          // leave named connections unresolved. A conditional source port can
          // therefore be an inactive preprocessor branch; never choose it by
          // name or token order. Show the confirmed instance when the source has
          // no unique unconditional connection (also covers positional / .*).
          const uniquePort = declaration.kind === 'port' && ports.length === 1 && !ports[0].conditional;
          let target = options.target === 'port' && declaration.kind === 'port' && !uniquePort ? undefined : uniquePort ? ports[0] : instance;
          // Combined local/upstream peek requests the parent's actual source
          // expression. Empty or unsafe expressions add no signal preview;
          // an ambiguous connection retains only its confirmed instance name.
          if (uniquePort && options.target === 'expression') target = connectionExpression(source.text, target);
          if (target) {
            const range = { start: positionAt(source.text, target.start), end: positionAt(source.text, target.end) };
            const offset = offsetAt(text, position);
            results.push({ targetUri: item.instLoc.uri, targetRange: range, targetSelectionRange: range,
              ...(offset >= declaration.start && offset <= declaration.end ? {
                originSelectionRange: { start: positionAt(text, declaration.start), end: positionAt(text, declaration.end) }
              } : {}) });
          }
        }
      }
      if (hasDescendant(itemPath) && ['Instance', 'Scope', 'ScopeArray', 'InstanceArray'].includes(item.kind)) {
        const children = item.children?.length ? item.children : await execute('slang.getScope', [itemPath]);
        await walk(itemPath, children, depth + 1);
      }
    }
  };
  await walk('', await execute('slang.getScope', ['']));
  if (token?.isCancellationRequested) return [];
  return [...new Map(results.map(result => [JSON.stringify([uriKey(result.targetUri), result.targetSelectionRange]), result])).values()];
}

function decodeSource(bytes, encoding = 'auto') {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  if (encoding === 'gb18030') return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch (error) {
    if (encoding === 'utf-8') throw error;
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' };
  }
}

function quoteArgument(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('Filelist 参数包含控制字符。');
  // Slang expands environment variables in command files, even though no shell is used.
  if (text.includes('$')) throw new Error(`Filelist 暂不支持包含 $ 的路径或参数：${text}`);
  return `"${text.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function semanticFilelist(project) {
  const lines = ['// Generated by FPGA Workbench. Absolute paths; no project files are changed.'];
  if (project.top) lines.push('--top', quoteArgument(project.top));
  for (const directory of project.includeDirs || []) lines.push('-I', quoteArgument(directory));
  for (const define of project.defines || []) lines.push(quoteArgument(`-D${define}`));
  for (const file of project.sourceFiles || []) if (/\.(sv|v)$/i.test(file)) lines.push(quoteArgument(file));
  return `${lines.join('\n')}\n`;
}

class SlangBackend {
  constructor() {
    this.running = false;
    this.status = 'idle';
    this.diagnostics = new Map();
    this.documents = new Map();
    this.subscriptions = [];
    this.queue = Promise.resolve();
    this.scopeCache = new Map();
  }

  log(message) { this.output?.appendLine(`[slang] ${message}`); }

  async start({ context, project, output, onChange }) {
    await this.stop();
    this.status = 'starting';
    const vscode = this.vscode = require('vscode');
    this.output = output;
    this.project = project;
    this.onChange = onChange;
    this.sourceSet = new Set(project.sourceFiles.map(canonical));
    const settings = vscode.workspace.getConfiguration('fpgaWorkbench');
    if (settings.get('backend', 'auto') === 'builtin') { this.status = 'disabled'; return false; }
    this.encoding = settings.get('sourceEncoding', 'auto');
    const configured = settings.get('slangPath', '');
    const executable = configured || path.join(context.extensionPath, 'vendor', 'slang', process.platform === 'win32' ? 'slang-server.exe' : 'slang-server');
    try {
      if (configured && !path.isAbsolute(configured)) throw new Error('slangPath 必须是绝对路径。');
      await fs.access(executable);
      const hash = crypto.createHash('sha1').update(canonical(project.path)).digest('hex');
      const root = this.cacheRoot = path.join(context.globalStorageUri.fsPath, hash);
      await fs.mkdir(path.join(root, '.slang', 'local'), { recursive: true });
      const build = path.join(root, 'project.f');
      await fs.writeFile(build, semanticFilelist(project), 'utf8');
      // An explicit empty index avoids scanning unrelated backup trees. Build sources
      // supply full design semantics; opened documents are synchronized below.
      const config = { build, index: [{ dirs: [] }], flags: '', indexingThreads: 2 };
      await fs.writeFile(path.join(root, '.slang', 'server.json'), JSON.stringify(config, null, 2), 'utf8');
      await fs.writeFile(path.join(root, '.slang', 'local', 'server.json'), JSON.stringify({ build, flags: '' }), 'utf8');
      const client = this.client = new StdioLsp({
        onNotification: (method, params) => {
          if (method === 'window/showMessage') this.log(params.message);
          if (method === 'slang/activeInstanceChanged') this.onChange?.();
          if (method === 'textDocument/publishDiagnostics') this.diagnostics.set(params.uri, params.diagnostics || []);
        },
        onRequest: async (method, params) => {
          if (method === 'window/showDocument') {
            const uri = vscode.Uri.parse(params.uri);
            if (uri.scheme !== 'file') return { success: false };
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { preserveFocus: params.takeFocus === false,
              ...(params.selection ? { selection: this.range(params.selection) } : {}) });
            return { success: true };
          }
          if (method === 'workspace/configuration') return (params.items || []).map(() => null);
          return null; // watcher registration / progress requests need acknowledgements.
        },
        onStderr: text => { if (/error|fatal/i.test(text)) this.log(text.trim().slice(0, 1500)); },
        onExit: error => { if (this.running) { this.running = false; this.status = `failed: ${error.message}`; this.log(error.message); this.onChange?.(); } },
      });
      // Remove only the child process's HOME so global Slang config cannot append
      // unrelated indexes. Parent environment and user configuration are untouched.
      const childEnvironment = { ...process.env };
      delete childEnvironment.HOME;
      client.start(executable, [], { cwd: root, env: childEnvironment });
      const rootUri = pathToFileURL(root).href;
      const initialized = await client.request('initialize', { processId: process.pid, rootUri,
        workspaceFolders: [{ uri: rootUri, name: project.name || 'FPGA project' }],
        capabilities: { workspace: { configuration: true }, window: { showDocument: { support: true } },
          textDocument: { definition: { linkSupport: true }, synchronization: { didSave: true } },
          general: { positionEncodings: ['utf-16'] } },
        clientInfo: { name: 'FPGA Workbench', version: '0.1.0' } }, { timeout: 60000 });
      this.commands = new Set(initialized.capabilities?.executeCommandProvider?.commands || []);
      client.notify('initialized', {});
      this.running = true;
      // didOpen provides decoded text for legacy GBK files without rewriting them.
      // All files also remain available when the server has no directory index.
      for (const file of project.sourceFiles) {
        const open = vscode.workspace.textDocuments.find(doc => canonical(doc.uri.fsPath) === canonical(file));
        if (open) this.syncDocument(open);
        else {
          const decoded = decodeSource(await fs.readFile(file), this.encoding);
          this.syncText(vscode.Uri.file(file).toString(), decoded.text);
          if (decoded.encoding !== 'utf-8') this.log(`已按 ${decoded.encoding} 解码：${file}`);
        }
      }
      const last = [...this.documents.entries()].at(-1);
      if (last) client.notify('textDocument/didSave', { textDocument: { uri: last[0] }, text: last[1].text });
      // A request after all notifications ensures parsing has completed before UI reads hierarchy.
      if (this.commands.has('slang.getScope')) await this.execute('slang.getScope', [''], 60000);
      const event = promise => { this.queue = this.queue.then(() => promise()).catch(error => this.log(error.message)); };
      this.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (this.belongs(document)) event(() => this.syncDocument(document));
      }));
      this.subscriptions.push(vscode.workspace.onDidChangeTextDocument(change => {
        if (this.belongs(change.document)) event(() => this.syncDocument(change.document));
      }));
      this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (this.belongs(document)) event(() => {
          this.syncDocument(document);
          this.client.notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() }, text: document.getText() });
          this.onChange?.();
        });
      }));
      this.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
        if (this.belongs(document)) event(async () => {
          // Closing a dirty editor can discard its unsaved text. Keep the server's
          // decoded document open, but restore the actual disk contents.
          const decoded = decodeSource(await fs.readFile(document.uri.fsPath), this.encoding);
          this.syncText(document.uri.toString(), decoded.text);
          this.client.notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() }, text: decoded.text });
          this.onChange?.();
        });
      }));
      this.log(`已启动 ${initialized.serverInfo?.name || 'slang-server'} ${initialized.serverInfo?.version?.trim() || ''}`);
      this.status = 'running';
      this.version = initialized.serverInfo?.version?.trim() || '';
      return true;
    } catch (error) {
      this.log(`语义服务启动失败：${error.message}`);
      await this.stop();
      this.status = `failed: ${error.message}`;
      return false;
    }
  }

  belongs(document) {
    return document.uri.scheme === 'file' && hdl(document.uri.fsPath) && this.sourceSet?.has(canonical(document.uri.fsPath));
  }

  syncText(uri, text) {
    if (!this.running) return;
    const previous = this.documents.get(uri);
    if (previous?.text === text) return;
    const version = (previous?.version || 0) + 1;
    if (previous) this.client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    else this.client.notify('textDocument/didOpen', { textDocument: { uri, version, languageId: /\.svh?$/i.test(uri) ? 'systemverilog' : 'verilog', text } });
    this.documents.set(uri, { text, version });
    this.scopeCache.clear();
    this.designDirty = uri;
  }

  syncDocument(document) { if (this.belongs(document)) this.syncText(document.uri.toString(), document.getText()); }
  range(range) { return new this.vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character); }
  locations(result) {
    if (!result) return null;
    return (Array.isArray(result) ? result : [result]).map(item => item.targetUri
      ? { targetUri: this.vscode.Uri.parse(item.targetUri), targetRange: this.range(item.targetRange),
        targetSelectionRange: this.range(item.targetSelectionRange),
        ...(item.originSelectionRange ? { originSelectionRange: this.range(item.originSelectionRange) } : {}) }
      : new this.vscode.Location(this.vscode.Uri.parse(item.uri), this.range(item.range)));
  }

  async definitions(document, position, token) {
    if (!this.running || !this.belongs(document)) return null;
    try {
      await this.queue;
      this.syncDocument(document);
      const text = document.getText();
      const result = await this.client.request('textDocument/definition', {
        textDocument: { uri: document.uri.toString() }, position: { line: position.line, character: position.character } }, { token });
      if (result && (!Array.isArray(result) || result.length)) return this.locations(result);
      if (token?.isCancellationRequested || !this.commands.has('slang.getInstancesOfModule')) return [];
      await this.flushDesign();
      const supplemental = await resolveElaboratedDefinition({ uri: document.uri.toString(), text, position,
        execute: (command, args) => this.cachedExecute(command, args),
        readText: async uri => {
          for (const [knownUri, data] of this.documents) if (uriKey(knownUri) === uriKey(uri)) return data.text;
          return decodeSource(await fs.readFile(fileURLToPath(uri)), this.encoding).text;
        } });
      return document.getText() === text ? this.locations(supplemental) : [];
    } catch (error) { if (!token?.isCancellationRequested) this.log(error.message); return null; }
  }

  async references(document, position, includeDeclaration, token) {
    if (!this.running || !this.belongs(document)) return null;
    try {
      await this.queue;
      this.syncDocument(document);
      return this.locations(await this.client.request('textDocument/references', {
        textDocument: { uri: document.uri.toString() }, position: { line: position.line, character: position.character },
        context: { includeDeclaration: Boolean(includeDeclaration) } }, { token }));
    } catch (error) { if (!token?.isCancellationRequested) this.log(error.message); return null; }
  }

  async parentConnections(document, position, query, token, options = {}) {
    if (!this.running || !this.belongs(document)) return null;
    try {
      await this.queue;
      if (token?.isCancellationRequested || !this.commands.has('slang.getInstancesOfModule') || !this.commands.has('slang.getScope')) return [];
      this.syncDocument(document);
      const text = document.getText();
      await this.flushDesign();
      const result = await resolveElaboratedParentConnections({ uri: document.uri.toString(), text, position, query, token, options,
        execute: (command, args) => this.cachedExecute(command, args),
        readText: async uri => {
          for (const [knownUri, data] of this.documents) if (uriKey(knownUri) === uriKey(uri)) return data.text;
          return decodeSource(await fs.readFile(fileURLToPath(uri)), this.encoding).text;
        } });
      return !token?.isCancellationRequested && document.getText() === text ? this.locations(result) : [];
    } catch (error) { if (!token?.isCancellationRequested) this.log(error.message); return null; }
  }

  execute(command, args, timeout = 10000) {
    return this.client.request('workspace/executeCommand', { command, arguments: args }, { timeout });
  }
  cachedExecute(command, args) {
    const key = JSON.stringify([command, args]);
    if (!this.scopeCache.has(key)) this.scopeCache.set(key, this.execute(command, args).catch(error => { this.scopeCache.delete(key); throw error; }));
    return this.scopeCache.get(key);
  }
  async flushDesign() {
    if (!this.designDirty) return;
    const uri = this.designDirty;
    this.designDirty = undefined;
    const document = this.documents.get(uri);
    // Slang refreshes its full in-memory compilation on this notification. No
    // source file is written; includeText retains unsaved editor contents.
    if (document) this.client.notify('textDocument/didSave', { textDocument: { uri }, text: document.text });
  }
  get diagnosticsCounts() {
    const counts = { errors: 0, warnings: 0 };
    for (const list of this.diagnostics.values()) for (const diagnostic of list) {
      if (diagnostic.severity === 1) counts.errors++;
      else if (diagnostic.severity === 2) counts.warnings++;
    }
    return counts;
  }
  async hierarchy(scope = '') {
    if (!this.running || !this.commands.has('slang.getScope')) return [];
    try { await this.queue; await this.flushDesign(); return await this.cachedExecute('slang.getScope', [scope]) || []; }
    catch (error) { this.log(error.message); return []; }
  }
  async showHierarchy(hierPath) {
    if (!this.running || !this.commands.has('slang.showHierLocation')) return;
    try { await this.execute('slang.showHierLocation', [{ hierPath, takeFocus: true }]); }
    catch (error) { this.log(error.message); }
  }
  async changed(uri, type = 2) {
    if (!this.running) return;
    const client = this.client;
    try {
      const open = this.vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      if (!open && type !== 3 && hdl(uri.fsPath)) {
        const decoded = decodeSource(await fs.readFile(uri.fsPath), this.encoding);
        if (!this.running || this.client !== client) return;
        this.syncText(uri.toString(), decoded.text);
        this.client.notify('textDocument/didSave', { textDocument: { uri: uri.toString() }, text: decoded.text });
      }
      if (type === 3) {
        this.client.notify('textDocument/didClose', { textDocument: { uri: uri.toString() } });
        this.documents.delete(uri.toString());
      }
      this.client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type }] });
      this.scopeCache.clear();
      this.onChange?.();
    } catch (error) { this.log(error.message); }
  }

  async stop() {
    this.running = false;
    this.status = 'stopped';
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    await this.queue.catch(() => {});
    this.queue = Promise.resolve();
    const client = this.client;
    this.client = undefined;
    if (client) await client.stop();
    this.documents.clear();
    this.diagnostics.clear();
    this.scopeCache.clear();
    this.designDirty = undefined;
  }
}

module.exports = { SlangBackend, decodeSource, semanticFilelist, resolveElaboratedDefinition, resolveElaboratedParentConnections };
