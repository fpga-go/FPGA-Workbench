'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { createTokenizer, HdlTokenDocument, tokenCategory } = require('../src/hdl-tokens');

const root = path.resolve(__dirname, '..');
let deployment, tokenizer;
before(async () => {
  deployment = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-hdl-tokens-'));
  await fs.mkdir(path.join(deployment, 'vendor/oniguruma'), { recursive: true });
  await fs.mkdir(path.join(deployment, 'syntaxes'));
  await fs.copyFile(require.resolve('vscode-oniguruma/release/onig.wasm'), path.join(deployment, 'vendor/oniguruma/onig.wasm'));
  for (const file of ['hdl.tmLanguage.json', 'systemverilog.tmLanguage.json']) await fs.copyFile(path.join(root, 'syntaxes', file), path.join(deployment, 'syntaxes', file));
  tokenizer = await createTokenizer(deployment);
});
after(async () => {
  tokenizer?.dispose();
  if (deployment) {
    assert(deployment.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(deployment).startsWith('fpga-hdl-tokens-'));
    await fs.rm(deployment, { recursive: true, force: true });
  }
});

function categoryAt(document, lines, line, text, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = lines[line].indexOf(text, start + 1);
  assert(start >= 0, `Missing sample ${text}`);
  const token = document.tokens(line).find(token => token.startIndex <= start && token.endIndex >= start + text.length);
  assert(token, `Missing token at ${line}:${start} (${text})`);
  return token.category;
}

test('scope categories preserve lexical roles without inventing signal semantics', () => {
  const examples = [
    [['source.verilog', 'meta.identifier.verilog'], 'text'],
    [['entity.name.type.class.systemverilog', 'meta.identifier.escaped.systemverilog'], 'text'],
    [['meta.instance.name.systemverilog'], 'text'],
    [['unknown.scope'], 'text'],
    [['support.function.port.systemverilog'], 'text'],
    [['comment.block', 'keyword.control'], 'comment'],
    [['string.quoted.double', 'constant.character.escape'], 'string'],
    [['source.systemverilog', 'string.regexp.systemverilog'], 'macro'],
    [['string.quoted.double', 'string.regexp.systemverilog'], 'string'],
    [['constant.numeric.sized_integer.verilog'], 'number'],
    [['keyword.other.compiler.directive.verilog'], 'macro'],
    [['variable.other.constant.verilog'], 'macro'],
    [['variable.other.constant.preprocessor.systemverilog'], 'macro'],
    [['meta.preprocessor.systemverilog', 'keyword.control.systemverilog'], 'macro'],
    [['meta.preprocessor.systemverilog', 'constant.numeric.systemverilog'], 'number'],
    [['storage.type.module.verilog'], 'declaration'],
    [['storage.type.function.systemverilog'], 'declaration'],
    [['storage.type.vector.systemverilog'], 'type'],
    [['entity.name.type.class.systemverilog'], 'type'],
    [['entity.name.type.module.verilog'], 'module'],
    [['entity.name.function.verilog'], 'function'],
    [['support.function.systemverilog'], 'function'],
    [['keyword.operator.systemverilog'], 'keyword']
  ];
  for (const [scopes, category] of examples) assert.equal(tokenCategory(scopes), category, scopes.join(' '));
  for (const [word, category] of [['module', 'declaration'], ['endmodule', 'declaration'], ['reg', 'type'],
    ['wire', 'type'], ['logic', 'type'], ['assign', 'assignment'], ['deassign', 'assignment'],
    ['force', 'assignment'], ['release', 'assignment'], ['alias', 'assignment'], ['if', 'keyword'],
    ['begin', 'bracket'], ['end', 'bracket']]) {
    assert.equal(tokenCategory(['keyword.other.verilog'], ` ${word} `), category, word);
  }
  for (const text of ['begin', 'end', 'module', 'reg', 'assign']) {
    assert.equal(tokenCategory(['keyword.control', 'meta.identifier.verilog'], text), 'text');
    assert.equal(tokenCategory(['keyword.control', 'meta.identifier.escaped.verilog'], `\\${text}`), 'text');
    assert.equal(tokenCategory(['keyword.control', 'comment.line'], text), 'comment');
    assert.equal(tokenCategory(['keyword.control', 'string.quoted.double'], text), 'string');
    assert.equal(tokenCategory(['keyword.other.compiler.directive.verilog'], text), 'macro');
  }
  assert.equal(tokenCategory(['keyword.other.verilog'], 'BEGIN'), 'keyword', 'Word classification must remain case-sensitive');
  assert.equal(tokenCategory(['keyword.other.verilog'], 'foo$begin'), 'keyword', 'A suffix is not a block keyword');
  assert.equal(tokenCategory(undefined), 'text');
});

test('deployment loading is independent of themes and rejects unsupported or disposed grammars', async () => {
  assert.strictEqual(await tokenizer.grammar('verilog'), await tokenizer.grammar('verilog'));
  assert.notStrictEqual(await tokenizer.grammar('verilog'), await tokenizer.grammar('systemverilog'));
  await assert.rejects(tokenizer.grammar('vhdl'), /Unsupported HDL language/);
  const other = await createTokenizer(deployment);
  const pending = other.grammar('verilog');
  other.dispose();
  other.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(other.grammar('verilog'), /disposed/);
});

for (const language of ['verilog', 'systemverilog']) {
  test(`${language}: complete module text keeps signals neutral and lexical categories distinct`, async () => {
    const lines = [
      '`define WIDTH 8',
      `module top(input ${language === 'verilog' ? 'wire' : 'logic'} clk, input wire rst_n, input wire [7:0] payload);`,
      `${language === 'verilog' ? 'reg' : 'logic'} [7:0] data;`,
      "localparam IDLE = 2'd0;",
      'child #(.WIDTH(`WIDTH)) u_child(.clk(clk), .payload(data));',
      'always @(posedge clk or negedge rst_n) begin',
      "  if (!rst_n) data <= 8'd0;",
      '  else case (state)',
      '    IDLE: data <= payload;',
      '    default: data <= data;',
      '  endcase',
      'end',
      'function [7:0] transform;',
      '  input [7:0] value;',
      "  begin transform = value ^ 8'hA5; end",
      'endfunction',
      'wire \\always.signal ;',
      'assign \\always.signal = data;',
      'initial $display("module while payload", data);',
      '// module data payload',
      'endmodule'
    ];
    if (language === 'systemverilog') lines.push('class Packet;', '  logic payload;', '  function int update(input int value);', '    payload = value;', '  endfunction', 'endclass');
    const document = new HdlTokenDocument(await tokenizer.grammar(language));
    document.update(lines, 1);
    assert.equal(await document.ensure(lines.length - 1), true);
    const expected = [[0, 'define', 'macro'], [1, 'module', 'declaration'], [1, 'top', 'module'], [1, 'clk', 'text'],
      [2, language === 'verilog' ? 'reg' : 'logic', 'type'], [2, 'data', 'text'], [3, 'IDLE', 'text'], [3, "2'd0", 'number'],
      [4, 'child', 'module'], [4, 'u_child', 'text'], [4, '`WIDTH', 'macro'], [4, 'payload', 'text'], [5, 'always', 'keyword'],
      [6, 'data', 'text'], [8, 'IDLE', 'text'], [8, 'payload', 'text'], [12, 'transform', 'function'], [13, 'value', 'text'],
      [5, 'begin', 'bracket'], [11, 'end', 'bracket'], [16, 'wire', 'type'], [16, '\\always.signal', 'text'],
      [17, 'assign', 'assignment'], [17, '\\always.signal', 'text'], [18, 'module while payload', 'string'], [19, 'module data payload', 'comment']];
    for (const [line, text, category] of expected) assert.equal(categoryAt(document, lines, line, text), category, `${language}:${line}:${text}`);
    if (language === 'systemverilog') {
      assert.equal(categoryAt(document, lines, 21, 'Packet'), 'type');
      assert.equal(categoryAt(document, lines, 22, 'logic'), 'type');
      assert.equal(categoryAt(document, lines, 24, 'payload'), 'text');
    }
    assert.deepEqual(document.tokens(lines.length), []);
  });

  test(`${language}: edits invalidate multiline comment and string state after a preserved prefix`, async () => {
    const grammar = await tokenizer.grammar(language);
    let calls = 0;
    const document = new HdlTokenDocument({ tokenizeLine(...args) { calls++; return grammar.tokenizeLine(...args); } });
    const lines = ['module top;', 'wire early;', '/* opening', 'wire hidden;', '*/ wire recovered;', 'endmodule'];
    document.update(lines, 1);
    assert.equal(await document.ensure(5), true);
    assert.equal(categoryAt(document, lines, 3, 'wire'), 'comment');
    const prefix = document.tokens(1), priorCalls = calls;
    const edited = [...lines];
    edited[2] = '// no block comment';
    document.update(edited, 2, 2);
    assert.strictEqual(document.tokens(1), prefix);
    assert.deepEqual(document.tokens(2), []);
    assert.deepEqual(document.tokens(3), []);
    assert.equal(await document.ensure(3), true);
    assert.equal(calls - priorCalls, 2);
    assert.notEqual(categoryAt(document, edited, 3, 'wire'), 'comment');
    assert.deepEqual(document.tokens(4), []);
    const strings = ['module top;', 'initial $display("hello \\', 'world");', 'wire recovered;', 'endmodule'];
    document.update(strings, 3, 1);
    assert.equal(await document.ensure(4), true);
    assert.equal(categoryAt(document, strings, 2, 'world'), 'string');
    const closed = [...strings];
    closed[1] = 'initial $display("hello");';
    document.update(closed, 4, 1);
    assert.equal(await document.ensure(4), true);
    assert.notEqual(categoryAt(document, closed, 2, 'world'), 'string');
  });
}

test('SV directive words use macro colors without swallowing quoted include paths or comments', async () => {
  const lines = ['`define WIDTH 8', '`ifdef WIDTH', '`timescale 1ns/1ps', '`include "module.v"', '`else', '`endif',
    '// `define ignored', 'initial $display("`ifdef WIDTH");'];
  const document = new HdlTokenDocument(await tokenizer.grammar('systemverilog'));
  document.update(lines, 1);
  assert.equal(await document.ensure(lines.length - 1), true);
  for (const [line, text] of [[0, 'define'], [1, 'ifdef'], [2, 'timescale'], [3, 'include'], [4, 'else'], [5, 'endif']]) {
    assert.equal(categoryAt(document, lines, line, text), 'macro');
  }
  assert.equal(categoryAt(document, lines, 3, 'module.v'), 'string');
  assert.equal(categoryAt(document, lines, 6, 'define'), 'comment');
  assert.equal(categoryAt(document, lines, 7, '`ifdef WIDTH'), 'string');
});

test('UTF-16 positions and empty lines stay within editor coordinates', async () => {
  const lines = ['/*😀*/ wire signal;', 'initial $display("😀", signal);', '', 'wire after;'];
  const document = new HdlTokenDocument(await tokenizer.grammar('verilog'));
  document.update(lines, 1);
  assert.equal(await document.ensure(3), true);
  const wire = document.tokens(0).find(token => token.category === 'type');
  assert.equal(wire.startIndex, lines[0].indexOf('wire'));
  const string = document.tokens(1).find(token => token.category === 'string');
  assert.equal(string.startIndex, lines[1].indexOf('"😀"'));
  assert.equal(string.endIndex, lines[1].indexOf('"😀"') + '"😀"'.length);
  assert.deepEqual(document.tokens(2), []);
  for (let line = 0; line < lines.length; line++) for (const token of document.tokens(line)) {
    assert(token.startIndex >= 0 && token.endIndex <= lines[line].length && token.startIndex < token.endIndex);
  }
});

test('cancellation does not publish a partly parsed line and later requests can resume', async () => {
  const grammar = await tokenizer.grammar('verilog');
  let calls = 0;
  const document = new HdlTokenDocument({ tokenizeLine(...args) { calls++; return grammar.tokenizeLine(...args); } });
  const lines = Array.from({ length: 20 }, (_, i) => `wire signal_${i};`);
  document.update(lines, 1);
  assert.equal(await document.ensure(19, () => calls >= 3), false);
  assert(document.tokens(1).length > 0);
  assert.deepEqual(document.tokens(2), []);
  assert.equal(await document.ensure(19), true);
  document.update(lines, 2);
  const before = calls;
  assert.equal(await document.ensure(19, () => true), false);
  assert.equal(calls, before);
});

test('version and same-version generation changes discard in-flight work', async () => {
  const grammar = await tokenizer.grammar('verilog');
  for (const nextVersion of [2, 1]) {
    const document = new HdlTokenDocument(grammar), lines = Array.from({ length: 300 }, (_, i) => `wire old_${i};`);
    document.update(lines, 1);
    const pending = document.ensure(299);
    const changed = [...lines];
    changed[0] = '// replacement';
    document.update(changed, nextVersion, 0);
    assert.equal(await pending, false);
    assert.deepEqual(document.tokens(0), []);
    assert.equal(await document.ensure(0), true);
    assert.equal(categoryAt(document, changed, 0, 'replacement'), 'comment');
  }
});

test('updates verify their prefix hint and copy caller input', async () => {
  const document = new HdlTokenDocument(await tokenizer.grammar('verilog'));
  const lines = ['wire a;', 'wire b;', 'wire c;'];
  document.update(lines, 1);
  lines[0] = '// caller mutation';
  assert.equal(await document.ensure(2), true);
  assert.equal(document.tokens(0)[0].category, 'type');
  document.update(['// changed', 'wire b;', 'wire c;'], 2, 3);
  assert.deepEqual(document.tokens(0), []);
  assert.equal(await document.ensure(0), true);
  assert.equal(document.tokens(0)[0].category, 'comment');
  document.update([], 3, 3);
  assert.equal(await document.ensure(100), true);
  assert.deepEqual(document.tokens(0), []);
});

test('a long document yields to pending editor events and overlapping requests share valid state', async () => {
  const document = new HdlTokenDocument(await tokenizer.grammar('systemverilog'));
  const lines = Array.from({ length: 1500 }, (_, i) => `logic signal_${i};`);
  document.update(lines, 1);
  let eventRan = false;
  setTimeout(() => { eventRan = true; }, 0);
  const large = document.ensure(lines.length - 1), smaller = document.ensure(100);
  assert.equal(await smaller, true);
  assert.equal(await large, true);
  assert.equal(eventRan, true, 'editor event must run before the long request completes');
  assert.equal(categoryAt(document, lines, 1499, 'logic'), 'type');
  assert.equal(categoryAt(document, lines, 1499, 'signal_1499'), 'text');
});

test('bounded line parsing reports stoppedEarly instead of caching incomplete output', async () => {
  let observedLimit;
  const document = new HdlTokenDocument({ tokenizeLine(line, state, limit) {
    observedLimit = limit;
    return { tokens: [{ startIndex: 0, endIndex: line.length, scopes: ['comment'] }], ruleStack: state, stoppedEarly: true };
  } });
  document.update(['wire value;'], 1);
  await assert.rejects(document.ensure(0), error => error.code === 'HDL_TOKENIZE_TIMEOUT' && error.line === 0);
  assert(observedLimit > 0 && observedLimit <= 50);
  assert.deepEqual(document.tokens(0), []);
});

for (const language of ['verilog', 'systemverilog']) {
  test(`${language}: declarations, types, assignments and control differ while actual brackets yield to native colors`, async () => {
    const lines = [
      'module sample(input wire clk);',
      `${language === 'verilog' ? 'reg' : 'logic'} [7:0] r_data;`,
      'wire [7:0] w_data;',
      'assign w_data = {r_data[0], f(r_data)};',
      'initial begin',
      '  if (r_data[0]) begin',
      '  end else begin',
      '    begin end',
      '  end',
      'end',
      'wire BEGIN, foo$begin;',
      'wire \\begin[end] ;',
      '`begin',
      '// module reg wire assign begin end ()[]{}',
      'initial $display("module reg wire assign begin end ()[]{}");',
      'endmodule'
    ];
    const document = new HdlTokenDocument(await tokenizer.grammar(language));
    document.update(lines, 1);
    assert.equal(await document.ensure(lines.length - 1), true);
    for (const [line, text, category] of [[0, 'module', 'declaration'], [0, 'input', 'type'], [0, 'wire', 'type'],
      [1, language === 'verilog' ? 'reg' : 'logic', 'type'], [2, 'wire', 'type'], [3, 'assign', 'assignment'],
      [4, 'initial', 'keyword'], [4, 'begin', 'bracket'], [5, 'if', 'keyword'], [5, 'begin', 'bracket'],
      [6, 'end', 'bracket'], [6, 'else', 'keyword'], [6, 'begin', 'bracket'], [7, 'begin', 'bracket'], [7, 'end', 'bracket'], [8, 'end', 'bracket'],
      [9, 'end', 'bracket'], [10, 'BEGIN', 'text'], [10, 'foo$begin', 'text'], [11, '\\begin[end]', 'text'],
      [12, 'begin', 'macro'], [13, 'begin end ()[]{}', 'comment'], [14, 'begin end ()[]{}', 'string'],
      [15, 'endmodule', 'declaration']]) {
      assert.equal(categoryAt(document, lines, line, text), category, `${language}:${line}:${text}`);
    }
    for (const character of '()[]{}') {
      assert.equal(categoryAt(document, lines, 3, character), 'bracket', `${language}: source ${character}`);
      assert.equal(categoryAt(document, lines, 13, character), 'comment', `${language}: commented ${character}`);
      // Find the glyph inside the quoted text, rather than the display-call parentheses.
      const position = lines[14].indexOf(character, lines[14].indexOf('"'));
      const token = document.tokens(14).find(token => token.startIndex <= position && position < token.endIndex);
      assert.equal(token.category, 'string', `${language}: quoted ${character}`);
    }
    assert.equal(document.tokens(10).some(token => token.category === 'bracket'), false);
    assert.equal(document.tokens(11).some(token => token.category === 'bracket'), false);
    assert.equal(document.tokens(12).some(token => token.category === 'bracket'), false);
  });
}

test('mixed source-token bracket spans split at exact UTF-16 positions while lexical islands stay whole', async () => {
  const scopes = [undefined, ['comment.block'], ['string.quoted.double'], ['variable.other.constant.verilog'],
    ['keyword.control', 'meta.identifier.escaped.verilog']];
  const line = '😀 value[7:0] + fn({arg})';
  for (const protectedScopes of scopes) {
    const document = new HdlTokenDocument({ tokenizeLine(text, state) {
      return { tokens: [{ startIndex: 0, endIndex: text.length, scopes: protectedScopes || ['source.verilog'] }], ruleStack: state };
    } });
    document.update([line], 1);
    assert.equal(await document.ensure(0), true);
    const tokens = document.tokens(0);
    assert.equal(tokens.map(token => line.slice(token.startIndex, token.endIndex)).join(''), line);
    if (protectedScopes) {
      assert.equal(tokens.length, 1, protectedScopes.join(' '));
      assert.notEqual(tokens[0].category, 'bracket');
    } else {
      const brackets = tokens.filter(token => token.category === 'bracket');
      assert.equal(brackets.map(token => line.slice(token.startIndex, token.endIndex)).join(''), '[]({})');
      for (const token of brackets) assert.match(line.slice(token.startIndex, token.endIndex), /^[()[\]{}]+$/);
      assert.equal(brackets[0].startIndex, line.indexOf('['));
      assert.equal(tokens[0].endIndex, line.indexOf('['));
    }
  }
});

test('editing a multiline lexical island restores bracket spans and preserves only the unchanged prefix', async () => {
  const grammar = await tokenizer.grammar('verilog');
  let calls = 0;
  const document = new HdlTokenDocument({ tokenizeLine(...args) { calls++; return grammar.tokenizeLine(...args); } });
  const lines = ['module top;', 'wire stable;', '/* begin (', 'end ) */', 'initial begin', 'end', 'endmodule'];
  document.update(lines, 1);
  assert.equal(await document.ensure(6), true);
  assert.equal(categoryAt(document, lines, 2, 'begin ('), 'comment');
  assert.equal(categoryAt(document, lines, 3, 'end )'), 'comment');
  const prefix = document.tokens(1), priorCalls = calls;
  const edited = [...lines];
  edited[2] = 'initial begin'; edited[3] = 'end';
  document.update(edited, 2, 2);
  assert.strictEqual(document.tokens(1), prefix);
  assert.deepEqual(document.tokens(2), []);
  assert.equal(await document.ensure(3), true);
  assert.equal(calls - priorCalls, 2);
  assert.equal(categoryAt(document, edited, 2, 'initial'), 'keyword');
  assert.equal(categoryAt(document, edited, 2, 'begin'), 'bracket');
  assert.equal(categoryAt(document, edited, 3, 'end'), 'bracket');
  assert.deepEqual(document.tokens(4), []);
});
