'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HdlHighlighter, PALETTES, SELECTED_COMMENT_COLORS, INACTIVE_SELECTED_COMMENT_COLORS } = require('../src/highlighting');
const SELECTED_COMMENT_COLOR = SELECTED_COMMENT_COLORS.light;
const isSelectedCommentType = type => type.options.color?.startsWith('color-mix(');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

class Emitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
}
class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'number' ? { line: a, character: b } : a;
    this.end = typeof a === 'number' ? { line: c, character: d } : b;
  }
  get isEmpty() { return comparePosition(this.start, this.end) === 0; }
}
const comparePosition = (a, b) => a.line - b.line || a.character - b.character;
class Selection extends Range {
  constructor(a, b, c, d) {
    const anchor = typeof a === 'number' ? { line: a, character: b } : a;
    const active = typeof a === 'number' ? { line: c, character: d } : b;
    super(comparePosition(anchor, active) <= 0 ? anchor : active,
      comparePosition(anchor, active) <= 0 ? active : anchor);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() { return comparePosition(this.anchor, this.active) > 0; }
}

// A deliberately small stateful lexer: controller tests do not repeat grammar coverage.
function grammar(hook = () => {}) {
  const calls = [];
  const plain = Object.freeze({ block: false }), block = Object.freeze({ block: true });
  return {
    calls,
    tokenizeLine(line, state, limit) {
      calls.push({ line, limit });
      hook(line, calls.length);
      if (state?.block || line.startsWith('/*')) {
        return { tokens: [{ startIndex: 0, endIndex: line.length, scopes: ['source.verilog', 'comment.block'] }],
          ruleStack: line.includes('*/') ? plain : block, stoppedEarly: false };
      }
      if (line.startsWith('//')) return { tokens: [{ startIndex: 0, endIndex: line.length, scopes: ['comment.line'] }], ruleStack: plain, stoppedEarly: false };
      if (line.startsWith('`define')) return { tokens: [{ startIndex: 0, endIndex: line.length, scopes: ['meta.preprocessor.define.verilog'] }], ruleStack: plain, stoppedEarly: false };
      const tokens = [];
      for (const match of line.matchAll(/\\[^\s]+|"(?:\\.|[^"\\])*"|\d+|[A-Za-z_][\w$]*|[^\w"\\]+/g)) {
        const scope = match[0].startsWith('\\') ? 'meta.identifier.escaped.verilog'
          : match[0].startsWith('"') ? 'string.quoted.double.verilog'
          : /^(wire|reg|logic|module|endmodule|assign|always|if|begin|end)$/.test(match[0]) ? 'keyword.other.verilog'
          : /^\d+$/.test(match[0]) ? 'constant.numeric.verilog' : 'meta.identifier.verilog';
        tokens.push({ startIndex: match.index, endIndex: match.index + match[0].length, scopes: ['source.verilog', scope] });
      }
      return { tokens, ruleStack: plain, stoppedEarly: false };
    }
  };
}

function harness(options = {}) {
  // Existing palette tests explicitly opt in. Passing mode: undefined models
  // a fresh installation with no user or workspace setting.
  let mode = Object.hasOwn(options, 'mode') ? options.mode : 'fixed';
  const events = Object.fromEntries(['visible', 'active', 'ranges', 'theme', 'selection', 'window', 'open', 'close', 'change', 'configuration'].map(name => [name, new Emitter()]));
  const types = [], editors = [], writes = [], reads = [], errors = [], calls = [], grammarRequests = [];
  let nextDocument = 0;
  const theme = { kind: 1 };
  for (const name of ['name', 'label', 'id']) Object.defineProperty(theme, name, { get() { throw new Error('Theme names must not control HDL colors'); } });
  const vscode = {
    Range, Selection,
    DecorationRangeBehavior: { ClosedClosed: 1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
      visibleTextEditors: [], activeTextEditor: undefined, activeColorTheme: theme, state: { focused: true },
      createTextEditorDecorationType(options) {
        const type = { options, disposeCount: 0, dispose() {
          this.disposeCount++;
          for (const editor of editors) editor.applied.delete(this);
        } };
        types.push(type);
        return type;
      },
      onDidChangeVisibleTextEditors: events.visible.event,
      onDidChangeActiveTextEditor: events.active.event,
      onDidChangeTextEditorVisibleRanges: events.ranges.event,
      onDidChangeActiveColorTheme: events.theme.event,
      onDidChangeTextEditorSelection: events.selection.event,
      onDidChangeWindowState: events.window.event
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'fpgaWorkbench', 'Coloring may only read its own configuration');
        reads.push([section]);
        return { get(key, fallback) {
          assert.ok(['highlighting.mode', 'highlighting.lightColors', 'highlighting.darkColors'].includes(key), 'Theme names and editor color settings must not be consulted');
          reads.push([key]); if (key !== 'highlighting.mode') return options[key] || fallback; return mode === undefined ? fallback : mode;
        },
          update(...args) { writes.push(args); throw new Error('Coloring must not write user configuration'); } };
      },
      fs: { writeFile() { throw new Error('Coloring must not write source files'); } },
      onDidOpenTextDocument: events.open.event,
      onDidCloseTextDocument: events.close.event,
      onDidChangeTextDocument: events.change.event,
      onDidChangeConfiguration: events.configuration.event
    }
  };
  const grammars = { verilog: grammar(), systemverilog: grammar() };
  const tokenizer = {
    disposeCount: 0,
    grammar(language) { grammarRequests.push(language); return Promise.resolve(grammars[language]); },
    dispose() { this.disposeCount++; }
  };
  const h = {
    vscode, events, types, editors, writes, reads, errors, calls, grammars, grammarRequests, tokenizer, theme,
    mode(value) {
      mode = value;
      events.configuration.fire({affectsConfiguration: section => section === 'fpgaWorkbench.highlighting.mode' || section === 'fpgaWorkbench'});
    },
    assertModeOnlyReads() {
      assert(reads.every(([name]) => ['fpgaWorkbench', 'highlighting.mode'].includes(name)));
      assert.deepEqual(writes, []);
    },
    document(languageId = 'verilog', text = 'wire payload;', uri = `file:///synthetic-${++nextDocument}.v`) {
      return { languageId, text, version: 1, isClosed: false,
        uri: { scheme: uri.split(':')[0], toString: () => uri }, getText() { return this.text; } };
    },
    editor(document, endLine = 5) {
      const editor = { document, visibleRanges: [new Range(0, 0, endLine, 0)], selections: [new Selection(0, 0, 0, 0)], applied: new Map(),
        get selection() { return this.selections[0]; },
        setDecorations(type, ranges) {
          assert.equal(type.disposeCount, 0, 'A disposed type must never be reused');
          const copied = ranges.map(range => ({ start: { ...range.start }, end: { ...range.end } }));
          this.applied.set(type, copied);
          calls.push({ editor: this, type, ranges: copied, version: this.document.version, text: this.document.text,
            active: vscode.window.activeTextEditor === this && vscode.window.state.focused !== false,
            selections: this.selections.map(selection => ({ start: { ...selection.start }, end: { ...selection.end } })) });
        } };
      editors.push(editor);
      return editor;
    },
    visible(visible) {
      vscode.window.visibleTextEditors = visible;
      vscode.window.activeTextEditor = visible[0];
      events.visible.fire(visible);
    },
    active(editor) {
      vscode.window.activeTextEditor = editor;
      events.active.fire(editor);
    },
    focus(focused) {
      vscode.window.state = { focused };
      events.window.fire(vscode.window.state);
    },
    edit(document, text, line = 0) {
      document.text = text;
      document.version++;
      events.change.fire({ document, contentChanges: [{ range: new Range(line, 0, line, 1), text }] });
    },
    select(editor, selections) {
      editor.selections = selections;
      events.selection.fire({ textEditor: editor, selections, kind: 2 });
    },
    service(t, options = {}) {
      const service = new HdlHighlighter(vscode, '/synthetic-extension', {
        createTokenizer: async () => tokenizer, delay: 1, onError: error => errors.push(error), ...options
      });
      t.after(() => service.dispose());
      return service;
    },
    nonempty(editor) { return calls.filter(call => call.editor === editor && call.ranges.length); },
    colorAt(editor, line, column, kind = theme.kind) {
      const matches = [];
      for (const [type, ranges] of editor.applied) {
        if (type.disposeCount) continue;
        if (ranges.some(range => range.start.line === line && range.start.character <= column && range.end.character > column)) {
          const palette = kind === 1 || kind === 4 ? type.options.light : type.options.dark;
          matches.push(palette?.color ?? type.options.color);
        }
      }
      assert.equal(matches.length, 1, `Expected one non-overlapping color at ${line}:${column}`);
      return matches[0];
    },
    listeners() { return Object.values(events).reduce((sum, event) => sum + event.listeners.size, 0); }
  };
  return h;
}

function assertThemeOwnsEditor(h, service, editor) {
  for (const ranges of editor.applied.values()) assert.equal(ranges.length, 0, 'No fixed foreground or selected-comment tint may remain');
  assert.deepEqual(service.snapshot(), []);
  assert.equal(service.pending.size, 0);
  h.assertModeOnlyReads();
}

test('an unset highlighting mode leaves all four native theme kinds in control', async t => {
  for (const kind of [1, 2, 3, 4]) {
    const h = harness({mode: undefined}); h.theme.kind = kind;
    const doc = h.document('systemverilog', '// native comment\nmodule reader(input wire clk);\nendmodule'), editor = h.editor(doc);
    editor.selections = [new Selection(0, 3, 0, 9)];
    h.visible([editor]);
    const service = h.service(t);
    await service.whenIdle();
    h.select(editor, [new Selection(0, 0, 1, 6)]);
    h.edit(doc, '// changed native comment\nmodule reader;\nendmodule');
    h.events.ranges.fire({textEditor: editor});
    h.events.theme.fire(h.theme);
    h.focus(false); h.focus(true);
    await service.whenIdle();
    assertThemeOwnsEditor(h, service, editor);
    assert.equal(h.nonempty(editor).length, 0, `Theme kind ${kind} must never receive a fixed range`);
    assert.equal(h.grammarRequests.length, 0, 'Native theming does not need the decoration tokenizer');
  }
});

test('invalid highlighting modes conservatively preserve native theme colors', async t => {
  for (const mode of ['auto', '', null, true]) {
    const h = harness({mode}), doc = h.document(), editor = h.editor(doc);
    h.visible([editor]);
    const service = h.service(t);
    await service.whenIdle();
    assertThemeOwnsEditor(h, service, editor);
    assert.equal(h.nonempty(editor).length, 0);
  }
});

test('switching from fixed to theme clears both selection tints and previously hidden split editors', async t => {
  const h = harness(), doc = h.document('verilog', '// selected comment\nwire payload;');
  const first = h.editor(doc), second = h.editor(doc);
  first.selections = [new Selection(0, 3, 0, 10)];
  second.selections = [new Selection(0, 4, 0, 12)];
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  assert(first.applied.get(service.selectedCommentType)?.length);
  assert(second.applied.get(service.selectedCommentInactiveType)?.length);
  h.visible([first]);
  await service.whenIdle();
  const calls = h.calls.length;
  h.mode('theme');
  assertThemeOwnsEditor(h, service, first);
  assertThemeOwnsEditor(h, service, second);
  h.visible([first, second]);
  h.select(second, [new Selection(0, 0, 1, 8)]);
  h.theme.kind = 2; h.events.theme.fire(h.theme);
  await service.whenIdle();
  assert(h.calls.slice(calls).every(call => call.ranges.length === 0));
  assertThemeOwnsEditor(h, service, first);
  assertThemeOwnsEditor(h, service, second);
  h.mode('fixed');
  await service.whenIdle();
  assert.equal(service.snapshot().length, 1);
  assert.equal(h.colorAt(first, 1, 6), PALETTES.dark.text);
  assert(second.applied.get(service.selectedCommentInactiveType)?.length, 'Opting back in restores the current split selection only');
});

test('switching to theme cancels pending work before delayed initialization resolves', async t => {
  const h = harness(), gate = deferred(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, {createTokenizer: () => gate.promise});
  await turn();
  h.mode('theme');
  assertThemeOwnsEditor(h, service, editor);
  gate.resolve(h.tokenizer);
  await service.whenIdle();
  assert.equal(h.nonempty(editor).length, 0, 'A late tokenizer cannot reapply fixed colors');
  assertThemeOwnsEditor(h, service, editor);
});

test('a delayed grammar cannot restore fixed colors after switching to theme', async t => {
  const h = harness(), gate = deferred(), entered = deferred(), doc = h.document(), editor = h.editor(doc);
  h.tokenizer.grammar = () => { entered.resolve(); return gate.promise; };
  h.visible([editor]);
  const service = h.service(t);
  await entered.promise;
  h.mode('theme');
  gate.resolve(h.grammars.verilog);
  await service.whenIdle();
  assert.equal(h.nonempty(editor).length, 0);
  assertThemeOwnsEditor(h, service, editor);
});

test('switching to theme during yielded tokenization prevents late foreground publication', async t => {
  const h = harness(), doc = h.document('verilog', Array.from({length: 700}, (_, index) => `wire data_${index};`).join('\n')), editor = h.editor(doc, 699);
  let switched = false;
  h.grammars.verilog = grammar(() => {
    if (!switched) { switched = true; setTimeout(() => h.mode('theme'), 0); }
  });
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assert(switched);
  assert.equal(h.nonempty(editor).length, 0);
  assertThemeOwnsEditor(h, service, editor);
});

test('switching to theme cancels delayed edits and a later fixed choice paints only fresh text', async t => {
  const h = harness(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, {delay: 100});
  await service.whenIdle();
  h.edit(doc, '// latest text waiting for debounce');
  const calls = h.calls.length;
  h.mode('theme');
  await service.whenIdle();
  assertThemeOwnsEditor(h, service, editor);
  assert(h.calls.slice(calls).every(call => !call.ranges.length));
  h.mode('fixed');
  await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 4), PALETTES.light.comment);
  assert(h.calls.slice(calls).filter(call => call.ranges.length).every(call => call.version === doc.version));
});

test('native mode does not report an unused fixed-color tokenizer failure', async t => {
  const h = harness({mode: undefined}), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, {createTokenizer: async () => { throw new Error('fixed tokenizer unavailable'); }});
  await service.whenIdle();
  assert.equal(h.errors.length, 0, 'Native TextMate colors do not depend on the decoration tokenizer');
  assertThemeOwnsEditor(h, service, editor);
  h.mode('fixed');
  await service.whenIdle();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /fixed tokenizer unavailable/);
  h.mode('theme'); h.mode('fixed');
  await service.whenIdle();
  assert.equal(h.errors.length, 1, 'The same initialization failure is reported only once');
  assert.equal(h.nonempty(editor).length, 0);
});

function assertNoOldRangesOnNewComment(h, editor) {
  for (const call of h.nonempty(editor)) {
    if (!call.text.startsWith('//')) continue;
    for (const range of call.ranges.filter(range => range.start.line === 0)) {
      assert.equal(call.type.options.dark.color, PALETTES.dark.comment,
        `A stale non-comment range reached the new comment at ${range.start.character}`);
    }
  }
}

test('fixed foreground types and existing visible HDL work without any project or theme name', async t => {
  const h = harness(), v = h.document(), sv = h.document('systemverilog', 'logic payload;'), untitled = h.document('systemverilog', 'logic draft;', 'untitled:Untitled-1');
  const editors = [h.editor(v), h.editor(sv), h.editor(untitled)];
  h.visible(editors);
  const service = h.service(t);
  await service.whenIdle();
  assert.equal(service.snapshot().length, 3);
  for (const editor of editors) assert(h.nonempty(editor).length > 0);
  assert.equal(h.colorAt(editors[0], 0, 6), PALETTES.light.text);
  assert.notEqual(h.colorAt(editors[0], 0, 1), PALETTES.light.text);
  assert(Object.isFrozen(service.palettes) && Object.isFrozen(service.palettes.light) && Object.isFrozen(service.palettes.dark));
  assert.equal(h.types.length, Object.keys(PALETTES.dark).length + 2);
  for (const type of h.types.filter(type => !isSelectedCommentType(type))) {
    assert.equal(type.options.rangeBehavior, h.vscode.DecorationRangeBehavior.ClosedClosed);
    assert.match(type.options.light.color, /^#[0-9a-f]{6}$/i);
    assert.match(type.options.dark.color, /^#[0-9a-f]{6}$/i);
    assert.deepEqual(Object.keys(type.options).sort(), ['color', 'dark', 'light', 'rangeBehavior']);
  }
  assert.equal(SELECTED_COMMENT_COLOR.replace(/\s/g, ''),
    'color-mix(insrgb,var(--vscode-editor-selectionForeground,var(--vscode-editor-foreground))80%,#00800020%)');
  assert.equal(SELECTED_COMMENT_COLORS.dark.replace(/\s/g, ''),
    'color-mix(insrgb,var(--vscode-editor-selectionForeground,var(--vscode-editor-foreground))80%,#00FF0020%)');
  assert(Object.isFrozen(SELECTED_COMMENT_COLORS));
  assert.deepEqual(service.selectedCommentType.options, {
    color: SELECTED_COMMENT_COLORS.dark,
    light: { color: SELECTED_COMMENT_COLORS.light }, dark: { color: SELECTED_COMMENT_COLORS.dark },
    rangeBehavior: h.vscode.DecorationRangeBehavior.ClosedClosed
  });
  assert.equal(INACTIVE_SELECTED_COMMENT_COLORS.light.replace(/\s/g, ''),
    'color-mix(insrgb,var(--vscode-editor-foreground)80%,#00800020%)');
  assert.equal(INACTIVE_SELECTED_COMMENT_COLORS.dark, SELECTED_COMMENT_COLORS.dark,
    'Dark inactive selections must retain native selectionForeground before falling back to editorForeground');
  assert(Object.isFrozen(INACTIVE_SELECTED_COMMENT_COLORS));
  assert.deepEqual(service.selectedCommentInactiveType.options, {
    color: INACTIVE_SELECTED_COMMENT_COLORS.dark,
    light: { color: INACTIVE_SELECTED_COMMENT_COLORS.light }, dark: { color: INACTIVE_SELECTED_COMMENT_COLORS.dark },
    rangeBehavior: h.vscode.DecorationRangeBehavior.ClosedClosed
  });
  assert.deepEqual(h.writes, []);
});

test('opening a second split of an already painted document replays cached colors', async t => {
  const h = harness(), doc = h.document(), first = h.editor(doc);
  h.visible([first]);
  const service = h.service(t);
  await service.whenIdle();
  const before = h.grammars.verilog.calls.length, second = h.editor(doc);
  h.visible([first, second]);
  h.events.active.fire(second); // VS Code can deliver both events in this order.
  await service.whenIdle();
  assert(h.nonempty(second).length > 0, 'New split must get colors even when parsed extent is unchanged');
  assert.equal(h.colorAt(first, 0, 6), h.colorAt(second, 0, 6));
  assert.equal(h.grammars.verilog.calls.length, before, 'Splitting must reuse lexical cache');
});

test('native brackets never receive fixed foreground while distinct keyword groups and lexical islands stay colored', async t => {
  const h = harness(), text = [
    'module example(input wire clk);', 'wire value;', 'reg state;', 'assign value = state;',
    'always @(clk) begin', 'if (state) begin', 'state <= 1;', 'end', 'end',
    'wire \\begin ;', 'wire foo$begin;', 'wire BEGIN;', '`define TEXT begin ( end )',
    '"begin ( end )"', '/* begin (', 'end ) */', 'endmodule'
  ].join('\n');
  const doc = h.document('verilog', text), first = h.editor(doc), second = h.editor(doc);
  const comments = commentLines(text, [14, 15]);
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  assert.equal(service.types.size, 11);
  assert.equal(service.types.has('bracket'), false, 'Native bracket category must not allocate a fixed foreground decoration');
  assert.equal(h.colorAt(first, 0, 1), PALETTES.light.declaration);
  assert.equal(h.colorAt(first, 1, 1), PALETTES.light.type);
  assert.equal(h.colorAt(first, 2, 1), PALETTES.light.type);
  assert.equal(h.colorAt(first, 3, 1), PALETTES.light.assignment);
  assert.equal(h.colorAt(first, 4, 1), PALETTES.light.keyword);
  assert.equal(h.colorAt(first, 5, 1), PALETTES.light.keyword);
  assert.equal(new Set(['declaration', 'type', 'assignment', 'keyword'].map(key => PALETTES.light[key])).size, 4);
  assert.equal(h.colorAt(first, 9, 7), PALETTES.light.text, 'Escaped begin is a normal identifier');
  assert.equal(h.colorAt(first, 10, 11), PALETTES.light.text, 'Dollar-containing identifier remains whole');
  assert.equal(h.colorAt(first, 11, 6), PALETTES.light.text, 'Uppercase BEGIN is case-sensitive identifier text');
  assert.equal(h.colorAt(first, 12, 14), PALETTES.light.macro, 'Macro body remains a protected lexical island');
  assert.equal(h.colorAt(first, 13, 3), PALETTES.light.string);
  assert.equal(h.colorAt(first, 14, 4), PALETTES.light.comment);
  for (const editor of [first, second]) assertSelectionCoverage(editor, comments);
  const parsed = h.grammars.verilog.calls.length;
  h.select(first, [new Selection(4, 0, 9, 0)]);
  h.select(second, [new Selection(14, 2, 15, 6)]);
  await service.whenIdle();
  for (const editor of [first, second]) assertSelectionCoverage(editor, comments);
  assert.equal(h.colorAt(second, 14, 4), INACTIVE_SELECTED_COMMENT_COLORS.light, 'Selected comment text may retain its separate tint');
  h.select(first, [new Selection(0, 0, 0, 0)]);
  h.select(second, [new Selection(0, 0, 0, 0)]);
  await service.whenIdle();
  for (const editor of [first, second]) {
    assertSelectionCoverage(editor, comments);
    assertPaintsRespectSelections(h, editor, () => comments);
  }
  assert.equal(h.grammars.verilog.calls.length, parsed, 'Bracket/selection projection reuses lexical state');
  h.assertModeOnlyReads();
  assert.deepEqual(h.writes, []);
});

test('hidden editors cancel work and the same editor instance repaints when shown again', async t => {
  const h = harness(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  h.visible([]);
  await service.whenIdle();
  assert.deepEqual(service.snapshot(), []);
  h.edit(doc, '// changed while hidden');
  const before = h.calls.length;
  h.visible([editor]);
  await service.whenIdle();
  assert(h.calls.length > before);
  assert.equal(h.colorAt(editor, 0, 5), PALETTES.light.comment);
  assert.equal(service.snapshot()[0].version, doc.version);
});

test('newly visible files paint, closed documents are removed, and unsupported languages stay clear', async t => {
  const h = harness(), service = h.service(t);
  await service.whenIdle();
  const doc = h.document(), editor = h.editor(doc), plain = h.editor(h.document('plaintext'));
  h.visible([editor, plain]);
  h.events.open.fire(doc);
  await service.whenIdle();
  assert(h.nonempty(editor).length);
  assert.equal(h.nonempty(plain).length, 0);
  doc.isClosed = true;
  h.visible([plain]);
  h.events.close.fire(doc);
  await service.whenIdle();
  assert.deepEqual(service.snapshot(), []);
});

test('language replacement at one URI cannot let a late old close discard the new document', async t => {
  const h = harness(), old = h.document(), editor = h.editor(old);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const plain = h.document('plaintext', 'plain text', old.uri.toString());
  old.isClosed = true; editor.document = plain;
  h.events.close.fire(old); h.events.open.fire(plain);
  await service.whenIdle();
  assert.equal(h.nonempty(editor).at(-1).text, old.text);
  for (const ranges of editor.applied.values()) assert.equal(ranges.length, 0);
  const live = h.document('systemverilog', 'logic current;', old.uri.toString());
  plain.isClosed = true; editor.document = live;
  h.events.open.fire(live);
  await service.whenIdle();
  h.events.close.fire(old);
  await service.whenIdle();
  assert.equal(service.snapshot()[0].language, 'systemverilog');
  assert.equal(h.colorAt(editor, 0, 7), PALETTES.light.text);
});

test('multiple dirty edits preserve only the genuinely unchanged lexical prefix', async t => {
  const h = harness(), doc = h.document('verilog', 'wire prefix;\n/* comment\nwire hidden;\n*/\nwire tail;'), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, { delay: 10 });
  await service.whenIdle();
  assert.equal(h.colorAt(editor, 2, 1), PALETTES.light.comment);
  h.edit(doc, 'wire prefix;\n/* comment\nwire hidden;\n*/\nwire newer;', 4);
  h.edit(doc, 'wire prefix;\n// comment\nwire hidden;\n*/\nwire newer;', 1);
  await service.whenIdle();
  assert.equal(h.grammars.verilog.calls.filter(call => call.line === 'wire prefix;').length, 1);
  assert.equal(h.colorAt(editor, 2, 1), PALETTES.light.type);
  assert.equal(service.snapshot()[0].version, 3);
});

test('theme changes reuse tokens and scrolling retains the prefix used by Sticky Scroll', async t => {
  const h = harness(), doc = h.document('verilog', Array.from({ length: 90 }, (_, index) => `wire signal_${index};`).join('\n')), editor = h.editor(doc, 1);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  for (const kind of [2, 3, 4, 1]) {
    h.theme.kind = kind; h.events.theme.fire(h.theme);
    await service.whenIdle();
    assert.equal(h.colorAt(editor, 0, 6), kind === 1 || kind === 4 ? PALETTES.light.text : PALETTES.dark.text);
  }
  assert.equal(h.grammars.verilog.calls.length, parsed);
  const created = h.types.length;
  editor.visibleRanges = [new Range(60, 0, 65, 0)];
  h.events.ranges.fire({ textEditor: editor });
  await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 6), PALETTES.light.text, 'Scrolled-off prefix must remain decorated for Sticky headers');
  assert.equal(h.colorAt(editor, 65, 6), PALETTES.light.text);
  assert.equal(h.types.length, created);
});

test('delayed initialization always paints the latest document text', async t => {
  const h = harness(), ready = deferred(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, { createTokenizer: () => ready.promise });
  await turn();
  h.edit(doc, '// latest while loading');
  ready.resolve(h.tokenizer);
  await service.whenIdle();
  assert(h.nonempty(editor).every(call => call.version === 2));
  assertNoOldRangesOnNewComment(h, editor);
  assert.equal(h.colorAt(editor, 0, 3), PALETTES.light.comment);
});

test('delayed grammar requests cannot paint text from before an edit or a close', async t => {
  const h = harness(), gate = deferred(), entered = deferred(), doc = h.document(), editor = h.editor(doc);
  h.tokenizer.grammar = () => { entered.resolve(); return gate.promise; };
  h.visible([editor]);
  const service = h.service(t);
  await entered.promise;
  h.edit(doc, '// latest grammar version');
  gate.resolve(h.grammars.verilog);
  await service.whenIdle();
  assert(h.nonempty(editor).every(call => call.version === 2));
  assertNoOldRangesOnNewComment(h, editor);
  assert.equal(h.colorAt(editor, 0, 3), PALETTES.light.comment);
  const later = h.document(), laterEditor = h.editor(later), closedGate = deferred(), closedEntered = deferred();
  h.tokenizer.grammar = () => { closedEntered.resolve(); return closedGate.promise; };
  h.visible([laterEditor]);
  await closedEntered.promise;
  later.isClosed = true; h.visible([]); h.events.close.fire(later);
  closedGate.resolve(h.grammars.verilog);
  await service.whenIdle();
  assert.equal(h.nonempty(laterEditor).length, 0);
});

test('an edit during yielded tokenization cannot publish the old version', async t => {
  const h = harness(), doc = h.document('verilog', Array.from({ length: 700 }, (_, index) => `wire old_${index};`).join('\n')), editor = h.editor(doc, 699);
  let sent = false;
  h.grammars.verilog = grammar(() => {
    if (sent) return;
    sent = true;
    setTimeout(() => h.edit(doc, '// changed\n' + Array.from({ length: 699 }, (_, index) => `wire fresh_${index};`).join('\n')), 0);
  });
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assert(sent);
  assert(h.nonempty(editor).length);
  assert(h.nonempty(editor).every(call => call.version === 2), 'No pre-edit ranges may reach the editor');
  assertNoOldRangesOnNewComment(h, editor);
  assert.equal(h.colorAt(editor, 0, 2), PALETTES.light.comment);
});

test('hiding during yielded tokenization never paints a hidden editor', async t => {
  const h = harness(), doc = h.document('verilog', Array.from({ length: 700 }, (_, index) => `wire data_${index};`).join('\n')), editor = h.editor(doc, 699);
  let hidden = false;
  h.grammars.verilog = grammar(() => {
    if (!hidden) { hidden = true; setTimeout(() => h.visible([]), 0); }
  });
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assert(hidden);
  assert.equal(h.nonempty(editor).length, 0);
  assert.deepEqual(service.snapshot(), []);
});

test('transient windows and repeated events do not accumulate types, listeners or caches', async t => {
  const h = harness(), service = h.service(t);
  await service.ready;
  const listeners = h.listeners(), typeCount = h.types.length;
  for (let index = 0; index < 8; index++) {
    const doc = h.document(), editor = h.editor(doc);
    h.visible([editor]);
    for (let edit = 0; edit < 5; edit++) h.edit(doc, `wire updated_${edit};`);
    await service.whenIdle();
    assert.equal(service.snapshot().length, 1);
    doc.isClosed = true; h.visible([]); h.events.close.fire(doc);
    await service.whenIdle();
    assert.deepEqual(service.snapshot(), []);
  }
  assert.equal(h.listeners(), listeners);
  assert.equal(h.types.length, typeCount);
  service.dispose(); service.dispose();
  assert.equal(h.listeners(), 0);
  assert(h.types.every(type => type.disposeCount === 1));
  assert.equal(h.tokenizer.disposeCount, 1);
  const calls = h.calls.length;
  h.events.theme.fire(h.theme); h.events.visible.fire([]);
  assert.equal(h.calls.length, calls);
});

test('dispose before initialization completes releases the late tokenizer without painting', async t => {
  const h = harness(), gate = deferred(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, { createTokenizer: () => gate.promise });
  await turn();
  service.dispose();
  gate.resolve(h.tokenizer);
  await service.ready;
  await service.whenIdle();
  assert.equal(h.tokenizer.disposeCount, 1);
  assert.equal(h.nonempty(editor).length, 0);
  assert.equal(h.listeners(), 0);
  assert(h.types.every(type => type.disposeCount === 1));
});

test('initialization failure is reported once and never leaves synthetic colors', async t => {
  const h = harness(), doc = h.document(), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t, { createTokenizer: async () => { throw new Error('synthetic load failure'); } });
  await service.whenIdle();
  h.events.theme.fire(h.theme);
  await service.whenIdle();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /synthetic load failure/);
  assert.equal(h.nonempty(editor).length, 0);
});

function appliedRanges(editor) {
  return [...editor.applied].filter(([type]) => !type.disposeCount).flatMap(([, ranges]) => ranges);
}
function selectedPoint(selections, point) {
  return selections.some(selection => comparePosition(selection.start, point) <= 0 && comparePosition(point, selection.end) < 0);
}
// Fixture-only coverage oracle. It identifies native bracket glyphs/words,
// while escaped names, quoted text and macro definitions remain lexical islands.
// Comment ranges come from independent fixture data supplied by each test.
function nativeBracketRanges(text) {
  return text.split(/\r\n|\n|\r/).flatMap((line, index) => {
    if (line.startsWith('`define')) return [];
    return [...line.matchAll(/\\[^\s]+|"(?:\\.|[^"\\])*"|(?<![A-Za-z0-9_$])(?:begin|end)(?![A-Za-z0-9_$])|[()[\]{}]/g)]
      .filter(match => !match[0].startsWith('\\') && !match[0].startsWith('"'))
      .map(match => new Range(index, match.index, index, match.index + match[0].length));
  });
}
function assertSelectionCoverage(editor, comments = []) {
  const typesAndRanges = [...editor.applied].filter(([type]) => !type.disposeCount);
  const lines = editor.document.text.split(/\r\n|\n|\r/);
  const native = nativeBracketRanges(editor.document.text);
  for (let line = 0; line < lines.length; line++) {
    for (let character = 0; character < lines[line].length; character++) {
      const point = { line, character };
      const matches = typesAndRanges.flatMap(([type, ranges]) => ranges.filter(range =>
        comparePosition(range.start, point) <= 0 && comparePosition(point, range.end) < 0).map(() => type));
      const selected = selectedPoint(editor.selections, point), comment = selectedPoint(comments, point);
      const bracket = !comment && selectedPoint(native, point);
      assert.equal(matches.length, bracket || selected && !comment ? 0 : 1,
        `Selection coverage mismatch at ${line}:${character}`);
      if (matches.length) assert.equal(isSelectedCommentType(matches[0]), selected && comment,
        `Selected-comment tint mismatch at ${line}:${character}`);
    }
  }
}
function assertPaintsRespectSelections(h, editor, commentsForText = () => []) {
  for (const call of h.calls.filter(call => call.editor === editor)) {
    if (isSelectedCommentType(call.type)) {
      const lines = call.text.split(/\r\n|\n|\r/), comments = commentsForText(call.text);
      if (call.ranges.length) {
        // Dark active/inactive colors intentionally match. The light variant
        // identifies the role; both variants must still match its full palette.
        assert.equal(call.type.options.light.color === INACTIVE_SELECTED_COMMENT_COLORS.light, !call.active,
          'Selected-comment tint must use the current editor/window activity, including intermediate paints');
        const expected = call.active ? SELECTED_COMMENT_COLORS : INACTIVE_SELECTED_COMMENT_COLORS;
        assert.deepEqual({ light: call.type.options.light.color, dark: call.type.options.dark.color }, expected);
        assert.equal(call.type.options.color, expected.dark);
      }
      for (const range of call.ranges) {
        assert(comparePosition(range.start, range.end) < 0, 'Selected-comment tint must not contain empty ranges');
        for (let line = range.start.line; line <= range.end.line; line++) {
          const start = line === range.start.line ? range.start.character : 0;
          const end = line === range.end.line ? range.end.character : lines[line].length;
          for (let character = start; character < end; character++) {
            const point = { line, character };
            assert(selectedPoint(call.selections, point), 'Selected-comment tint reached an unselected character');
            assert(selectedPoint(comments, point), 'Selected-comment tint reached non-comment text');
          }
        }
      }
      continue;
    }
    const native = nativeBracketRanges(call.text), comments = commentsForText(call.text);
    for (const range of call.ranges) {
      for (const bracket of native) {
        if (selectedPoint(comments, bracket.start)) continue;
        assert.equal(comparePosition(range.start, bracket.end) < 0 && comparePosition(bracket.start, range.end) < 0, false,
          `Fixed foreground reached a native bracket during an intermediate paint: ${JSON.stringify({ range, bracket })}`);
      }
    }
    for (const selection of call.selections.filter(selection => comparePosition(selection.start, selection.end) < 0)) {
      for (const range of call.ranges) {
        assert.equal(comparePosition(range.start, selection.end) < 0 && comparePosition(selection.start, range.end) < 0, false,
          `Fixed foreground reached a selection during an intermediate paint: ${JSON.stringify({ range, selection })}`);
      }
    }
  }
}

test('an existing single-line selection has no fixed foreground and clearing it restores colors without lexing', async t => {
  const h = harness(), doc = h.document(), editor = h.editor(doc);
  h.select(editor, [new Selection(0, 6, 0, 10)]);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
  assert.equal(h.colorAt(editor, 0, 5), PALETTES.light.text);
  const parsed = h.grammars.verilog.calls.length;
  h.select(editor, [new Selection(0, 10, 0, 10)]);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 7), PALETTES.light.text);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('cross-line selections remove all middle-line foreground and preserve exact half-open boundaries', async t => {
  const h = harness(), doc = h.document('verilog', 'wire alpha;\nwire beta;\nlogic gamma;'), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  h.select(editor, [new Selection(0, 2, 2, 4)]);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(appliedRanges(editor).some(range => range.start.line === 1), false);
  assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
  assert.equal(h.colorAt(editor, 2, 4), PALETTES.light.type, 'The end character belongs outside the selection');
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor);
});

test('overlapping, adjacent, duplicate and unsorted selections exclude their union only', async t => {
  const h = harness(), doc = h.document('verilog', 'wire alpha; wire beta; wire gamma;'), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  h.select(editor, [new Selection(0, 25, 0, 30), new Selection(0, 5, 0, 12), new Selection(0, 2, 0, 7),
    new Selection(0, 12, 0, 17), new Selection(0, 5, 0, 12), new Selection(0, 18, 0, 18)]);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 18), PALETTES.light.text, 'An empty cursor must not create a hole');
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor);
});

test('backward selections follow normalized bounds and multiple empty cursors leave colors intact', async t => {
  const h = harness(), doc = h.document('verilog', 'wire alpha;\nwire beta;'), editor = h.editor(doc);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  const backward = new Selection(1, 4, 0, 6);
  assert.equal(backward.isReversed, true);
  h.select(editor, [backward]);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  h.select(editor, [new Selection(0, 1, 0, 1), new Selection(1, 4, 1, 4)]);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 7), PALETTES.light.text);
  assert.equal(h.colorAt(editor, 1, 1), PALETTES.light.type);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor);
});

test('two splits sharing one document keep independent selection exclusions and restore independently', async t => {
  const h = harness(), doc = h.document(), first = h.editor(doc), second = h.editor(doc);
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  h.select(first, [new Selection(0, 0, 0, 4)]);
  h.select(second, [new Selection(0, 5, 0, 12)]);
  await service.whenIdle();
  assertSelectionCoverage(first); assertSelectionCoverage(second);
  assert.equal(h.colorAt(first, 0, 7), PALETTES.light.text);
  assert.equal(h.colorAt(second, 0, 1), PALETTES.light.type);
  h.select(first, [new Selection(0, 4, 0, 4)]);
  await service.whenIdle();
  assertSelectionCoverage(first); assertSelectionCoverage(second);
  assert.equal(h.colorAt(first, 0, 1), PALETTES.light.type);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, first); assertPaintsRespectSelections(h, second);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('a selection change while grammar loads uses the latest editor selection', async t => {
  const h = harness(), gate = deferred(), entered = deferred(), doc = h.document(), editor = h.editor(doc);
  h.select(editor, [new Selection(0, 0, 0, 4)]);
  h.tokenizer.grammar = () => { entered.resolve(); return gate.promise; };
  h.visible([editor]);
  const service = h.service(t);
  await entered.promise;
  h.select(editor, [new Selection(0, 5, 0, 12)]);
  gate.resolve(h.grammars.verilog);
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
  assertPaintsRespectSelections(h, editor);
});

test('selection changes during asynchronous tokenization cannot flash old full-token foreground', async t => {
  const h = harness(), doc = h.document('verilog', Array.from({ length: 700 }, (_, index) => `wire data_${index};`).join('\n')), editor = h.editor(doc, 699);
  let changed = false;
  h.grammars.verilog = grammar(() => {
    if (changed) return;
    changed = true;
    setTimeout(() => {
      h.select(editor, [new Selection(0, 1, 0, 3)]);
      h.select(editor, [new Selection(0, 9, 0, 4)]);
    }, 0);
  });
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assert.equal(changed, true);
  assert.equal(editor.selection.isReversed, true);
  assertSelectionCoverage(editor);
  assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
  assertPaintsRespectSelections(h, editor);
  assert.equal(h.grammars.verilog.calls.length, 700, 'Selection-only events must reuse already tokenized state');
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

// Expected comment regions are fixture data, independent of the tokenizer and
// the controller's interval projection. Newline positions have no text glyph.
function commentLines(text, indices) {
  const lines = text.split(/\r\n|\n|\r/);
  return indices.map(line => new Range(line, 0, line, lines[line].length));
}
const rangeData = (...ranges) => ranges.map(range => ({ start: { ...range.start }, end: { ...range.end } }));

test('selected line comments get one foreground-only tint and clearing selection restores ordinary green', async t => {
  const h = harness(), doc = h.document('verilog', '// selected comment\nwire payload;'), editor = h.editor(doc);
  const comments = commentLines(doc.text, [0]);
  h.select(editor, [new Selection(0, 3, 0, 12), new Selection(1, 5, 1, 12)]);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  assertSelectionCoverage(editor, comments);
  assert.equal(h.colorAt(editor, 0, 5), SELECTED_COMMENT_COLOR);
  assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.comment);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), rangeData(new Range(0, 3, 0, 12)));
  const parsed = h.grammars.verilog.calls.length;
  for (const kind of [2, 3, 4, 1]) {
    h.theme.kind = kind; h.events.theme.fire(h.theme);
    await service.whenIdle();
    assertSelectionCoverage(editor, comments);
    assert.equal(h.colorAt(editor, 0, 5), kind === 1 || kind === 4 ? SELECTED_COMMENT_COLORS.light : SELECTED_COMMENT_COLORS.dark,
      'Native foreground variables must remain live across theme kinds');
  }
  h.select(editor, [new Selection(0, 12, 0, 12)]);
  await service.whenIdle();
  assertSelectionCoverage(editor, comments);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), []);
  assert.equal(h.colorAt(editor, 0, 5), PALETTES.light.comment);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor, text => commentLines(text, [0]));
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('cross-line block comment selections tint their merged union with exact reverse and empty-selection bounds', async t => {
  const h = harness(), doc = h.document('verilog', '/* alpha\nmiddle payload\nlast */\nwire payload;'), editor = h.editor(doc);
  const comments = commentLines(doc.text, [0, 1, 2]);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  h.select(editor, [new Selection(2, 4, 0, 3), new Selection(0, 1, 0, 6),
    new Selection(2, 4, 2, 7), new Selection(0, 1, 0, 6), new Selection(1, 3, 1, 3),
    new Selection(3, 0, 3, 4)]);
  await service.whenIdle();
  assertSelectionCoverage(editor, comments);
  assert.equal(h.colorAt(editor, 0, 0), PALETTES.light.comment);
  assert.equal(h.colorAt(editor, 0, 1), SELECTED_COMMENT_COLOR);
  assert.equal(h.colorAt(editor, 1, 2), SELECTED_COMMENT_COLOR);
  assert.equal(h.colorAt(editor, 2, 6), SELECTED_COMMENT_COLOR);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), rangeData(new Range(0, 1, 0, 8), new Range(1, 0, 1, 14), new Range(2, 0, 2, 7)));
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, editor, text => commentLines(text, [0, 1, 2]));
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('split editors tint only their own comment selections and clear independently without re-tokenizing', async t => {
  const h = harness(), doc = h.document('verilog', '// alpha comment\n// beta comment\nwire payload;'), first = h.editor(doc), second = h.editor(doc);
  const comments = commentLines(doc.text, [0, 1]);
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length;
  h.select(first, [new Selection(0, 3, 0, 10)]);
  h.select(second, [new Selection(1, 0, 1, 7), new Selection(2, 5, 2, 12)]);
  await service.whenIdle();
  assertSelectionCoverage(first, comments); assertSelectionCoverage(second, comments);
  assert.equal(h.colorAt(first, 0, 5), SELECTED_COMMENT_COLOR);
  assert.equal(h.colorAt(second, 0, 5), PALETTES.light.comment);
  const secondTint = structuredClone(second.applied.get(service.selectedCommentInactiveType));
  h.select(first, [new Selection(0, 10, 0, 10)]);
  await service.whenIdle();
  assertSelectionCoverage(first, comments); assertSelectionCoverage(second, comments);
  assert.deepEqual(first.applied.get(service.selectedCommentType), []);
  assert.deepEqual(second.applied.get(service.selectedCommentInactiveType), secondTint);
  assert.deepEqual(second.applied.get(service.selectedCommentType), []);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assertPaintsRespectSelections(h, first, text => commentLines(text, [0, 1]));
  assertPaintsRespectSelections(h, second, text => commentLines(text, [0, 1]));
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('an edit and selection event cannot reuse stale selected-comment ranges on new code', async t => {
  const h = harness(), doc = h.document('verilog', '// initial comment'), editor = h.editor(doc);
  h.select(editor, [new Selection(0, 3, 0, 10)]);
  h.visible([editor]);
  const service = h.service(t, { delay: 10 });
  await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 5), SELECTED_COMMENT_COLOR);
  h.edit(doc, 'wire payload;');
  h.select(editor, [new Selection(0, 3, 0, 10)]);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), [], 'A version mismatch must clear the old selected-comment tint immediately');
  await service.whenIdle();
  assertSelectionCoverage(editor);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), []);
  h.edit(doc, '// latest comment');
  h.select(editor, [new Selection(0, 5, 0, 11)]);
  await service.whenIdle();
  assertSelectionCoverage(editor, commentLines(doc.text, [0]));
  assert.equal(h.colorAt(editor, 0, 6), SELECTED_COMMENT_COLOR);
  assertPaintsRespectSelections(h, editor, text => text.startsWith('//') ? commentLines(text, [0]) : []);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('late grammar and yielded tokenization use current comment selections and window focus without additional lexical work', async t => {
  const h = harness(), gate = deferred(), entered = deferred();
  const doc = h.document('verilog', Array.from({ length: 700 }, (_, index) => `// comment_${index}`).join('\n')), editor = h.editor(doc, 699);
  let changedDuringLexing = false;
  h.grammars.verilog = grammar(() => {
    if (changedDuringLexing) return;
    changedDuringLexing = true;
    setTimeout(() => {
      h.select(editor, [new Selection(0, 10, 0, 4), new Selection(699, 3, 699, 8)]);
      h.focus(false);
    }, 0);
  });
  h.tokenizer.grammar = () => { entered.resolve(); return gate.promise; };
  h.select(editor, [new Selection(0, 0, 0, 2)]);
  h.visible([editor]);
  const service = h.service(t);
  await entered.promise;
  h.select(editor, [new Selection(0, 2, 0, 4)]);
  gate.resolve(h.grammars.verilog);
  await service.whenIdle();
  const comments = commentLines(doc.text, Array.from({ length: 700 }, (_, index) => index));
  assert.equal(changedDuringLexing, true);
  assert.equal(editor.selection.isReversed, true);
  assertSelectionCoverage(editor, comments);
  assert.deepEqual(editor.applied.get(service.selectedCommentType), []);
  assert.deepEqual(editor.applied.get(service.selectedCommentInactiveType), rangeData(new Range(0, 4, 0, 10), new Range(699, 3, 699, 8)));
  assert.equal(h.grammars.verilog.calls.length, 700, 'Selection changes during loading and lexing must reuse the lexical cache');
  assertPaintsRespectSelections(h, editor, () => comments);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('language changes clear selected-comment tint and disposing releases its type and selection listener once', async t => {
  const h = harness(), doc = h.document('verilog', '// selected comment'), editor = h.editor(doc);
  h.select(editor, [new Selection(0, 3, 0, 10)]);
  h.visible([editor]);
  const service = h.service(t);
  await service.whenIdle();
  const tint = service.selectedCommentType;
  assert.equal(h.colorAt(editor, 0, 5), SELECTED_COMMENT_COLOR);
  const plain = h.document('plaintext', doc.text, doc.uri.toString());
  doc.isClosed = true; editor.document = plain;
  h.events.close.fire(doc); h.events.open.fire(plain);
  await service.whenIdle();
  assert.deepEqual(editor.applied.get(tint), []);
  const live = h.document('systemverilog', '// selected again', doc.uri.toString());
  plain.isClosed = true; editor.document = live;
  h.events.open.fire(live);
  await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 5), SELECTED_COMMENT_COLOR);
  const typeCount = h.types.length;
  service.dispose(); service.dispose();
  assert.equal(tint.disposeCount, 1);
  assert.equal(editor.applied.has(tint), false);
  assert(h.types.every(type => type.disposeCount === 1));
  assert.equal(h.listeners(), 0);
  const painted = h.calls.length;
  h.select(editor, [new Selection(0, 10, 0, 10)]);
  assert.equal(h.calls.length, painted);
  assert.equal(h.types.length, typeCount);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('active split changes exchange comment tint roles and visible events reproject without lexing', async t => {
  const h = harness(), doc = h.document('verilog', '// selected comment\nwire payload;'), first = h.editor(doc), second = h.editor(doc);
  const comments = commentLines(doc.text, [0]);
  h.select(first, [new Selection(0, 3, 0, 10), new Selection(1, 5, 1, 12)]);
  h.select(second, [new Selection(0, 7, 0, 14)]);
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length, typeCount = h.types.length;
  const assertRoles = active => {
    for (const editor of [first, second]) {
      assertSelectionCoverage(editor, comments);
      const role = active === editor ? service.selectedCommentType : service.selectedCommentInactiveType;
      const unused = active === editor ? service.selectedCommentInactiveType : service.selectedCommentType;
      assert.equal(editor.applied.get(role).length, 1);
      assert.deepEqual(editor.applied.get(unused), [], 'Each comment intersection must use exactly one tint role');
    }
  };
  assertRoles(first);
  h.active(second);
  await service.whenIdle();
  assertRoles(second);
  h.active(undefined); // No active text editor is distinct from two visible splits.
  await service.whenIdle();
  assertRoles(undefined);
  h.visible([first, second]); // The same editor objects can acquire a new active role.
  await service.whenIdle();
  assertRoles(first);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assert.equal(h.types.length, typeCount);
  assertPaintsRespectSelections(h, first, () => comments);
  assertPaintsRespectSelections(h, second, () => comments);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});

test('window blur makes all selected comments inactive and focus restores only the active split without lexing', async t => {
  const h = harness(), doc = h.document('verilog', '// selected comment\nwire payload;'), first = h.editor(doc), second = h.editor(doc);
  const comments = commentLines(doc.text, [0]);
  h.select(first, [new Selection(0, 1, 0, 6)]);
  h.select(second, [new Selection(0, 3, 0, 11), new Selection(1, 0, 1, 4)]);
  h.visible([first, second]);
  const service = h.service(t);
  await service.whenIdle();
  const parsed = h.grammars.verilog.calls.length, typeCount = h.types.length;
  h.active(second);
  await service.whenIdle();
  h.focus(false);
  await service.whenIdle();
  for (const editor of [first, second]) {
    assertSelectionCoverage(editor, comments);
    assert.deepEqual(editor.applied.get(service.selectedCommentType), []);
    assert.equal(editor.applied.get(service.selectedCommentInactiveType).length, 1);
  }
  h.active(first); // An active editor alone cannot make an unfocused window active.
  await service.whenIdle();
  for (const editor of [first, second]) assert.deepEqual(editor.applied.get(service.selectedCommentType), []);
  h.focus(true);
  await service.whenIdle();
  assert.equal(h.colorAt(first, 0, 3), SELECTED_COMMENT_COLORS.light);
  assert.equal(h.colorAt(second, 0, 5), INACTIVE_SELECTED_COMMENT_COLORS.light);
  assert.deepEqual(first.applied.get(service.selectedCommentInactiveType), []);
  assert.deepEqual(second.applied.get(service.selectedCommentType), []);
  assertSelectionCoverage(first, comments); assertSelectionCoverage(second, comments);
  h.focus(false);
  h.select(first, [new Selection(0, 6, 0, 6)]);
  await service.whenIdle();
  assert.deepEqual(first.applied.get(service.selectedCommentType), []);
  assert.deepEqual(first.applied.get(service.selectedCommentInactiveType), []);
  h.focus(true);
  await service.whenIdle();
  assertSelectionCoverage(first, comments); assertSelectionCoverage(second, comments);
  assert.equal(h.colorAt(first, 0, 3), PALETTES.light.comment);
  assert.equal(h.grammars.verilog.calls.length, parsed);
  assert.equal(h.types.length, typeCount);
  assertPaintsRespectSelections(h, first, () => comments);
  assertPaintsRespectSelections(h, second, () => comments);
  service.dispose();
  assert(h.types.every(type => type.disposeCount === 1));
  assert.equal(h.listeners(), 0);
  const painted = h.calls.length;
  h.focus(false); h.active(second);
  assert.equal(h.calls.length, painted);
  assert.deepEqual(h.writes, []);
  h.assertModeOnlyReads();
});


test('custom palettes override valid categories and fall back for invalid values', async t => {
  const options = {mode: 'custom', 'highlighting.lightColors': {comment: '#123456', type: 'red'}, 'highlighting.darkColors': {type: '#ABCDEF', comment: null}};
  const h = harness(options), editor = h.editor(h.document('verilog', '// comment\nwire data;'));
  h.visible([editor]); const service = h.service(t); await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 1, 1), '#123456');
  assert.equal(h.colorAt(editor, 1, 1, 1), PALETTES.light.type);
  assert.equal(h.colorAt(editor, 0, 1, 2), PALETTES.dark.comment);
  assert.equal(h.colorAt(editor, 1, 1, 2), '#ABCDEF');
  const oldTypes = [...service.types.values()];
  options['highlighting.lightColors'].comment = '#654321';
  h.events.configuration.fire({affectsConfiguration: key => key === 'fpgaWorkbench.highlighting.lightColors'});
  await service.whenIdle();
  assert(oldTypes.every(type => type.disposeCount === 1));
  assert.equal(h.colorAt(editor, 0, 1, 1), '#654321');
  h.mode('fixed'); await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 1, 1), PALETTES.light.comment);
  h.mode('custom'); await service.whenIdle();
  assert.equal(h.colorAt(editor, 0, 1, 1), '#654321');
  h.select(editor, [new Selection(0, 0, 0, 10)]);
  assert.equal(editor.applied.get(service.selectedCommentType).length, 0);
  assert.equal(editor.applied.get(service.selectedCommentInactiveType).length, 0);
  assert.deepEqual(h.writes, []);
});

test('theme and legacy auto followed by fixed repeatedly restore real grammar categories', async t => {
  const h = harness({mode: 'theme'});
  const editor = h.editor(h.document('systemverilog', '// comment\nmodule m;\nwire a;\nassign a = 1;\nendmodule'));
  h.visible([editor]);
  const path = require('node:path');
  const {createTokenizer} = require('../src/hdl-tokens');
  const service = h.service(t, {createTokenizer: () => createTokenizer(path.resolve(__dirname, '..'))});
  for (const mode of ['theme', 'auto', 'theme']) {
    h.mode(mode); await service.whenIdle(); assertThemeOwnsEditor(h, service, editor);
    h.mode('fixed'); await service.whenIdle();
    assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.comment);
    assert.equal(h.colorAt(editor, 1, 1), PALETTES.light.declaration);
    assert.equal(h.colorAt(editor, 2, 1), PALETTES.light.type);
    assert.equal(h.colorAt(editor, 3, 1), PALETTES.light.assignment);
  }
});

test('scheme picker respects workspace overrides, cancellation and explicit repaint', async t => {
  for (const workspaceValue of [undefined, 'theme']) {
    const h = harness({mode: 'theme'}), editor = h.editor(h.document());
    h.visible([editor]); const service = h.service(t); await service.whenIdle();
    let stored = 'theme', choice = 'fixed'; const writes = [], commands = [];
    h.vscode.ConfigurationTarget = {Global: 1, Workspace: 2};
    h.vscode.workspace.getConfiguration = () => ({get: (key, fallback) => key === 'highlighting.mode' ? stored : fallback,
      inspect: () => ({workspaceValue}), update: async (key, value, target) => {writes.push({key, value, target}); stored = value;}});
    h.vscode.window.showQuickPick = async items => items.find(item => item.value === choice);
    h.vscode.commands = {executeCommand: async (...args) => {commands.push(args);}};
    assert.equal(await service.selectScheme(), 'fixed');
    assert.equal(writes[0].target, workspaceValue === undefined ? 1 : 2);
    assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
    service.clearEditor(editor);
    await service.selectScheme();
    assert.equal(h.colorAt(editor, 0, 1), PALETTES.light.type);
    choice = 'custom'; await service.selectScheme();
    assert.equal(service.mode, 'custom');
    choice = undefined; const count = writes.length; await service.selectScheme(); assert.equal(writes.length, count);
    choice = 'edit'; await service.selectScheme(); assert.equal(writes.length, count);
    assert.deepEqual(commands, [['workbench.action.openSettings', 'fpgaWorkbench.highlighting']]);
  }
});
