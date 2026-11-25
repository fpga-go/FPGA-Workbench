'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadProject, filelist, parsePdc, parsePrjx } = require('../src/xpr');
const { buildProjectTree } = require('../src/project-tree');
const { HdlIndex } = require('../src/indexer');
const { semanticFilelist } = require('../src/slang');
const { main: runFilelistCli } = require('../src/filelist-cli');

const scratch = path.resolve(__dirname, '../test-tmp');

async function makeFixtureDir(t, prefix = 'libero-') {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, prefix));
  t.after(async () => {
    const relative = path.relative(scratch, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('parsePdc supports Libero 11 positional and SoC 12+ named flags, continuations and header die metadata', () => {
  const pdcText = [
    '# Microsemi Physical design constraints file',
    '# Family: ProASIC3L , Die: A3PE3000L , Package: 484 FBGA , Speed grade: -1',
    'set_iobank Bank0 -vcci 3.30',
    'set_iobank -bank_name Bank1 -vcci 1.80',
    'set_io sys_clk -iostd LVCMOS33 -pinname E18',
    'set_io rst_n \\',
    '  -iostd LVCMOS18 -pinname AB10',
    'set_io -port_name {led_bus[0]} -pin_name R21 -io_std LVCMOS33 -DIRECTION OUTPUT',
  ].join('\r\n');

  const parsed = parsePdc(pdcText);
  assert.equal(parsed.headerDie, 'A3PE3000L');
  assert.equal(parsed.iobanks.length, 2);
  assert.deepEqual(parsed.iobanks[0], {
    bank: 'Bank0',
    vcci: '3.30',
    attributes: { vcci: '3.30' },
    raw: 'set_iobank Bank0 -vcci 3.30',
  });
  assert.equal(parsed.iobanks[1].bank, 'Bank1');
  assert.equal(parsed.ios.length, 3);
  assert.equal(parsed.ios[0].port, 'sys_clk');
  assert.equal(parsed.ios[0].pin, 'E18');
  assert.equal(parsed.ios[1].port, 'rst_n');
  assert.equal(parsed.ios[1].pin, 'AB10');
  assert.equal(parsed.ios[2].port, 'led_bus[0]');
  assert.equal(parsed.ios[2].pin, 'R21');
  assert.equal(parsed.ios[2].iostd, 'LVCMOS33');
  assert.deepEqual(parsed.ports, ['sys_clk', 'rst_n', 'led_bus']);

  assert.throws(() => parsePdc('set_io clk -pinname A1\0'), /空字符/);
  assert.throws(() => parsePdc('<Component/>'), /XML/);
});

test('parsePrjx validates structure and rejects malformed blocks, binary input and XML', () => {
  assert.throws(() => parsePrjx('KEY LIBERO "11.9"\0'), /空字符/);
  assert.throws(() => parsePrjx('<Project/>'), /XML/);
  assert.throws(() => parsePrjx('plain unrelated text'), /未检测到 Libero/);
  assert.throws(() => parsePrjx('KEY LIBERO "11.9"\nLIST FileManager\nVALUE "<project>\\hdl\\a.v,hdl"\nENDLIST'), /缺少 ENDFILE/);
  assert.throws(() => parsePrjx('KEY LIBERO "11.9"\nLIST REVISIONS\nVALUE="Impl1",NUM=1'), /未闭合的 LIST/);
  assert.throws(() => parsePrjx('KEY LIBERO "11.9"\nENDLIST'), /多余的 ENDLIST/);
});

test('loads relocated Libero .prjx project with external sources, SmartGen/Component .cxf IP, Synplify options and PDC constraints', async t => {
  const workspace = await makeFixtureDir(t, 'libero-relocated-');
  const legacyPrefix = 'Z:\\legacy_machine\\archive_ws';
  const legacyProjectLoc = `${legacyPrefix}\\demo_unit\\libero\\ctrl_proj`;

  const files = {
    'common/bus_slave.v': 'module bus_slave(input wire clk, input wire rst_n, output wire ready); assign ready = clk & rst_n; endmodule\n',
    'demo_unit/include/proj_defs.vh': '`define DEFAULT_DIV 4\n',
    'demo_unit/rtl/board_top.v': [
      'module board_top(input wire sys_clk, input wire rst_n, output wire status_led);',
      '  wire pll_clk, pll_lock, sub_ok;',
      '  clk_pll u_clk_pll(.CLKA(sys_clk), .LOCK(pll_lock), .GLA(pll_clk));',
      '  sd_sub u_sd_sub(.clk(pll_clk), .ok(sub_ok));',
      '  bus_slave u_slave(.clk(pll_clk), .rst_n(rst_n), .ready(status_led));',
      'endmodule',
      '',
    ].join('\n'),
    'demo_unit/rtl/board.pdc': [
      '# Family: ProASIC3L , Die: A3PE3000L , Package: 484 FBGA , Speed grade: -1',
      'set_iobank Bank0 -vcci 3.30',
      'set_io sys_clk -iostd LVCMOS33 -pinname E18',
      'set_io rst_n -iostd LVCMOS33 -pinname AB10',
      'set_io status_led -iostd LVCMOS33 -pinname R21',
    ].join('\n'),
    'demo_unit/rtl/board.sdc': 'create_clock -period 20.0 [get_ports sys_clk]\n',
    'demo_unit/libero/ctrl_proj/smartgen/clk_pll/clk_pll.cxf': `<?xml version="1.0" encoding="UTF-8"?>
<Component xmlns="http://actel.com/sweng/afi">
  <name>clk_pll</name>
  <fileSets>
    <fileSet fileSetId="HDL_FILESET">
      <file fileid="0"><name>clk_pll.v</name><fileType>verilogSource</fileType></file>
    </fileSet>
  </fileSets>
</Component>`,
    'demo_unit/libero/ctrl_proj/smartgen/clk_pll/clk_pll.v': 'module clk_pll(CLKA, LOCK, GLA); input CLKA; output LOCK; output GLA; assign GLA = CLKA; assign LOCK = 1\'b1; endmodule\n',
    'demo_unit/libero/ctrl_proj/component/work/sd_sub/sd_sub.cxf': `<?xml version="1.0" encoding="UTF-8"?>
<Component xmlns="http://actel.com/sweng/afi">
  <name>sd_sub</name>
  <fileSets>
    <fileSet fileSetId="HDL_FILESET">
      <file fileid="0"><name>sd_sub.v</name><fileType>verilogSource</fileType></file>
    </fileSet>
  </fileSets>
</Component>`,
    'demo_unit/libero/ctrl_proj/component/work/sd_sub/sd_sub.v': 'module sd_sub(input wire clk, output wire ok); assign ok = clk; endmodule\n',
    'demo_unit/libero/ctrl_proj/stimulus/tb_board.sv': 'module tb_board; endmodule\n',
    'demo_unit/libero/ctrl_proj/designer/impl1/release_artifact.pdb': 'binary-bitstream-placeholder',
    'demo_unit/libero/ctrl_proj/designer/impl1/board_top.adb': 'adb-placeholder',
    'demo_unit/libero/ctrl_proj/synthesis/board_top.edn': 'edif-placeholder',
    'demo_unit/libero/ctrl_proj/synthesis/board_top_sdc.sdc': '# generated syn_sdc\n',
    'demo_unit/libero/ctrl_proj/synthesis/board_top_syn.prj': [
      `add_file -verilog "${legacyPrefix}/demo_unit/rtl/board_top.v"`,
      'set_option -technology ProASIC3L',
      'set_option -part A3PE3000L',
      `set_option -include_path "${legacyPrefix}/demo_unit/include"`,
      'set_option -hdl_define -set "SYNTH_MODE USE_PLL=1"',
      'hdl_param -set BUS_WIDTH 16',
      'set_option -top_module "board_top"',
    ].join('\n'),
    'demo_unit/libero/ctrl_proj/ctrl_proj.prjx': [
      'KEY LIBERO "11.9"',
      'KEY CAPTURE "11.9.6.7"',
      'KEY HDLTechnology "VERILOG"',
      'KEY VendorTechnology_Family "ProASIC3L"',
      'KEY VendorTechnology_Die "IT14X14M4LDP"',
      'KEY VendorTechnology_Package "fg484"',
      'KEY VendorTechnology_Speed "-1"',
      `KEY ProjectLocation "${legacyProjectLoc}"`,
      'KEY ActiveRoot "board_top::work"',
      'LIST REVISIONS',
      'VALUE="Impl1",NUM=1',
      'VALUE="Impl2",NUM=2',
      'CURREV=1',
      'ENDLIST',
      'LIST FileManager',
      'VALUE "<project>\\designer\\impl1\\release_artifact.pdb,pdb"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\designer\\impl1\\board_top.adb,adb"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\synthesis\\board_top.edn,syn_edn"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\synthesis\\board_top_sdc.sdc,syn_sdc"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\synthesis\\board_top_syn.prj,prj"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\smartgen\\clk_pll\\clk_pll.cxf,actgen_cxf"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\smartgen\\clk_pll\\clk_pll.v,hdl"',
      'STATE="utd"',
      'PARENT="<project>\\smartgen\\clk_pll\\clk_pll.cxf"',
      'IS_READONLY="TRUE"',
      'ENDFILE',
      'VALUE "<project>\\component\\work\\sd_sub\\sd_sub.cxf,sd_cxf"',
      'STATE="utd"',
      'ENDFILE',
      'VALUE "<project>\\stimulus\\tb_board.sv,tb_hdl"',
      'STATE="utd"',
      'ENDFILE',
      `VALUE "${legacyPrefix}\\common\\bus_slave.v,hdl"`,
      'STATE="utd"',
      'ENDFILE',
      `VALUE "${legacyPrefix}\\demo_unit\\rtl\\board_top.v,hdl"`,
      'STATE="utd"',
      'ENDFILE',
      `VALUE "${legacyPrefix}\\demo_unit\\rtl\\board.pdc,pdc"`,
      'STATE="utd"',
      'ENDFILE',
      `VALUE "${legacyPrefix}\\demo_unit\\rtl\\board.sdc,sdc"`,
      'STATE="utd"',
      'ENDFILE',
      'ENDLIST',
      'LIST AssociatedStimulus',
      'LIST board_top',
      'VALUE "<project>\\stimulus\\tb_board.sv,tb_hdl"',
      'ENDLIST',
      'ENDLIST',
    ].join('\r\n'),
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspace, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  const prjxPath = path.join(workspace, 'demo_unit/libero/ctrl_proj/ctrl_proj.prjx');
  const pdcPath = path.join(workspace, 'demo_unit/rtl/board.pdc');
  const beforePrjx = await fs.readFile(prjxPath);

  const loaded = await loadProject(prjxPath);
  assert.equal(loaded.projectType, 'libero');
  assert.equal(loaded.name, 'ctrl_proj');
  assert.equal(loaded.liberoVersion, '11.9');
  assert.equal(loaded.part, 'ProASIC3L A3PE3000L-fg484-1');
  assert.equal(loaded.top, 'board_top');
  assert.deepEqual(loaded.filesets.map(s => s.name), ['Impl1', 'Impl2']);
  assert.deepEqual(loaded.selectedFilesets, ['Impl1']);
  assert.equal(loaded.pdcPath, pdcPath);
  assert.equal(loaded.pdc.ios.length, 3);
  assert.equal(loaded.pdc.iobanks.length, 1);

  // Build outputs (.pdb, .adb, .edn, syn_sdc, .prj) must be excluded from project tree
  assert.ok(!loaded.files.some(f => /\.(pdb|adb|edn|prj)$/i.test(f.path || '')));
  assert.ok(!loaded.files.some(f => (f.path || '').endsWith('board_top_sdc.sdc')));

  // Active HDL sources include relocated user RTL + both SmartGen and Component .cxf stubs, excluding stimulus by default
  const expectedSources = [
    'demo_unit/libero/ctrl_proj/smartgen/clk_pll/clk_pll.v',
    'common/bus_slave.v',
    'demo_unit/rtl/board_top.v',
    'demo_unit/libero/ctrl_proj/component/work/sd_sub/sd_sub.v',
  ].map(p => path.join(workspace, p));
  assert.deepEqual(loaded.sourceFiles, expectedSources);
  assert.deepEqual(loaded.includeDirs, [path.join(workspace, 'demo_unit/include')]);
  assert.deepEqual(loaded.defines, ['SYNTH_MODE', 'USE_PLL=1', 'BUS_WIDTH=16']);
  assert.equal(loaded.ipReferences.length, 2);

  // Simulation toggle and revision selection
  const withSim = await loadProject(prjxPath, { includeSimulation: true });
  assert.ok(withSim.sourceFiles.includes(path.join(workspace, 'demo_unit/libero/ctrl_proj/stimulus/tb_board.sv')));
  const impl2 = await loadProject(prjxPath, { fileset: 'Impl2' });
  assert.deepEqual(impl2.selectedFilesets, ['Impl2']);
  await assert.rejects(loadProject(prjxPath, { fileset: 'MissingImpl' }), /找不到 fileset/);

  // Navigation across relocated RTL and SmartGen IP stub
  const index = new HdlIndex();
  const entries = await Promise.all(loaded.sourceFiles.map(async f => [f, await fs.readFile(f, 'utf8')]));
  index.updateBatch(entries);
  const topFile = path.join(workspace, 'demo_unit/rtl/board_top.v');
  const pllFile = path.join(workspace, 'demo_unit/libero/ctrl_proj/smartgen/clk_pll/clk_pll.v');
  const topText = await fs.readFile(topFile, 'utf8');
  const pllDefs = index.definitions(topFile, topText.indexOf('clk_pll u_clk_pll'));
  assert.equal(pllDefs.length, 1);
  assert.equal(pllDefs[0].path, pllFile);

  // Project tree, semantic filelist, static filelist export & CLI input protection
  const tree = buildProjectTree(loaded);
  assert.equal(tree[0].label, 'Impl1');
  const sf = semanticFilelist(loaded);
  assert.match(sf, /--top\n"board_top"/);

  const exported = filelist(loaded, path.dirname(prjxPath));
  assert.match(exported, /Libero PRJX:/);
  assert.match(exported, /Libero PDC:/);
  assert.match(exported, /PDC constraints: ios 3; iobanks 1/);
  // Static filelist excludes generated IP stubs from active lines and lists only pure user RTL
  assert.deepEqual(
    exported.split('\n').filter(line => line && !line.startsWith('//')),
    ['../../../common/bus_slave.v', '../../rtl/board_top.v']
  );

  const cliOut = path.join(path.dirname(prjxPath), 'exported-libero.f');
  let stdout = '', stderr = '';
  const code = await runFilelistCli(['--prjx', prjxPath, '--out', cliOut], {
    stdout: { write: s => { stdout += s; } },
    stderr: { write: s => { stderr += s; } },
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /已导出静态 XPR Filelist/);

  for (const protectedPath of [
    prjxPath,
    pdcPath,
    topFile,
    pllFile,
    path.join(workspace, 'demo_unit/libero/ctrl_proj/smartgen/clk_pll/clk_pll.cxf'),
  ]) {
    let errOut = '';
    const res = await runFilelistCli(['--prjx', prjxPath, '--out', protectedPath, '--force'], {
      stdout: { write: () => {} },
      stderr: { write: s => { errOut += s; } },
    });
    assert.equal(res, 1);
    assert.match(errOut, /工程输入文件或 IP 参考工件/);
  }

  assert.deepEqual(await fs.readFile(prjxPath), beforePrjx);
});
