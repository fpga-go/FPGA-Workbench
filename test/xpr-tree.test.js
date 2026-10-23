'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadProject } = require('../src/xpr');
const { buildProjectTree } = require('../src/project-tree');

const scratch = path.resolve(__dirname, '../test-tmp');
const leaves = node => node.kind === 'file' ? [node] : node.children.flatMap(leaves);

test('loaded XPR SrcSet places an external BlockSrcs IP and its declaration in the explicit alternative design', async t => {
  await fs.mkdir(scratch, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(scratch, 'xpr-tree-'));
  t.after(async () => {
    assert.equal(path.dirname(fixtureRoot), scratch);
    assert.match(path.basename(fixtureRoot), /^xpr-tree-/);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(fixtureRoot, 'project');
  const ipRoot = path.join(fixtureRoot, 'external', 'fifo');
  await fs.mkdir(projectRoot); await fs.mkdir(ipRoot, { recursive: true });
  const xci = path.join(ipRoot, 'fifo.xci');
  const stub = path.join(ipRoot, 'fifo_stub.v');
  await fs.writeFile(xci, '<component/>');
  await fs.writeFile(stub, '// navigation existence marker\n');
  const xpr = path.join(projectRoot, 'fixture.xpr');
  await fs.writeFile(xpr, `<?xml version="1.0"?>
<Project><FileSets>
  <FileSet Name="sources_1" Type="DesignSrcs"/>
  <FileSet Name="sources_2" Type="DesignSrcs"/>
  <FileSet Name="external_fifo" Type="BlockSrcs">
    <File Path="$PPRDIR/../external/fifo/fifo.xci"/>
    <Config><Option Name="SrcSet" Val="sources_2"/></Config>
  </FileSet>
</FileSets></Project>`);
  const original = await fs.readFile(xpr);
  const loaded = await loadProject(xpr);
  assert.deepEqual(loaded.filesets.find(set => set.name === 'external_fifo').srcSets, ['sources_2']);
  assert.ok(loaded.files.find(file => file.path === stub && file.generated && file.origin === xci));
  const snapshot = JSON.stringify(loaded);
  const tree = buildProjectTree(loaded);
  const main = tree.find(node => node.label === 'sources_1');
  const alternative = tree.find(node => node.label === 'sources_2');
  assert.equal(main.count, 0);
  assert.equal(alternative.count, 2);
  assert.equal(tree.some(node => node.label === 'external_fifo'), false);
  assert.deepEqual(leaves(alternative).map(node => node.file.path).sort(), [xci, stub].sort());
  assert.equal(alternative.children[0].label, 'ip');
  assert.equal(alternative.children[0].children[0].label, '外部文件');
  assert.equal(JSON.stringify(loaded), snapshot);
  assert.deepEqual(await fs.readFile(xpr), original);
});
