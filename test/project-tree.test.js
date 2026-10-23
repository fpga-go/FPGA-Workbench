'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProjectTree } = require('../src/project-tree');

const project = (files, filesets = [{ name: 'sources_1', type: 'DesignSrcs' }], extra = {}) => ({
  path: 'C:/work/demo/demo.xpr', root: 'C:/work/demo', name: 'demo', files, filesets, ...extra
});
const file = (path, fileset = 'sources_1', extra = {}) => ({ path, rawPath: path, fileset,
  enabled: true, selected: true, exists: true, generated: false, ...extra });
const leafPaths = nodes => nodes.flatMap(node => node.kind === 'file' ? [node.label]
  : leafPaths(node.children).map(child => `${node.label}/${child}`));
const leaves = nodes => nodes.flatMap(node => node.kind === 'file' ? [node] : leaves(node.children));

test('design directories form actual nested folders and BlockSrcs IPs and generated declarations join their owner', () => {
  const xci = 'C:/work/demo/demo.srcs/sources_1/ip/fifo/fifo.xci';
  const input = project([
    file('C:/work/demo/demo.srcs/sources_1/new/top.v'),
    file('C:/work/demo/demo.srcs/sources_1/new/xx_dir/worker.v'),
    file(xci, 'fifo'),
    file('C:/work/demo/demo.gen/sources_1/ip/fifo/fifo_stub.v', 'fifo', { generated: true, origin: xci })
  ], [{ name: 'sources_1', type: 'DesignSrcs' }, { name: 'fifo', type: 'BlockSrcs' }]);
  const tree = buildProjectTree(input);
  assert.deepEqual(tree.map(node => node.label), ['sources_1']);
  assert.deepEqual(leafPaths(tree), [
    'sources_1/ip/fifo/fifo_stub.v', 'sources_1/ip/fifo/fifo.xci',
    'sources_1/new/xx_dir/worker.v', 'sources_1/new/top.v'
  ]);
  assert.equal(tree[0].count, 4);
  assert.equal(leaves(tree).find(node => node.label === 'fifo_stub.v').file.generated, true);
});

test('duplicate disabled design and enabled BlockSrcs XCI registrations merge and retain all original states', () => {
  const path = 'C:/work/demo/demo.srcs/sources_1/ip/fifo/fifo.xci';
  const disabled = file(path, 'sources_1', { enabled: false });
  const enabled = file(path.toUpperCase().replace(/\//g, '\\'), 'fifo');
  const input = project([disabled, enabled], [{ name: 'sources_1', type: 'DesignSrcs' }, { name: 'fifo', type: 'BlockSrcs' }]);
  const nodes = leaves(buildProjectTree(input));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].file.enabled, true);
  assert.equal(nodes[0].file.fileset, 'fifo');
  assert.deepEqual(nodes[0].origins, [disabled, enabled]);
  assert.deepEqual(nodes[0].origins.map(origin => origin.enabled), [false, true]);
});

test('non-default design sets and explicit SrcSet metadata own their IP without using the selected default', () => {
  const input = project([
    file('C:/work/demo/demo.srcs/sources_2/ip/clock/clock.xci', 'clock'),
    file('D:/shared/ip/fifo/fifo.xci', 'external_fifo')
  ], [
    { name: 'sources_1', type: 'DesignSrcs' }, { name: 'sources_2', type: 'DesignSrcs' },
    { name: 'clock', type: 'BlockSrcs' }, { name: 'external_fifo', type: 'BlockSrcs', srcSets: ['sources_2'] }
  ], { selectedFilesets: ['sources_1', 'clock', 'external_fifo'] });
  const tree = buildProjectTree(input);
  assert.deepEqual(tree.map(node => node.label), ['sources_1', 'sources_2']);
  assert.deepEqual(leafPaths(tree), [
    'sources_2/ip/clock/clock.xci', 'sources_2/ip/外部文件/D:/shared/ip/fifo/fifo.xci'
  ]);
});

test('unknown or conflicting BlockSrcs ownership remains an independent fileset', () => {
  const input = project([
    file('D:/shared/unknown/unknown.xci', 'unknown'),
    file('C:/work/demo/demo.srcs/sources_1/ip/conflict/conflict.xci', 'conflict')
  ], [
    { name: 'sources_1', type: 'DesignSrcs' }, { name: 'sources_2', type: 'DesignSrcs' },
    { name: 'unknown', type: 'BlockSrcs' }, { name: 'conflict', type: 'BlockSrcs', srcSet: 'sources_2' }
  ], { selectedFilesets: ['sources_1', 'unknown', 'conflict'] });
  const tree = buildProjectTree(input);
  assert.deepEqual(tree.map(node => node.label), ['sources_1', 'sources_2', 'unknown', 'conflict']);
  assert.equal(tree.find(node => node.label === 'unknown').count, 1);
  assert.equal(tree.find(node => node.label === 'conflict').count, 1);
  assert.equal(tree.find(node => node.label === 'sources_1').count, 0);
});

test('constraints, simulation, disabled, missing and unresolved records keep separate fileset context', () => {
  const shared = 'D:/shared/rtl/shared.v';
  const input = project([
    file(shared), file(shared, 'sim_1'),
    file('C:/work/demo/demo.srcs/constrs_1/new/board/pins.xdc', 'constrs_1'),
    file('C:/work/demo/demo.srcs/sim_1/new/tb.sv', 'sim_1'),
    file('C:/work/demo/demo.srcs/sources_1/new/off.v', 'sources_1', { enabled: false }),
    file('C:/work/demo/demo.srcs/sources_1/new/missing.v', 'sources_1', { exists: false, existence: 'missing' }),
    file(null, 'sources_1', { rawPath: '$UNKNOWN/new/source.v', exists: false, existence: 'unknown' })
  ], [{ name: 'sources_1', type: 'DesignSrcs' }, { name: 'constrs_1', type: 'Constrs' }, { name: 'sim_1', type: 'SimulationSrcs', srcSets: ['sources_1'] }]);
  const tree = buildProjectTree(input), nodes = leaves(tree);
  assert.ok(leafPaths(tree).includes('constrs_1/new/board/pins.xdc'));
  assert.ok(leafPaths(tree).includes('sim_1/new/tb.sv'));
  assert.equal(nodes.filter(node => node.label === 'shared.v').length, 2);
  assert.equal(nodes.find(node => node.label === 'off.v').file.enabled, false);
  assert.equal(nodes.find(node => node.label === 'missing.v').file.exists, false);
  assert.equal(nodes.find(node => node.label === 'source.v').file.path, null);
});

test('registered external and internal sources retain nested paths without inventing unlisted files', () => {
  const input = project([
    file('C:/work/demo/rtl/nested/top.v'),
    file('C:/work/shared/rtl/shared.v'),
    file('C:/work/demo/demo.srcs/legacy/old.v')
  ]);
  assert.deepEqual(leafPaths(buildProjectTree(input)), [
    'sources_1/legacy/old.v', 'sources_1/rtl/nested/top.v',
    'sources_1/外部文件/C:/work/shared/rtl/shared.v'
  ]);
  assert.equal(leaves(buildProjectTree(input)).length, input.files.length);
});

test('explicit IP artifact references place an externally located generated stub beside its XCI', () => {
  const xci = 'C:/work/demo/demo.srcs/sources_1/ip/fifo/fifo.xci';
  const stub = 'C:/work/demo/.cache/unrelated/deep/fifo_stub.v';
  const input = project([file(xci, 'fifo'), file(stub, 'fifo', { generated: true })],
    [{ name: 'sources_1', type: 'DesignSrcs' }, { name: 'fifo', type: 'BlockSrcs' }],
    { ipReferences: [{ path: xci, artifactPaths: [stub] }] });
  assert.deepEqual(leafPaths(buildProjectTree(input)), ['sources_1/ip/fifo/fifo_stub.v', 'sources_1/ip/fifo/fifo.xci']);
});

test('building the layout is deterministic and never mutates project metadata', () => {
  const input = project([file('C:/work/demo/demo.srcs/sources_1/new/b.v'), file('C:/work/demo/demo.srcs/sources_1/new/a.v')]);
  const before = JSON.stringify(input);
  for (const item of input.files) Object.freeze(item);
  Object.freeze(input.files); Object.freeze(input.filesets); Object.freeze(input);
  const first = buildProjectTree(input), second = buildProjectTree(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(leafPaths(first), ['sources_1/new/a.v', 'sources_1/new/b.v']);
});

test('an external XCI registered in the design proves the duplicate BlockSrcs owner without relying on a default', () => {
  const xci = 'D:/shared/ip/fifo/fifo.xci';
  const input = project([file(xci, 'sources_2', { enabled: false }), file(xci, 'fifo')], [
    { name: 'sources_1', type: 'DesignSrcs' }, { name: 'sources_2', type: 'DesignSrcs' }, { name: 'fifo', type: 'BlockSrcs' }
  ], { selectedFilesets: ['sources_1', 'fifo'] });
  const tree = buildProjectTree(input);
  assert.deepEqual(tree.map(node => node.label), ['sources_1', 'sources_2']);
  assert.deepEqual(leafPaths(tree), ['sources_2/ip/外部文件/D:/shared/ip/fifo/fifo.xci']);
  assert.equal(leaves(tree)[0].origins.length, 2);
});

test('POSIX paths remain case sensitive and sibling directory prefixes are not treated as project children', () => {
  const input = {
    path: '/work/demo/demo.xpr', root: '/work/demo', name: 'demo',
    filesets: [{ name: 'sources_1', type: 'DesignSrcs' }],
    files: [file('/work/demo/demo.srcs/sources_1/new/A.v'), file('/work/demo/demo.srcs/sources_1/new/a.v'), file('/work/demo-other/shared.v')]
  };
  const tree = buildProjectTree(input);
  assert.equal(leaves(tree).length, 3);
  assert.ok(leafPaths(tree).includes('sources_1/外部文件/work/demo-other/shared.v'));
  assert.ok(leafPaths(tree).includes('sources_1/new/A.v'));
  assert.ok(leafPaths(tree).includes('sources_1/new/a.v'));
});

test('merged registration flags always describe one original entry rather than an invented active combination', () => {
  const xci = 'C:/work/demo/demo.srcs/sources_1/ip/fifo/fifo.xci';
  const input = project([
    file(xci, 'sources_1', { enabled: false, selected: true }),
    file(xci, 'fifo', { enabled: true, selected: false })
  ], [{ name: 'sources_1', type: 'DesignSrcs' }, { name: 'fifo', type: 'BlockSrcs' }]);
  const node = leaves(buildProjectTree(input))[0];
  assert.equal(node.file.enabled, true);
  assert.equal(node.file.selected, false);
  assert.ok(node.origins.some(origin => origin.enabled === node.file.enabled && origin.selected === node.file.selected));
});

test('shared external XCI keeps each design context and merges a BlockSrcs registration only into its explicit owner', () => {
  const xci = 'D:/shared/ip/fifo/fifo.xci';
  const stub = 'D:/shared/ip/fifo/fifo_stub.v';
  const input = project([
    file(xci, 'sources_1', { enabled: false }), file(xci, 'sources_2'),
    file(xci, 'fifo'), file(stub, 'fifo', { generated: true, origin: xci })
  ], [
    { name: 'sources_1', type: 'DesignSrcs' }, { name: 'sources_2', type: 'DesignSrcs' },
    { name: 'fifo', type: 'BlockSrcs', srcSets: ['sources_1'] }
  ]);
  const tree = buildProjectTree(input), xcis = leaves(tree).filter(node => node.label === 'fifo.xci');
  assert.deepEqual(tree.map(node => node.label), ['sources_1', 'sources_2']);
  assert.equal(xcis.length, 2);
  assert.equal(xcis[0].origins.length, 2);
  assert.equal(xcis[1].origins.length, 1);
  assert.ok(leafPaths(tree).includes('sources_1/ip/外部文件/D:/shared/ip/fifo/fifo_stub.v'));
  assert.ok(!leafPaths(tree).includes('sources_2/ip/外部文件/D:/shared/ip/fifo/fifo_stub.v'));
});

test('Windows directory aliases share one folder and ordinary-file duplicates retain their registrations', () => {
  const original = file('C:/work/demo/demo.srcs/sources_1/new/top.v', 'sources_1', { enabled: false });
  const alias = file('C:\\WORK\\DEMO\\DEMO.SRCS\\SOURCES_1\\NEW\\TOP.V');
  const sibling = file('C:/work/demo/demo.srcs/sources_1/NEW/worker.v');
  const tree = buildProjectTree(project([original, alias, sibling]));
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].label, 'new');
  const nodes = leaves(tree);
  assert.equal(nodes.length, 2);
  assert.equal(nodes.find(node => node.label === 'top.v').file.enabled, true);
  assert.deepEqual(nodes.find(node => node.label === 'top.v').origins, [original, alias]);
});
