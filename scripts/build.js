'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
require('./notices');
fs.mkdirSync(path.join(__dirname, '../output'), {recursive:true});
const onigRoot=path.join(__dirname,'../vendor/oniguruma');
fs.mkdirSync(onigRoot,{recursive:true});
for(const [source,target] of [['release/onig.wasm','onig.wasm'],['LICENSE.txt','LICENSE.txt'],['NOTICES.txt','NOTICES.txt']]) {
  fs.copyFileSync(path.join(__dirname,'../node_modules/vscode-oniguruma',source),path.join(onigRoot,target));
}
const onigPackage=require('../node_modules/vscode-oniguruma/package.json');
fs.writeFileSync(path.join(onigRoot,'UPSTREAM.json'),JSON.stringify({
  package:'vscode-oniguruma',version:onigPackage.version,license:onigPackage.license,
  source:`https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-${onigPackage.version}.tgz`,
  file:'release/onig.wasm',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(onigRoot,'onig.wasm'))).digest('hex')
},null,2)+'\n');
esbuild.buildSync({entryPoints:[path.join(__dirname, '../src/extension.js')],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:path.join(__dirname,'../dist/extension.js')});
esbuild.buildSync({entryPoints:[path.join(__dirname, '../src/filelist-cli.js')],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:path.join(__dirname,'../skills/fpga-workbench-filelist/scripts/export-filelist.cjs')});
const skillRoot=path.join(__dirname,'../skills/fpga-workbench-filelist');
fs.copyFileSync(path.join(__dirname,'../LICENSE.txt'),path.join(skillRoot,'LICENSE.txt'));
const separator='\n\n----------------------------------------\n\n';
const notices=fs.readFileSync(path.join(__dirname,'../THIRD_PARTY_NOTICES.txt'),'utf8')
  .split(separator).filter(section=>!section.startsWith('Bundled slang-server:') && !section.startsWith('HDL syntax grammars:') && !section.startsWith('vscode-textmate ') && !section.startsWith('vscode-oniguruma ')).join(separator)
  .replace('FPGA Workbench third-party notices','FPGA Workbench Filelist third-party notices');
fs.writeFileSync(path.join(skillRoot,'THIRD_PARTY_NOTICES.txt'),notices);
