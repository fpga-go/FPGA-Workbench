'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {validatePackageRequest} = require('./package-policy');
const {validatePackageIcon} = require('./package-assets');
const root = path.resolve(__dirname, '..');
const {name, version, icon} = require('../package.json');
const options = process.argv.slice(2);
const branchResult = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  {cwd:root, encoding:'utf8', windowsHide:true, shell:false});
if(branchResult.error || branchResult.status !== 0) {
  throw new Error('无法读取当前 Git 分支，拒绝打包。请在已检出的 feature 或 develop 分支中运行；分离 HEAD 不允许打包。');
}
validatePackageRequest(branchResult.stdout?.trim(), options);
validatePackageIcon(root, icon);
fs.mkdirSync(path.join(root, 'output'), {recursive:true});
const executable = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const result = spawnSync(process.execPath, [executable, 'package', '--target', 'win32-x64', '--no-dependencies',
  '--allow-missing-repository', '--no-rewrite-relative-links', '--out', `output/${name}-${version}-win32-x64.vsix`, ...options],
  {cwd:root, stdio:'inherit', windowsHide:true});
if(result.error) throw result.error;
process.exitCode = result.status ?? 1;
