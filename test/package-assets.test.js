'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assets = require('../scripts/package-assets');
const policy = require('../scripts/package-policy');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fpga-package-assets-'));
  const root = path.join(base, 'repository');
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('fpga-package-assets-'));
    fs.rmSync(base, {recursive:true, force:true});
  });
  return {base, root, write: (name, data = png) => fs.writeFileSync(path.join(root, name), data)};
}

test('accepts supported PNG/JPEG signatures and case-insensitive extensions', t => {
  const {root, write} = fixture(t);
  write('icon.PNG');
  // The validator checks file type signatures, not image decoding or dimensions.
  write('icon.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
  write('icon.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 16]));
  assert.equal(assets.validatePackageIcon(root, 'icon.PNG').format, 'png');
  assert.equal(assets.validatePackageIcon(root, 'icon.jpg').format, 'jpeg');
  assert.equal(assets.validatePackageIcon(root, 'icon.jpeg').format, 'jpeg');
});

test('accepts exactly 1024 KiB and rejects one byte above the Marketplace limit', t => {
  const {root, write} = fixture(t);
  const atLimit = Buffer.alloc(assets.MAX_ICON_BYTES);
  png.copy(atLimit);
  write('limit.png', atLimit);
  assert.equal(assets.validatePackageIcon(root, 'limit.png').size, 1024 * 1024);
  write('oversized.png', Buffer.concat([atLimit, Buffer.from([0])]));
  assert.throws(() => assets.validatePackageIcon(root, 'oversized.png'), /1024 KB.*1048576.*1048577.*压缩/);
});

test('rejects missing icons, non-files, unsupported types and mismatched signatures', t => {
  const {root, write} = fixture(t);
  for (const icon of [undefined, null, '', '   ']) {
    assert.throws(() => assets.validatePackageIcon(root, icon), /必须配置 icon/);
  }
  assert.throws(() => assets.validatePackageIcon(root, 'missing.png'), /不存在或无法访问/);
  fs.mkdirSync(path.join(root, 'directory.png'));
  assert.throws(() => assets.validatePackageIcon(root, 'directory.png'), /普通文件|无法读取/);
  write('icon.svg', '<svg/>');
  write('fake.png', 'plain text');
  write('wrong.jpg');
  write('empty.png', Buffer.alloc(0));
  assert.throws(() => assets.validatePackageIcon(root, 'icon.svg'), /仅支持 PNG 或 JPEG/);
  for (const icon of ['fake.png', 'wrong.jpg', 'empty.png']) {
    assert.throws(() => assets.validatePackageIcon(root, icon), /内容与 PNG\/JPEG 文件扩展名不匹配/);
  }
});

test('rejects parent escape and absolute paths even when those files exist', t => {
  const {base, root, write} = fixture(t);
  fs.writeFileSync(path.join(base, 'outside.png'), png);
  write('inside.png');
  for (const icon of ['../outside.png', path.join(root, 'inside.png')]) {
    assert.throws(() => assets.validatePackageIcon(root, icon), /仓库内的相对路径/);
  }
});

test('rejects directory links that lead outside the repository', t => {
  const {base, root} = fixture(t);
  const external = path.join(base, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'icon.png'), png);
  try {
    fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`Directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => assets.validatePackageIcon(root, 'linked/icon.png'), /链接指向仓库外/);
});

test('package entry rejects an oversized icon before output creation or VSCE startup', t => {
  const {root, write} = fixture(t);
  const oversized = Buffer.alloc(assets.MAX_ICON_BYTES + 1);
  png.copy(oversized);
  write('icon.png', oversized);
  const script = fs.readFileSync(path.resolve(__dirname, '../scripts/package.js'), 'utf8');
  const calls = [];
  const imports = {
    'node:fs': {mkdirSync: () => calls.push('mkdir')},
    'node:path': path,
    'node:child_process': {spawnSync: command => {
      calls.push(command);
      if (command === 'git') return {status:0, stdout:'develop\n'};
      throw new Error('VSCE must not start');
    }},
    './package-policy': policy,
    './package-assets': assets,
    '../package.json': {name:'fixture', version:'1.0.0', icon:'icon.png'},
  };
  const mockedRequire = name => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  };
  mockedRequire.resolve = () => { throw new Error('VSCE must not be resolved'); };
  assert.throws(() => vm.runInNewContext(script, {
    require: mockedRequire,
    __dirname: path.join(root, 'scripts'),
    process: {argv:['node', 'package.js'], execPath:'node'},
  }), /1024 KB/);
  assert.deepEqual(calls, ['git']);
});
