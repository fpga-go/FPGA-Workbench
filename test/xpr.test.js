'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadProject, resolveXprPath, filelist } = require('../src/xpr');

const scratch = path.resolve(__dirname, '../test-tmp');
async function fixture(t, xml, names = []) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'xpr-'));
  // This cleanup owns only the random fixture directory, never an input project.
  t.after(async () => {
    const relative = path.relative(scratch, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of names) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '// test fixture\n');
  }
  const xpr = path.join(root, 'fixture.xpr');
  await fs.writeFile(xpr, xml);
  return { root, xpr };
}

const project = contents => `<?xml version="1.0"?>\n<!-- Product Version: Vivado v2023.1 (64-bit) -->
<Project><Configuration><Option Name="Part" Val="test-part"/><Option Name="DefaultLib" Val="work"/>
<Option Name="ActiveSimSet" Val="sim_1"/></Configuration><FileSets>${contents}</FileSets></Project>`;
const file = (name, attrs = '') => `<File Path="${name}"><FileInfo>${attrs}</FileInfo></File>`;
const attr = (name, value) => `<Attr Name="${name}" Val="${value}"/>`;
const set = (name, type, contents, config = '') => `<FileSet Name="${name}" Type="${type}">${contents}<Config>${config}</Config></FileSet>`;

test('resolves relocated project tokens, braces, backslashes and parent directories', () => {
  const xpr = path.resolve(scratch, 'moved', 'fixture.xpr');
  const root = path.dirname(xpr);
  assert.equal(resolveXprPath('$PSRCDIR/sources_1/new/top.v', xpr), path.join(root, 'fixture.srcs/sources_1/new/top.v'));
  assert.equal(resolveXprPath('${PPRDIR}/../shared/top.v', xpr), path.resolve(root, '../shared/top.v'));
  assert.equal(resolveXprPath('$PGENDIR\\sources_1\\a.v', xpr), path.join(root, 'fixture.gen/sources_1/a.v'));
  assert.equal(resolveXprPath('$PIPUSERFILESDIR/ipstatic/a.v', xpr), path.join(root, 'fixture.ip_user_files/ipstatic/a.v'));
  assert.equal(resolveXprPath('C:/relocated/fixture.srcs/a.v', 'C:/relocated/fixture.xpr'), 'C:\\relocated\\fixture.srcs\\a.v');
  assert.throws(() => resolveXprPath('$UNTRUSTED/top.v', xpr), /未知/);
  assert.throws(() => resolveXprPath('$env(HOME)/top.v', xpr), /未知/);
  assert.throws(() => resolveXprPath('', xpr), /为空/);
  assert.throws(() => resolveXprPath('C:relative.v', 'C:/relocated/fixture.xpr'), /当前盘/);
});

test('reads design scope while retaining constraints, disabled and missing entries in tree', async t => {
  const xml = project(
    set('sources_1', 'DesignSrcs',
      file('$PSRCDIR/rtl/top.v') + file('$PPRDIR/include/header.svh') + file('$PPRDIR/missing.v')
      + file('$PPRDIR/disabled.v', attr('AutoDisabled', '1'))
      + file('$PPRDIR/not_enabled.v', attr('IsEnabled', 'false'))
      + file('$PPRDIR/sim_only.v', attr('UsedIn', 'simulation'))
      + file('$MISSING/unknown.v'), '<Option Name="TopModule" Val="top"/>')
    + set('alt_sources', 'DesignSrcs', file('$PPRDIR/alternate.v'))
    + set('constrs_1', 'Constrs', file('$PPRDIR/pins.xdc'))
    + set('sim_1', 'SimulationSrcs', file('$PPRDIR/tb.sv'), '<Option Name="SrcSet" Val="sources_1"/>')
    + set('helper', 'BlockSrcs', file('$PPRDIR/helper.v', attr('Library', 'ip_work')))
  );
  const { root, xpr } = await fixture(t, xml, ['fixture.srcs/rtl/top.v', 'include/header.svh', 'disabled.v', 'not_enabled.v', 'sim_only.v', 'alternate.v', 'pins.xdc', 'tb.sv', 'helper.v', 'unlisted.v']);
  const before = await fs.readFile(xpr);
  const loaded = await loadProject(xpr);
  assert.equal(loaded.top, 'top');
  assert.equal(loaded.part, 'test-part');
  assert.equal(loaded.vivadoVersion, '2023.1');
  assert.deepEqual(loaded.sourceFiles, ['fixture.srcs/rtl/top.v', 'include/header.svh', 'helper.v'].map(name => path.join(root, name)));
  assert.equal(loaded.files.find(item => item.rawPath.includes('disabled.v')).enabled, false);
  assert.equal(loaded.files.find(item => item.rawPath.includes('not_enabled')).enabled, false);
  assert.equal(loaded.files.find(item => item.type === 'XDC').exists, true);
  assert.equal(loaded.files.find(item => item.rawPath.includes('$MISSING')).path, null);
  assert.equal(loaded.files.find(item => item.rawPath.includes('helper.v')).library, 'ip_work');
  assert.ok(loaded.warnings.some(value => value.includes('未知 XPR 路径变量')));
  assert.ok(loaded.warnings.some(value => value.includes('missing.v')));
  assert.deepEqual(loaded.includeDirs, [path.join(root, 'include')]);
  assert.deepEqual(await fs.readFile(xpr), before, 'XPR input is not modified');
  const sim = await loadProject(xpr, { includeSimulation: true });
  assert.ok(sim.sourceFiles.includes(path.join(root, 'tb.sv')));
  assert.ok(sim.sourceFiles.includes(path.join(root, 'sim_only.v')));
  assert.ok(!sim.sourceFiles.includes(path.join(root, 'alternate.v')));
  const alternate = await loadProject(xpr, { fileset: 'alt_sources' });
  assert.deepEqual(alternate.sourceFiles, ['alternate.v', 'helper.v'].map(name => path.join(root, name)));
  await assert.rejects(loadProject(xpr, { fileset: 'typo' }), /找不到 fileset/);
});

test('XML namespaces, entities, macros and include directory grouping are preserved', async t => {
  const xml = '<p:Project xmlns:p="urn:test"><p:FileSets><p:FileSet Name="sources_1" Type="DesignSrcs">'
    + '<p:File Path="$PPRDIR/rtl &amp; test/top.sv"/>'
    + '<p:Config><p:Option Name="IncludeDirs" Val="{$PPRDIR/rtl &amp; test} ${PPRDIR}/include"/>'
    + '<p:Option Name="VerilogDefines" Val="DEBUG WIDTH=8 {LABEL=&quot;hello world&quot;} STRING=&quot;value&quot;"/>'
    + '</p:Config></p:FileSet></p:FileSets></p:Project>';
  const { root, xpr } = await fixture(t, xml, ['rtl & test/top.sv']);
  const loaded = await loadProject(xpr, { includeDirs: ['$PPRDIR/extra'], defines: ['LOCAL=1'] });
  assert.deepEqual(loaded.sourceFiles, [path.join(root, 'rtl & test/top.sv')]);
  assert.deepEqual(loaded.includeDirs, ['rtl & test', 'include', 'extra'].map(name => path.join(root, name)));
  assert.deepEqual(loaded.defines, ['DEBUG', 'WIDTH=8', 'LABEL="hello world"', 'STRING="value"', 'LOCAL=1']);
});

test('honors active synthesis fileset instead of accidentally mixing alternate designs', async t => {
  const xml = project(set('sources_1', 'DesignSrcs', file('a.v')) + set('sources_2', 'DesignSrcs', file('b.v')))
    .replace('</Project>', '<Runs><Run Id="synth_2" Type="Ft3:Synth" State="current" SrcSet="sources_2"/></Runs></Project>');
  const { root, xpr } = await fixture(t, xml, ['a.v', 'b.v']);
  const loaded = await loadProject(xpr);
  assert.deepEqual(loaded.sourceFiles, [path.join(root, 'b.v')]);
});

test('discovers only existing exact IP stubs, prefers gen path and deduplicates references', async t => {
  const xci = '$PSRCDIR/sources_1/ip/fifo/fifo.xci';
  const xml = project(set('sources_1', 'DesignSrcs', file('top.v') + file(xci)) + set('fifo', 'BlockSrcs', file(xci)));
  const { root, xpr } = await fixture(t, xml, ['top.v', 'fixture.srcs/sources_1/ip/fifo/fifo.xci',
    'fixture.gen/sources_1/ip/fifo/fifo_stub.v', 'fixture.srcs/sources_1/ip/fifo/fifo_stub.v',
    'fixture.gen/sources_1/ip/fifo/fifo_sim_netlist.v', 'backup/top.v']);
  const loaded = await loadProject(xpr);
  assert.deepEqual(loaded.sourceFiles, [path.join(root, 'top.v'), path.join(root, 'fixture.gen/sources_1/ip/fifo/fifo_stub.v')]);
  assert.equal(loaded.files.filter(item => item.generated).length, 1);
  assert.ok(loaded.files.find(item => item.generated).origin.endsWith('fifo.xci'));
  assert.deepEqual((await loadProject(xpr, { includeIpStubs: false })).sourceFiles, [path.join(root, 'top.v')]);
});

test('exports relative quoted source paths and explicitly identifies static ordering', () => {
  const root = path.resolve(scratch, 'export');
  const text = filelist({ sourceFiles: [path.join(root, 'rtl folder/top.v'), path.join(root, '../shared/child.sv')] }, root);
  assert.match(text, /NOT elaborated compile order/);
  assert.match(text, /"rtl folder\/top.v"/);
  assert.match(text, /\.\.\/shared\/child.sv/);
  assert.throws(() => filelist({ sourceFiles: [path.join(root, 'bad"name.v')] }), /无法将路径/);
  const acrossDrives = filelist({ sourceFiles: ['D:\\shared\\child.v'] }, 'C:\\project');
  assert.match(acrossDrives, /D:\/shared\/child.v/);
});

test('rejects malformed XML and external declarations instead of guessing a file tree', async t => {
  const invalid = await fixture(t, '<Project><FileSets></Project>');
  await assert.rejects(loadProject(invalid.xpr), /XML 无效/);
  const wrongRoot = await fixture(t, '<Other/>');
  await assert.rejects(loadProject(wrongRoot.xpr), /根节点/);
  const dtd = await fixture(t, '<!DOCTYPE Project [<!ENTITY hidden SYSTEM "file:///secret">]><Project/>');
  await assert.rejects(loadProject(dtd.xpr), /DTD/);
});

test('detects fileset dependency cycles and resolves an explicit simulation fileset', async t => {
  const cycle = await fixture(t, project(set('sources_1', 'DesignSrcs', '')
    + set('sim_1', 'SimulationSrcs', '', '<Option Name="SrcSet" Val="sim_2"/>')
    + set('sim_2', 'SimulationSrcs', '', '<Option Name="SrcSet" Val="sim_1"/>')));
  await assert.rejects(loadProject(cycle.xpr, { includeSimulation: true }), /循环/);
  const normal = await fixture(t, project(set('sources_1', 'DesignSrcs', file('top.v'))
    + set('sim_1', 'SimulationSrcs', file('tb.sv'), '<Option Name="TopModule" Val="tb"/><Option Name="SrcSet" Val="sources_1"/>')), ['top.v', 'tb.sv']);
  const loaded = await loadProject(normal.xpr, { fileset: 'sim_1' });
  assert.equal(loaded.top, 'tb');
  assert.deepEqual(loaded.sourceFiles, ['top.v', 'tb.sv'].map(name => path.join(normal.root, name)));
});
