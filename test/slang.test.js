'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { StdioLsp } = require('../src/lsp');
const { decodeSource, semanticFilelist, resolveElaboratedDefinition } = require('../src/slang');
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

const executable = path.join(__dirname, '..', 'vendor', 'slang', 'slang-server.exe');
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
