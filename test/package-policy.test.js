'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../scripts/package-policy');

const scriptPath = path.resolve(__dirname, '../scripts/package.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const root = path.dirname(path.dirname(scriptPath));

function runPackage({ branch = 'feature', args = [], gitResult, packageResult = { status: 0 } } = {}) {
  const calls = [], directories = [];
  const mockProcess = { argv: ['synthetic-node', scriptPath, ...args], execPath: 'synthetic-node' };
  const imports = {
    'node:fs': { mkdirSync: (...values) => directories.push(values) },
    'node:path': path,
    'node:child_process': {
      spawnSync: (command, options, settings) => {
        calls.push({ command, options: Array.from(options), settings });
        if (command === 'git') return gitResult || { status: 0, stdout: `${branch}\n` };
        if (command === mockProcess.execPath) return packageResult;
        throw new Error(`Unexpected subprocess: ${command}`);
      },
    },
    './package-policy': policy,
    '../package.json': { name: 'fpga-workbench', version: '0.9.0' },
  };
  const mockedRequire = name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  };
  mockedRequire.resolve = name => {
    assert.equal(name, '@vscode/vsce/package.json');
    return path.join(root, 'node_modules', '@vscode', 'vsce', 'package.json');
  };
  let error;
  try {
    vm.runInNewContext(source, { require: mockedRequire, __dirname: path.dirname(scriptPath), process: mockProcess }, { filename: scriptPath });
  } catch (failure) { error = failure; }
  return { calls, directories, process: mockProcess, error };
}

function assertRefused(result, pattern) {
  assert.ok(result.error, 'Packaging must fail before invoking vsce');
  assert.match(result.error.message, pattern);
  assert.equal(result.directories.length, 0, 'Refused requests must not create output directories');
  assert.equal(result.calls.filter(call => call.command !== 'git').length, 0, 'Refused requests must not build or package');
}

test('feature requires explicit pre-release packaging and forwards its channel to vsce', () => {
  assertRefused(runPackage({ branch: 'feature' }), /feature.*预发布/);
  const result = runPackage({ branch: 'feature', args: ['--pre-release'] });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 2);
  assert.equal(result.directories.length, 1);
  assert.deepEqual(result.calls[0].options, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  assert.equal(result.calls[0].settings.cwd, root);
  assert.equal(result.calls[0].settings.shell, false);
  assert.equal(result.calls[1].options.filter(value => value === '--pre-release').length, 1);
  assert.ok(result.calls[1].options.includes('output/fpga-workbench-0.9.0-win32-x64.vsix'));
  assert.equal(result.process.exitCode, 0);
});

test('develop can package a regular release and can explicitly request a pre-release', () => {
  for (const args of [[], ['--pre-release']]) {
    const result = runPackage({ branch: 'develop', args });
    assert.equal(result.error, undefined);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[1].options.includes('--pre-release'), args.length === 1);
  }
});

test('main rejects both regular and pre-release packaging', () => {
  for (const args of [[], ['--pre-release']]) assertRefused(runPackage({ branch: 'main', args }), /main.*禁止/);
});

test('unknown branch names cannot package through similarly named branches or flags', () => {
  for (const branch of ['feature/fix', 'develop-next', 'release', 'Feature', 'feature\ndevelop']) {
    for (const args of [[], ['--pre-release']]) assertRefused(runPackage({ branch, args }), /仅允许 feature 或 develop/);
  }
});

test('detached HEAD, missing Git, and failed branch detection all fail closed', () => {
  const failures = [
    { status: 1, stdout: '' },
    { status: 128, stdout: '', stderr: 'not a git repository' },
    { status: null, stdout: '', error: new Error('spawn git ENOENT') },
    { status: 0, stdout: '' },
    { status: 0, stdout: 'HEAD\n' },
  ];
  for (const gitResult of failures) assertRefused(runPackage({ gitResult, args: ['--pre-release'] }), /Git 分支.*拒绝打包/);
});

test('unsupported, overriding, and duplicated parameters are refused before packaging', () => {
  for (const args of [['--force'], ['--branch=develop'], ['--pre-release=false'], ['--pre-release', '--force'], ['--pre-release', '--pre-release']]) {
    assertRefused(runPackage({ branch: 'develop', args }), /参数/);
  }
});

test('allowed packaging preserves vsce failures instead of reporting success', () => {
  const exited = runPackage({ branch: 'develop', packageResult: { status: 7 } });
  assert.equal(exited.error, undefined);
  assert.equal(exited.process.exitCode, 7);
  const failed = runPackage({ branch: 'develop', packageResult: { status: null, error: new Error('synthetic package failure') } });
  assert.match(failed.error.message, /synthetic package failure/);
});
