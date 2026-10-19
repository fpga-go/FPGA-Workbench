'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HdlIndex } = require('../src/indexer');

function setup(files) {
  const index = new HdlIndex();
  for (const [path, text] of Object.entries(files)) index.update(path, text);
  const at = (path, text, occurrence = 0, delta = 0) => {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) offset = files[path].indexOf(text, offset + 1);
    assert.notEqual(offset, -1, `Missing test marker ${text}`);
    return offset + delta;
  };
  const defs = (path, text, occurrence = 0, delta = 0) => index.definitions(path, at(path, text, occurrence, delta));
  return { index, at, defs };
}

test('module type and instance name navigate across files; multiple parameterized instances are indexed', () => {
  const files = {
    'leaf.sv': 'module leaf #(parameter integer W = 8)(input logic [W-1:0] data, output logic ready); endmodule',
    'top.sv': 'module top; wire [7:0] bus; wire ok; leaf #(.W(8)) first(.data(bus), .ready(ok)), second(.data(bus), .ready()); endmodule'
  };
  const { index, defs } = setup(files);
  assert.equal(index.modules().find(m => m.name === 'top').instances.length, 2);
  for (const word of ['leaf', 'first', 'second']) {
    assert.deepEqual(defs('top.sv', word).map(d => [d.path, d.name, d.kind]), [['leaf.sv', 'leaf', 'module']]);
  }
  assert.equal(defs('top.sv', '.W', 0, 1)[0].name, 'W');
  assert.equal(defs('top.sv', '.W', 0, 1)[0].kind, 'parameter');
});

test('named port left side resolves child port and right side resolves parent signal', () => {
  const files = {
    'child.v': 'module child(input clk, input data, output done); wire clk; endmodule',
    'top.v': 'module top; wire clk; wire data; wire done; child u_child(.clk(clk), .data(data), .done(done)); endmodule',
    'unrelated.v': 'module unrelated; wire clk; wire data; endmodule'
  };
  const { defs } = setup(files);
  assert.equal(defs('top.v', '.clk', 0, 1)[0].path, 'child.v');
  assert.equal(defs('top.v', '(clk)', 0, 1)[0].path, 'top.v');
  assert.equal(defs('top.v', '.data', 0, 1)[0].path, 'child.v');
  assert.equal(defs('top.v', '(data)', 0, 1)[0].path, 'top.v');
  assert.equal(defs('top.v', '(done)', 0, 1).length, 1);
});

test('same-file modules and non-ANSI repeated port declarations do not leak or duplicate', () => {
  const text = 'module a(clk, result); input clk; output result; reg result; wire private_a; assign result = clk; endmodule\n' +
    'module b; wire clk; wire result; assign result = private_a; endmodule';
  const { index, defs } = setup({ 'both.v': text });
  const a = index.modules().find(m => m.name === 'a');
  assert.equal(a.symbols.filter(s => s.name === 'result').length, 1);
  assert.equal(a.symbols.find(s => s.name === 'result').kind, 'port');
  assert.equal(defs('both.v', 'clk', 2)[0].start, text.indexOf('input clk') + 'input '.length);
  assert.equal(defs('both.v', 'result = private_a', 0)[0].start, text.indexOf('wire result') + 'wire '.length);
  assert.deepEqual(defs('both.v', 'private_a', 1), []);
});

test('comments, strings, macro bodies and package-qualified names do not become definitions', () => {
  const text = '`define FAKE module bad; wire phantom; endmodule\n' +
    '// module another; wire ghost; endmodule\n' +
    'module real_module; wire good; /* wire hidden; */ initial $display("module nope; wire phantom;"); assign good = pkg::value; endmodule';
  const { index, defs } = setup({ 'real.sv': text });
  assert.deepEqual(index.modules().map(m => m.name), ['real_module']);
  assert.deepEqual(index.modules()[0].symbols.map(s => s.name), ['good']);
  assert.deepEqual(defs('real.sv', 'phantom', 0), []);
  assert.deepEqual(defs('real.sv', 'phantom', 1), []);
  assert.deepEqual(defs('real.sv', 'pkg::value', 0, 5), []);
});

test('nested hierarchy resolves through instances without falling back to same-name global wires', () => {
  const files = {
    'child.v': 'module child; wire inside_wire; endmodule',
    'middle.v': 'module middle; child nested(); endmodule',
    'top.v': 'module top; wire inside_wire; middle u_middle(); assign inside_wire = u_middle.nested.inside_wire; assign inside_wire = missing.inside_wire; endmodule'
  };
  const { defs } = setup(files);
  assert.equal(defs('top.v', 'u_middle.nested.inside_wire', 0, 'u_middle.nested.'.length)[0].path, 'child.v');
  assert.equal(defs('top.v', 'u_middle.nested.inside_wire', 0, 'u_middle.'.length)[0].name, 'child');
  assert.deepEqual(defs('top.v', 'missing.inside_wire', 0, 'missing.'.length), []);
});

test('procedural blocks and functions use the closest local declaration', () => {
  const text = 'module top; logic value; initial begin : worker logic value; value = 1; end\n' +
    'function automatic int calculate(input int value); int local_value; local_value = value; return local_value; endfunction\n' +
    'assign value = calculate(2); endmodule';
  const { defs } = setup({ 'scope.sv': text });
  assert.equal(defs('scope.sv', 'value = 1')[0].start, text.indexOf('logic value', text.indexOf('worker')) + 6);
  assert.equal(defs('scope.sv', 'local_value = value', 0, 'local_value = '.length)[0].start, text.indexOf('input int value') + 10);
  assert.equal(defs('scope.sv', 'assign value', 0, 7)[0].start, text.indexOf('logic value') + 6);
  assert.equal(defs('scope.sv', 'calculate(2)')[0].kind, 'function');
});

test('generate source scopes and instance arrays resolve by source declaration and warn about elaboration', () => {
  const files = {
    'leaf.v': 'module leaf; wire sig; endmodule',
    'top.v': 'module top; generate for (genvar i=0; i<2; i=i+1) begin : lanes leaf u_leaf(); end endgenerate\n' +
      'leaf many[1:0](); wire val; assign val = lanes[0].u_leaf.sig; assign val = many[1].sig; endmodule'
  };
  const { index, defs } = setup(files);
  const top = index.modules().find(m => m.name === 'top');
  assert.match(top.warnings.join(' '), /not elaborated/);
  assert.equal(defs('top.v', 'lanes[0].u_leaf.sig', 0, 'lanes[0].u_leaf.'.length)[0].path, 'leaf.v');
  assert.equal(defs('top.v', 'many[1].sig', 0, 'many[1].'.length)[0].path, 'leaf.v');
});

test('ambiguous module definitions return candidates and unresolved modules return no target', () => {
  const files = {
    'one.v': 'module choice(input a); endmodule',
    'two.v': 'module choice(input a); endmodule',
    'top.v': 'module top; wire a; choice u(.a(a)); unknown x(.a(a)); endmodule'
  };
  const { defs } = setup(files);
  assert.equal(defs('top.v', 'choice').length, 2);
  assert.equal(defs('top.v', '.a', 0, 1).length, 2);
  assert.deepEqual(defs('top.v', 'unknown'), []);
  assert.deepEqual(defs('top.v', '.a', 1, 1), []);
});

test('references follow definitions and do not include comments or unrelated same-name signals', () => {
  const files = {
    'child.v': 'module child(input clk); wire x; assign x = clk; endmodule',
    'top.v': 'module top; wire clk; child u(.clk(clk)); // clk\n endmodule',
    'other.v': 'module other; wire clk; endmodule'
  };
  const { index, at } = setup(files);
  const childRefs = index.references('child.v', at('child.v', 'clk'), false);
  assert.deepEqual(childRefs.map(r => [r.path, r.start]), [
    ['child.v', files['child.v'].indexOf('= clk') + 2],
    ['top.v', files['top.v'].indexOf('.clk') + 1]
  ]);
  const parentRefs = index.references('top.v', at('top.v', 'wire clk', 0, 5), true);
  assert.equal(parentRefs.length, 2);
  assert.ok(parentRefs.every(r => r.path === 'top.v'));
});

test('conditional branches are identified; symbols are not chosen arbitrarily', () => {
  const text = 'module top;\n`ifdef BIG\nwire selected;\n`else\nwire selected;\n`endif\nassign selected = 1; endmodule';
  const { index, defs } = setup({ 'conditional.v': text });
  assert.equal(defs('conditional.v', 'assign selected', 0, 7).length, 2);
  assert.match(index.modules()[0].warnings.join(' '), /conditions are not evaluated/);
});

test('implicit named ports expose both source endpoints; escaped identifiers retain source spans', () => {
  const files = {
    'child.sv': 'module child(input clk); endmodule',
    'top.sv': 'module top; wire clk; wire \\odd.name ; child u(.clk); assign clk = \\odd.name ; endmodule'
  };
  const { defs } = setup(files);
  assert.equal(defs('top.sv', '.clk', 0, 1).length, 2);
  const escaped = defs('top.sv', '\\odd.name', 1)[0];
  assert.equal(escaped.name, 'odd.name');
  assert.equal(escaped.end - escaped.start, '\\odd.name'.length);
});

test('updating, removal and clear invalidate stale cross-file definitions', () => {
  const { index, defs } = setup({ 'child.v': 'module child; endmodule', 'top.v': 'module top; child u(); endmodule' });
  assert.equal(defs('top.v', 'child').length, 1);
  index.update('child.v', 'module renamed; endmodule');
  assert.equal(defs('top.v', 'child').length, 0);
  index.remove('child.v');
  assert.deepEqual(index.modules().map(m => m.name), ['top']);
  index.clear();
  assert.equal(index.modules().length, 0);
});

test('Windows path casing and separators share one absolute document key', () => {
  const index = new HdlIndex();
  const original = 'C:/Workspace/rtl/top.v';
  const editor = 'c:\\workspace\\RTL\\top.v';
  const source = 'module top; wire signal_name; assign signal_name = 1; endmodule';
  index.update(original, 'module stale; endmodule');
  index.update(editor, source);
  assert.deepEqual(index.modules().map(mod => mod.name), ['top']);
  assert.equal(index.definitions(original, source.indexOf('top'))[0].name, 'top');
  const signal = index.definitions('C:/Workspace/rtl/../rtl/top.v', source.indexOf('assign signal_name') + 7);
  assert.equal(signal.length, 1);
  assert.equal(signal[0].start, source.indexOf('wire signal_name') + 5);
  index.remove('C:\\WORKSPACE\\rtl\\top.v');
  assert.equal(index.modules().length, 0);
});
