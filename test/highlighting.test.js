'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const root = path.resolve(__dirname, '..');
const files = {
  verilog: 'syntaxes/hdl.tmLanguage.json',
  systemverilog: 'syntaxes/systemverilog.tmLanguage.json'
};
let registryPromise;
function registry() {
  if (!registryPromise) registryPromise = (async () => {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    return new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
        createOnigString: value => new oniguruma.OnigString(value)
      }),
      loadGrammar: async scope => {
        const file = files[scope.replace('source.', '')];
        assert.ok(file, `unexpected external grammar dependency: ${scope}`);
        return textmate.parseRawGrammar(fs.readFileSync(path.join(root, file), 'utf8'), file);
      }
    });
  })();
  return registryPromise;
}
async function tokenize(language, lines) {
  const grammar = await (await registry()).loadGrammar(`source.${language}`);
  let state = textmate.INITIAL;
  return lines.map(line => {
    const result = grammar.tokenizeLine(line, state, 1000);
    assert.equal(result.stoppedEarly, false, 'bounded line tokenization must complete');
    state = result.ruleStack;
    return { line, tokens: result.tokens.map(token => ({
      ...token, text: line.slice(token.startIndex, token.endIndex)
    })) };
  });
}
function tokenAt(row, value, occurrence = 0) {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = row.line.indexOf(value, start + 1);
  assert.notEqual(start, -1, `missing fixture text ${value}`);
  const token = row.tokens.find(item => item.startIndex <= start && item.endIndex >= start + value.length);
  assert.ok(token, `expected a single token for ${value}: ${JSON.stringify(row.tokens)}`);
  return token;
}
function scoped(row, value, scope, occurrence) {
  const token = tokenAt(row, value, occurrence);
  assert.ok(token.scopes.some(item => item === scope || item.startsWith(`${scope}.`)),
    `${value}: expected ${scope}, got ${token.scopes.join(' ')}`);
  return token;
}
function cleanOfCodeScope(row, value) {
  const token = tokenAt(row, value);
  assert.equal(token.scopes.some(scope => /^(?:keyword|entity|variable|storage|support)\./.test(scope)), false,
    `code rule leaked into ${value}: ${token.scopes.join(' ')}`);
}

async function tokenizeWithOneLight(language, lines) {
  // Use a separate registry: changing a theme invalidates previously cached rule stacks.
  await registry();
  const directory = path.join(__dirname, 'fixtures/themes/atom-one-light');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'UPSTREAM.json'), 'utf8'));
  assert.equal(manifest.version, '2.3.0');
  for (const entry of manifest.files) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, entry.local))).digest('hex'), entry.sha256);
  }
  const theme = JSON.parse(fs.readFileSync(path.join(directory, 'OneLight.json'), 'utf8'));
  const themed = new textmate.Registry({
    theme: { settings: [{ settings: { foreground: theme.colors['editor.foreground'], background: theme.colors['editor.background'] } }, ...theme.tokenColors] },
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: value => new oniguruma.OnigString(value)
    }),
    loadGrammar: async scope => {
      const file = files[scope.replace('source.', '')];
      assert.ok(file, `unexpected external grammar dependency: ${scope}`);
      return textmate.parseRawGrammar(fs.readFileSync(path.join(root, file), 'utf8'), file);
    }
  });
  try {
    const grammar = await themed.loadGrammar(`source.${language}`);
    const colors = themed.getColorMap();
    let state = textmate.INITIAL;
    return lines.map(line => {
      const textual = grammar.tokenizeLine(line, state, 1000);
      const binary = grammar.tokenizeLine2(line, state, 1000);
      assert.equal(textual.stoppedEarly, false);
      assert.equal(binary.stoppedEarly, false);
      state = textual.ruleStack;
      const runs = [];
      for (let index = 0; index < binary.tokens.length; index += 2) {
        // EncodedTokenMetadata's foreground field is the 9 bits starting at bit 15.
        runs.push({ start: binary.tokens[index], end: binary.tokens[index + 2] ?? line.length,
          foreground: colors[(binary.tokens[index + 1] & 0x00FF8000) >>> 15] });
      }
      return { line, tokens: textual.tokens.map(token => ({ ...token,
        text: line.slice(token.startIndex, token.endIndex),
        foreground: runs.find(run => run.start <= token.startIndex && run.end > token.startIndex)?.foreground
      })) };
    });
  } finally {
    themed.dispose();
  }
}

for (const language of Object.keys(files)) {
  test(`${language}: One Light keeps ordinary signals neutral across a complete reset/state example`, async () => {
    // Original generic fixture, independent of user RTL, settings and installed extensions.
    const lines = [
      '`define WIDTH 8',
      'module reader(input wire clk, input wire rst_n, input wire [7:0] i_payload, output reg [7:0] o_payload);',
      "localparam ST_IDLE = 2'd0;",
      'reg [1:0] state;',
      'reg [7:0] r_payload;',
      'wire [7:0] next_payload;',
      'wire [2:0] bit_index;',
      'child #(.WIDTH(`WIDTH)) u_child(.clk(clk), .i_payload(r_payload), .o_payload(next_payload));',
      'always @(posedge clk or negedge rst_n) begin',
      '  if (!rst_n) begin',
      '    state <= ST_IDLE;',
      "    r_payload <= 8'd0;",
      '  end else begin',
      '    case (state)',
      '      ST_IDLE: r_payload <= i_payload;',
      '      default: r_payload <= next_payload;',
      '    endcase',
      '    o_payload <= r_payload;',
      '  end',
      'end',
      'wire \\always.signal ;',
      'assign \\always.signal = r_payload[bit_index];',
      'function [7:0] transform;',
      '  input [7:0] value;',
      "  begin transform = value ^ 8'hA5; end",
      'endfunction',
      'initial $display("module r_payload state", r_payload);',
      '/* state r_payload',
      '   if ST_IDLE */ wire recovered;',
      'endmodule',
      'module child(clk, i_payload, o_payload);',
      '  parameter WIDTH = 8;',
      '  input clk;',
      '  input [WIDTH-1:0] i_payload;',
      '  output [WIDTH-1:0] o_payload;',
      '  assign o_payload = i_payload;',
      'endmodule'
    ];
    if (language === 'systemverilog') lines.push(
      'class Packet;', '  logic [7:0] payload;', '  logic ACTIVE;',
      '  function automatic logic [7:0] update(input logic [7:0] value);',
      '    payload = value;', '    ACTIVE = payload[0];', '    return payload;', '  endfunction', 'endclass'
    );
    lines.push('module direct_reader(input wire clk);', 'child u_plain(.clk(clk));', 'endmodule');
    const rows = await tokenizeWithOneLight(language, lines);
    const at = (line, text) => tokenAt(rows[line - 1], text);
    const neutral = (line, text) => {
      const token = at(line, text);
      assert.equal(token.foreground, '#383A42', `${language}:${line} ${text}: ${token.scopes.join(' ')}`);
      assert.equal(token.scopes.some(scope => /^(?:variable|entity|storage|support|constant|string|comment)\./.test(scope)), false,
        `${text} must not be disguised as a known semantic category: ${token.scopes.join(' ')}`);
    };
    for (const [line, text] of [
      [2, 'i_payload'], [2, 'o_payload'], [3, 'ST_IDLE'], [4, 'state'], [5, 'r_payload'],
      [6, 'next_payload'], [7, 'bit_index'], [11, 'state'], [11, 'ST_IDLE'], [12, 'r_payload'],
      [14, 'state'], [15, 'i_payload'], [16, 'next_payload'], [18, 'o_payload'],
      [21, '\\always.signal'], [22, '\\always.signal'], [22, 'r_payload'], [22, 'bit_index'],
      [24, 'value'], [25, 'value'], [29, 'recovered'], [31, 'i_payload'],
      [33, 'clk'], [34, 'i_payload'], [35, 'o_payload'], [36, 'o_payload'], [36, 'i_payload']
    ]) neutral(line, text);
    if (language === 'systemverilog') {
      for (const [line, text] of [[39, 'payload'], [40, 'ACTIVE'], [41, 'value'], [42, 'payload'], [42, 'value'], [43, 'ACTIVE'], [43, 'payload'], [44, 'payload']]) neutral(line, text);
    }
    assert.equal(at(8, 'u_child').foreground, '#383A42');
    assert.equal(at(8, 'u_child').scopes.some(scope => /^(?:variable|entity\.name\.tag)\./.test(scope)), false);
    assert.equal(at(8, 'child').foreground, '#C18401');
    const plainInstance = rows.find(row => row.line === 'child u_plain(.clk(clk));');
    assert.equal(tokenAt(plainInstance, 'u_plain').foreground, '#383A42');
    assert.equal(tokenAt(plainInstance, 'child').foreground, '#C18401');
    assert.equal(at(2, 'reader').foreground, '#C18401');
    assert.equal(at(9, 'always').foreground, '#A626A4');
    assert.equal(at(10, 'if').foreground, '#A626A4');
    assert.equal(at(12, "8'd0").foreground, '#986801');
    assert.equal(at(23, 'transform').foreground, '#4078F2');
    assert.equal(at(27, 'module r_payload state').foreground, '#50A14F');
    assert.equal(at(28, 'state').foreground, '#A0A1A7');
    assert.equal(at(29, 'ST_IDLE').foreground, '#A0A1A7');
    assert.ok(new Set(rows.flatMap(row => row.tokens.map(token => token.foreground))).size >= 6);
  });
}

test('grammar provenance, hashes, independent scopes and local includes are complete', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'syntaxes/UPSTREAM.json'), 'utf8'));
  assert.equal(manifest.commit, '4af5dc18fdf906d35577bbc0aa2937d09d964f5b');
  assert.equal(manifest.files.length, 2);
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, entry.local));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.localSha256);
    assert.match(entry.upstreamSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.patches.length > 0);
    const grammar = JSON.parse(bytes.toString('utf8'));
    assert.equal(grammar.scopeName, entry.scopeName);
    const walk = object => {
      if (!object || typeof object !== 'object') return;
      if (object.include) {
        assert.ok(object.include.startsWith('#') || ['$self', '$base'].includes(object.include), object.include);
        if (object.include.startsWith('#')) assert.ok(grammar.repository[object.include.slice(1)], object.include);
      }
      for (const value of Object.values(object)) walk(value);
    };
    walk(grammar);
    const reachable = new Set();
    const visitIncludes = object => {
      if (!object || typeof object !== 'object') return;
      if (object.include?.startsWith('#')) {
        const name = object.include.slice(1);
        if (!reachable.has(name)) {
          reachable.add(name);
          visitIncludes(grammar.repository[name]);
        }
      }
      for (const value of Object.values(object)) visitIncludes(value);
    };
    visitIncludes(grammar.patterns);
    assert.deepEqual([...reachable].sort(), Object.keys(grammar.repository).sort(), 'all repository rules must be reachable');
  }
  const notice = fs.readFileSync(path.join(root, manifest.licenseNotice), 'utf8');
  for (const copyright of ['2016-2022 Masahiro H', '2018 Eirik Prestegårdshus', 'TextMate Verilog Bundle']) {
    assert.ok(notice.includes(copyright));
  }
});

for (const language of Object.keys(files)) {
  test(`${language}: comments and strings isolate HDL syntax and resume after closing`, async () => {
    const rows = await tokenize(language, [
      '// module fake 8\'shA5 `MACRO "function"',
      '/* module fake',
      '   assert property (x); */ wire recovered;',
      'initial $display("module function `MACRO \\"quoted\\" 8\'shA5");',
      'wire after_string;'
    ]);
    scoped(rows[0], 'module', 'comment');
    scoped(rows[1], 'module', 'comment');
    scoped(rows[2], 'assert', 'comment');
    cleanOfCodeScope(rows[0], 'module');
    cleanOfCodeScope(rows[1], 'module');
    scoped(rows[2], 'wire', language === 'verilog' ? 'keyword' : 'storage');
    scoped(rows[3], 'module function `MACRO', 'string');
    cleanOfCodeScope(rows[3], 'module function `MACRO');
    scoped(rows[4], 'after_string', 'meta.identifier');
  });

  test(`${language}: multiline macro body and continued string recover`, async () => {
    const rows = await tokenize(language, [
      '`define MESSAGE "module \\',
      'function task"',
      '`define APPLY(x) \\',
      '  ((x) + 1)',
      'wire recovered;'
    ]);
    scoped(rows[1], 'function task', 'string');
    cleanOfCodeScope(rows[1], 'function task');
    scoped(rows[3], '1', 'constant.numeric');
    scoped(rows[4], 'recovered', 'meta.identifier');
  });

  test(`${language}: escaped identifiers are one lexical token before keywords`, async () => {
    const rows = await tokenize(language, [
      'module top;',
      'wire \\module.end ;',
      'assign \\module.end = \\function/task ;',
      'child u_child(.\\input.output (\\module.end ));',
      'endmodule'
    ]);
    for (const [index, value] of [[1, '\\module.end'], [2, '\\function/task'], [3, '\\input.output'], [3, '\\module.end']]) {
      const token = scoped(rows[index], value, `meta.identifier.escaped.${language}`);
      assert.equal(token.text, value);
      assert.equal(token.scopes.some(scope => scope.startsWith('string.')), false);
    }
  });
}

test('Verilog: signed based literals, unknown digits and real exponents are whole tokens', async () => {
  const row = (await tokenize('verilog', ["localparam A = 8'shA5, B = 'hff, C = 4'b10?z, D = 32'd1_024, E = -32'sd1, F = 12.5e-3, G = 1e+6, H = 1.25; "]))[0];
  for (const value of ["8'shA5", "'hff", "4'b10?z", "32'd1_024", "32'sd1"]) {
    assert.equal(scoped(row, value, 'constant.numeric.sized_integer.verilog').text, value);
  }
  for (const value of ['12.5e-3', '1e+6', '1.25']) {
    assert.equal(scoped(row, value, 'constant.numeric.real.verilog').text, value);
  }
  const malformed = await tokenize('verilog', ["localparam BAD = 32'sd-1;", 'module recovered;', 'endmodule']);
  scoped(malformed[1], 'recovered', 'entity.name.type.module.verilog');
});

test('Verilog: modules, parameterized instances, multiline functions and tasks', async () => {
  const rows = await tokenize('verilog', [
    '`define WIDTH 8', '`ifdef_flag', 'module top(input wire clk);',
    'child u_child(.clk(clk));', 'child #(.WIDTH(`WIDTH)) u_param(.clk(clk));',
    'function automatic [7:0]', '  mix(input [7:0] value);', 'endfunction',
    'task drive;', 'endtask', 'endmodule'
  ]);
  scoped(rows[0], '`define', 'keyword.other.compiler.directive.verilog');
  scoped(rows[1], '`ifdef_flag', 'variable.other.constant.verilog');
  scoped(rows[2], 'top', 'entity.name.type.module.verilog');
  scoped(rows[3], 'child', 'entity.name.type.module.verilog');
  scoped(rows[3], 'u_child', 'meta.instance.name.verilog');
  scoped(rows[4], 'u_param', 'meta.instance.name.verilog');
  scoped(rows[4], '`WIDTH', 'variable.other.constant.verilog');
  scoped(rows[5], 'function', 'storage.type.function.verilog');
  scoped(rows[6], 'mix', 'entity.name.function.verilog');
  scoped(rows[8], 'drive', 'entity.name.function.verilog');
  scoped(rows[10], 'endmodule', 'storage.type.module.verilog');
});

test('SystemVerilog: signed, unbased, exponent and time literals retain numeric scopes', async () => {
  const row = (await tokenize('systemverilog', ["localparam A = 8'shA5, B = -32'sd1, C = '0, D = '1, E = 'x, F = 12.5e-3, G = 1e+6, H = 2.5ns, I = 10ps; "]))[0];
  for (const value of ["8'shA5", "32'sd1", "'0", "'1", "'x", '12.5e-3', '1e+6', '2.5ns', '10ps']) {
    assert.equal(scoped(row, value, 'constant.numeric').text, value);
  }
});

test('SystemVerilog: package, interface, class, typedef, functions and SVA have lexical scopes', async () => {
  const rows = await tokenize('systemverilog', [
    '`define WIDTH 8', '`ifdef_flag', 'package pkg;', 'typedef logic [7:0] byte_t;', 'endpackage',
    'interface link(input logic clk);', 'modport master(input clk);', 'endinterface',
    'class Worker;', 'function automatic int mix(input int value);', 'endfunction', 'task drive;', 'endtask', 'endclass',
    'module top;', 'child #(.WIDTH(`WIDTH)) u_child(.clk(clk));',
    'sequence delayed; ready ##1 done; endsequence',
    'ap: assert property (@(posedge clk) ready |=> done);', 'while_helper(value);', 'endmodule'
  ]);
  scoped(rows[0], 'WIDTH', 'variable.other.constant.preprocessor.systemverilog');
  scoped(rows[1], 'ifdef_flag', 'variable.other.constant.preprocessor.systemverilog');
  for (const [index, value] of [[2, 'pkg'], [5, 'link'], [6, 'master']]) scoped(rows[index], value, 'entity.name.type.module.systemverilog');
  scoped(rows[3], 'byte_t', 'meta.typedef.systemverilog');
  scoped(rows[8], 'Worker', 'entity.name.type.class.systemverilog');
  scoped(rows[9], 'mix', 'entity.name.function.systemverilog');
  scoped(rows[11], 'drive', 'entity.name.function.systemverilog');
  scoped(rows[15], 'u_child', 'meta.instance.name.systemverilog');
  scoped(rows[15], 'clk', 'support.function.port.systemverilog');
  scoped(rows[16], 'delayed', 'entity.name.function.systemverilog');
  scoped(rows[17], 'ap', 'entity.name.label.systemverilog');
  scoped(rows[17], 'property', 'keyword');
  scoped(rows[17], '|=>', 'keyword.operator.logical.systemverilog');
  scoped(rows[18], 'while_helper', 'entity.name.function.systemverilog');
});

test('bounded real-engine workload records throughput and long-line recovery', { timeout: 20000 }, async t => {
  for (const language of Object.keys(files)) {
    const lines = ['module workload(input wire clk);'];
    for (let index = 0; index < 1500; index++) lines.push(`wire signal_${index}; // comment module \'shFF`);
    lines.push(`/* ${'module " fake '.repeat(400)}`, '*/ wire recovered;', 'endmodule');
    const started = performance.now();
    const rows = await tokenize(language, lines);
    const elapsedMs = performance.now() - started;
    scoped(rows.at(-2), 'recovered', 'meta.identifier');
    const tokenCount = rows.reduce((count, row) => count + row.tokens.length, 0);
    assert.ok(tokenCount > 4500);
    t.diagnostic(JSON.stringify({ language, lines: lines.length, bytes: Buffer.byteLength(lines.join('\n')), maxLine: Math.max(...lines.map(line => line.length)), tokenCount, elapsedMs: Math.round(elapsedMs * 100) / 100 }));
  }
});
