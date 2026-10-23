'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HdlIndex, connectionExpression } = require('../src/indexer');

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

test('port declarations reverse to each matching parent connection without changing definitions or references', () => {
  const files = {
    'child.sv': 'module child(input logic data, output logic done); assign done = data; endmodule',
    'top.sv': 'module top; wire data; wire done; child first(.data(data), .done(done)), second(.data(data), .done()); endmodule',
    'other.sv': 'module other(input data); endmodule\nmodule another; wire data; other u(.data(data)); endmodule'
  };
  const { index, at, defs } = setup(files);
  const offset = at('child.sv', 'data');
  const query = index.parentConnections('child.sv', offset);
  assert.equal(query.declaration.kind, 'port');
  assert.equal(query.declaration.start, offset);
  assert.deepEqual(query.module, { name: 'child', path: 'child.sv', start: 7, end: 12, bodyStart: 0, bodyEnd: files['child.sv'].length });
  assert.deepEqual(query.connections.map(loc => [loc.path, loc.name, loc.start, loc.instance, loc.parentModule]), [
    ['top.sv', 'data', at('top.sv', '.data', 0, 1), 'first', 'top'],
    ['top.sv', 'data', at('top.sv', '.data', 1, 1), 'second', 'top']
  ]);
  assert.equal(defs('child.sv', 'data')[0].start, offset);
  assert.equal(index.references('child.sv', offset).length, 3);
  assert.equal(index.parentConnections('child.sv', at('child.sv', '= data', 0, 2)), undefined);
  assert.equal(index.parentConnections('top.sv', at('top.sv', 'wire data', 0, 5)), undefined);
  assert.equal(index.parentConnections('top.sv', at('top.sv', '.data', 0, 1)), undefined);
});

test('module declarations reverse to parent instance names and preserve their forward definition', () => {
  const files = {
    'child.v': 'module child; endmodule',
    'top.v': 'module top; child one(), two(); endmodule'
  };
  const { index, at, defs } = setup(files);
  const query = index.parentConnections('child.v', at('child.v', 'child', 0, 5));
  assert.equal(query.declaration.kind, 'module');
  assert.deepEqual(query.connections.map(loc => [loc.kind, loc.name, loc.start]), [
    ['instance', 'one', at('top.v', 'one')], ['instance', 'two', at('top.v', 'two')]
  ]);
  assert.equal(defs('child.v', 'child')[0].path, 'child.v');
  assert.equal(index.parentConnections('top.v', at('top.v', 'child')), undefined);
  assert.deepEqual(index.parentConnections('top.v', at('top.v', 'top')).connections, []);
});

test('non-ANSI header ports and explicit declarations share one canonical reverse-navigation declaration', () => {
  const files = {
    'child.v': 'module child(data, done); input data; output done; reg done; assign done = data; endmodule',
    'top.v': 'module top; wire data; child u(.data, .done()); endmodule'
  };
  const { index, at } = setup(files);
  const header = index.parentConnections('child.v', at('child.v', 'data'));
  const body = index.parentConnections('child.v', at('child.v', 'input data', 0, 6));
  assert.equal(header.declaration.start, at('child.v', 'input data', 0, 6));
  assert.deepEqual(header, body);
  assert.equal(body.connections[0].start, at('top.v', '.data', 0, 1));
  assert.equal(body.connections[0].implicit, true);
  assert.equal(index.parentConnections('child.v', at('child.v', 'reg done', 0, 4)), undefined);
  assert.equal(index.parentConnections('child.v', at('child.v', '= data', 0, 2)), undefined);
});

test('reverse navigation rejects local task ports, ordinary signals, comments, and strings', () => {
  const text = 'module child(input data); wire local_signal;\n' +
    'function automatic int f(input int data); return data; endfunction\n' +
    'task automatic t(input data); endtask\n' +
    '// data\ninitial $display("data"); endmodule';
  const { index, at } = setup({ 'child.sv': text });
  for (const marker of ['local_signal', 'input int data', 'task automatic t(input data)', '// data', '"data"']) {
    const delta = marker === 'input int data' ? 10 : marker === 'task automatic t(input data)' ? 23 : marker === '// data' ? 3 : marker === '"data"' ? 1 : 0;
    assert.equal(index.parentConnections('child.sv', at('child.sv', marker, 0, delta)), undefined, marker);
  }
  assert.equal(index.parentConnections('missing.sv', 0), undefined);
});

test('builtin reverse navigation keeps unelaborated conditional, generate, and macro candidates out', () => {
  const files = {
    'child.v': 'module child(input data); endmodule',
    'top.sv': 'module top; wire data; child certain(.data(data));\n' +
      '`ifdef ENABLED\nchild conditional(.data(data));\n`endif\n' +
      'generate if (1) begin : explicit_gen child explicit_child(.data(data)); end endgenerate\n' +
      'if (1) begin : implicit_gen child implicit_child(.data(data)); child another_child(.data(data)); end : implicit_gen\n' +
      'if (0) child short_if(.data(data)); else child short_else(.data(data));\n' +
      'for (genvar i=0; i<2; i=i+1) child loop_child(.data(data));\n' +
      'case (1) 0: child case_zero(.data(data)); 1: begin : selected child case_one(.data(data)); end endcase\n' +
      'child after_controls(.data(data)); endmodule',
    'macro.sv': 'module macro_parent; wire data; child #(.W(`WIDTH)) macro_child(.data(data)); endmodule',
    'port_branch.sv': 'module port_branch; wire data; child branch_port(\n`ifdef ENABLED\n.data(data)\n`endif\n); endmodule'
  };
  const { index, at } = setup(files);
  const query = index.parentConnections('child.v', at('child.v', 'data'));
  assert.deepEqual(query.connections.map(loc => loc.instance), ['certain', 'after_controls']);
  assert.deepEqual(index.parentConnections('child.v', at('child.v', 'child')).connections.map(loc => loc.name), ['certain', 'after_controls', 'branch_port']);
});

test('conditional declarations and ambiguous module names remain available to semantic lookup without guessing a parent', () => {
  const files = {
    'conditional.v': '`ifdef ENABLED\nmodule child(input data); endmodule\n`endif',
    'top.v': 'module top; wire data; child u(.data(data)); endmodule'
  };
  const { index, at } = setup(files);
  const conditional = index.parentConnections('conditional.v', at('conditional.v', 'data'));
  assert.equal(conditional.declaration.conditional, true);
  assert.equal(conditional.module.name, 'child');
  assert.deepEqual(conditional.connections, []);
  index.update('duplicate.v', 'module child(input data); endmodule');
  const duplicate = index.parentConnections('duplicate.v', 'module child(input '.length);
  assert.equal(duplicate.declaration.name, 'data');
  assert.deepEqual(duplicate.connections, []);
});

test('reverse connection queries honor Windows document keys and invalidate removed parents', () => {
  const index = new HdlIndex();
  const text = 'module child(input data); endmodule';
  index.update('C:/Work/child.v', text);
  index.update('C:/Work/top.v', 'module top; wire data; child u(.data(data)); endmodule');
  const offset = text.indexOf('data');
  assert.equal(index.parentConnections('c:\\work\\CHILD.v', offset).connections.length, 1);
  index.update('C:/Work/top.v', 'module top; endmodule');
  assert.equal(index.parentConnections('C:/Work/child.v', offset).connections.length, 0);
  index.remove('C:/Work/child.v');
  assert.equal(index.parentConnections('C:/Work/child.v', offset), undefined);
});

test('parent expression queries select one full connection per instance and preserve the default port targets', () => {
  const files = {
    'child.sv': 'module child(input logic data); endmodule',
    'top.sv': 'module top; wire sys_clk, data; wire [7:0] bus; wire other;\n' +
      'child first(.data( /* leading */ sys_clk /* trailing */ )),\n' +
      'second(.data( {bus[7:4], 2\'b0, other[0]} )),\n' +
      'implicit_port(.data /* same parent signal */), empty(.data( /* open */ )); endmodule'
  };
  const { index, at } = setup(files);
  const query = index.parentConnections('child.sv', at('child.sv', 'data'), { target: 'expression' });
  assert.deepEqual(query.connections.map(loc => [loc.instance, files[loc.path].slice(loc.start, loc.end)]), [
    ['first', 'sys_clk'], ['second', "{bus[7:4], 2'b0, other[0]}"], ['implicit_port', 'data']
  ]);
  assert.ok(query.connections.every(loc => loc.parentModule === 'top' && loc.type === 'child'));
  const original = index.parentConnections('child.sv', at('child.sv', 'data'));
  assert.equal(original.connections.length, 4);
  assert.ok(original.connections.every(loc => files[loc.path].slice(loc.start, loc.end) === 'data'));
  const modules = index.parentConnections('child.sv', at('child.sv', 'child'), { target: 'expression' });
  assert.deepEqual(modules.connections.map(loc => loc.name), ['first', 'second', 'implicit_port', 'empty']);
});

test('connection expressions trim outer comments and keep internal comments, slices, literals, and escaped identifiers', () => {
  const source = 'module top; child u(.data( // leading\n /* before */ {bus[3:0], /* inside */ other} // after\n )); endmodule';
  const index = new HdlIndex(); index.update('top.sv', source);
  const port = index.modules()[0].instances[0].ports[0];
  const target = connectionExpression(source, port);
  assert.equal(source.slice(target.start, target.end), '{bus[3:0], /* inside */ other}');
  assert.equal(port.start, source.indexOf('.data') + 1, 'The source connection is not mutated');
  for (const expression of ['\\system.clock ', '"literal ` text"', "1'b0", 'bus[3:0]']) {
    const text = `module top; child u(.data( /* left */ ${expression} /* right */ )); endmodule`;
    index.update('top.sv', text);
    const result = connectionExpression(text, index.modules()[0].instances[0].ports[0]);
    assert.equal(text.slice(result.start, result.end), expression.trim());
  }
});

test('connection expression targets exclude empty, macro, preprocessor, and malformed implicit connections', () => {
  const expressions = [
    '', ' /* no signal */ ', '`CLOCK',
    '\n`ifdef SELECT\nfirst\n`else\nsecond\n`endif\n'
  ];
  for (const expression of expressions) {
    const text = `module top; child u(.data(${expression})); endmodule`;
    const index = new HdlIndex(); index.update('top.sv', text);
    const port = index.modules()[0].instances[0].ports[0];
    assert.equal(connectionExpression(text, port), undefined, expression);
  }
  const implicitText = 'module top; child u(.data /* outer */ // line\n); endmodule';
  const index = new HdlIndex(); index.update('top.sv', implicitText);
  const implicit = index.modules()[0].instances[0].ports[0];
  assert.deepEqual(connectionExpression(implicitText, implicit), implicit);
  assert.equal(connectionExpression(implicitText, { ...implicit, conditional: true }), undefined);
  assert.equal(connectionExpression(implicitText.replace(' /* outer */', ' `UNEXPANDED'), implicit), undefined);
  assert.equal(connectionExpression(implicitText, { ...implicit, start: -1 }), undefined);
  assert.equal(connectionExpression(implicitText, { ...implicit, implicit: false, expressionStart: -1 }), undefined);
  const suffixMacro = 'module top; child u(.data(sys_clk) `UNEXPANDED); endmodule';
  index.update('top.sv', suffixMacro);
  assert.equal(connectionExpression(suffixMacro, index.modules()[0].instances[0].ports[0]), undefined);
});

test('builtin expression queries skip duplicate connections rather than choosing a source token by order', () => {
  const files = {
    'child.sv': 'module child(input data); endmodule',
    'top.sv': 'module top; wire first, second; child duplicate(.data(first), .data(second)); endmodule'
  };
  const { index, at } = setup(files);
  assert.equal(index.parentConnections('child.sv', at('child.sv', 'data')).connections.length, 2);
  assert.deepEqual(index.parentConnections('child.sv', at('child.sv', 'data'), { target: 'expression' }).connections, []);
  assert.deepEqual(index.parentConnections('child.sv', at('child.sv', 'data'), { target: 'port' }).connections, []);
});

test('local signal queries bind assign, always, runtime conditions, and parent-side connection uses inside one module', () => {
  const files = {
    'both.sv': 'module child(input clk); endmodule\n' +
      'module top(input clk); logic value; assign value = clk;\n' +
      'always @(posedge clk) begin if (clk) value <= clk; end\n' +
      'always_comb if (clk) value = clk;\n' +
      'child u(.clk(clk)); // clk\ninitial $display("clk"); endmodule\n' +
      'module other(input clk); wire value; assign value = clk; endmodule'
  };
  const { index, at, defs } = setup(files);
  const query = index.localSignal('both.sv', at('both.sv', 'assign value = clk', 0, 15));
  assert.equal(query.declaration.start, at('both.sv', 'module top(input clk)', 0, 'module top(input '.length));
  assert.equal(query.declaration.kind, 'port');
  assert.equal(query.module.name, 'top');
  assert.equal(query.certain, true);
  assert.equal(query.references.length, 7);
  assert.ok(query.references.every(loc => loc.start > query.module.start && loc.end <= query.module.bodyEnd));
  assert.ok(!query.references.some(loc => loc.start === at('both.sv', '.clk', 0, 1)));
  assert.equal(defs('both.sv', 'assign value = clk', 0, 15)[0].start, query.declaration.start);
  assert.equal(index.localSignal('both.sv', at('both.sv', '.clk', 0, 1)), undefined);
  assert.equal(index.localSignal('both.sv', at('both.sv', '// clk', 0, 3)), undefined);
  assert.equal(index.localSignal('both.sv', at('both.sv', '"clk"', 0, 1)), undefined);
});

test('local signal references respect nested shadowing and exclude external hierarchy', () => {
  const files = {
    'child.sv': 'module child; wire value; endmodule',
    'top.sv': 'module top; logic value; child u(); initial begin : local_block logic value; value = 1; end\n' +
      'assign value = u.value; endmodule'
  };
  const { index, at } = setup(files);
  const root = index.localSignal('top.sv', at('top.sv', 'assign value', 0, 7));
  assert.equal(root.declaration.start, at('top.sv', 'logic value', 0, 6));
  assert.deepEqual(root.references.map(loc => loc.start), [at('top.sv', 'assign value', 0, 7)]);
  const shadow = index.localSignal('top.sv', at('top.sv', 'value = 1'));
  assert.equal(shadow.declaration.start, at('top.sv', 'logic value', 1, 6));
  assert.deepEqual(shadow.references.map(loc => loc.start), [at('top.sv', 'value = 1')]);
  assert.equal(index.localSignal('top.sv', at('top.sv', 'u.value', 0, 2)), undefined);
});

test('local function and task signal bindings retain their runtime condition references without leaking into the module port', () => {
  const text = 'module top(input data);\n' +
    'function automatic int sample(input int data); if (data) sample = data; endfunction\n' +
    'task show(input data); if (data) $display(data); endtask endmodule';
  const { index, at } = setup({ 'top.sv': text });
  const func = index.localSignal('top.sv', at('top.sv', 'input int data', 0, 10));
  assert.equal(func.certain, true);
  assert.equal(func.references.length, 2);
  const taskPort = index.localSignal('top.sv', at('top.sv', 'task show(input data)', 0, 'task show(input '.length));
  assert.equal(taskPort.certain, true);
  assert.equal(taskPort.references.length, 2);
  assert.equal(index.localSignal('top.sv', at('top.sv', 'input data', 0, 6)).references.length, 0);
});

test('implicit named connections bind the local signal while explicit formal ports never become local, even for self types', () => {
  const text = 'module top(input clk); top explicit_child(.clk(clk)); top implicit_child(.clk); endmodule';
  const { index, at } = setup({ 'top.sv': text });
  const query = index.localSignal('top.sv', at('top.sv', '.clk', 1, 1));
  assert.equal(query.declaration.start, at('top.sv', 'clk'));
  assert.deepEqual(query.references.map(loc => loc.start), [at('top.sv', '(clk)', 0, 1), at('top.sv', '.clk', 1, 1)]);
  assert.equal(index.localSignal('top.sv', at('top.sv', '.clk', 0, 1)), undefined);
});

test('non-ANSI header aliases resolve to the canonical local port and remain source references', () => {
  const text = 'module old_style(clk); input clk; wire value; assign value = clk; endmodule';
  const { index, at } = setup({ 'old.v': text });
  const query = index.localSignal('old.v', at('old.v', 'clk'));
  assert.equal(query.declaration.start, at('old.v', 'input clk', 0, 6));
  assert.deepEqual(query.references.map(loc => loc.start), [at('old.v', 'clk'), at('old.v', '= clk', 0, 2)]);
  assert.deepEqual(index.localSignal('old.v', at('old.v', 'input clk', 0, 9)), query);
});

test('local signal queries exclude parameter and callable names and module navigation remains separate', () => {
  const text = 'module top #(parameter W=8)(input clk); function int f(); return W; endfunction task t; endtask wire value; endmodule';
  const { index, at } = setup({ 'top.sv': text });
  for (const marker of ['top', 'W', 'f()', 't;']) assert.equal(index.localSignal('top.sv', at('top.sv', marker)), undefined, marker);
  assert.equal(index.localSignal('missing.sv', 0), undefined);
  assert.equal(index.parentConnections('top.sv', at('top.sv', 'top')).declaration.kind, 'module');
});

test('conditional and macro local metadata remains conservative and does not pick an unelaborated declaration', () => {
  const text = 'module top; wire stable;\n`ifdef ENABLED\nwire selected; assign stable = selected;\n`else\nwire selected;\n`endif\n' +
    'if (1) begin : generated wire inner; assign inner = stable; end\n' +
    'assign stable = 1; endmodule';
  const { index, at } = setup({ 'top.sv': text });
  assert.equal(index.localSignal('top.sv', at('top.sv', 'selected')), undefined);
  const stable = index.localSignal('top.sv', at('top.sv', 'wire stable', 0, 5));
  assert.equal(stable.certain, true);
  assert.deepEqual(stable.references.map(loc => loc.start), [at('top.sv', 'assign stable = 1', 0, 7)]);
  const generated = index.localSignal('top.sv', at('top.sv', 'wire inner', 0, 5));
  assert.equal(generated.certain, false);
  const conditional = index.localSignal('top.sv', at('top.sv', 'assign stable = selected', 0, 7));
  assert.equal(conditional.certain, false);
  const macroText = 'module top; wire clk; assign clk = `CLOCK; endmodule';
  index.update('top.sv', macroText);
  assert.equal(index.localSignal('top.sv', macroText.indexOf('clk')).certain, false);
});
