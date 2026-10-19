'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const {name, version} = require('../package.json');
const options = process.argv.slice(2);
if(options.some(option => option !== '--pre-release')) throw new Error('Supported option: --pre-release');
fs.mkdirSync(path.join(root, 'output'), {recursive:true});
const executable = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const result = spawnSync(process.execPath, [executable, 'package', '--target', 'win32-x64', '--no-dependencies',
  '--allow-missing-repository', '--no-rewrite-relative-links', '--out', `output/${name}-${version}-win32-x64.vsix`, ...options],
  {cwd:root, stdio:'inherit', windowsHide:true});
if(result.error) throw result.error;
process.exitCode = result.status ?? 1;
