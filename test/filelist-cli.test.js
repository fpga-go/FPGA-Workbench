'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { main, parseArgs } = require('../src/filelist-cli');

const scratch = path.resolve(__dirname, '../test-tmp');
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'filelist-cli-'));
  t.after(async () => {
    const relative = path.relative(scratch, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  const files = {
    'top.v': 'module top; endmodule\n',
    'alternate.sv': 'module alternate; endmodule\n',
    'tb.sv': 'module tb; endmodule\n',
    'pins.xdc': 'set_property PACKAGE_PIN A1 [get_ports clk]\n',
    'fixture.srcs/sources_1/ip/fifo/fifo.xci': '<test-ip/>\n',
    'fixture.gen/sources_1/ip/fifo/fifo_stub.v': 'module fifo; endmodule\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const xpr = path.join(root, 'fixture.xpr');
  const xml = `<?xml version="1.0"?>
<!-- Product Version: Vivado v2023.1 (64-bit) -->
<Project><Configuration><Option Name="Part" Val="test-part"/>
<Option Name="ActiveSimSet" Val="sim_1"/></Configuration><FileSets>
<FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.v"/>
<File Path="$PSRCDIR/sources_1/ip/fifo/fifo.xci"/><Config><Option Name="TopModule" Val="top"/></Config></FileSet>
<FileSet Name="sources_2" Type="DesignSrcs"><File Path="$PPRDIR/alternate.sv"/><Config><Option Name="TopModule" Val="alternate"/></Config></FileSet>
<FileSet Name="sim_1" Type="SimulationSrcs"><File Path="$PPRDIR/tb.sv"/><Config><Option Name="SrcSet" Val="sources_1"/></Config></FileSet>
<FileSet Name="constrs_1" Type="Constrs"><File Path="$PPRDIR/pins.xdc"/></FileSet>
</FileSets></Project>`;
  await fs.writeFile(xpr, xml);
  return { root, xpr, files: { ...files, 'fixture.xpr': xml } };
}

async function invoke(args) {
  let stdout = '', stderr = '';
  const code = await main(args, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}
const activePaths = text => text.split('\n').filter(line => line && !line.startsWith('//'));

test('CLI exports a relative static list with metadata and comment-only IP while preserving all inputs', async t => {
  const { root, xpr, files } = await fixture(t);
  const outputDirectory = path.join(root, 'output folder');
  await fs.mkdir(outputDirectory);
  const out = path.join(outputDirectory, 'sources.f');
  const result = await invoke(['--xpr', xpr, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const text = await fs.readFile(out, 'utf8');
  assert.deepEqual(activePaths(text), ['../top.v']);
  assert.ok(text.includes(`// Output file: ${out.replace(/\\/g, '/')}`));
  assert.match(text, /XPR-recorded Vivado version: 2023\.1/);
  assert.match(text, /NOT elaborated compile order/);
  assert.match(text, /XCI original path: \$PSRCDIR\/sources_1\/ip\/fifo\/fifo\.xci/);
  assert.match(text, /Simulation netlist candidate \[missing\]:/);
  assert.match(result.stdout, /已导出静态 XPR Filelist/);
  assert.match(result.stderr, /警告（静态 XPR）/);
  for (const [name, contents] of Object.entries(files)) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), contents);
});

test('CLI forwards fileset, top and simulation options with the requested static scope', async t => {
  const { root, xpr } = await fixture(t);
  const alternate = path.join(root, 'alternate.f');
  assert.equal((await invoke(['--xpr', xpr, '--out', alternate, '--fileset', 'sources_2', '--top', 'review_top'])).code, 0);
  const alternateText = await fs.readFile(alternate, 'utf8');
  assert.deepEqual(activePaths(alternateText), ['alternate.sv']);
  assert.match(alternateText, /Top: review_top/);
  assert.match(alternateText, /Selected filesets: sources_2/);
  const simulation = path.join(root, 'simulation.f');
  assert.equal((await invoke(['--xpr', xpr, '--out', simulation, '--with-sim'])).code, 0);
  const simText = await fs.readFile(simulation, 'utf8');
  assert.deepEqual(activePaths(simText), ['top.v', 'tb.sv']);
  assert.match(simText, /simulation indexing included/);
});

test('CLI requires explicit force for an existing independent output and leaves no temporary files', async t => {
  const { root, xpr } = await fixture(t);
  const out = path.join(root, 'existing.f');
  await fs.writeFile(out, 'keep this output\n');
  const denied = await invoke(['--xpr', xpr, '--out', out]);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /已存在/);
  assert.equal(await fs.readFile(out, 'utf8'), 'keep this output\n');
  const replaced = await invoke(['--xpr', xpr, '--out', out, '--force']);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.deepEqual(activePaths(await fs.readFile(out, 'utf8')), ['top.v']);
  assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.tmp')));
});

test('CLI refuses XPR, all registered inputs and existing or missing IP artifacts even with force', async t => {
  const { root, xpr, files } = await fixture(t);
  for (const name of ['fixture.xpr', 'top.v', 'alternate.sv', 'pins.xdc',
    'fixture.srcs/sources_1/ip/fifo/fifo.xci', 'fixture.gen/sources_1/ip/fifo/fifo_stub.v',
    'fixture.gen/sources_1/ip/fifo/fifo_sim_netlist.v', 'fixture.srcs/sources_1/ip/fifo/fifo_sim_netlist.v']) {
    const out = path.join(root, name);
    const result = await invoke(['--xpr', xpr, '--out', out, '--force']);
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, /工程输入文件或 IP 参考工件/, name);
  }
  for (const [name, contents] of Object.entries(files)) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), contents);
  assert.equal(await fs.stat(path.join(root, 'fixture.gen/sources_1/ip/fifo/fifo_sim_netlist.v')).catch(error => error.code), 'ENOENT');
});

test('CLI refuses a hard-link alias of a project input', async t => {
  const { root, xpr } = await fixture(t);
  const original = path.join(root, 'top.v');
  const alias = path.join(root, 'alias.f');
  await fs.link(original, alias);
  const before = await fs.readFile(original);
  const result = await invoke(['--xpr', xpr, '--out', alias, '--force']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /相同文件身份/);
  assert.deepEqual(await fs.readFile(original), before);
});

test('CLI rejects missing values, duplicate and unknown arguments before creating output', async t => {
  const { root, xpr } = await fixture(t);
  const out = path.join(root, 'invalid.f');
  const valid = ['--xpr', xpr, '--out', out];
  for (const args of [[], ['--xpr'], ['--out'], ['--xpr', '--out', out],
    [...valid, '--fileset'], [...valid, '--top', ''], [...valid, '--unknown'],
    [...valid, '--xpr', xpr], [...valid, '--out', out], [...valid, '--fileset', 'sources_1', '--fileset', 'sources_2'],
    [...valid, '--top', 'top', '--top', 'other'], [...valid, '--force', '--force'],
    [...valid, '--with-sim', '--with-sim'], [...valid, '--help'], ['--help', '--help']]) {
    const result = await invoke(args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Filelist 导出失败/);
    assert.equal(await fs.stat(out).catch(error => error.code), 'ENOENT');
  }
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('CLI help needs no project and missing directories or invalid filesets produce no output', async t => {
  const help = await invoke(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--xpr <project\.xpr>/);
  assert.equal(help.stderr, '');
  const { root, xpr } = await fixture(t);
  const missingDirectory = path.join(root, 'absent', 'sources.f');
  const missing = await invoke(['--xpr', xpr, '--out', missingDirectory]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /父目录不存在/);
  assert.equal(await fs.stat(path.join(root, 'absent')).catch(error => error.code), 'ENOENT');
  const invalid = path.join(root, 'invalid.f');
  const badFileset = await invoke(['--xpr', xpr, '--out', invalid, '--fileset', 'not_a_fileset']);
  assert.equal(badFileset.code, 1);
  assert.match(badFileset.stderr, /找不到 fileset/);
  assert.equal(await fs.stat(invalid).catch(error => error.code), 'ENOENT');
});
