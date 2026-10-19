'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {loadProject, filelist} = require('./xpr');
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
    this.watchers = [];
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
      vscode.languages.registerDefinitionProvider(selector,{provideDefinition:(d,p,t)=>this.definitions(d,p,t)}),
      vscode.languages.registerReferenceProvider(selector,{provideReferences:(d,p,c,t)=>this.references(d,p,c.includeDeclaration,t)}),
      vscode.languages.registerDocumentSymbolProvider(selector,{provideDocumentSymbols:d=>this.symbols(d)}),
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
      const picked = await vscode.window.showOpenDialog({title:'选择 Vivado 工程',filters:{'Vivado 工程':['xpr']},canSelectMany:false});
      if(!picked?.length) return;
      uri = picked[0];
    }
    const xpr = typeof uri === 'string' ? uri : uri.fsPath;
    this.fileset = undefined; this.top = undefined;
    await this.load(xpr);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr)) || vscode.workspace.workspaceFolders?.[0];
    await this.context.workspaceState.update('project', {absolutePath:xpr,workspaceUri:folder?.uri.toString(),relativePath:folder ? path.relative(folder.uri.fsPath,xpr) : undefined});
    await this.context.workspaceState.update('fileset',undefined);
    await this.context.workspaceState.update('top',undefined);
    await vscode.commands.executeCommand('workbench.view.extension.fpgaWorkbench');
  }
  async restore() {
    const saved = this.context.workspaceState.get('project');
    if(!saved) return;
    const folder = vscode.workspace.workspaceFolders?.find(f=>f.uri.toString() === saved.workspaceUri) || vscode.workspace.workspaceFolders?.[0];
    const candidates = folder && saved.relativePath ? [path.resolve(folder.uri.fsPath,saved.relativePath),saved.absolutePath] : [saved.absolutePath];
    for(const p of candidates) {
      if(!p) continue;
      try {await fs.access(p);} catch {continue;}
      await this.load(p); return;
    }
    this.status.text = '$(warning) FPGA: 工程路径已失效';
    this.output.appendLine('保存的 XPR 不存在，请重新选择工程。');
  }
  async load(xpr) {
    clearTimeout(this.refreshTimer);
    this.clearWatchers();
    this.loadTarget = xpr;
    // Serialize project changes so an older slow load cannot replace a newer selection.
    const operation = async () => vscode.window.withProgress({location:{viewId:'fpgaWorkbench.files'},title:'读取 FPGA 工程'},async()=> {
      this.status.text = '$(sync~spin) FPGA: 建立索引';
      const cfg = this.config();
      const project = await loadProject(xpr,{fileset:this.fileset,includeSimulation:cfg.get('includeSimulation'),includeDirs:cfg.get('extraIncludeDirs'),defines:cfg.get('extraDefines')});
      const index = new HdlIndex(); const texts = new Map();
      for(const file of project.sourceFiles) {
        try {
          const opened = vscode.workspace.textDocuments.find(d=>d.uri.scheme === 'file' && key(d.uri.fsPath) === key(file));
          const text = opened ? opened.getText() : await readSource(file,cfg.get('sourceEncoding','auto'));
          index.update(file,text); texts.set(key(file),text);
        } catch(err) {project.warnings.push(`${file}: ${err.message}`);}
      }
      await this.backend.stop();
      this.clearWatchers();
      const newMembers=new Set(project.sourceFiles.map(key));
      for(const doc of vscode.workspace.textDocuments) {
        if(doc.uri.scheme==='file' && newMembers.has(key(doc.uri.fsPath))) {
          index.update(doc.uri.fsPath,doc.getText());texts.set(key(doc.uri.fsPath),doc.getText());
        }
      }
      this.project = project; this.index = index; this.texts = texts;
      this.members = new Set(project.sourceFiles.map(key));
      await vscode.commands.executeCommand('setContext','fpgaWorkbench.loaded',true);
      this.change.fire();
      for(const warning of project.warnings) this.output.appendLine(warning);
      try {await this.backend.start({context:this.context,project:{...project,top:this.top || project.top},output:this.output,onChange:()=>this.refreshStatus()});}
      catch(err) {this.output.appendLine(`语义服务未就绪，使用结构索引：${err.message}`);}
      if(cfg.get('watchFiles')) this.installWatchers();
      this.refreshStatus();
      this.output.appendLine(`${project.name}: ${project.sourceFiles.length} 个源文件，${index.modules().length} 个模块，${project.warnings.length} 条提示。`);
    });
    this.loading = (this.loading || Promise.resolve()).catch(()=>{}).then(operation);
    try {await this.loading;} catch(err) {this.refreshStatus();throw err;}
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
    if(!target)return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer=setTimeout(()=>{if(target === this.loadTarget) this.load(target).catch(e=>this.report(e));},600);
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
        this.backend.changed(uri,type);
        this.scheduleRefresh();
      };
      this.watchers.push(w,w.onDidChange(u=>change(u,2)),w.onDidCreate(u=>change(u,1)),w.onDidDelete(u=>change(u,3)));
    }
  }
  changedDocument(doc) {
    if(doc.uri.scheme !== 'file' || !this.members.has(key(doc.uri.fsPath))) return;
    this.index.update(doc.uri.fsPath,doc.getText());this.texts.set(key(doc.uri.fsPath),doc.getText());
    clearTimeout(this.treeTimer);this.treeTimer=setTimeout(()=>this.change.fire(),250);
  }
  async closedDocument(doc) {
    if(doc.uri.scheme !== 'file' || !this.members.has(key(doc.uri.fsPath))) return;
    try {const text=await readSource(doc.uri.fsPath,this.config().get('sourceEncoding','auto'));this.index.update(doc.uri.fsPath,text);this.texts.set(key(doc.uri.fsPath),text);this.change.fire();}
    catch {this.index.remove(doc.uri.fsPath);this.texts.delete(key(doc.uri.fsPath));this.change.fire();}
  }
  fileChildren(node) {
    if(!this.project) return [];
    if(node?.items) return node.items;
    if(node) return [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    const relative = folder ? slash(path.relative(folder.uri.fsPath,this.project.path)) : this.project.path;
    const root = this.node(this.project.name,{children:true,description:relative,tooltip:`XPR: ${this.project.path}\n工作区 → XPR: ${relative}`,icon:'circuit-board',items:[]});
    for(const set of this.project.filesets) {
      const files = this.project.files.filter(f=>f.fileset === set.name);
      const setNode = this.node(set.name,{children:true,description:`${set.type} · ${files.length}`,icon:'library',items:[]});
      const folders = new Map();
      for(const f of files) {
        const rel = f.path ? slash(path.relative(this.project.root,f.path)) : f.rawPath;
        const group = path.posix.dirname(rel);
        let parent = setNode;
        if(group !== '.') {
          if(!folders.has(group)) {const n=this.node(group,{children:true,icon:'folder',items:[]});folders.set(group,n);setNode.items.push(n);}
          parent=folders.get(group);
        }
        const item = this.node(f.path ? path.basename(f.path) : f.rawPath,{description:!f.exists?'缺失':!f.enabled?'已禁用':f.generated?'IP 声明':undefined,tooltip:`${f.path || f.rawPath}\n文件集: ${set.name}\n${f.enabled?'启用':'禁用'}`,icon:!f.exists?'warning':!f.enabled?'circle-slash':'file-code'});
        if(f.path) item.resourceUri=vscode.Uri.file(f.path);
        if(f.exists) item.command={command:'vscode.open',title:'打开文件',arguments:[vscode.Uri.file(f.path)]};
        parent.items.push(item);
      }
      root.items.push(setNode);
    }
    return [root];
  }
  async hierChildren(node) {
    if(!this.project) return [];
    if(this.backend.running) {
      try {
        const raw = await this.backend.hierarchy(node?.hierPath || '');
        if(raw?.length || node) return (raw || []).filter(x=>['Instance','Scope','GenerateBlock','GenerateBlockArray','InstanceArray'].includes(x.kind)).map(x=>{
          const hierPath = [node?.hierPath,x.instName].filter(Boolean).join('.');
          return this.node(x.instName || x.declName || x.kind,{children:x.hasChildren !== false,description:x.declName || x.kind,icon:x.kind==='Instance'?'symbol-module':'symbol-namespace',hierPath,command:{command:'fpgaWorkbench.openHierarchy',title:'打开模块',arguments:[hierPath]}});
        });
      } catch(e) {this.output.appendLine(`层级暂不可用: ${e.message}`);}
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
  location(loc) {
    const text=this.texts.get(key(loc.path)) || '';
    return new vscode.Location(vscode.Uri.file(loc.path),new vscode.Range(this.position(text,loc.start),this.position(text,loc.end)));
  }
  async definitions(doc,pos,token) {
    if(!this.members.has(key(doc.uri.fsPath))) return [];
    this.changedDocument(doc);
    if(this.backend.running) {
      try {return await this.backend.definitions(doc,pos,token) || [];}
      catch(e) {this.output.appendLine(`定义查询：${e.message}`);return [];}
    }
    return this.index.definitions(doc.uri.fsPath,doc.offsetAt(pos)).map(l=>this.location(l));
  }
  async references(doc,pos,includeDeclaration,token) {
    if(!this.members.has(key(doc.uri.fsPath))) return [];
    this.changedDocument(doc);
    if(this.backend.running) {
      try {return await this.backend.references(doc,pos,includeDeclaration,token) || [];}
      catch(e) {this.output.appendLine(`引用查询：${e.message}`);return [];}
    }
    return this.index.references(doc.uri.fsPath,doc.offsetAt(pos),includeDeclaration).map(l=>this.location(l));
  }
  symbols(doc) {
    if(!this.members.has(key(doc.uri.fsPath))) return [];
    this.changedDocument(doc);
    return this.index.modules().filter(m=>key(m.path)===key(doc.uri.fsPath)).map(m=>new vscode.SymbolInformation(m.name,vscode.SymbolKind.Module,'',this.location(m)));
  }
  async navigate(peek) {
    const editor=vscode.window.activeTextEditor;if(!editor) return;
    const locations=await this.definitions(editor.document,editor.selection.active,new vscode.CancellationTokenSource().token);
    const targets=(locations || []).map(l=>l.targetUri ? new vscode.Location(l.targetUri,l.targetSelectionRange || l.targetRange):l);
    if(!targets.length) {vscode.window.showInformationMessage('当前工程中没有找到定义。请检查文件集、宏定义和 include 路径。');return;}
    await vscode.commands.executeCommand('editor.action.goToLocations',editor.document.uri,editor.selection.active,targets,peek?'peek':'goto','未找到定义',peek);
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
    const picked=await vscode.window.showQuickPick(this.project.filesets.filter(s=>/design/i.test(s.type)).map(s=>({label:s.name,description:s.type})),{title:'选择设计文件集'});
    if(!picked)return;this.fileset=picked.label;this.top=undefined;
    await this.context.workspaceState.update('fileset',this.fileset);await this.context.workspaceState.update('top',undefined);await this.refresh();
  }
  async chooseTop() {
    const picked=await vscode.window.showQuickPick([{label:'使用 XPR 顶层',value:undefined},...this.index.modules().map(m=>({label:m.name,description:path.basename(m.path),value:m.name}))],{title:'选择顶层模块'});
    if(!picked)return;this.top=picked.value;await this.context.workspaceState.update('top',this.top);await this.refresh();
  }
  async exportFilelist() {
    if(!this.project) return this.selectProject();
    const uri=await vscode.window.showSaveDialog({title:'导出工程源文件清单',defaultUri:vscode.Uri.file(path.join(this.project.root,`${this.project.name}-sources.f`)),filters:{Filelist:['f']}});
    if(!uri)return;
    const protectedKeys=new Set([this.project.path,...this.project.files.map(f=>f.path).filter(Boolean)].map(key));
    if(protectedKeys.has(key(uri.fsPath)))throw new Error('导出路径指向工程输入文件，请选择其他文件名。');
    await vscode.workspace.fs.writeFile(uri,Buffer.from(filelist(this.project,path.dirname(uri.fsPath)),'utf8'));
    await vscode.window.showTextDocument(uri);
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
  dispose() {clearTimeout(this.refreshTimer);clearTimeout(this.treeTimer);this.clearWatchers();void this.backend.stop();}
}

function activate(context) {
  const app = new Workbench(context);active=app;
  const commands={selectProject:u=>app.selectProject(u),refresh:()=>app.refresh(),selectFileset:()=>app.chooseFileset(),selectTop:()=>app.chooseTop(),exportFilelist:()=>app.exportFilelist(),projectInfo:()=>app.info(),peekDefinition:()=>app.navigate(true),gotoDefinition:()=>app.navigate(false),parentConnections:()=>app.findReferences(),openLocation:l=>app.openLocation(l),openHierarchy:p=>app.backend.showHierarchy(p)};
  for(const [name,handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`fpgaWorkbench.${name}`,async(...args)=>{try{return await handler(...args);}catch(e){app.report(e);}}));
  void app.restore().catch(e=>app.report(e));
  return {workbench:app};
}
async function deactivate() {if(active)await active.backend.stop();}
module.exports={activate,deactivate};
