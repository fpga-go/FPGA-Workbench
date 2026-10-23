'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { StdioLsp } = require('../src/lsp');
const { HdlIndex } = require('../src/indexer');
const { semanticFilelist, resolveElaboratedParentConnections } = require('../src/slang');

const uriKey = uri => path.resolve(fileURLToPath(uri)).toLowerCase();
const positionAt = (text, offset) => {
  const prefix = text.slice(0, offset);
  return { line: (prefix.match(/\n/g) || []).length, character: offset - prefix.lastIndexOf('\n') - 1 };
};
const span = (text, marker, delta, width) => {
  const index = text.indexOf(marker);
  assert.ok(index >= 0, marker);
  return { start: positionAt(text, index + delta), end: positionAt(text, index + delta + width) };
};
const rangeKey = range => JSON.stringify(range);

test('bundled Slang signal references distinguish local symbols and expose parent labels outside the module',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-signal-references-'));
    const client = new StdioLsp({ onRequest: () => null });
    t.after(async () => {
      await client.stop();
      assert.equal(path.resolve(path.dirname(base)), path.resolve(os.tmpdir()));
      assert.match(path.basename(base), /^fpga-signal-references-/);
      await fs.rm(base, { recursive: true, force: true });
    });
    const sources = path.join(base, 'sources');
    await fs.mkdir(sources); await fs.mkdir(path.join(base, '.slang'));
    const design = [
      'module top;',
      'wire sys_clk;',
      'child first(.clk(sys_clk));',
      'child second(.clk(sys_clk));',
      'other sibling(.clk(sys_clk));',
      'external_parent ext(.clk(sys_clk));',
      'endmodule',
      'module child(input wire clk);',
      'wire root_use=clk;',
      '`include "child_refs.svh"',
      'initial begin: shadow',
      'logic clk;',
      "clk=1'b0;",
      'end',
      'wire after_shadow=clk;',
      'endmodule',
      'module other(input wire clk);',
      'wire other_use=clk;',
      'endmodule',
      ''
    ].join('\n');
    const external = [
      'module external_parent(input wire clk);',
      'child nested(.clk(clk));',
      'wire external_use=clk;',
      'endmodule',
      ''
    ].join('\n');
    const header = 'wire header_use=clk;\n';
    const mainPath = path.join(sources, 'design.sv');
    const externalPath = path.join(sources, 'external.sv');
    const headerPath = path.join(sources, 'child_refs.svh');
    const documents = [[mainPath, design], [externalPath, external], [headerPath, header]];
    for (const [file, text] of documents) await fs.writeFile(file, text);
    const build = path.join(base, 'project.f');
    await fs.writeFile(build, semanticFilelist({ top: 'top', includeDirs: [sources], sourceFiles: documents.map(([file]) => file) }));
    await fs.writeFile(path.join(base, '.slang', 'server.json'), JSON.stringify({ build, index: [{ dirs: [] }] }));
    const env = { ...process.env }; delete env.HOME;
    client.start(path.resolve(__dirname, '../vendor/slang/slang-server.exe'), [], { cwd: base, env });
    await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(base).href,
      capabilities: { textDocument: { definition: { linkSupport: true } } } });
    client.notify('initialized', {});
    for (const [file, text] of documents) client.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(file).href, text, version: 1, languageId: 'systemverilog' } });
    const uri = pathToFileURL(mainPath).href;
    const externalUri = pathToFileURL(externalPath).href;
    const headerUri = pathToFileURL(headerPath).href;
    client.notify('textDocument/didSave', { textDocument: { uri }, text: design });
    const declaration = span(design, 'module child(input wire clk)', 'module child(input wire '.length, 3);
    const localUses = [span(design, 'wire root_use=clk', 'wire root_use='.length, 3),
      span(design, 'wire after_shadow=clk', 'wire after_shadow='.length, 3)];
    const parentLabels = [span(design, 'child first(.clk', 'child first(.'.length, 3),
      span(design, 'child second(.clk', 'child second(.'.length, 3)];
    const externalLabel = span(external, 'child nested(.clk', 'child nested(.'.length, 3);
    const otherDeclaration = span(design, 'module other(input wire clk)', 'module other(input wire '.length, 3);
    const otherUse = span(design, 'wire other_use=clk', 'wire other_use='.length, 3);
    const shadowDeclaration = span(design, 'logic clk;', 'logic '.length, 3);
    const shadowUse = span(design, "clk=1'b0", 0, 3);
    const definition = async range => client.request('textDocument/definition', { textDocument: { uri }, position: range.start });
    const references = async (range, includeDeclaration = false) => client.request('textDocument/references', {
      textDocument: { uri }, position: range.start, context: { includeDeclaration } });
    const assertDefinition = (result, expected) => {
      assert.equal(result.length, 1, JSON.stringify(result));
      assert.equal(uriKey(result[0].targetUri || result[0].uri), uriKey(uri));
      assert.deepEqual(result[0].targetSelectionRange || result[0].range, expected);
    };

    await t.test('definition confirms the exact root port before local reference candidates are considered', async () => {
      assertDefinition(await definition(declaration), declaration);
      assertDefinition(await definition(localUses[0]), declaration);
      assertDefinition(await definition(localUses[1]), declaration);
    });

    await t.test('raw references contain same-file parent port labels; document and module filtering keeps local uses only', async () => {
      const result = await references(declaration);
      for (const range of [...localUses, ...parentLabels]) assert.ok(result.some(item => uriKey(item.uri) === uriKey(uri) && rangeKey(item.range) === rangeKey(range)), JSON.stringify(result));
      assert.ok(!result.some(item => uriKey(item.uri) === uriKey(uri) && [shadowUse, otherUse, declaration].some(range => rangeKey(range) === rangeKey(item.range))));
      // Module source boundaries alone do not exclude other documents. Both
      // document identity and this module's exact source range are required.
      const local = result.filter(item => uriKey(item.uri) === uriKey(uri) && item.range.start.line >= 7 && item.range.end.line < 16);
      assert.deepEqual(local.map(item => item.range), localUses);
      const withDeclaration = await references(declaration, true);
      assert.ok(withDeclaration.some(item => uriKey(item.uri) === uriKey(uri) && rangeKey(item.range) === rangeKey(declaration)));
      const scope = await client.request('workspace/executeCommand', { command: 'slang.getScope', arguments: ['top.first'] });
      assert.ok(scope.some(item => item.instName === 'header_use'), JSON.stringify(scope));
      const externalScope = await client.request('workspace/executeCommand', { command: 'slang.getScope', arguments: ['top.ext'] });
      assert.ok(externalScope.some(item => item.kind === 'Instance' && item.instName === 'nested' && item.declName === 'child'), JSON.stringify(externalScope));
      // The bundled server may omit references expanded from an include, even
      // though elaboration sees that symbol. Do not invent lexical references.
      t.diagnostic(`include reference locations reported by bundled Slang: ${result.filter(item => uriKey(item.uri) === uriKey(headerUri)).length}`);
      t.diagnostic(`cross-document parent port references reported by bundled Slang: ${result.filter(item => uriKey(item.uri) === uriKey(externalUri) && rangeKey(item.range) === rangeKey(externalLabel)).length}`);
    });

    await t.test('shadowed and same-name signals in a second module resolve to their own declarations and uses', async () => {
      assertDefinition(await definition(shadowUse), shadowDeclaration);
      assert.deepEqual((await references(shadowUse)).map(item => ({ uri: uriKey(item.uri), range: item.range })), [{ uri: uriKey(uri), range: shadowUse }]);
      assertDefinition(await definition(otherUse), otherDeclaration);
      const otherReferences = await references(otherUse);
      assert.ok(otherReferences.some(item => rangeKey(item.range) === rangeKey(otherUse)));
      assert.ok(!otherReferences.some(item => [...localUses, shadowUse].some(range => rangeKey(range) === rangeKey(item.range))));
    });

    await t.test('confirmed parent-port navigation supplements the actual external instance label omitted by raw references', async () => {
      const index = new HdlIndex(); index.update(mainPath, design);
      const offset = design.indexOf('module child(input wire clk)') + 'module child(input wire '.length;
      const query = index.parentConnections(mainPath, offset);
      assert.ok(query);
      const parents = await resolveElaboratedParentConnections({ uri, text: design, position: declaration.start, query,
        options: { target: 'port' },
        execute: (command, args) => client.request('workspace/executeCommand', { command, arguments: args }),
        readText: async target => documents.find(([file]) => uriKey(pathToFileURL(file).href) === uriKey(target))?.[1] });
      assert.equal(parents.length, 3, JSON.stringify(parents));
      for (const range of parentLabels) assert.ok(parents.some(item => uriKey(item.targetUri) === uriKey(uri)
        && rangeKey(item.targetSelectionRange) === rangeKey(range)), JSON.stringify(parents));
      assert.ok(parents.some(item => uriKey(item.targetUri) === uriKey(externalUri)
        && rangeKey(item.targetSelectionRange) === rangeKey(externalLabel)), JSON.stringify(parents));
      for (const parent of parents) {
        const source = uriKey(parent.targetUri) === uriKey(uri) ? design : external;
        const range = parent.targetSelectionRange;
        assert.equal(source.split('\n')[range.start.line].slice(range.start.character, range.end.character), 'clk');
      }
    });

    await t.test('the parent net references are right-hand expressions rather than child port labels', async () => {
      const net = span(design, 'wire sys_clk;', 'wire '.length, 7);
      assertDefinition(await definition(net), net);
      const result = await references(net);
      assert.equal(result.length, 4);
      for (const item of result) {
        assert.equal(uriKey(item.uri), uriKey(uri));
        const line = design.split('\n')[item.range.start.line];
        assert.equal(line.slice(item.range.start.character, item.range.end.character), 'sys_clk');
      }
    });
    for (const [file, text] of documents) assert.equal(await fs.readFile(file, 'utf8'), text);
  });
