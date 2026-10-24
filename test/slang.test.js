'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { StdioLsp } = require('../src/lsp');
const { HdlIndex } = require('../src/indexer');
const { decodeSource, semanticFilelist, resolveElaboratedDefinition, resolveElaboratedParentConnections } = require('../src/slang');
const sameUri = (left, right) => {
  const key = uri => { const value = path.resolve(fileURLToPath(uri)); return process.platform === 'win32' ? value.toLowerCase() : value; };
  return key(left) === key(right);
};

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

test('LSP decodes fragmented UTF-8 messages and multiple frames without losing bytes', () => {
  const received = [];
  const client = new StdioLsp({ onNotification: (method, params) => received.push([method, params]) });
  client.closed = false;
  const input = Buffer.concat([frame({ jsonrpc: '2.0', method: 'note', params: '中文注释' }), frame({ method: 'second', params: 3 })]);
  for (const byte of input) client.consume(Buffer.from([byte]));
  assert.deepEqual(received, [['note', '中文注释'], ['second', 3]]);
});

test('LSP rejects unanswered requests on timeout and cancels the server request', async () => {
  const sent = [];
  const client = new StdioLsp();
  client.send = message => sent.push(message);
  await assert.rejects(client.request('test/wait', {}, { timeout: 15 }), /timed out/);
  assert.equal(client.pending.size, 0);
  assert.equal(sent[1].method, '$/cancelRequest');
});

test('LSP resolves out-of-order request IDs and rejects errors', async () => {
  const client = new StdioLsp();
  client.send = () => {};
  const first = client.request('one', {});
  const second = client.request('two', {});
  const rejected = assert.rejects(second, /invalid request/);
  client.dispatch({ id: 2, error: { code: -1, message: 'invalid request' } });
  client.dispatch({ id: 1, result: ['definition'] });
  assert.deepEqual(await first, ['definition']);
  await rejected;
});

test('legacy Chinese source is decoded in memory, UTF-8 is retained, and malformed explicit UTF-8 fails', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.deepEqual(decodeSource(gbk), { text: '中文', encoding: 'gb18030' });
  assert.deepEqual(decodeSource(Buffer.from('中文')), { text: '中文', encoding: 'utf-8' });
  assert.throws(() => decodeSource(gbk, 'utf-8'));
  assert.equal(decodeSource(Buffer.from([0xff, 0xfe, 0x41, 0x00])).text, 'A');
});

test('semantic filelist retains spaced paths and definitions but does not compile headers as units', () => {
  const value = semanticFilelist({ top: 'top', includeDirs: ['C:\\RTL 项目\\include'], defines: ['WIDTH=8'],
    sourceFiles: ['C:\\RTL 项目\\top.v', 'C:\\RTL 项目\\defs.vh', 'C:\\RTL 项目\\child.sv'] });
  assert.match(value, /"C:\/RTL 项目\/top.v"/);
  assert.match(value, /"-DWIDTH=8"/);
  assert.match(value, /--top\n"top"/);
  assert.doesNotMatch(value, /defs.vh/);
  assert.throws(() => semanticFilelist({ sourceFiles: ['C:/bad\nfile.v'] }), /控制字符/);
});

test('elaborated definition supplement excludes inactive and same-name instances at other source locations', async () => {
  const uri = pathToFileURL(path.resolve('test-owner.v')).href;
  const targetUri = pathToFileURL(path.resolve('test-child.v')).href;
  const text = 'module top;\n`ifdef OFF\nchild hidden();\n`endif\nchild enabled();\nendmodule';
  const request = async (command, args) => {
    if (command === 'slang.getInstancesOfModule') return [{ instPath: 'top' }];
    if (command === 'slang.getScope' && args[0] === 'top') return [{ kind: 'Instance', instName: 'enabled', declName: 'child',
      instLoc: { uri, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 15 } } },
      declLoc: { uri: targetUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } } } }];
    return [];
  };
  const query = position => resolveElaboratedDefinition({ uri, text, position, execute: request, readText: async () => 'module child; endmodule' });
  assert.deepEqual(await query({ line: 2, character: 2 }), []);
  assert.equal((await query({ line: 4, character: 2 }))[0].targetUri, targetUri);
  assert.deepEqual(await query({ line: 4, character: 15 }), []);
});

test('reverse semantic navigation rejects unrelated declarations, local signals, roots, and cancelled requests', async () => {
  const file = path.resolve('reverse.v');
  const uri = pathToFileURL(file).href;
  const text = 'module child(input wire clk); wire local_clk; endmodule';
  const index = new HdlIndex(); index.update(file, text);
  const owner = index.modules()[0];
  const declaration = owner.symbols.find(symbol => symbol.name === 'clk');
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } };
  const item = { kind: 'Instance', instName: 'child', declName: 'child', instLoc: { uri, range }, declLoc: { uri, range } };
  const execute = async command => command === 'slang.getInstancesOfModule' ? [{ instPath: 'child', instLoc: item.instLoc }] : [item];
  const request = query => resolveElaboratedParentConnections({ uri, text, position: { line: 0, character: declaration.start }, query,
    execute, readText: async () => text });
  assert.deepEqual(await request(undefined), []);
  assert.deepEqual(await request({ module: owner, declaration: { ...declaration, kind: 'signal' } }), []);
  assert.deepEqual(await request({ module: { ...owner, bodyStart: 1 }, declaration }), []);
  assert.deepEqual(await request({ module: owner, declaration: { ...owner, kind: 'module' } }), []);
  assert.deepEqual(await resolveElaboratedParentConnections({ uri, text, position: { line: 0, character: declaration.start },
    query: { module: owner, declaration }, token: { isCancellationRequested: true },
    execute: () => { throw new Error('Cancelled requests must not query the service'); } }), []);
});

const executable = path.join(__dirname, '..', 'vendor', 'slang', 'slang-server.exe');

test('bundled slang reverse navigation uses actual parents across instances, generate scopes, arrays, and non-ANSI ports',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-slang-reverse-'));
    const cache = path.join(base, 'cache');
    const sources = path.join(base, 'sources');
    await fs.mkdir(path.join(cache, '.slang'), { recursive: true });
    await fs.mkdir(sources);
    const topPath = path.join(sources, 'top.sv');
    const childPath = path.join(sources, 'child.sv');
    const top = [
      'module top;',
      '  wire clk, other_clk, sys_clk, clock_in; wire [7:0] bus; wire [3:0] data_in;',
      '  child first(.clk(clk));',
      '  child second(.clk(other_clk));',
      '  decoy misleading(.clk(clk));',
      '  if (1) begin: enabled',
      '    child same_name(.clk(clk));',
      '  end',
      '  if (0) begin: disabled',
      '    child same_name(.clk(clk));',
      '  end',
      '`ifdef OFF',
      '  child inactive(.clk(clk));',
      '`endif',
      '  child #(.ENABLED(0)) muted(.clk(clk));',
      '  old_style old_one(.clk);',
      '  child arrayed [1:0] (.clk(clk));',
      '  branch_port_child conditional_ports(',
      '`ifdef OFF',
      '    .clk(other_clk)',
      '`else',
      '    .clk(clk)',
      '`endif',
      '  );',
      '  expression_child explicit_expression(.clock_in( /* parent */ sys_clk /* end */ ), .data_in(bus[3:0]), .empty_in());',
      '  expression_child concat_expression(.clock_in(sys_clk), .data_in({bus[1:0], bus[3:2]}), .empty_in());',
      '  expression_child implicit_expression(.clock_in, .data_in, .empty_in());',
      '`define PARENT_CLOCK sys_clk',
      '  expression_child macro_expression(.clock_in(`PARENT_CLOCK), .data_in(bus[3:0]), .empty_in());',
      '  expression_child ifdef_expression(.clock_in(',
      '`ifdef OFF',
      '    other_clk',
      '`else',
      '    sys_clk',
      '`endif',
      '  ), .data_in(bus[3:0]), .empty_in());',
      'endmodule',
      'module decoy(input wire clk); endmodule',
      ''
    ].join('\n');
    const child = [
      '`ifdef OFF',
      'module child(input wire clk);',
      'endmodule',
      '`endif',
      'module child #(parameter ENABLED=1)(input wire clk);',
      '  wire local_use=clk;',
      '  if (ENABLED) begin: internal',
      '    wire clk;',
      '  end',
      'endmodule',
      'module old_style(clk);',
      '  input wire clk;',
      '  wire local_use=clk;',
      'endmodule',
      'module branch_port_child(input wire clk); endmodule',
      'module expression_child(input wire clock_in, input wire [3:0] data_in, input wire empty_in); endmodule',
      ''
    ].join('\n');
    await fs.writeFile(topPath, top); await fs.writeFile(childPath, child);
    const build = path.join(cache, 'project.f');
    await fs.writeFile(build, semanticFilelist({ top: 'top', sourceFiles: [topPath, childPath] }));
    await fs.writeFile(path.join(cache, '.slang', 'server.json'), JSON.stringify({ build, index: [{ dirs: [] }] }));
    const client = new StdioLsp({ onRequest: () => null });
    t.after(async () => {
      await client.stop();
      assert.equal(path.dirname(base), os.tmpdir());
      assert.match(path.basename(base), /^fpga-slang-reverse-/);
      await fs.rm(base, { recursive: true, force: true });
    });
    const env = { ...process.env }; delete env.HOME;
    client.start(executable, [], { cwd: cache, env });
    await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(cache).href,
      capabilities: { textDocument: { definition: { linkSupport: true } } } });
    client.notify('initialized', {});
    const topUri = pathToFileURL(topPath).href;
    const childUri = pathToFileURL(childPath).href;
    for (const [uri, text] of [[topUri, top], [childUri, child]]) client.notify('textDocument/didOpen', {
      textDocument: { uri, text, version: 1, languageId: 'systemverilog' } });
    client.notify('textDocument/didSave', { textDocument: { uri: topUri }, text: top });
    const index = new HdlIndex(); index.update(childPath, child); index.update(topPath, top);
    const positionAt = (text, offset) => {
      const prefix = text.slice(0, offset);
      return { line: (prefix.match(/\n/g) || []).length, character: offset - prefix.lastIndexOf('\n') - 1 };
    };
    const reverse = async (moduleName, kind, name, selectedOwner, selectedOffset, options = {}) => {
      const owner = selectedOwner || index.modules().find(mod => mod.name === moduleName && !mod.conditional);
      const declaration = kind === 'module' ? { ...owner, kind } : owner.symbols.find(symbol => symbol.kind === kind && symbol.name === name);
      const offset = selectedOffset ?? declaration.start;
      const query = index.parentConnections(owner.path, offset);
      assert.ok(query, `Missing declaration query for ${moduleName}.${name || ''}`);
      return resolveElaboratedParentConnections({ uri: pathToFileURL(owner.path).href,
        text: owner.path === childPath ? child : top, position: positionAt(owner.path === childPath ? child : top, offset), query, options,
        execute: (command, args) => client.request('workspace/executeCommand', { command, arguments: args }),
        readText: async uri => sameUri(uri, childUri) ? child : top });
    };
    const parents = await reverse('child', 'module');
    assert.deepEqual(parents.map(item => item.targetSelectionRange.start.line).sort((a, b) => a - b), [2, 3, 6, 14, 16]);
    assert.deepEqual(parents.map(item => top.split('\n')[item.targetSelectionRange.start.line]
      .slice(item.targetSelectionRange.start.character, item.targetSelectionRange.end.character)).sort(),
    ['arrayed', 'first', 'muted', 'same_name', 'second']);
    const ports = await reverse('child', 'port', 'clk');
    assert.deepEqual(ports.map(item => item.targetSelectionRange.start.line).sort((a, b) => a - b), [2, 3, 6, 14, 16]);
    for (const item of ports) {
      assert.ok(sameUri(item.targetUri, topUri));
      assert.equal(top.split('\n')[item.targetSelectionRange.start.line].slice(item.targetSelectionRange.start.character, item.targetSelectionRange.end.character), 'clk');
    }
    const oldPort = await reverse('old_style', 'port', 'clk');
    assert.deepEqual(oldPort.map(item => item.targetSelectionRange.start.line), [15]);
    const oldHeader = await reverse('old_style', 'port', 'clk', undefined, child.indexOf('old_style(clk)') + 'old_style('.length);
    assert.deepEqual(oldHeader.map(item => item.targetSelectionRange.start.line), [15]);
    // Both preprocessor branches contain .clk and the inactive one comes first.
    // Slang confirms conditional_ports is active, but has no parent connection
    // token location, so the source port must degrade to that instance name.
    const conditionalPorts = await reverse('branch_port_child', 'port', 'clk');
    assert.equal(conditionalPorts.length, 1);
    const conditionalTarget = conditionalPorts[0].targetSelectionRange;
    assert.equal(conditionalTarget.start.line, 17);
    assert.equal(top.split('\n')[conditionalTarget.start.line].slice(conditionalTarget.start.character, conditionalTarget.end.character), 'conditional_ports');
    assert.deepEqual(await reverse('branch_port_child', 'port', 'clk', undefined, undefined, { target: 'expression' }), conditionalPorts);
    assert.deepEqual(await reverse('branch_port_child', 'port', 'clk', undefined, undefined, { target: 'port' }), []);
    assert.deepEqual(await reverse('child', 'port', 'clk', undefined, undefined, { target: 'port' }), ports);
    assert.deepEqual(await reverse('child', 'module', undefined, undefined, undefined, { target: 'expression' }), parents);
    const expression = name => reverse('expression_child', 'port', name, undefined, undefined, { target: 'expression' });
    const selectedText = item => {
      const range = item.targetSelectionRange;
      return top.split('\n')[range.start.line].slice(range.start.character, range.end.character);
    };
    const clockExpressions = await expression('clock_in');
    assert.deepEqual(clockExpressions.map(selectedText), ['sys_clk', 'sys_clk', 'clock_in']);
    assert.ok(clockExpressions.every(item => sameUri(item.targetUri, topUri)));
    const dataExpressions = await expression('data_in');
    assert.deepEqual(dataExpressions.map(selectedText), ['bus[3:0]', '{bus[1:0], bus[3:2]}', 'data_in', 'bus[3:0]', 'bus[3:0]']);
    assert.deepEqual(await expression('empty_in'), []);
    const connectionNames = await reverse('expression_child', 'port', 'clock_in');
    assert.deepEqual(connectionNames.map(selectedText), ['clock_in', 'clock_in', 'clock_in', 'clock_in', 'clock_in']);
    const inactiveOwner = index.modules().find(mod => mod.name === 'child' && mod.conditional);
    assert.deepEqual(await reverse('child', 'module', undefined, inactiveOwner), []);
    assert.deepEqual(await reverse('child', 'port', 'clk', inactiveOwner), []);
    assert.equal(index.parentConnections(childPath, child.indexOf('local_use=clk') + 'local_use='.length), undefined);
    assert.deepEqual(await reverse('top', 'module'), []);
    assert.equal((await fs.readFile(topPath, 'utf8')), top);
    assert.equal((await fs.readFile(childPath, 'utf8')), child);
  });

test('bundled slang resolves external project modules, local nets, named ports, and hierarchy from private cache root',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fpga-slang-test-'));
    const cache = path.join(base, 'cache');
    const sources = path.join(base, '工程 sources');
    await fs.mkdir(path.join(cache, '.slang'), { recursive: true });
    await fs.mkdir(sources, { recursive: true });
    const topPath = path.join(sources, 'top.v');
    const childPath = path.join(sources, 'child.sv');
    const top = 'module top;\n  wire clk;\n  child u_child(.clk(clk));\nendmodule\n';
    const child = '// 中文\nmodule child(input wire clk);\nendmodule\n';
    await fs.writeFile(topPath, top);
    // The initial on-disk comments are GBK. didOpen must supply decoded Unicode.
    await fs.writeFile(childPath, Buffer.concat([Buffer.from('// '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\nmodule child(input wire clk);\nendmodule\n')]));
    const build = path.join(cache, 'project.f');
    await fs.writeFile(build, semanticFilelist({ top: 'top', sourceFiles: [topPath, childPath] }));
    await fs.writeFile(path.join(cache, '.slang', 'server.json'), JSON.stringify({ build, index: [{ dirs: [] }] }));
    const client = new StdioLsp({ onRequest: () => null });
    t.after(async () => {
      await client.stop();
      assert.equal(path.dirname(base), os.tmpdir());
      assert.match(path.basename(base), /^fpga-slang-test-/);
      await fs.rm(base, { recursive: true, force: true });
    });
    const env = { ...process.env }; delete env.HOME;
    client.start(executable, [], { cwd: cache, env });
    const rootUri = pathToFileURL(cache).href;
    const initialize = await client.request('initialize', { processId: process.pid, rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'private cache' }],
      capabilities: { textDocument: { definition: { linkSupport: true } } } });
    assert.match(initialize.serverInfo.version, /^0\.3\.0/);
    client.notify('initialized', {});
    const topUri = pathToFileURL(topPath).href;
    const childUri = pathToFileURL(childPath).href;
    for (const [uri, text] of [[topUri, top], [childUri, child]]) client.notify('textDocument/didOpen', {
      textDocument: { uri, text, version: 1, languageId: 'systemverilog' } });
    client.notify('textDocument/didSave', { textDocument: { uri: topUri }, text: top });
    const definition = async (line, character) => {
      const result = await client.request('textDocument/definition', { textDocument: { uri: topUri }, position: { line, character } });
      if (result && (!Array.isArray(result) || result.length)) return Array.isArray(result) ? result : [result];
      return resolveElaboratedDefinition({ uri: topUri, text: top, position: { line, character },
        execute: (command, args) => client.request('workspace/executeCommand', { command, arguments: args }),
        readText: async uri => sameUri(uri, childUri) ? child : top });
    };
    const moduleDefinition = await definition(2, 3);
    assert.ok(moduleDefinition.some(item => sameUri(item.targetUri || item.uri, childUri)), JSON.stringify(moduleDefinition));
    const netDefinition = await definition(2, 23);
    assert.ok(netDefinition.some(item => (item.targetSelectionRange || item.range).start.line === 1), JSON.stringify(netDefinition));
    const portDefinition = await definition(2, 18);
    assert.ok(portDefinition.some(item => sameUri(item.targetUri || item.uri, childUri)), JSON.stringify(portDefinition));
    const roots = await client.request('workspace/executeCommand', { command: 'slang.getScope', arguments: [''] });
    assert.ok(roots.some(item => item.instName === 'top'), JSON.stringify(roots));
    const children = await client.request('workspace/executeCommand', { command: 'slang.getScope', arguments: ['top'] });
    assert.ok(children.some(item => item.instName === 'u_child' && item.declName === 'child'), JSON.stringify(children));
    // Source content and encoding remain untouched.
    const disk = await fs.readFile(childPath);
    assert.ok(disk.includes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])));
  });
