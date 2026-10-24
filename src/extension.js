'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {loadProject, filelist} = require('./xpr');
const {buildProjectTree} = require('./project-tree');
const {HdlIndex} = require('./indexer');
const {SlangBackend} = require('./slang');
const {readSource} = require('./encoding');
const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const slash = p => p.replace(/\\/g, '/');
const selector = [{scheme:'file',pattern:'**/*.{v,sv,vh,svh}'}];
let active;

class Workbench {
  constructor(context) {
    this.context = context;
    this.index = new HdlIndex();
    this.backend = new SlangBackend();
    this.texts = new Map();
    this.members = new Set();
    this.symbolRegistration = undefined;
    this.watchers = [];
    this.revision = 0;
    this.sourceRevision = 0;
    this.disposed = false;
    this.project = undefined;
    this.fileset = context.workspaceState.get('fileset');
    this.top = context.workspaceState.get('top');
    this.output = vscode.window.createOutputChannel('FPGA Workbench');
    this.change = new vscode.EventEmitter();
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
    this.status.command = 'fpgaWorkbench.projectInfo';
    this.status.text = '$(circuit-board) FPGA: 选择工程';
    this.status.show();
    this.fileView = vscode.window.createTreeView('fpgaWorkbench.files', {treeDataProvider:{
      onDidChangeTreeData:this.change.event, getTreeItem:n=>n, getChildren:n=>this.fileChildren(n)
    }});
    this.hierView = vscode.window.createTreeView('fpgaWorkbench.hierarchy', {treeDataProvider:{
      onDidChangeTreeData:this.change.event, getTreeItem:n=>n, getChildren:n=>this.hierChildren(n)
    }});
    context.subscriptions.push(this.output,this.change,this.status,this.fileView,this.hierView,
      vscode.workspace.onDidChangeTextDocument(e=>this.changedDocument(e.document)),
      vscode.workspace.onDidOpenTextDocument(d=>this.changedDocument(d)),
      vscode.workspace.onDidCloseTextDocument(d=>this.closedDocument(d)),
      vscode.workspace.onDidChangeConfiguration(e=> {if(e.affectsConfiguration('fpgaWorkbench')) this.scheduleRefresh();}),
      vscode.workspace.onDidChangeWorkspaceFolders(()=>this.change.fire()),
      vscode.window.onDidChangeActiveTextEditor(()=>this.updateEditorContext()),
      vscode.languages.registerDefinitionProvider(selector,{provideDefinition:(d,p,t)=>this.definitions(d,p,t)}),
      vscode.languages.registerReferenceProvider(selector,{provideReferences:(d,p,c,t)=>this.references(d,p,c.includeDeclaration,t)}),
      {dispose:()=>this.dispose()});
  }
  config() { return vscode.workspace.getConfiguration('fpgaWorkbench'); }
  node(label, options={}) {
    const item = new vscode.TreeItem(label,options.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    Object.assign(item,options);
    if(options.icon) item.iconPath = new vscode.ThemeIcon(options.icon);
    return item;
  }
  async selectProject(uri) {
    if (!uri) {
      const revision = this.revision;
      const picked = await vscode.window.showOpenDialog({title:'选择 Vivado 工程',filters:{'Vivado 工程':['xpr']},canSelectMany:false});
      if(!picked?.length || !this.isCurrent(revision)) return;
      uri = picked[0];
    }
    const xpr = typeof uri === 'string' ? uri : uri.fsPath;
    this.fileset = undefined; this.top = undefined;
    const loading = this.load(xpr), revision = this.revision;
    if(!await loading || !this.isCurrent(revision)) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr)) || vscode.workspace.workspaceFolders?.[0];
    // Issue state writes together so a later close cannot be followed by an old write.
    await Promise.all([
      this.context.workspaceState.update('project', {absolutePath:xpr,workspaceUri:folder?.uri.toString(),relativePath:folder ? path.relative(folder.uri.fsPath,xpr) : undefined}),
      this.context.workspaceState.update('fileset',undefined),
      this.context.workspaceState.update('top',undefined),
      vscode.commands.executeCommand('workbench.view.extension.fpgaWorkbench')
    ]);
  }
  async restore() {
    const revision = this.revision;
    const saved = this.context.workspaceState.get('project');
    if(!saved) return;
    const folder = vscode.workspace.workspaceFolders?.find(f=>f.uri.toString() === saved.workspaceUri) || vscode.workspace.workspaceFolders?.[0];
    const candidates = folder && saved.relativePath ? [path.resolve(folder.uri.fsPath,saved.relativePath),saved.absolutePath] : [saved.absolutePath];
    for(const p of candidates) {
      if(!p) continue;
      try {await fs.access(p);} catch {continue;}
      if(!this.isCurrent(revision)) return;
      await this.load(p); return;
    }
    if(!this.isCurrent(revision)) return;
    this.status.text = '$(warning) FPGA: 工程路径已失效';
    this.output.appendLine('保存的 XPR 不存在，请重新选择工程。');
  }
  async load(xpr) {
    if(this.disposed) return false;
    const revision = ++this.revision;
    const current = () => this.isCurrent(revision);
    const fileset = this.fileset, top = this.top, cfg = this.config();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.treeTimer);
    this.clearWatchers();
    this.clearProjectView();
    this.loadTarget = xpr;
    this.status.text = '$(sync~spin) FPGA: 建立索引';
    void vscode.commands.executeCommand('setContext','fpgaWorkbench.hasProject',true);
    // Serialize backend ownership; revision guards discard stale work after every await.
    const operation = async () => {
      if(!current()) return false;
      return vscode.window.withProgress({location:{viewId:'fpgaWorkbench.files'},title:'读取 FPGA 工程'},async()=> {
        await this.backend.stop();
        if(!current()) return false;
        const project = await loadProject(xpr,{fileset,includeSimulation:cfg.get('includeSimulation'),includeDirs:cfg.get('extraIncludeDirs'),defines:cfg.get('extraDefines')});
        if(!current()) return false;
        const index = new HdlIndex(); const texts = new Map();
        for(const file of project.sourceFiles) {
          try {
            const opened = vscode.workspace.textDocuments.find(d=>d.uri.scheme === 'file' && key(d.uri.fsPath) === key(file));
            const text = opened ? opened.getText() : await readSource(file,cfg.get('sourceEncoding','auto'));
            if(!current()) return false;
            index.update(file,text); texts.set(key(file),text);
          } catch(err) {project.warnings.push(`${file}: ${err.message}`);}
        }
        if(!current()) return false;
        const newMembers=new Set(project.sourceFiles.map(key));
        for(const doc of vscode.workspace.textDocuments) {
          if(doc.uri.scheme==='file' && newMembers.has(key(doc.uri.fsPath))) {
            index.update(doc.uri.fsPath,doc.getText());texts.set(key(doc.uri.fsPath),doc.getText());
          }
        }
        this.project = project; this.index = index; this.texts = texts;
        this.members = new Set(project.sourceFiles.map(key));
        this.registerDocumentSymbols();
        await vscode.commands.executeCommand('setContext','fpgaWorkbench.loaded',true);
        await this.updateEditorContext();
        if(!current()) return false;
        this.change.fire();
        for(const warning of project.warnings) this.output.appendLine(warning);
        try {await this.backend.start({context:this.context,project:{...project,top:top || project.top},output:this.output,onChange:()=>{if(current())this.refreshStatus();}});}
        catch(err) {if(current())this.output.appendLine(`语义服务未就绪，使用结构索引：${err.message}`);}
        if(!current()) {await this.backend.stop();return false;}
        if(cfg.get('watchFiles')) this.installWatchers();
        this.refreshStatus();
        this.output.appendLine(`${project.name}: ${project.sourceFiles.length} 个源文件，${index.modules().length} 个模块，${project.warnings.length} 条提示。`);
        return true;
      });
    };
    try {return await this.enqueue(operation) && current();}
    catch(err) {if(!current())return false;this.disposeDocumentSymbols();this.status.text='$(warning) FPGA: 读取失败';throw err;}
  }
  isCurrent(revision) {return !this.disposed && revision === this.revision;}
  enqueue(operation) {
    this.loading = (this.loading || Promise.resolve()).catch(()=>{}).then(operation);
    return this.loading;
  }
  disposeDocumentSymbols() {
    this.symbolRegistration?.dispose();
    this.symbolRegistration = undefined;
  }
  registerDocumentSymbols() {
    this.disposeDocumentSymbols();
    if(this.disposed || !this.project) return;
    const revision=this.revision;
    // A new provider identity invalidates VS Code's cached Outline and Sticky
    // Scroll models when project membership changes without a text edit.
    this.symbolRegistration=vscode.languages.registerDocumentSymbolProvider(selector,{
      provideDocumentSymbols:(d,t)=>this.isCurrent(revision) ? this.symbols(d,t) : []
    });
  }
  clearProjectView() {
    this.disposeDocumentSymbols();
    this.project = undefined;this.loadTarget = undefined;
    ++this.sourceRevision;
    this.index = new HdlIndex();this.texts.clear();this.members.clear();
    this.status.text = '$(circuit-board) FPGA: 选择工程';this.status.tooltip = undefined;
    this.fileView.description = undefined;this.hierView.description = undefined;
    void vscode.commands.executeCommand('setContext','fpgaWorkbench.loaded',false);
    void this.updateEditorContext();
    this.change.fire();
  }
  async closeProject() {
    ++this.revision;
    clearTimeout(this.refreshTimer);clearTimeout(this.treeTimer);this.clearWatchers();
    this.fileset = undefined;this.top = undefined;
    this.clearProjectView();
    await Promise.all([
      vscode.commands.executeCommand('setContext','fpgaWorkbench.hasProject',false),
      ...['project','fileset','top'].map(name=>this.context.workspaceState.update(name,undefined)),
      this.enqueue(()=>this.backend.stop())
    ]);
  }
  refreshStatus() {
    if(!this.project) return;
    const semantic = this.backend.running;
    const counts=this.backend.diagnosticsCounts || {errors:0,warnings:0};
    this.status.text = `$(circuit-board) ${this.project.name} · ${semantic ? 'slang' : '结构索引'}`;
    this.status.tooltip = `${this.project.path}\n${this.project.sourceFiles.length} 个源文件；${this.project.warnings.length} 条提示\n点击查看路径和索引状态`;
    this.hierView.description = semantic ? (counts.errors ? '语义层级 · 存在解析诊断' : '语义层级') : '结构层级（未展开条件）';
    this.fileView.description = `${this.project.sourceFiles.length} 个源文件`;
    this.change.fire();
  }
  async refresh() {if(this.loadTarget || this.project) await this.load(this.loadTarget || this.project.path); else await this.selectProject();}
  scheduleRefresh() {
    const target=this.loadTarget || this.project?.path;
    const revision=this.revision;
    if(!target)return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer=setTimeout(()=>{if(this.isCurrent(revision) && target === this.loadTarget) this.load(target).catch(e=>this.report(e));},600);
  }
  report(e) {this.output.appendLine(e.stack || String(e));vscode.window.showErrorMessage(`FPGA Workbench: ${e.message || e}`);}
  clearWatchers() {for(const w of this.watchers) w.dispose();this.watchers=[];}
  installWatchers() {
    const paths = new Set(this.project.files.filter(f=>f.path).map(f=>f.path));
    paths.add(this.project.path);
    const watchedKeys = new Set([...paths].map(key));
    const dirs = new Set([...paths].map(p=>path.dirname(p)));
    for(const dir of this.project.includeDirs) dirs.add(dir);
    for(const dir of dirs) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir,'*'));
      const change = (uri,type) => {
        if(!watchedKeys.has(key(uri.fsPath)) && !/\.(vh|svh)$/i.test(uri.fsPath)) return;
        ++this.sourceRevision;
        this.backend.changed(uri,type);
        this.scheduleRefresh();
      };
      this.watchers.push(w,w.onDidChange(u=>change(u,2)),w.onDidCreate(u=>change(u,1)),w.onDidDelete(u=>change(u,3)));
    }
  }
  changedDocument(doc) {
    if(doc.uri.scheme !== 'file' || !this.members.has(key(doc.uri.fsPath))) return;
    const text=doc.getText();
    if(this.texts.get(key(doc.uri.fsPath))!==text)++this.sourceRevision;
    this.index.update(doc.uri.fsPath,text);this.texts.set(key(doc.uri.fsPath),text);
    clearTimeout(this.treeTimer);this.treeTimer=setTimeout(()=>this.change.fire(),250);
  }
  async closedDocument(doc) {
    if(doc.uri.scheme !== 'file' || !this.members.has(key(doc.uri.fsPath))) return;
    const revision=this.revision;
    try {const text=await readSource(doc.uri.fsPath,this.config().get('sourceEncoding','auto'));if(!this.isCurrent(revision))return;if(this.texts.get(key(doc.uri.fsPath))!==text)++this.sourceRevision;this.index.update(doc.uri.fsPath,text);this.texts.set(key(doc.uri.fsPath),text);this.change.fire();}
    catch {if(!this.isCurrent(revision))return;++this.sourceRevision;this.index.remove(doc.uri.fsPath);this.texts.delete(key(doc.uri.fsPath));this.change.fire();}
  }
  fileChildren(node) {
    if(!this.project) return [];
    if(node?.items) return node.items;
    if(node) return [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    const relative = folder ? slash(path.relative(folder.uri.fsPath,this.project.path)) : this.project.path;
    const root = this.node(this.project.name,{children:true,contextValue:'fpgaWorkbench.project',description:relative,tooltip:`XPR: ${this.project.path}\n工作区 → XPR: ${relative}`,icon:'circuit-board',items:[]});
    const render = entry => {
      if(entry.kind !== 'file') return this.node(entry.label,{children:true,
        description:entry.kind === 'fileset' ? `${entry.type} · ${entry.count}` : undefined,
        icon:entry.kind === 'fileset' ? 'library' : 'folder',items:entry.children.map(render)});
      const f=entry.file;
      const origins=(entry.origins || [f]).map(source=>`${source.fileset}（${source.enabled?'启用':'禁用'}）`);
      const item=this.node(entry.label,{description:!f.exists?'缺失':!f.enabled?'已禁用':f.generated?'IP 声明':undefined,
        tooltip:`${f.path || f.rawPath}\n文件集: ${[...new Set(origins)].join('、')}`,
        icon:!f.exists?'warning':!f.enabled?'circle-slash':'file-code'});
      if(f.path) item.resourceUri=vscode.Uri.file(f.path);
      if(f.exists && f.path) item.command={command:'vscode.open',title:'打开文件',arguments:[vscode.Uri.file(f.path)]};
      return item;
    };
    root.items=buildProjectTree(this.project).map(render);
    return [root];
  }
  async hierChildren(node) {
    if(!this.project) return [];
    const revision=this.revision;
    if(this.backend.running) {
      try {
        const raw = await this.backend.hierarchy(node?.hierPath || '');
        if(!this.isCurrent(revision))return [];
        if(raw?.length || node) return (raw || []).filter(x=>['Instance','Scope','GenerateBlock','GenerateBlockArray','InstanceArray'].includes(x.kind)).map(x=>{
          const hierPath = [node?.hierPath,x.instName].filter(Boolean).join('.');
          return this.node(x.instName || x.declName || x.kind,{children:x.hasChildren !== false,description:x.declName || x.kind,icon:x.kind==='Instance'?'symbol-module':'symbol-namespace',hierPath,command:{command:'fpgaWorkbench.openHierarchy',title:'打开模块',arguments:[hierPath]}});
        });
      } catch(e) {if(!this.isCurrent(revision))return [];this.output.appendLine(`层级暂不可用: ${e.message}`);}
    }
    const mods = this.index.modules();
    if(!node) {
      const top=this.top || this.project.top;
      const roots=mods.filter(m=>m.name===top);
      const called=new Set(mods.flatMap(m=>m.instances.map(i=>i.type)));
      return (roots.length?roots:mods.filter(m=>!called.has(m.name))).map(m=>this.moduleNode(m,[],m.name));
    }
    if(!node.module) return [];
    return node.module.instances.flatMap(inst=> {
      const targets=mods.filter(m=>m.name===inst.type);
      if(!targets.length) return [this.node(inst.name,{description:`${inst.type} · 外部/IP 未解析`,icon:'question',command:{command:'fpgaWorkbench.openLocation',title:'打开实例',arguments:[{path:node.module.path,start:inst.start,end:inst.end}]}})];
      return targets.map(m=>this.moduleNode(m,node.ancestors,`${inst.name} : ${m.name}`));
    });
  }
  moduleNode(m,ancestors,label) {
    const id=`${m.path}:${m.start}`;const cyclic=ancestors.includes(id);
    return this.node(label,{module:m,ancestors:[...ancestors,id],children:!cyclic && m.instances.length>0,description:cyclic?'递归引用':path.basename(m.path),icon:'symbol-module',command:{command:'fpgaWorkbench.openLocation',title:'打开模块',arguments:[m]}});
  }
  position(text,offset) {const before=text.slice(0,offset);const line=before.split('\n').length-1;return new vscode.Position(line,offset-(before.lastIndexOf('\n')+1));}
  offset(text,position) {
    let offset=0;
    for(let line=0;line<position.line;line++) {const end=text.indexOf('\n',offset);if(end<0)return text.length;offset=end+1;}
    return Math.min(text.length,offset+position.character);
  }
  updateEditorContext() {
    const doc=vscode.window.activeTextEditor?.document;
    return vscode.commands.executeCommand('setContext','fpgaWorkbench.editorInProject',!!doc && doc.uri.scheme==='file' && this.members.has(key(doc.uri.fsPath)));
  }
  location(loc) {
    const text=this.texts.get(key(loc.path)) || '';
    return new vscode.Location(vscode.Uri.file(loc.path),new vscode.Range(this.position(text,loc.start),this.position(text,loc.end)));
  }
  uniqueLocations(items) {
    return [...new Map(items.map(item=> {
      const uri=item.targetUri || item.uri,range=item.targetSelectionRange || item.range || item.targetRange;
      return [JSON.stringify([key(uri.fsPath),range.start.line,range.start.character,range.end.line,range.end.character]),item];
    })).values()];
  }
  async definitions(doc,pos,token,options={}) {
    if(options.localOnly)return this.definitionTargets(doc,pos,token,options);
    if(doc.uri.scheme!=='file' || !this.members.has(key(doc.uri.fsPath)) || token?.isCancellationRequested)return [];
    const revision=this.revision,text=doc.getText();
    this.changedDocument(doc);
    const sources=this.sourceRevision;
    const current=()=>this.isCurrent(revision) && this.sourceRevision===sources && !token?.isCancellationRequested && doc.getText()===text;
    const locals=await this.definitionTargets(doc,pos,token);
    if(!current())return [];
    const query=this.index.localSignal(doc.uri.fsPath,doc.offsetAt(pos));
    if(!query)return locals;
    const matching=items=>this.uniqueLocations((items || []).filter(item=> {
      const uri=item.targetUri || item.uri,range=item.targetSelectionRange || item.range || item.targetRange;
      return uri?.scheme==='file' && range && key(uri.fsPath)===key(query.declaration.path)
        && this.offset(text,range.start)===query.declaration.start && this.offset(text,range.end)===query.declaration.end;
    }));
    const signalLocals=matching(locals);
    if(signalLocals.length!==1)return locals;
    const parents=this.index.parentConnections(query.declaration.path,query.declaration.start,{target:'port'});
    const results=[...signalLocals];
    if(this.backend.running) {
      try {
        // Declaration lookup is intentionally local even for inactive source.
        // Extra signal uses must still be confirmed by the semantic service.
        const atDeclaration=this.index.parentConnections(doc.uri.fsPath,doc.offsetAt(pos));
        if(atDeclaration?.declaration.kind==='port') {
          const confirmed=await this.backend.definitions(doc,pos,token);
          if(!current())return [];
          if(matching(confirmed).length!==1)return signalLocals;
        }
        const references=await this.backend.references(doc,pos,false,token);
        if(!current())return [];
        for(const item of references || []) {
          const uri=item.targetUri || item.uri,range=item.targetSelectionRange || item.range || item.targetRange;
          if(uri?.scheme!=='file' || !range || key(uri.fsPath)!==key(query.module.path))continue;
          const start=this.offset(text,range.start),end=this.offset(text,range.end);
          if(start>=query.module.bodyStart && end<=query.module.bodyEnd)results.push(item);
        }
        if(parents?.declaration.kind==='port') {
          const connections=await this.backend.parentConnections(doc,this.position(text,query.declaration.start),parents,token,{target:'port'});
          if(!current())return [];
          results.push(...(connections || []));
        }
      } catch(e) {if(current())this.output.appendLine(`信号导航：${e.message}`);}
    } else if(query.certain) {
      results.push(...query.references.map(item=>this.location(item)));
      if(parents?.declaration.kind==='port')results.push(...parents.connections.map(item=>this.location(item)));
    }
    return current() ? this.uniqueLocations(results) : [];
  }
  async definitionTargets(doc,pos,token,options={}) {
    if(!this.members.has(key(doc.uri.fsPath)) || token?.isCancellationRequested) return [];
    const revision=this.revision;
    const text=doc.getText();
    this.changedDocument(doc);
    const sources=this.sourceRevision;
    const current=()=>this.isCurrent(revision) && this.sourceRevision===sources && !token?.isCancellationRequested && doc.getText()===text;
    const parents=this.index.parentConnections(doc.uri.fsPath,doc.offsetAt(pos));
    // A port declaration is also a useful local preview target. Do not replace
    // it with its callers; parent-side connections belong to the peek list.
    if(parents && (parents.declaration.kind==='port' || options.localOnly))return [this.location(parents.declaration)];
    if(this.backend.running) {
      try {
        if(parents) {
          const results=await this.backend.parentConnections(doc,pos,parents,token);
          if(!current())return [];
          if(results?.length)return results;
        }
        const results=await this.backend.definitions(doc,pos,token);
        return current() ? results || [] : [];
      }
      catch(e) {if(this.isCurrent(revision))this.output.appendLine(`定义查询：${e.message}`);return [];}
    }
    if(parents?.connections.length)return parents.connections.map(l=>this.location(l));
    return this.index.definitions(doc.uri.fsPath,doc.offsetAt(pos)).map(l=>this.location(l));
  }
  async peekDefinitions(doc,pos,token) {
    if(doc.uri.scheme!=='file' || !this.members.has(key(doc.uri.fsPath)) || token?.isCancellationRequested)return [];
    const revision=this.revision,text=doc.getText();
    this.changedDocument(doc);
    const sources=this.sourceRevision;
    const current=()=>this.isCurrent(revision) && this.sourceRevision===sources && !token?.isCancellationRequested && doc.getText()===text;
    const locals=await this.definitionTargets(doc,pos,token,{localOnly:true});
    if(!current())return [];
    const results=[...locals],seen=new Set();
    for(const local of locals) {
      const uri=local.targetUri || local.uri,range=local.targetSelectionRange || local.range || local.targetRange;
      if(uri?.scheme!=='file' || !range || !this.members.has(key(uri.fsPath)))continue;
      const source=this.texts.get(key(uri.fsPath));if(source===undefined)continue;
      const query=this.index.parentConnections(uri.fsPath,this.offset(source,range.start));
      if(!query || query.declaration.kind!=='port')continue;
      const identity=`${key(uri.fsPath)}:${query.declaration.start}`;
      if(seen.has(identity))continue;seen.add(identity);
      if(this.backend.running) {
        try {
          const opened=vscode.workspace.textDocuments.find(item=>item.uri.scheme==='file' && key(item.uri.fsPath)===key(uri.fsPath));
          const document=opened || {uri,getText:()=>source};
          const parents=await this.backend.parentConnections(document,this.position(source,query.declaration.start),query,token,{target:'expression'});
          if(!current())return [];
          if(this.texts.get(key(uri.fsPath))!==source)return [];
          results.push(...(parents || []));
        } catch(e) {if(current())this.output.appendLine(`连接速览：${e.message}`);}
      } else {
        const parents=this.index.parentConnections(uri.fsPath,query.declaration.start,{target:'expression'});
        results.push(...(parents?.connections || []).map(item=>this.location(item)));
      }
    }
    if(!current())return [];
    return this.uniqueLocations(results);
  }
  async references(doc,pos,includeDeclaration,token) {
    if(!this.members.has(key(doc.uri.fsPath))) return [];
    const revision=this.revision;
    this.changedDocument(doc);
    if(this.backend.running) {
      try {const results=await this.backend.references(doc,pos,includeDeclaration,token);return this.isCurrent(revision) ? results || [] : [];}
      catch(e) {if(this.isCurrent(revision))this.output.appendLine(`引用查询：${e.message}`);return [];}
    }
    return this.index.references(doc.uri.fsPath,doc.offsetAt(pos),includeDeclaration).map(l=>this.location(l));
  }
  symbols(doc,token) {
    if(this.disposed || doc.uri.scheme!=='file' || !this.members.has(key(doc.uri.fsPath)) || token?.isCancellationRequested) return [];
    this.changedDocument(doc);
    const text=this.texts.get(key(doc.uri.fsPath));
    // Native Sticky Scroll needs the whole module body, while symbol selection
    // should still reveal only its name. No editor setting is changed here.
    return this.index.modules().filter(m=>key(m.path)===key(doc.uri.fsPath)).map(m=>new vscode.DocumentSymbol(m.name,'',vscode.SymbolKind.Module,
      new vscode.Range(this.position(text,m.bodyStart),this.position(text,m.bodyEnd)),
      new vscode.Range(this.position(text,m.start),this.position(text,m.end))));
  }
  async navigate(peek) {
    const editor=vscode.window.activeTextEditor;if(!editor) return;
    if(peek && (editor.document.uri.scheme!=='file' || !this.members.has(key(editor.document.uri.fsPath))))return vscode.commands.executeCommand('editor.action.peekDefinition');
    const revision=this.revision,text=editor.document.getText(),position=editor.selection.active;
    const cancellation=new vscode.CancellationTokenSource();
    let locations;
    try {locations=await (peek ? this.peekDefinitions(editor.document,position,cancellation.token) : this.definitions(editor.document,position,cancellation.token));}
    finally {cancellation.dispose();}
    if(!this.isCurrent(revision) || vscode.window.activeTextEditor!==editor || editor.document.getText()!==text || editor.selection.active.line!==position.line || editor.selection.active.character!==position.character)return;
    const targets=(locations || []).map(l=>l.targetUri ? new vscode.Location(l.targetUri,l.targetSelectionRange || l.targetRange):l);
    if(!targets.length) {vscode.window.showInformationMessage('当前工程中没有找到定义。请检查文件集、宏定义和 include 路径。');return;}
    const signal=this.index.localSignal(editor.document.uri.fsPath,editor.document.offsetAt(position));
    const showPeek=peek || !!signal;
    await vscode.commands.executeCommand('editor.action.goToLocations',editor.document.uri,position,targets,showPeek?'peek':'goto','未找到定义',showPeek);
  }
  async findReferences() {
    const editor=vscode.window.activeTextEditor;if(!editor)return;
    const refs=await this.references(editor.document,editor.selection.active,true,new vscode.CancellationTokenSource().token);
    await vscode.commands.executeCommand('editor.action.showReferences',editor.document.uri,editor.selection.active,refs);
  }
  async openLocation(loc) {
    const target=this.location(loc);
    await vscode.window.showTextDocument(target.uri,{selection:target.range,preview:true});
  }
  async chooseFileset() {
    if(!this.project) return this.selectProject();
    const revision=this.revision;
    const picked=await vscode.window.showQuickPick(this.project.filesets.filter(s=>/design/i.test(s.type)).map(s=>({label:s.name,description:s.type})),{title:'选择设计文件集'});
    if(!picked || !this.isCurrent(revision))return;this.fileset=picked.label;this.top=undefined;
    await Promise.all([this.context.workspaceState.update('fileset',this.fileset),this.context.workspaceState.update('top',undefined)]);
    if(this.isCurrent(revision))await this.refresh();
  }
  async chooseTop() {
    const revision=this.revision;
    const picked=await vscode.window.showQuickPick([{label:'使用 XPR 顶层',value:undefined},...this.index.modules().map(m=>({label:m.name,description:path.basename(m.path),value:m.name}))],{title:'选择顶层模块'});
    if(!picked || !this.isCurrent(revision))return;this.top=picked.value;await this.context.workspaceState.update('top',this.top);if(this.isCurrent(revision))await this.refresh();
  }
  async exportFilelist() {
    if(!this.project) return this.selectProject();
    const revision=this.revision;
    const uri=await vscode.window.showSaveDialog({title:'导出工程源文件清单',defaultUri:vscode.Uri.file(path.join(this.project.root,`${this.project.name}-sources.f`)),filters:{Filelist:['f']}});
    if(!uri || !this.isCurrent(revision))return;
    const ipInputs=(this.project.ipReferences || []).flatMap(ip=>[ip.path,...(ip.artifactPaths || [])]).filter(Boolean);
    const protectedKeys=new Set([this.project.path,...this.project.files.map(f=>f.path).filter(Boolean),...ipInputs].map(key));
    if(protectedKeys.has(key(uri.fsPath)))throw new Error('导出路径指向工程输入文件，请选择其他文件名。');
    await vscode.workspace.fs.writeFile(uri,Buffer.from(filelist(this.project,path.dirname(uri.fsPath),{outputPath:uri.fsPath,top:this.top || this.project.top}),'utf8'));
    await vscode.window.showTextDocument(uri);
  }
  async openFilelistSkill() {
    const uri=vscode.Uri.file(path.join(this.context.extensionPath,'skills','fpga-workbench-filelist','SKILL.md'));
    this.output.appendLine(`Filelist Skill: ${uri.fsPath}`);
    await vscode.window.showTextDocument(uri,{preview:false});
    return uri;
  }
  async info() {
    if(!this.project) return this.selectProject();
    const p=this.project;
    this.output.appendLine(`\n工程：${p.name}\nXPR：${p.path}\n根目录：${p.root}\n器件：${p.part || '未知'}\nVivado：${p.vivadoVersion || '未知'}\n顶层：${this.top || p.top || '自动'}\n后端：${this.backend.status || (this.backend.running?'slang':'结构索引')}\n源文件：${p.sourceFiles.length}\ninclude：${p.includeDirs.join('; ')}\n宏定义：${p.defines.join('; ')}`);
    for(const f of vscode.workspace.workspaceFolders || [])this.output.appendLine(`工作区 ${f.name} → XPR：${slash(path.relative(f.uri.fsPath,p.path))}`);
    for(const w of p.warnings)this.output.appendLine(`提示：${w}`);
    const counts=this.backend.diagnosticsCounts;
    if(counts)this.output.appendLine(`语义服务诊断：${counts.errors} 个错误、${counts.warnings} 个警告（不是 Vivado 编译结果）。`);
    this.output.show(true);
  }
  dispose() {
    if(this.disposed)return this.loading;
    this.disposed=true;++this.revision;
    clearTimeout(this.refreshTimer);clearTimeout(this.treeTimer);this.clearWatchers();
    this.disposeDocumentSymbols();
    return this.enqueue(()=>this.backend.stop());
  }
}

function activate(context) {
  const app = new Workbench(context);active=app;
  const commands={selectProject:u=>app.selectProject(u),switchProject:u=>app.selectProject(typeof u === 'string' || (u?.scheme === 'file' && typeof u.fsPath === 'string') ? u : undefined),closeProject:()=>app.closeProject(),refresh:()=>app.refresh(),selectFileset:()=>app.chooseFileset(),selectTop:()=>app.chooseTop(),exportFilelist:()=>app.exportFilelist(),openFilelistSkill:()=>app.openFilelistSkill(),projectInfo:()=>app.info(),peekDefinition:()=>app.navigate(true),gotoDefinition:()=>app.navigate(false),parentConnections:()=>app.findReferences(),openLocation:l=>app.openLocation(l),openHierarchy:p=>app.backend.showHierarchy(p)};
  for(const [name,handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`fpgaWorkbench.${name}`,async(...args)=>{try{return await handler(...args);}catch(e){app.report(e);}}));
  void app.restore().catch(e=>app.report(e));
  return {workbench:app};
}
async function deactivate() {if(active)await active.dispose();}
module.exports={activate,deactivate};
