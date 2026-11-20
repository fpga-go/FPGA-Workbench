'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildLintPlan, parseLintOutput, filterLintOutput, unlocatedLintMessages } = require('../src/lint-tools');

const cwd = path.resolve('synthetic-lint', 'project');
const workDir = path.resolve('synthetic-lint', 'scratch');
const source = path.join(cwd, 'rtl', 'top.sv');
const common = { cwd, workDir, files: [source] };

test('Icarus plan checks all units without emitting or running simulation output', () => {
  const plan = buildLintPlan({ ...common, top: 'not_a_real_top', files: [source, source, 'inc/defs.svh'],
    includeDirs: ['include space'], defines: ['WIDTH=8', 'LABEL="hello world"'] });
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.executable, 'iverilog');
  assert.equal(step.cwd, workDir);
  assert.deepEqual(step.args.slice(0, 5), ['-g2012', '-Wall', '-Wno-timescale', '-i', '-tnull']);
  assert.equal(step.args.filter(value => value === source).length, 1);
  assert.ok(step.args.includes(path.join(cwd, 'inc')));
  assert.ok(step.args.includes(path.join(cwd, 'include space')));
  assert.ok(step.args.includes('LABEL="hello world"'));
  assert.ok(!step.args.some(value => /defs\.svh|old\.vhd|not_a_real_top|vvp/.test(value)));
});

test('ModelSim plan creates a private library before compile and preserves Windows argv', () => {
  const plan = buildLintPlan({ backend: 'modelsim', cwd: 'C:\\工程 空格', workDir: 'C:\\临时 空格\\run',
    executable: 'D:\\EDA Tools\\modelsim\\vlog.exe', files: ['rtl\\top.v', 'rtl\\sub.sv'],
    includeDirs: ['defs'], defines: ['WIDTH=8', 'NAME="a b"'] });
  assert.equal(plan.steps[0].executable, 'D:\\EDA Tools\\modelsim\\vlib.exe');
  assert.deepEqual(plan.steps[0].args, ['C:\\临时 空格\\run\\work']);
  assert.equal(plan.steps[1].cwd, 'C:\\临时 空格\\run');
  assert.deepEqual(plan.steps[1].args.slice(0, 5), ['-nologo', '-sv', '-lint', '-work', 'C:\\临时 空格\\run\\work']);
  assert.ok(plan.steps[1].args.includes('+incdir+C:\\工程 空格\\defs'));
  assert.ok(plan.steps[1].args.includes('+define+NAME="a b"'));
  assert.ok(plan.steps[1].args.includes('C:\\工程 空格\\rtl\\top.v'));
  assert.ok(!plan.steps.some(step => /vsim|vmap/.test(step.executable)));
});

test('XSim plan invokes only xvlog and isolates all generated files in the scratch cwd', () => {
  const plan = buildLintPlan({ ...common, backend: 'xsim', defines: ['VALUE=(1+2)'], includeDirs: ['a b'] });
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.executable, 'xvlog');
  assert.deepEqual(step.args.slice(0, 3), ['--sv', '--work', 'work']);
  assert.equal(step.cwd, workDir);
  assert.ok(step.args.includes('VALUE=(1+2)'));
  assert.ok(step.args.includes(path.join(cwd, 'a b')));
});

test('Icarus rejects VHDL instead of silently skipping mixed-language source files', () => {
  for (const files of [['legacy.vhd'], ['modern.VHDL'], [source, 'legacy.vhd']]) {
    assert.throws(() => buildLintPlan({ ...common, files }), error =>
      error.code === 'LINT_LANGUAGE_UNSUPPORTED' && /不支持 VHDL/.test(error.message));
  }
});

test('XSim preserves mixed source order, logical libraries and per-file VHDL standards', () => {
  const files = ['types.vhd', 'top.sv', 'counter.vhdl', 'legacy.vhd', 'last.v'];
  const sourceEntries = files.map((file, index) => ({ path: file,
    library: index === 0 ? 'PkgLib' : 'xil_defaultlib', type: index === 2 ? 'VHDL 2008' : 'VHDL' }));
  const plan = buildLintPlan({ ...common, backend: 'xsim', executable: 'D:\\Vivado\\bin\\xvlog.exe', files, sourceEntries,
    defines: ['WIDTH=8'], includeDirs: ['include'] });
  assert.equal(plan.steps.length, 5);
  assert.deepEqual(plan.steps.map(step => path.win32.basename(step.executable)), ['xvhdl.exe', 'xvlog.exe', 'xvhdl.exe', 'xvhdl.exe', 'xvlog.exe']);
  assert.deepEqual(plan.steps.map(step => step.args.at(-1)), files.map(file => path.join(cwd, file)));
  assert.deepEqual(plan.steps[0].args.slice(0, 2), ['--work', 'pkglib']);
  assert.deepEqual(plan.steps[2].args.slice(0, 3), ['--2008', '--work', 'xil_defaultlib']);
  assert.ok(!plan.steps[3].args.includes('--2008'));
  for (const index of [0, 2, 3]) assert.ok(!plan.steps[index].args.some(value => /--sv|--include|--define/.test(value)));
  assert.ok(plan.steps[1].args.includes('--define'));
  assert.ok(plan.steps.every(step => step.cwd === workDir));
});

test('ModelSim creates private logical-library mappings and uses vcom for both VHDL extensions', () => {
  const files = ['package.vhd', 'top.sv', 'consumer.vhdl'];
  const plan = buildLintPlan({ ...common, backend: 'modelsim', executable: 'D:\\ModelSim\\vlog.exe', files,
    sourceEntries: [{ path: files[0], library: 'types_lib', type: 'VHDL' },
      { path: files[1], library: 'rtl_lib', type: 'SystemVerilog' },
      { path: files[2], library: 'rtl_lib', type: 'VHDL 2008' }], defines: ['WIDTH=8'] });
  assert.deepEqual(plan.steps[0], { executable: 'D:\\ModelSim\\vmap.exe', args: ['-c'], cwd: workDir });
  const ini = path.join(workDir, 'modelsim.ini');
  assert.deepEqual(plan.steps[2].args, ['-modelsimini', ini, 'types_lib', path.join(workDir, 'types_lib')]);
  assert.deepEqual(plan.steps[4].args, ['-modelsimini', ini, 'rtl_lib', path.join(workDir, 'rtl_lib')]);
  const compilers = plan.steps.slice(5);
  assert.deepEqual(compilers.map(step => path.win32.basename(step.executable)), ['vcom.exe', 'vlog.exe', 'vcom.exe']);
  assert.deepEqual(compilers.map(step => step.args.at(-1)), files.map(file => path.join(cwd, file)));
  assert.ok(compilers[0].args.includes('-93'));
  assert.ok(compilers[2].args.includes('-2008'));
  assert.ok(!compilers[0].args.some(value => value.startsWith('+incdir+') || value.startsWith('+define+')));
  assert.ok(compilers.every(step => step.args.includes(ini) && step.cwd === workDir));
});

test('adjacent compatible units share one compiler call without regrouping dependencies', () => {
  const plan = buildLintPlan({ ...common, backend: 'xsim', files: ['a.vhd', 'b.vhdl', 'c.sv', 'd.vhd'] });
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps[0].args.slice(-2), [path.join(cwd, 'a.vhd'), path.join(cwd, 'b.vhdl')]);
  assert.equal(plan.steps[2].args.at(-1), path.join(cwd, 'd.vhd'));
});

test('source metadata rejects escaping library names and conflicting duplicate entries', () => {
  for (const library of ['../other', 'a/b', '-work', 'work\nother']) {
    assert.throws(() => buildLintPlan({ ...common, backend: 'modelsim', sourceEntries: [{path: source, library}] }), /逻辑库名称/);
  }
  assert.throws(() => buildLintPlan({ ...common, backend: 'xsim', sourceEntries:
    [{path: source, library: 'one'}, {path: source, library: 'two'}] }), /不一致/);
  assert.throws(() => buildLintPlan({ ...common, backend: 'xsim', files: ['a.vhd'], sourceEntries:
    [{path: 'a.vhd', type: 'VHDL'}, {path: 'a.vhd', type: 'VHDL 2008'}] }), /不一致/);
});

test('VHDL diagnostic locations and vcom codes retain Error and Warning separation', () => {
  const text = '** Error: C:/design/types.vhd(3): (vcom-1136) Unknown identifier "missing".\n' +
    '# ** Warning: (vcom-1234) C:/design/top.vhdl(9,2): Unused declaration.';
  const diagnostics = parseLintOutput('modelsim', text, {cwd});
  assert.deepEqual(diagnostics.map(item => [item.severity, item.code, item.line, item.column]),
    [['error', 'vcom-1136', 2, 0], ['warning', 'vcom-1234', 8, 1]]);
  assert.equal(diagnostics[0].message, 'Unknown identifier "missing".');
  assert.deepEqual(unlocatedLintMessages('modelsim', text, {cwd}), {error: [], warning: []});
  const xsim = parseLintOutput('xsim', 'ERROR: [VRFC 10-91] missing declaration [C:/design/consumer.vhdl:12]', {cwd});
  assert.equal(xsim[0].line, 11);
  assert.equal(xsim[0].file, 'C:\\design\\consumer.vhdl');
});

test('plans reject ambiguous ModelSim plusargs and malformed inputs before execution', () => {
  assert.throws(() => buildLintPlan({ ...common, backend: 'unknown' }), /不支持/);
  assert.throws(() => buildLintPlan({ ...common, workDir: 'relative' }), /绝对路径/);
  assert.throws(() => buildLintPlan({ ...common, workDir: cwd }), /工程根目录/);
  assert.throws(() => buildLintPlan({ ...common, files: ['only.vh'] }), /没有可检查/);
  assert.throws(() => buildLintPlan({ ...common, defines: ['-o=file'] }), /宏定义/);
  assert.throws(() => buildLintPlan({ ...common, files: ['bad\nfile.v'] }), /控制字符/);
  assert.throws(() => buildLintPlan({ ...common, executable: 'bad\u0000.exe' }), /控制字符/);
  assert.throws(() => buildLintPlan({ ...common, backend: 'modelsim', includeDirs: ['a+b'] }), /加号/);
  assert.throws(() => buildLintPlan({ ...common, backend: 'modelsim', defines: ['WIDTH=1+2'] }), /加号/);
});

test('Icarus diagnostics retain Windows drive, Unicode path, severity and 0-based positions', () => {
  const text = [
    'C:\\工程 空格\\top.sv:12: syntax error',
    'C:\\工程 空格\\top.sv:13:4: warning: implicit definition of wire foo.',
    'C:\\工程 空格\\top.sv:14: sorry: unsupported construct.',
    'C:\\工程 空格\\top.sv:12: syntax error',
    'iverilog: invalid option -- z',
    'I give up.'
  ].join('\n');
  assert.deepEqual(parseLintOutput('iverilog', text, { cwd }), [
    { file: 'C:\\工程 空格\\top.sv', line: 11, column: 0, severity: 'error', message: 'syntax error' },
    { file: 'C:\\工程 空格\\top.sv', line: 12, column: 3, severity: 'warning', message: 'implicit definition of wire foo.' },
    { file: 'C:\\工程 空格\\top.sv', line: 13, column: 0, severity: 'error', message: 'unsupported construct.' }
  ]);
});

test('ModelSim diagnostics parse both code placements, suppressible warnings and transcript prefix', () => {
  const text = [
    '** Error: (vlog-13069) C:/项目/test(1)/bad.sv(4): near "end": syntax error.',
    '# ** Warning (suppressible): C:/项目/test(1)/bad.sv(7,9): (vlog-2583) A port is unconnected.',
    '** Note: other.v(2): informational message',
    '** Error: Failed to check out license.',
    'Errors: 1, Warnings: 1'
  ].join('\r\n');
  const result = parseLintOutput('modelsim', text, { cwd, files: [path.join(cwd, 'rtl', 'other.v')] });
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { file: 'C:\\项目\\test(1)\\bad.sv', line: 3, column: 0,
    severity: 'error', message: 'near "end": syntax error.', code: 'vlog-13069' });
  assert.equal(result[1].severity, 'warning');
  assert.equal(result[1].column, 8);
  assert.equal(result[1].code, 'vlog-2583');
  assert.equal(result[2].file, path.join(cwd, 'rtl', 'other.v'));
  assert.equal(result[2].severity, 'info');
});

test('XSim diagnostics parse severity and VRFC codes without inventing locations for tool failures', () => {
  const text = [
    'ERROR: [VRFC 10-4982] syntax error near end [C:/工程/top.sv:23]',
    'WARNING: [VRFC 10-123] warning with [quoted text] [C:/工程/top.sv:25:4]',
    'INFO: [VRFC 10-311] analyzing module top',
    'ERROR: [XSIM 43-3409] Failed to compile all files.'
  ].join('\n');
  assert.deepEqual(parseLintOutput('xsim', text, { cwd }), [
    { file: 'C:\\工程\\top.sv', line: 22, column: 0, severity: 'error', message: 'syntax error near end', code: 'VRFC 10-4982' },
    { file: 'C:\\工程\\top.sv', line: 24, column: 3, severity: 'warning', message: 'warning with [quoted text]', code: 'VRFC 10-123' }
  ]);
});

test('relative include errors, ANSI output and unlocated errors are handled without shell interpretation', () => {
  const output = '\u001b[31minclude/defs.svh:8: error: Undefined macro\u001b[0m\n<command line>:1: syntax error';
  const result = parseLintOutput('iverilog', output, { cwd });
  assert.equal(result.length, 1);
  assert.equal(result[0].file, path.join(cwd, 'include', 'defs.svh'));
  assert.equal(result[0].line, 7);
  const args = buildLintPlan({ ...common, defines: ['TEXT="$(touch file) & whoami"'] }).steps[0].args;
  assert.ok(args.includes('TEXT="$(touch file) & whoami"'));
});

test('Icarus timescale warnings are disabled after Wall by default and can be restored', () => {
  const normal = buildLintPlan(common).steps[0].args;
  assert.equal(normal[normal.indexOf('-Wall') + 1], '-Wno-timescale');
  const restored = buildLintPlan({ ...common, ignoreTimescaleWarnings: false }).steps[0].args;
  assert.ok(restored.includes('-Wall'));
  assert.ok(!restored.includes('-Wno-timescale'));
  assert.deepEqual(restored.slice(0, 4), ['-g2012', '-Wall', '-i', '-tnull']);
});

test('Icarus source-location notes never inflate errors and ignored timescale notes disappear', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`part${i}.v:2: warning: timescale for part${i} inherited from another file.`);
    lines.push(`timebase${i % 5}.v:1: ...: The inherited timescale is here.`);
  }
  for (let i = 0; i < 16; i++) lines.push(`top.v:${10 + i}: warning: implicit definition of wire 'signal${i}'.`);
  for (let i = 0; i < 5; i++) lines.push(`data.v:${10 + i}: warning: Extra digits given for sized hex constant.`);
  lines.push("clock.v:65: error: 'clock' has already been declared in this scope.");
  lines.push('clock.v:28:      : It was declared here as a net.');
  const text = lines.join('\r\n');
  const counts = diagnostics => Object.fromEntries(['error', 'warning', 'info'].map(kind => [kind, diagnostics.filter(item => item.severity === kind).length]));
  assert.deepEqual(counts(parseLintOutput('iverilog', text, { cwd })), { error: 1, warning: 21, info: 1 });
  assert.deepEqual(counts(parseLintOutput('iverilog', text, { cwd, ignoreTimescaleWarnings: false })), { error: 1, warning: 61, info: 6 });
  assert.ok(!filterLintOutput('iverilog', text).includes('The inherited timescale is here'));
  assert.equal(filterLintOutput('iverilog', text, { ignoreTimescaleWarnings: false }), text);
});

test('timescale filtering preserves genuine errors, bare syntax errors and unrelated signal names', () => {
  const text = [
    'timescale.v:2: warning: implicit definition of wire timescale.',
    'top.v:3: syntax error',
    'top.v:4: error: Invalid timescale unit.',
    'top.v:5: sorry: time precision expression is not supported.',
    'top.v:6: error: ...: The inherited timescale is here.',
    'top.v:7: error: Module duplicate was already declared here: base.v:1',
    'top.v:8:      : It was declared here as a variable.'
  ].join('\n');
  assert.equal(filterLintOutput('iverilog', text), text);
  const result = parseLintOutput('iverilog', text, { cwd });
  assert.deepEqual(result.map(item => item.severity), ['warning', 'error', 'error', 'error', 'error', 'error', 'info']);
});

test('known multiline Icarus global timescale warnings are hidden without consuming following errors', () => {
  const warning = [
    'warning: Some design elements have no explicit time unit and/or',
    '       : time precision. This may cause confusing timing results.',
    '       : Affected design elements are:',
    '       :   -- module top declared here: rtl/top.v:2',
    '       :   -- package types declared here: rtl/types.sv:3'
  ].join('\r\n') + '\r\n';
  const rest = 'rtl/top.v:9: syntax error\r\nwarning: Port timescale is unconnected.\r\n';
  assert.equal(filterLintOutput('iverilog', warning + rest), rest);
  assert.equal(filterLintOutput('iverilog', warning + rest, { ignoreTimescaleWarnings: false }), warning + rest);
  assert.equal(parseLintOutput('iverilog', warning + rest, { cwd }).filter(item => item.severity === 'error').length, 1);
  const unusual = '       : Additional compiler details must remain.\r\n';
  assert.equal(filterLintOutput('iverilog', warning + unusual + rest), unusual + rest);
});

test('ModelSim filtering reads warning semantics rather than filenames, quoted names or errors', () => {
  const ignored = [
    '** Warning: (vlog-2275) rtl/top.v(2): Timescale of module top is inherited from another file.',
    '** Warning: (vlog-3009) Module top does not have a timeunit/timeprecision specification in effect.',
    '** Warning (suppressible): rtl/top.v(5): (vlog-2275) No time scale specified for module top.'
  ].join('\n') + '\n';
  const retained = [
    '** Error: (vlog-1) rtl/top.v(3): Invalid timescale directive.',
    '** Warning: rtl/timescale.v(7): (vlog-8) implicit definition of wire timescale.',
    '** Warning: rtl/top.v(8): (vlog-8) Module timescale has no output ports.',
    '** Note: rtl/top.v(9): time scale information'
  ].join('\n');
  assert.equal(filterLintOutput('modelsim', ignored + retained), retained);
  assert.equal(parseLintOutput('modelsim', ignored + retained, { cwd }).length, 4);
  assert.equal(parseLintOutput('modelsim', ignored + retained, { cwd, ignoreTimescaleWarnings: false }).length, 6);
});

test('XSim filtering hides explicit time-setting warnings and preserves error locations and original bytes', () => {
  const ignored = 'WARNING: [VRFC 10-1] module top has no explicit timescale [C:/设计/top.v:1]\r\n';
  const retained = [
    '\u001b[31mERROR: [VRFC 10-2] Invalid time scale syntax [C:/设计/top.v:2]\u001b[0m',
    'WARNING: [VRFC 10-3] signal timescale is never used [C:/设计/time scale.v:3]',
    'WARNING: [VRFC 10-4] port timeunit is unconnected [C:/设计/top.v:4]',
    'WARNING: [VRFC 10-5] timescale is an implicit wire [C:/设计/top.v:5]'
  ].join('\r\n') + '\r\n';
  assert.equal(filterLintOutput('xsim', ignored + retained), retained);
  const result = parseLintOutput('xsim', ignored + retained, { cwd });
  assert.equal(result.filter(item => item.severity === 'error').length, 1);
  assert.equal(result.filter(item => item.severity === 'warning').length, 3);
  assert.equal(filterLintOutput('xsim', ignored + retained, { ignoreTimescaleWarnings: false }), ignored + retained);
});

test('unlocated summaries keep explicit Icarus severities without duplicating located or ordinary lines', () => {
  const warning = '  warning: backend warning with no source';
  const error = '\u001b[31merror: Invalid timescale directive\u001b[0m';
  const text = [warning, error, 'fatal: tool stopped', 'compile started: error count follows', '0 errors, 1 warnings',
    'rtl/top.v:3: error: located error', 'rtl/top.v:4: warning: located warning',
    'warning: Some design elements have no explicit time unit and/or',
    '       : time precision. This may cause confusing timing results.'].join('\r\n');
  assert.deepEqual(unlocatedLintMessages('iverilog', text, {cwd}), {error: [error, 'fatal: tool stopped'], warning: [warning]});
  const all = unlocatedLintMessages('iverilog', text, {cwd, ignoreTimescaleWarnings: false});
  assert.equal(all.warning.length, 2);
  assert.equal(all.error[0], error, 'an erroneous timescale always stays visible');
  assert.equal(parseLintOutput('iverilog', text, {cwd}).length, 2, 'source diagnostics keep their existing scope');
});

test('unlocated ModelSim and xvlog summaries keep original lines and reject progress text', () => {
  const modelWarnings = ['** Warning: (vlog-7) Unresolved library', '# ** Warning (suppressible): (vlog-8) A global warning'];
  const modelError = '** Error: (vlog-9) Invalid timescale directive';
  const modelsim = [...modelWarnings, modelError, '** Warning: rtl/top.v(2): located warning',
    '** Error: rtl/top.v(3): located error', '** Note: ordinary note', 'Errors: 1, Warnings: 2',
    '** Warning: No time scale specified for module top.'].join('\n');
  assert.deepEqual(unlocatedLintMessages('modelsim', modelsim, {cwd}), {error: [modelError], warning: modelWarnings});
  const xsimWarnings = ['WARNING: [VRFC 10-1] Global warning', 'CRITICAL WARNING: [VRFC 10-2] Missing library'];
  const xsimError = 'ERROR: [VRFC 10-3] Invalid time scale syntax';
  const xsim = [...xsimWarnings, xsimError, 'ERROR: [VRFC 10-4] Local failure [rtl/top.v:4]',
    'WARNING: [VRFC 10-5] Local warning [rtl/top.v:5]', 'INFO: [VRFC 10-6] 0 errors',
    'WARNING: [VRFC 10-7] module top has no explicit timescale'].join('\n');
  assert.deepEqual(unlocatedLintMessages('xsim', xsim, {cwd}), {error: [xsimError], warning: xsimWarnings});
});
