'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadProject, filelist, parseLpf } = require('../src/xpr');
const { buildProjectTree } = require('../src/project-tree');
const { HdlIndex } = require('../src/indexer');
const { semanticFilelist } = require('../src/slang');
const { main: runFilelistCli } = require('../src/filelist-cli');

const scratch = path.resolve(__dirname, '../test-tmp');

async function makeFixtureDir(t, prefix = 'lattice-') {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, prefix));
  t.after(async () => {
    const relative = path.relative(scratch, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('parseLpf extracts blocks, sysconfig, locates, iobufs, frequencies and ports while ignoring comments', () => {
  const text = [
    '# Line comment with #',
    '// Line comment with //',
    '/* Block comment with ; and "quoted" */',
    'BLOCK RESETPATHS ;',
    'BLOCK ASYNCPATHS;',
    'SYSCONFIG MCCLK_FREQ=66.5 BACKGROUND_RECONFIG=OFF CONFIG_SECURE=ON ;',
    'LOCATE COMP "clk12" SITE "A10" ;',
    'LOCATE COMP "rst_n" SITE "G2";',
    '#LOCATE COMP "commented_pin" SITE "P6" ;',
    'IOBUF PORT "clk12" IO_TYPE=LVCMOS33 PULLMODE=NONE ;',
    'IOBUF PORT "rst_n" IO_TYPE=LVCMOS18 PULLMODE=UP;',
    'IOBUF ALLPORTS IO_TYPE=LVCMOS33 ;',
    'FREQUENCY PORT "clk12" 12.000048 MHz ;',
    'FREQUENCY NET "sys_clk" 100.0 MHz ;',
    'BLOCK JTAGPATHS ;',
  ].join('\r\n');

  const parsed = parseLpf(text);
  assert.deepEqual(parsed.blocks, ['RESETPATHS', 'ASYNCPATHS', 'JTAGPATHS']);
  assert.deepEqual(parsed.sysconfig, {
    MCCLK_FREQ: '66.5',
    BACKGROUND_RECONFIG: 'OFF',
    CONFIG_SECURE: 'ON',
  });
  assert.equal(parsed.locates.length, 2);
  assert.deepEqual(parsed.locates[0], {
    targetType: 'COMP',
    name: 'clk12',
    site: 'A10',
    raw: 'LOCATE COMP "clk12" SITE "A10"',
  });
  assert.equal(parsed.iobufs.length, 3);
  assert.deepEqual(parsed.iobufs[0].attributes, { IO_TYPE: 'LVCMOS33', PULLMODE: 'NONE' });
  assert.deepEqual(parsed.iobufs[1].attributes, { IO_TYPE: 'LVCMOS18', PULLMODE: 'UP' });
  assert.equal(parsed.iobufs[2].targetType, 'ALLPORTS');
  assert.equal(parsed.frequencies.length, 2);
  assert.deepEqual(parsed.frequencies[0], {
    targetType: 'PORT',
    name: 'clk12',
    value: '12.000048',
    unit: 'MHz',
    raw: 'FREQUENCY PORT "clk12" 12.000048 MHz',
  });
  assert.deepEqual(parsed.ports, ['clk12', 'rst_n']);
});

test('parseLpf rejects unclosed quotes, unclosed block comments, missing semicolons and binary/XML input', () => {
  assert.throws(() => parseLpf('LOCATE COMP "clk SITE "A10";'), /未闭合的引号/);
  assert.throws(() => parseLpf('/* unclosed comment\nBLOCK RESETPATHS;'), /未闭合的块注释/);
  assert.throws(() => parseLpf('BLOCK RESETPATHS'), /缺少分号/);
  assert.throws(() => parseLpf('BLOCK RESETPATHS;\0'), /空字符/);
  assert.throws(() => parseLpf('<BaliProject/>'), /XML/);
});

test('loads Lattice project via .lpf or .ldf with companion .ldf, strategy .sty, IP .ipx and implementation selection', async t => {
  const root = await makeFixtureDir(t, 'lattice-bali-');
  const files = {
    'src/top.v': 'module top(input wire clk12, input wire rst_n, output wire led); child u_child(.clk(clk12), .rst_n(rst_n), .led(led)); endmodule\n',
    'src/child.v': 'module child(input wire clk, input wire rst_n, output wire led); assign led = clk & rst_n; endmodule\n',
    'src/alt_top.v': 'module alt_top(input wire clk12, output wire led); assign led = clk12; endmodule\n',
    'src/disabled.v': 'module disabled_mod; endmodule\n',
    'sim/tb_top.sv': 'module tb_top; endmodule\n',
    'include/defs.vh': '`define STEP 1\n',
    'lib_inc/extra.vh': '`define EXTRA 1\n',
    'ips/pll/pll_core.ipx': `<?xml version="1.0" encoding="UTF-8"?>
<DiamondModule name="pll_core" module="PLL" VendorName="Lattice Semiconductor Corporation" generator="IPexpress" version="3.7" type="Module" synthesis="synplify" source_format="Verilog">
  <Package>
    <File name="pll_core.lpc" type="lpc"/>
    <File name="pll_core.v" type="top_level_verilog"/>
    <File name="pll_core_tmpl.v" type="template_verilog"/>
  </Package>
</DiamondModule>`,
    'ips/pll/pll_core.v': 'module pll_core(input wire clki, output wire clko); endmodule\n',
    'ips/pll/pll_core_tmpl.v': '// template only\n',
    'diamond/top1.sty': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE strategy>
<Strategy version="1.0" predefined="0" label="Strategy1">
  <Property name="PROP_LST_EdfInLibPath" value="../lib_inc" time="0"/>
  <Property name="PROP_LST_HashDefine" value="FROM_STY=1" time="0"/>
</Strategy>`,
    'diamond/top.lpf': [
      'BLOCK RESETPATHS ;',
      'LOCATE COMP "clk12" SITE "A10" ;',
      'LOCATE COMP "rst_n" SITE "G2" ;',
      'LOCATE COMP "led" SITE "B17" ;',
      'IOBUF PORT "clk12" IO_TYPE=LVCMOS33 ;',
      'FREQUENCY PORT "clk12" 12.0 MHz ;',
    ].join('\n'),
    'diamond/top.sdc': 'create_clock -period 83.33 [get_ports clk12]\n',
    'diamond/top.ldf': `<?xml version="1.0" encoding="UTF-8"?>
<BaliProject version="3.2" title="demo_lattice" device="LCMXO3LF-9400C-5BG256C" default_implementation="impl1">
  <Options/>
  <Implementation title="impl1" dir="impl1" description="impl1" synthesis="synplify" default_strategy="Strategy1">
    <Options def_top="child" top="top" include_path="../include" hdl_param="IMPL_MACRO=1"/>
    <Source name="../src/top.v" type="Verilog" type_short="Verilog">
      <Options top_module="top"/>
    </Source>
    <Source name="../src/child.v" type="Verilog" type_short="Verilog">
      <Options/>
    </Source>
    <Source name="../src/disabled.v" type="Verilog" type_short="Verilog" excluded="TRUE">
      <Options/>
    </Source>
    <Source name="../sim/tb_top.sv" type="Verilog" type_short="Verilog" syn_sim="SimOnly">
      <Options/>
    </Source>
    <Source name="../ips/pll/pll_core.ipx" type="sbx" type_short="IPX">
      <Options/>
    </Source>
    <Source name="top.lpf" type="Logic Preference" type_short="LPF">
      <Options/>
    </Source>
    <Source name="top.sdc" type="Synplify Design Constraints File" type_short="SDC">
      <Options/>
    </Source>
  </Implementation>
  <Implementation title="impl2" dir="impl2" description="impl2" synthesis="synplify" default_strategy="Strategy1">
    <Options top="alt_top"/>
    <Source name="../src/alt_top.v" type="Verilog" type_short="Verilog">
      <Options/>
    </Source>
  </Implementation>
  <Strategy name="Strategy1" file="top1.sty"/>
</BaliProject>`,
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  const lpfPath = path.join(root, 'diamond/top.lpf');
  const ldfPath = path.join(root, 'diamond/top.ldf');
  const beforeLpf = await fs.readFile(lpfPath);
  const beforeLdf = await fs.readFile(ldfPath);

  // 1. Load directly via .lpf (resolves companion .ldf + parses .lpf)
  const fromLpf = await loadProject(lpfPath);
  assert.equal(fromLpf.projectType, 'lattice');
  assert.equal(fromLpf.name, 'demo_lattice');
  assert.equal(fromLpf.part, 'LCMXO3LF-9400C-5BG256C');
  assert.equal(fromLpf.diamondVersion, '3.2');
  assert.equal(fromLpf.top, 'top');
  assert.equal(fromLpf.path, lpfPath);
  assert.equal(fromLpf.ldfPath, ldfPath);
  assert.equal(fromLpf.lpfPath, lpfPath);
  assert.ok(fromLpf.lpf);
  assert.equal(fromLpf.lpf.locates.length, 3);
  assert.equal(fromLpf.lpf.iobufs.length, 1);
  assert.equal(fromLpf.lpf.frequencies.length, 1);
  assert.deepEqual(fromLpf.selectedFilesets, ['impl1']);
  assert.deepEqual(
    fromLpf.sourceFiles,
    ['src/top.v', 'src/child.v', 'ips/pll/pll_core.v'].map(p => path.join(root, p))
  );
  assert.deepEqual(
    fromLpf.includeDirs,
    ['include', 'lib_inc'].map(p => path.join(root, p))
  );
  assert.deepEqual(fromLpf.defines, ['IMPL_MACRO=1', 'FROM_STY=1']);
  assert.equal(fromLpf.ipReferences.length, 1);

  // 2. Load via .ldf
  const fromLdf = await loadProject(ldfPath);
  assert.equal(fromLdf.top, 'top');
  assert.deepEqual(fromLdf.sourceFiles, fromLpf.sourceFiles);

  // 3. Simulation and alternate implementation selection
  const withSim = await loadProject(lpfPath, { includeSimulation: true });
  assert.ok(withSim.sourceFiles.includes(path.join(root, 'sim/tb_top.sv')));

  const altImpl = await loadProject(lpfPath, { fileset: 'impl2' });
  assert.equal(altImpl.top, 'alt_top');
  assert.deepEqual(altImpl.sourceFiles, [path.join(root, 'src/alt_top.v')]);
  await assert.rejects(loadProject(lpfPath, { fileset: 'nonexistent' }), /找不到 fileset/);

  // 4. Tree construction and Filelist export
  const tree = buildProjectTree(fromLpf);
  assert.deepEqual(tree.map(n => n.label), ['impl1', 'impl2']);
  const exported = filelist(fromLpf, path.join(root, 'diamond'));
  assert.match(exported, /Lattice LDF:/);
  assert.match(exported, /Lattice LPF:/);
  assert.match(exported, /LPF constraints: locates 3; iobufs 1; frequencies 1/);
  assert.deepEqual(
    exported.split('\n').filter(line => line && !line.startsWith('//')),
    ['../src/top.v', '../src/child.v']
  );

  // 5. CLI export with --lpf and protection of both .lpf and .ldf
  const cliOut = path.join(root, 'diamond', 'exported.f');
  let stdout = '';
  let stderr = '';
  const code = await runFilelistCli(['--lpf', lpfPath, '--out', cliOut], {
    stdout: { write: s => { stdout += s; } },
    stderr: { write: s => { stderr += s; } },
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /已导出静态 XPR Filelist/);
  for (const protectedFile of [lpfPath, ldfPath, path.join(root, 'src/top.v'), path.join(root, 'ips/pll/pll_core.v')]) {
    let errText = '';
    const res = await runFilelistCli(['--lpf', lpfPath, '--out', protectedFile, '--force'], {
      stdout: { write: () => {} },
      stderr: { write: s => { errText += s; } },
    });
    assert.equal(res, 1);
    assert.match(errText, /工程输入文件或 IP 参考工件/);
  }

  // Inputs untouched
  assert.deepEqual(await fs.readFile(lpfPath), beforeLpf);
  assert.deepEqual(await fs.readFile(ldfPath), beforeLdf);
});

test('loads standalone .lpf project without .ldf and infers top module from constrained LPF ports', async t => {
  const root = await makeFixtureDir(t, 'lattice-standalone-lpf-');
  await fs.mkdir(path.join(root, 'rtl'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'rtl/sub.v'),
    'module sub(input wire i_clk, output wire o_led); assign o_led = i_clk; endmodule\n'
  );
  await fs.writeFile(
    path.join(root, 'rtl/board_top.v'),
    'module board_top(input wire osc_25m, input wire rst_n, output wire led_out); sub u_sub(.i_clk(osc_25m), .o_led(led_out)); endmodule\n'
  );
  const lpfPath = path.join(root, 'pinout.lpf');
  await fs.writeFile(
    lpfPath,
    [
      'BLOCK RESETPATHS ;',
      'LOCATE COMP "osc_25m" SITE "L2" ;',
      'LOCATE COMP "rst_n" SITE "G2" ;',
      'LOCATE COMP "led_out" SITE "E9" ;',
      'IOBUF PORT "osc_25m" IO_TYPE=LVCMOS33 ;',
    ].join('\n')
  );

  const loaded = await loadProject(lpfPath);
  assert.equal(loaded.projectType, 'lattice');
  assert.equal(loaded.ldfPath, null);
  assert.equal(loaded.lpfPath, lpfPath);
  assert.equal(loaded.top, 'board_top');
  assert.equal(loaded.sourceFiles.length, 2);
  assert.deepEqual(loaded.lpf.ports, ['osc_25m', 'rst_n', 'led_out']);

  const index = new HdlIndex();
  for (const file of loaded.sourceFiles) {
    index.update(file, await fs.readFile(file, 'utf8'));
  }
  assert.deepEqual(index.modules().map(m => m.name).sort(), ['board_top', 'sub']);

  const topFile = path.join(root, 'rtl/board_top.v');
  const subFile = path.join(root, 'rtl/sub.v');
  const topText = await fs.readFile(topFile, 'utf8');
  const subText = await fs.readFile(subFile, 'utf8');
  const defs = index.definitions(topFile, topText.indexOf('sub u_sub'));
  assert.equal(defs.length, 1);
  assert.equal(defs[0].path, subFile);
  const parents = index.parentConnections(subFile, subText.indexOf('i_clk'), { target: 'expression' });
  assert.equal(parents.connections.length, 1);
  assert.equal(topText.slice(parents.connections[0].start, parents.connections[0].end), 'osc_25m');

  const slangF = semanticFilelist(loaded);
  assert.match(slangF, /--top\n"board_top"/);
  assert.ok(slangF.includes(topFile.replace(/\\/g, '/')));
  assert.ok(slangF.includes(subFile.replace(/\\/g, '/')));
});
