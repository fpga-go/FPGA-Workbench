'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { discoverLintTools, resolveLintExecutable, resolveLintCompanions, runLintProcess, decodeOutput } = require('../src/lint-process');
const { parseLintOutput } = require('../src/lint-tools');

async function temporary(t) {
  const base = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'fpga-lint-process-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), base);
    assert.ok(path.basename(dir).startsWith('fpga-lint-process-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
const nodeStep = (source, args = [], cwd = os.tmpdir()) => ({ executable: process.execPath, args: ['-e', source, ...args], cwd });

test('lint runner preserves Chinese, spaces and shell metacharacters as literal argv', async t => {
  const dir = await temporary(t);
  const args = ['目录 with spaces/模块.sv', 'LABEL="hello world"', '&|<>^%!$();`'];
  const result = await runLintProcess(nodeStep('process.stdout.write(JSON.stringify(process.argv.slice(1)));', args, dir));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), args);
});

test('lint runner returns compiler exit code and both output streams', async () => {
  const result = await runLintProcess(nodeStep('process.stdout.write("normal output\\n");process.stderr.write("error output\\n");process.exitCode=7;'));
  assert.equal(result.code, 7);
  assert.match(result.output, /normal output/);
  assert.match(result.output, /error output/);
});

test('lint runner preserves a diagnostic split across stderr writes while stdout emits progress', async () => {
  const source = `const bytes=Buffer.from('C:/工程/top.sv:9: syntax error\\n');
    process.stderr.write(bytes.subarray(0,5),()=>setTimeout(()=>{
      process.stdout.write('progress message\\n',()=>setTimeout(()=>process.stderr.write(bytes.subarray(5)),20));
    },20));`;
  const result = await runLintProcess(nodeStep(source));
  assert.equal(result.output, 'progress message\n\nC:/工程/top.sv:9: syntax error\n');
  const diagnostics = parseLintOutput('iverilog', result.output);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].file, 'C:\\工程\\top.sv');
  assert.equal(diagnostics[0].line, 8);
  assert.equal(diagnostics[0].message, 'syntax error');
});

test('lint output decoding preserves UTF-8 and falls back to GB18030', async () => {
  assert.equal(decodeOutput(Buffer.from('中文 warning')), '中文 warning');
  assert.equal(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  const result = await runLintProcess(nodeStep('process.stderr.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));'));
  assert.equal(result.output, '中文');
  const mixed = await runLintProcess(nodeStep('process.stdout.write("状态\\n");process.stderr.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));'));
  assert.equal(mixed.output, '状态\n\n中文');
});

test('lint runner explains oversized command lines for sync and async spawn failures', async () => {
  const oversized = () => Object.assign(Error('spawn E2BIG'), { code: 'E2BIG' });
  const verify = error => {
    assert.equal(error.code, 'LINT_COMMAND_TOO_LONG');
    assert.match(error.message, /命令行过长/);
    assert.match(error.message, /减少检查文件范围/);
    return true;
  };
  await assert.rejects(runLintProcess(nodeStep(''), { spawn() { throw oversized(); } }), verify);
  await assert.rejects(runLintProcess(nodeStep(''), { spawn() {
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('error', oversized()); child.emit('close', -1); });
    return child;
  } }), verify);
});

test('lint runner rejects spawn failure after process closure', async t => {
  const dir = await temporary(t);
  await assert.rejects(runLintProcess({ executable: path.join(dir, 'missing-tool.exe'), args: [], cwd: dir }), { code: 'LINT_SPAWN_FAILED' });
});

test('lint runner stops a timed out process and retains preceding diagnostics', { timeout: 15000 }, async () => {
  await assert.rejects(runLintProcess(nodeStep('process.stdout.write("started\\n");setInterval(()=>{},1000);'), { timeoutMs: 300 }), error => {
    assert.equal(error.code, 'LINT_TIMEOUT');
    assert.match(error.output, /started/);
    return true;
  });
});

test('lint runner cancels a live process and accepts an already cancelled signal', { timeout: 15000 }, async () => {
  const early = new AbortController();
  early.abort();
  await assert.rejects(runLintProcess(nodeStep('process.exit(0)'), { signal: early.signal }), { code: 'ABORT_ERR' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(runLintProcess(nodeStep('setInterval(()=>{},1000)'), { signal: controller.signal }), { code: 'ABORT_ERR' });
  } finally { clearTimeout(timer); }
});

test('lint runner bounds combined stdout and stderr before rejecting overflow', { timeout: 15000 }, async () => {
  await assert.rejects(runLintProcess(nodeStep('process.stdout.write("a".repeat(800));process.stderr.write("b".repeat(800));setInterval(()=>{},1000);'), { maxOutputBytes: 1000 }), error => {
    assert.equal(error.code, 'LINT_OUTPUT_LIMIT');
    // The byte cap is shared by both raw streams. One display separator is added.
    assert.equal(Buffer.byteLength(error.output.replace(/\n/g, '')), 1000);
    assert.ok(Buffer.byteLength(error.output) <= 1001);
    return true;
  });
});

test('lint runner cancellation terminates descendants before returning', { timeout: 20000 }, async t => {
  const dir = await temporary(t);
  const childCode = 'setInterval(()=>{},1000);';
  const source = `const cp=require('child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});process.stdout.write(String(child.pid));setInterval(()=>{},1000);`;
  let pid;
  await assert.rejects(runLintProcess(nodeStep(source, [], dir), { timeoutMs: 500 }), error => {
    assert.equal(error.code, 'LINT_TIMEOUT');
    pid = Number(error.output.trim());
    assert.ok(pid > 0);
    return true;
  });
  // Windows taskkill /T /F has exited before runLintProcess rejects.
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('lint tool resolver uses explicit absolute executables and preserves parent environment', async () => {
  const env = { Path: 'original path', KEEP: 'original' };
  const result = await resolveLintExecutable('iverilog', process.execPath, { env });
  assert.equal(result.executable, path.normalize(process.execPath));
  assert.deepEqual(result.env, env);
  assert.notEqual(result.env, env);
  await assert.rejects(resolveLintExecutable('iverilog', 'relative/tool.exe'), { code: 'LINT_TOOL_PATH' });
  await assert.rejects(resolveLintExecutable('unknown'), { code: 'LINT_BACKEND' });
});

test('lint tool resolver searches absolute PATH entries without invoking a shell', async t => {
  const dir = await temporary(t);
  const executable = path.join(dir, process.platform === 'win32' ? 'iverilog.exe' : 'iverilog');
  await fs.writeFile(executable, 'fixture');
  const env = { Path: ['.', 'relative', '"' + dir + '"'].join(path.delimiter) };
  const result = await resolveLintExecutable('iverilog', '', { env });
  assert.equal(result.executable, executable);
  await assert.rejects(resolveLintExecutable('modelsim', '', { env }), { code: 'LINT_TOOL_MISSING' });
});

test('explicit ModelSim path requires its companion vlib before it can be selected', async t => {
  const dir = await temporary(t);
  const executable = await fakeTool(path.join(dir, 'ModelSim with spaces'), 'vlog');
  await assert.rejects(resolveLintExecutable('modelsim', executable), error => error.code === 'LINT_TOOL_MISSING' && /vlib/.test(error.message));
  await fakeTool(path.dirname(executable), 'vlib');
  const resolved = await resolveLintExecutable('modelsim', executable, {env: {PATH: ''}});
  assert.equal(resolved.executable, executable);
  assert.equal(resolved.env.PATH, '');
});

test('Windows lint tool resolver refuses arbitrary batch scripts', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t);
  const batch = path.join(dir, 'tool.bat');
  await fs.writeFile(batch, '@echo off');
  await assert.rejects(resolveLintExecutable('iverilog', batch), { code: 'LINT_TOOL_PATH' });
  await assert.rejects(resolveLintExecutable('xsim', batch), { code: 'LINT_TOOL_PATH' });
});

test('Windows XSim resolves standard roots, wrappers, unwrapped exe and environment fallback', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t);
  const root = path.join(dir, 'Vivado 安装 2023.1');
  const exe = path.join(root, 'bin', 'unwrapped', 'win64.o', 'xvlog.exe');
  const batch = path.join(root, 'bin', 'xvlog.bat');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'fixture');
  await fs.writeFile(batch, '@echo off');
  const env = { Path: path.join(root, 'bin'), KEEP: 'unchanged' };
  for (const configured of [root, batch, exe, '']) {
    const result = await resolveLintExecutable('xsim', configured, { env });
    assert.equal(result.executable, exe);
    assert.equal(result.env.RDI_APPROOT, root);
    assert.equal(result.env.RDI_DATADIR, path.join(root, 'data'));
    assert.equal(result.env.RDI_PLATFORM, 'win64');
    assert.equal(result.env.KEEP, 'unchanged');
    assert.ok(result.env.Path.startsWith(path.join(root, 'lib', 'win64.o') + path.delimiter));
    assert.ok(!Object.hasOwn(result.env, 'PATH'));
  }
  assert.deepEqual(env, { Path: path.join(root, 'bin'), KEEP: 'unchanged' });
  const fallback = await resolveLintExecutable('xsim', '', { env: { PATH: '', XILINX_VIVADO: root } });
  assert.equal(fallback.executable, exe);
  await fs.unlink(exe);
  await assert.rejects(resolveLintExecutable('xsim', batch, { env }), { code: 'LINT_TOOL_PATH' });
});

test('lint runner rejects invalid resource limits before spawning', async () => {
  await assert.rejects(runLintProcess(nodeStep(''), { timeoutMs: 0 }), { code: 'LINT_LIMIT' });
  await assert.rejects(runLintProcess(nodeStep(''), { maxOutputBytes: 0 }), { code: 'LINT_LIMIT' });
});

const toolName = name => process.platform === 'win32' ? name + '.exe' : name;
async function fakeTool(directory, name) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, toolName(name));
  // These files are deliberately not executable programs. Discovery must not run them.
  await fs.writeFile(file, 'discovery fixture; never execute');
  return file;
}
async function fakeXsim(root) {
  const bin = path.join(root, 'bin');
  const executable = await fakeTool(process.platform === 'win32' ? path.join(bin, 'unwrapped', 'win64.o') : bin, 'xvlog');
  if (process.platform === 'win32') await fs.writeFile(path.join(bin, 'xvlog.bat'), '@echo discovery must not execute this wrapper');
  return { bin, executable };
}

test('discovery returns backend priority independently of PATH order and preserves parent environment', async t => {
  const dir = await temporary(t);
  const modelsim = path.join(dir, 'ModelSim 中文 空格');
  const vlog = await fakeTool(modelsim, 'vlog');
  await fakeTool(modelsim, 'vlib');
  const xsim = await fakeXsim(path.join(dir, 'Vivado 中文 空格'));
  const icarus = path.join(dir, 'Icarus 中文 空格');
  const iverilog = await fakeTool(icarus, 'iverilog');
  const env = Object.freeze({ Path: [modelsim, xsim.bin, '"' + icarus + '"'].join(path.delimiter), KEEP: 'original', XILINX_VIVADO: 'unused' });
  const before = { ...env };
  const tools = await discoverLintTools({ env });
  assert.deepEqual(tools.map(tool => tool.backend), ['iverilog', 'xsim', 'modelsim']);
  assert.deepEqual(tools.map(tool => tool.executable), [iverilog, xsim.executable, vlog]);
  assert.deepEqual(env, before);
  for (const tool of tools) { assert.notEqual(tool.env, env); assert.equal(tool.env.KEEP, 'original'); }
  assert.equal(tools[0].env.Path, before.Path);
  assert.equal(tools[2].env.Path, before.Path);
  if (process.platform === 'win32') {
    assert.ok(tools[1].env.Path.startsWith(path.join(path.dirname(xsim.bin), 'lib', 'win64.o')));
    assert.equal(tools[1].env.RDI_APPROOT, path.dirname(xsim.bin));
  }
});

test('discovery keeps the first usable PATH candidate for each backend without duplicates', async t => {
  const dir = await temporary(t);
  const first = path.join(dir, 'first'), second = path.join(dir, 'second');
  const firstIcarus = await fakeTool(first, 'iverilog');
  await fakeTool(second, 'iverilog');
  const firstVlog = await fakeTool(first, 'vlog');
  await fakeTool(first, 'vlib');
  await fakeTool(second, 'vlog'); await fakeTool(second, 'vlib');
  const firstXsim = await fakeXsim(path.join(dir, 'first-vivado'));
  const secondXsim = await fakeXsim(path.join(dir, 'second-vivado'));
  const env = { PATH: [first, firstXsim.bin, second, secondXsim.bin, first].join(path.delimiter) };
  const tools = await discoverLintTools({ env });
  assert.deepEqual(tools.map(tool => tool.executable), [firstIcarus, firstXsim.executable, firstVlog]);
});

test('discovery skips ModelSim without a same-directory vlib and finds a later complete installation', async t => {
  const dir = await temporary(t);
  const incomplete = path.join(dir, 'incomplete'), complete = path.join(dir, 'complete');
  await fakeTool(incomplete, 'vlog');
  const vlog = await fakeTool(complete, 'vlog');
  await fakeTool(complete, 'vlib');
  assert.deepEqual(await discoverLintTools({ env: { PATH: incomplete } }), []);
  const tools = await discoverLintTools({ env: { PATH: [incomplete, complete].join(path.delimiter) } });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].backend, 'modelsim');
  assert.equal(tools[0].executable, vlog);
});

test('discovery with empty or relative-only PATH never uses configured paths or installation variables', async t => {
  const dir = await temporary(t);
  const xsim = await fakeXsim(path.join(dir, 'not-on-path'));
  const iverilog = await fakeTool(path.join(dir, 'also-not-on-path'), 'iverilog');
  for (const PATH of ['', ['.', 'relative', ''].join(path.delimiter)]) {
    assert.deepEqual(await discoverLintTools({ env: { PATH, XILINX_VIVADO: path.dirname(xsim.bin) }, configured: iverilog }), []);
  }
  assert.deepEqual(await discoverLintTools({ env: {} }), []);
});

test('Windows discovery accepts only standard XSim wrappers with an existing unwrapped exe', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t);
  const arbitrary = path.join(dir, 'arbitrary');
  await fs.mkdir(arbitrary, { recursive: true });
  for (const name of ['iverilog.bat', 'vlog.bat', 'vlib.bat', 'xvlog.bat', 'xvlog.cmd']) {
    await fs.writeFile(path.join(arbitrary, name), '@echo must never run');
  }
  await fakeTool(arbitrary, 'xvlog');
  assert.deepEqual(await discoverLintTools({ env: { PATH: arbitrary } }), []);
  const brokenBin = path.join(dir, 'broken-vivado', 'bin');
  await fs.mkdir(brokenBin, { recursive: true });
  await fs.writeFile(path.join(brokenBin, 'xvlog.bat'), '@echo missing unwrapped exe');
  assert.deepEqual(await discoverLintTools({ env: { PATH: brokenBin } }), []);
  const valid = await fakeXsim(path.join(dir, 'valid-vivado'));
  const tools = await discoverLintTools({ env: { PATH: [arbitrary, brokenBin, valid.bin].join(path.delimiter) } });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].executable, valid.executable);
  assert.equal(path.extname(tools[0].executable).toLowerCase(), '.exe');
  const direct = await discoverLintTools({ env: { PATH: path.dirname(valid.executable) } });
  assert.equal(direct[0].executable, valid.executable);
});

test('VHDL companions use the selected Vivado installation and retain its child environment', async t => {
  const dir = await temporary(t);
  const xsim = await fakeXsim(path.join(dir, 'Vivado 中文 空格'));
  const xvhdl = await fakeTool(path.dirname(xsim.executable), 'xvhdl');
  const env = Object.freeze({ PATH: '', KEEP: 'original' });
  const selected = Object.freeze({ backend: 'xsim', ...await resolveLintExecutable('xsim', xsim.executable, { env }) });
  const selectedBefore = { ...selected, env: { ...selected.env } };
  const resolved = await resolveLintCompanions(selected, { vhdl: true, verilog: true });
  assert.equal(resolved.executable, xsim.executable);
  assert.equal(resolved.vhdlExecutable, xvhdl);
  assert.deepEqual(resolved.env, selected.env);
  assert.notEqual(resolved, selected);
  assert.notEqual(resolved.env, selected.env);
  assert.deepEqual(selected, selectedBefore);
  assert.deepEqual(env, { PATH: '', KEEP: 'original' });
  if (process.platform === 'win32') assert.equal(resolved.env.RDI_APPROOT, path.dirname(xsim.bin));
});

test('VHDL ModelSim companions include vcom, vmap and vlib from one directory', async t => {
  const dir = await temporary(t);
  const executable = await fakeTool(path.join(dir, 'ModelSim 中文 空格'), 'vlog');
  const vcom = await fakeTool(path.dirname(executable), 'vcom');
  const vmap = await fakeTool(path.dirname(executable), 'vmap');
  const vlib = await fakeTool(path.dirname(executable), 'vlib');
  const tool = { backend: 'modelsim', ...await resolveLintExecutable('modelsim', executable, { env: { PATH: '' } }) };
  const resolved = await resolveLintCompanions(tool, { vhdl: true, verilog: false });
  assert.equal(resolved.executable, executable);
  assert.equal(resolved.vhdlExecutable, vcom);
  assert.equal(resolved.mapExecutable, vmap);
  assert.equal(resolved.libraryExecutable, vlib);
  assert.deepEqual(resolved.env, { PATH: '' });
});

test('missing VHDL companions do not fall back to PATH or accept directories as executables', async t => {
  const dir = await temporary(t);
  const selected = path.join(dir, 'selected'), other = path.join(dir, 'other');
  for (const [backend, compiler, companion] of [['xsim', 'xvlog', 'xvhdl'], ['modelsim', 'vlog', 'vcom']]) {
    const executable = await fakeTool(selected, compiler);
    await fakeTool(other, companion);
    const tool = { backend, executable, env: { PATH: other } };
    const check = error => error.code === 'LINT_TOOL_MISSING' && error.message.includes(companion)
      && error.message.includes(selected) && !error.message.includes(other);
    await assert.rejects(resolveLintCompanions(tool, { vhdl: true }), check);
    await fs.mkdir(path.join(selected, toolName(companion)));
    await assert.rejects(resolveLintCompanions(tool, { vhdl: true }), check);
  }
});

test('VHDL ModelSim reports missing library helpers before running any compiler', async t => {
  const dir = await temporary(t);
  const executable = await fakeTool(dir, 'vlog');
  await fakeTool(dir, 'vcom');
  const tool = { backend: 'modelsim', executable, env: { PATH: '' } };
  await assert.rejects(resolveLintCompanions(tool, { vhdl: true }), error => error.code === 'LINT_TOOL_MISSING' && /vmap/.test(error.message));
  await fakeTool(dir, 'vmap');
  await assert.rejects(resolveLintCompanions(tool, { vhdl: true }), error => error.code === 'LINT_TOOL_MISSING' && /vlib/.test(error.message));
});

test('Verilog-only lint does not require VHDL compilers and VHDL never passes Icarus silently', async () => {
  for (const backend of ['iverilog', 'xsim', 'modelsim']) {
    const tool = Object.freeze({ backend, executable: process.execPath, env: Object.freeze({ PATH: '' }) });
    const resolved = await resolveLintCompanions(tool);
    assert.deepEqual(resolved, tool);
    assert.equal(resolved.vhdlExecutable, undefined);
  }
  await assert.rejects(resolveLintCompanions({ backend: 'iverilog', executable: process.execPath }, { vhdl: true }),
    error => error.code === 'LINT_LANGUAGE_UNSUPPORTED' && /iverilog 不支持 VHDL/.test(error.message));
  await assert.rejects(resolveLintCompanions({ backend: 'unknown' }, { vhdl: true }), { code: 'LINT_BACKEND' });
  await assert.rejects(resolveLintCompanions({ backend: 'xsim', executable: 'relative/xvlog.exe' }, { vhdl: true }), { code: 'LINT_TOOL_PATH' });
});

test('Verilog-only ModelSim library mapping requires vmap and vlib but not vcom', async t => {
  const dir = await temporary(t);
  const executable = await fakeTool(dir, 'vlog');
  const vlib = await fakeTool(dir, 'vlib');
  const tool = { backend: 'modelsim', executable, env: { PATH: '' } };
  await assert.rejects(resolveLintCompanions(tool, { libraryMapping: true }), error => error.code === 'LINT_TOOL_MISSING' && /vmap/.test(error.message));
  const vmap = await fakeTool(dir, 'vmap');
  const resolved = await resolveLintCompanions(tool, { libraryMapping: true, vhdl: false, verilog: true });
  assert.equal(resolved.mapExecutable, vmap);
  assert.equal(resolved.libraryExecutable, vlib);
  assert.equal(resolved.vhdlExecutable, undefined);
  for (const backend of ['iverilog', 'xsim']) {
    const other = { ...tool, backend };
    assert.deepEqual(await resolveLintCompanions(other, { libraryMapping: true }), other);
  }
});
