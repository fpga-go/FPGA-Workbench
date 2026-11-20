'use strict';

const { createTokenizer, HdlTokenDocument } = require('./hdl-tokens');

// Optional fixed foregrounds. The default mode leaves token colors to the theme.
// In fixed mode VS Code selects the palette by theme kind, never by theme name.
const PALETTES = Object.freeze({
  light: Object.freeze({
    text: '#383A42', comment: '#008000', string: '#A31515', number: '#098658',
    declaration: '#0000FF', type: '#267F99', assignment: '#A05A00', keyword: '#AF00DB',
    module: '#267F99', function: '#795E26', macro: '#995C00'
  }),
  dark: Object.freeze({
    text: '#D4D4D4', comment: '#6A9955', string: '#CE9178', number: '#B5CEA8',
    declaration: '#569CD6', type: '#4EC9B0', assignment: '#CE9178', keyword: '#C586C0',
    module: '#4EC9B0', function: '#DCDCAA', macro: '#9CDCFE'
  })
});
const CATEGORIES = Object.keys(PALETTES.dark);
// Retain the native selected foreground's light/dark direction, with a green tint.
// VS Code resolves these variables; no theme name or configuration lookup is needed.
// This is a tint, not a general contrast solver for arbitrary custom backgrounds.
const SELECTED_COMMENT_COLORS = Object.freeze({
  light: 'color-mix(in srgb, var(--vscode-editor-selectionForeground, var(--vscode-editor-foreground)) 80%, #008000 20%)',
  dark: 'color-mix(in srgb, var(--vscode-editor-selectionForeground, var(--vscode-editor-foreground)) 80%, #00FF00 20%)'
});
const INACTIVE_SELECTED_COMMENT_COLORS = Object.freeze({
  light: 'color-mix(in srgb, var(--vscode-editor-foreground) 80%, #008000 20%)',
  dark: SELECTED_COMMENT_COLORS.dark
});
const supported = document => !!document && !document.isClosed &&
  (document.languageId === 'verilog' || document.languageId === 'systemverilog');
const documentKey = document => document.uri.toString();
const compare = (left, right) => left.line - right.line || left.character - right.character;

function selectionsFor(editor) {
  const selected = (editor.selections || []).filter(range => compare(range.start, range.end) < 0)
    .map(range => ({ start: range.start, end: range.end }))
    .sort((left, right) => compare(left.start, right.start) || compare(left.end, right.end));
  const merged = [];
  for (const range of selected) {
    const previous = merged[merged.length - 1];
    if (previous && compare(range.start, previous.end) <= 0) {
      if (compare(range.end, previous.end) > 0) previous.end = range.end;
    } else merged.push(range);
  }
  return merged;
}

// Fixed syntax colors yield to native selection rendering. Selected comments
// receive a separate tint based on that native selected foreground.
function outsideSelections(ranges, selected, Range) {
  if (!selected.length) return ranges;
  const result = [];
  let first = 0;
  for (const range of ranges) {
    while (first < selected.length && compare(selected[first].end, range.start) <= 0) first++;
    let cursor = range.start;
    for (let index = first; index < selected.length && compare(selected[index].start, range.end) < 0; index++) {
      const selection = selected[index];
      if (compare(selection.start, cursor) > 0) {
        result.push(new Range(cursor.line, cursor.character, selection.start.line, selection.start.character));
      }
      if (compare(selection.end, cursor) > 0) cursor = selection.end;
      if (compare(cursor, range.end) >= 0) break;
    }
    if (compare(cursor, range.end) < 0) result.push(new Range(cursor.line, cursor.character, range.end.line, range.end.character));
  }
  return result;
}

function insideSelections(ranges, selected, Range) {
  const result = [];
  let first = 0;
  for (const range of ranges) {
    while (first < selected.length && compare(selected[first].end, range.start) <= 0) first++;
    for (let index = first; index < selected.length && compare(selected[index].start, range.end) < 0; index++) {
      const start = compare(selected[index].start, range.start) > 0 ? selected[index].start : range.start;
      const end = compare(selected[index].end, range.end) < 0 ? selected[index].end : range.end;
      if (compare(start, end) < 0) result.push(new Range(start.line, start.character, end.line, end.character));
    }
  }
  return result;
}

class HdlHighlighter {
  constructor(vscode, extensionPath, options = {}) {
    this.vscode = vscode;
    this.mode = this.readMode();
    this.palettes = this.readPalettes();
    this.entries = new Map();
    this.pending = new Map();
    this.running = new Set();
    this.visibleEditors = new Set();
    this.appliedSelections = new WeakMap();
    this.errors = new Map();
    this.disposed = false;
    this.delay = options.delay ?? 60;
    this.onError = options.onError || (() => {});
    this.types = new Map(CATEGORIES.map(category => [category,
      vscode.window.createTextEditorDecorationType({
        color: this.palettes.dark[category],
        light: { color: this.palettes.light[category] },
        dark: { color: this.palettes.dark[category] },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
      })
    ]));
    this.selectedCommentType = vscode.window.createTextEditorDecorationType({
      color: SELECTED_COMMENT_COLORS.dark,
      light: { color: SELECTED_COMMENT_COLORS.light },
      dark: { color: SELECTED_COMMENT_COLORS.dark },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    this.selectedCommentInactiveType = vscode.window.createTextEditorDecorationType({
      color: INACTIVE_SELECTED_COMMENT_COLORS.dark,
      light: { color: INACTIVE_SELECTED_COMMENT_COLORS.light },
      dark: { color: INACTIVE_SELECTED_COMMENT_COLORS.dark },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisible()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisible()),
      vscode.window.onDidChangeWindowState(() => this.refreshVisible()),
      vscode.window.onDidChangeTextEditorVisibleRanges(event => {
        if (supported(event.textEditor.document)) this.schedule(event.textEditor.document, 0);
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.refreshVisible(true)),
      vscode.window.onDidChangeTextEditorSelection(event => this.selection(event.textEditor)),
      vscode.workspace.onDidOpenTextDocument(() => this.refreshVisible()),
      vscode.workspace.onDidCloseTextDocument(document => this.close(document)),
      vscode.workspace.onDidChangeTextDocument(event => this.change(event)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!['mode', 'lightColors', 'darkColors'].some(key => event.affectsConfiguration('fpgaWorkbench.highlighting.' + key))) return;
        this.reloadConfiguration();
      })
    ];
    this.ready = Promise.resolve().then(() => (options.createTokenizer || createTokenizer)(extensionPath))
      .then(tokenizer => {
        if (this.disposed) { tokenizer.dispose(); return undefined; }
        this.tokenizer = tokenizer;
        return tokenizer;
      }).catch(error => {
        this.initializationError = error;
        this.reportInitializationError();
        return undefined;
      });
    this.refreshVisible();
  }

  readMode() {
    const mode = this.vscode.workspace.getConfiguration('fpgaWorkbench').get('highlighting.mode', 'theme');
    return ['fixed', 'custom'].includes(mode) ? mode : 'theme';
  }

  reloadConfiguration() {
    const vscode = this.vscode;
  this.mode = this.readMode();
  const palettes = this.readPalettes();
  if (JSON.stringify(palettes) !== JSON.stringify(this.palettes)) {
    for (const editor of this.visibleEditors) this.clearEditor(editor);
    for (const type of this.types.values()) type.dispose();
    this.palettes = palettes;
    this.types = new Map(CATEGORIES.map(category => [category, vscode.window.createTextEditorDecorationType({
      color: palettes.dark[category], light: {color: palettes.light[category]}, dark: {color: palettes.dark[category]},
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    })]));
  }
  this.reportInitializationError();
  this.refreshVisible(true);
  }

  async selectScheme() {
    const cfg = this.vscode.workspace.getConfiguration('fpgaWorkbench');
    const current = this.readMode();
    const items = [
      {label: '旧版固定配色', value: 'fixed', description: '按深色或浅色主题使用内置颜色'},
      {label: '自定义配色', value: 'custom', description: '使用 lightColors / darkColors'},
      {label: '跟随当前主题', value: 'theme', description: '由 TextMate 语法规则和当前主题着色'},
      {label: '编辑自定义颜色', value: 'edit', description: '打开深色和浅色配色设置'}
    ];
    for (const item of items) if (item.value === current) item.description = '当前方案 · ' + item.description;
    const picked = await this.vscode.window.showQuickPick(items, {title: 'HDL 语法配色', placeHolder: '选择配色方案'});
    if (!picked || this.disposed) return;
    if (picked.value === 'edit') return this.vscode.commands.executeCommand('workbench.action.openSettings', 'fpgaWorkbench.highlighting');
    // Update an existing workspace override rather than silently changing an
    // ineffective global value. With no override, remember the user choice globally.
    const scope = cfg.inspect('highlighting.mode');
    const target = scope?.workspaceValue !== undefined ? this.vscode.ConfigurationTarget.Workspace : this.vscode.ConfigurationTarget.Global;
    await cfg.update('highlighting.mode', picked.value, target);
    this.reloadConfiguration();
    // Selecting the current scheme is also an explicit repaint request.
    for (const editor of this.visibleEditors) this.clearEditor(editor);
    this.refreshVisible(true);
    await this.whenIdle();
    if (this.mode !== 'theme' && this.initializationError) throw this.initializationError;
    if (this.errors.size) throw new Error([...this.errors.values()].join('\n'));
    return this.mode;
  }

  readPalettes() {
    if (this.mode !== 'custom') return PALETTES;
    const cfg = this.vscode.workspace.getConfiguration('fpgaWorkbench');
    return Object.fromEntries(['light', 'dark'].map(kind => {
      const values = cfg.get('highlighting.' + kind + 'Colors', {});
      return [kind, Object.fromEntries(CATEGORIES.map(category => [category,
        values && typeof values[category] === 'string' && /^#[0-9a-f]{6}$/i.test(values[category]) ? values[category] : PALETTES[kind][category]]))];
    }));
  }

  shouldPaint(document) { return this.mode !== 'theme' && supported(document); }

  reportInitializationError() {
    if (!this.disposed && this.mode !== 'theme' && this.initializationError && !this.initializationErrorReported) {
      this.initializationErrorReported = true;
      this.onError(this.initializationError);
    }
  }

  editors(document) {
    return this.vscode.window.visibleTextEditors.filter(editor =>
      editor.document === document && this.shouldPaint(document));
  }

  cancel(key) {
    const ticket = this.pending.get(key);
    if (!ticket) return;
    clearTimeout(ticket.timer);
    this.pending.delete(key);
    ticket.resolve();
  }

  clearEditor(editor) {
    this.appliedSelections.delete(editor);
    for (const type of [...this.types.values(), this.selectedCommentType, this.selectedCommentInactiveType]) {
      try { editor.setDecorations(type, []); } catch { /* Editor may have closed. */ }
    }
  }

  applyEditor(editor, entry) {
    if (this.disposed || !this.shouldPaint(editor.document)) { this.clearEditor(editor); return; }
    const selected = selectionsFor(editor);
    const signature = selected.map(range => `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`).join(',');
    const active = this.vscode.window.activeTextEditor === editor && this.vscode.window.state.focused;
    const applied = this.appliedSelections.get(editor);
    if (applied?.ranges === entry.ranges && applied.signature === signature && applied.active === active) return;
    for (const [category, type] of this.types) {
      editor.setDecorations(type, outsideSelections(entry.ranges[category], selected, this.vscode.Range));
    }
    const comments = this.mode === 'fixed' ? insideSelections(entry.ranges.comment, selected, this.vscode.Range) : [];
    // Clear the previous role first; a range must never receive both tints.
    editor.setDecorations(active ? this.selectedCommentInactiveType : this.selectedCommentType, []);
    editor.setDecorations(active ? this.selectedCommentType : this.selectedCommentInactiveType, comments);
    this.appliedSelections.set(editor, { ranges: entry.ranges, signature, active });
  }

  selection(editor) {
    if (this.disposed) return;
    if (!this.shouldPaint(editor.document)) { this.clearEditor(editor); return; }
    if (!this.vscode.window.visibleTextEditors.includes(editor)) return;
    const document = editor.document, key = documentKey(document), entry = this.entries.get(key);
    if (entry?.document === document && entry.language === document.languageId &&
        entry.version === document.version && entry.ranges) {
      this.applyEditor(editor, entry);
    } else {
      this.clearEditor(editor);
      if (!this.pending.has(key)) this.schedule(document, 0, true);
    }
  }

  refreshVisible(force = false) {
    if (this.disposed) return;
    const editors = this.vscode.window.visibleTextEditors;
    // Decorations belong to an editor, while token state belongs to a document.
    // A new split must receive the cached ranges even if coverage is sufficient.
    force ||= editors.some(editor => !this.visibleEditors.has(editor));
    // Clear hidden editors while we still hold their references. This prevents
    // old foregrounds returning when a tab or split becomes visible again.
    for (const editor of new Set([...this.visibleEditors, ...editors])) {
      if (!editors.includes(editor) || !this.shouldPaint(editor.document)) this.clearEditor(editor);
    }
    this.visibleEditors = new Set(editors);
    const visible = new Map();
    for (const editor of editors) {
      if (this.shouldPaint(editor.document)) visible.set(documentKey(editor.document), editor.document);
    }
    for (const key of new Set([...this.entries.keys(), ...this.pending.keys()])) {
      if (!visible.has(key)) {
        this.cancel(key);
        this.entries.delete(key);
        this.errors.delete(key);
      }
    }
    for (const document of visible.values()) this.schedule(document, 0, force);
    for (const editor of editors) if (this.shouldPaint(editor.document)) this.selection(editor);
  }

  change(event) {
    const document = event.document;
    if (this.disposed) return;
    if (!supported(document)) { this.refreshVisible(); return; }
    if (!this.editors(document).length || !event.contentChanges.length) return;
    const entry = this.entries.get(documentKey(document));
    if (entry?.document === document) {
      const first = Math.min(...event.contentChanges.map(change => change.range.start.line));
      entry.dirtyFrom = Math.min(entry.dirtyFrom ?? first, first);
    }
    this.schedule(document, this.delay);
  }

  close(document) {
    const key = documentKey(document);
    // Changing language can close an old document and open another at the same URI.
    if (this.entries.get(key)?.document === document) {
      this.cancel(key);
      this.entries.delete(key);
      this.errors.delete(key);
    }
    this.refreshVisible();
  }

  schedule(document, delay = this.delay, force = false) {
    if (this.disposed || !this.shouldPaint(document) || !this.editors(document).length) return;
    const key = documentKey(document);
    const previous = this.pending.get(key);
    force ||= previous?.force || false;
    this.cancel(key);
    let resolve;
    const done = new Promise(complete => { resolve = complete; });
    const ticket = { document, force, done, resolve };
    this.pending.set(key, ticket);
    ticket.timer = setTimeout(() => {
      ticket.timer = undefined;
      const task = this.paint(document, ticket).catch(error => {
        if (this.disposed || this.pending.get(key) !== ticket) return;
        for (const editor of this.editors(document)) this.clearEditor(editor);
        this.entries.delete(key);
        if (this.errors.get(key) !== error.message) {
          this.errors.set(key, error.message);
          this.onError(error);
        }
      }).finally(() => {
        if (this.pending.get(key) === ticket) this.pending.delete(key);
        this.running.delete(task);
        resolve();
      });
      this.running.add(task);
    }, delay);
  }

  async paint(document, ticket) {
    const key = documentKey(document);
    const current = () => !this.disposed && this.shouldPaint(document) &&
      this.pending.get(key) === ticket && this.editors(document).length > 0;
    const tokenizer = await this.ready;
    if (!tokenizer || !current()) return;
    const language = document.languageId;
    const version = document.version;
    const unchanged = () => current() && document.version === version && document.languageId === language;
    let entry = this.entries.get(key);
    if (!entry || entry.document !== document || entry.language !== language) {
      const grammar = await tokenizer.grammar(language);
      if (!unchanged()) return;
      entry = { document, language, model: new HdlTokenDocument(grammar), version: -1, paintedEnd: -1 };
      this.entries.set(key, entry);
    }
    if (entry.version !== version) {
      entry.lines = document.getText().split(/\r\n|\n|\r/);
      entry.model.update(entry.lines, version, entry.dirtyFrom ?? 0);
      entry.version = version;
      entry.dirtyFrom = undefined;
      entry.paintedEnd = -1;
      entry.ranges = undefined;
    }
    const visibleEnd = Math.max(...this.editors(document).flatMap(editor =>
      editor.visibleRanges.length ? editor.visibleRanges.map(range => range.end.line + 20) : [0]));
    const wanted = Math.min(entry.lines.length - 1, visibleEnd);
    if (!ticket.force && entry.paintedEnd >= wanted) return;
    const end = Math.min(entry.lines.length - 1, Math.max(wanted, entry.paintedEnd));
    if (!await entry.model.ensure(end, () => !unchanged()) || !unchanged()) return;
    const ranges = Object.fromEntries(CATEGORIES.map(category => [category, []]));
    // Retain the parsed prefix as well as the viewport: Sticky Scroll renders
    // module headers above the viewport using these same inline decorations.
    for (let line = 0; line <= end; line++) {
      if (line && line % 256 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!unchanged()) return;
      }
      for (const token of entry.model.tokens(line)) {
        if (token.endIndex <= token.startIndex) continue;
        // Native bracket-pair colorization owns both keyword and symbol pairs.
        // A fixed foreground here would override its per-depth theme colors.
        if (token.category === 'bracket') continue;
        const category = ranges[token.category] ? token.category : 'text';
        ranges[category].push(new this.vscode.Range(line, token.startIndex, line, token.endIndex));
      }
    }
    if (!unchanged()) return;
    entry.ranges = ranges;
    for (const editor of this.editors(document)) {
      this.applyEditor(editor, entry);
    }
    entry.paintedEnd = end;
    this.errors.delete(key);
  }

  async whenIdle() {
    await this.ready;
    while (!this.disposed && (this.pending.size || this.running.size)) {
      await Promise.all([...this.pending.values()].map(ticket => ticket.done).concat([...this.running]));
    }
  }

  snapshot() {
    return [...this.entries.values()].map(entry => ({
      uri: documentKey(entry.document), language: entry.language, version: entry.version,
      paintedEnd: entry.paintedEnd, lineCount: entry.lines?.length || 0
    }));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const key of this.pending.keys()) this.cancel(key);
    for (const type of this.types.values()) type.dispose();
    this.selectedCommentType.dispose();
    this.selectedCommentInactiveType.dispose();
    this.entries.clear();
    this.errors.clear();
    this.visibleEditors.clear();
    this.tokenizer?.dispose();
  }
}

module.exports = { HdlHighlighter, PALETTES, SELECTED_COMMENT_COLORS, INACTIVE_SELECTED_COMMENT_COLORS };
