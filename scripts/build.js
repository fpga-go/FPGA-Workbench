'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
require('./notices');
fs.mkdirSync(path.join(__dirname, '../output'), {recursive:true});
esbuild.buildSync({entryPoints:[path.join(__dirname, '../src/extension.js')],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:path.join(__dirname,'../dist/extension.js')});
esbuild.buildSync({entryPoints:[path.join(__dirname, '../src/filelist-cli.js')],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:path.join(__dirname,'../skills/fpga-workbench-filelist/scripts/export-filelist.cjs')});
const skillRoot=path.join(__dirname,'../skills/fpga-workbench-filelist');
fs.copyFileSync(path.join(__dirname,'../LICENSE.txt'),path.join(skillRoot,'LICENSE.txt'));
const separator='\n\n----------------------------------------\n\n';
const notices=fs.readFileSync(path.join(__dirname,'../THIRD_PARTY_NOTICES.txt'),'utf8')
  .split(separator).filter(section=>!section.startsWith('Bundled slang-server:')).join(separator)
  .replace('FPGA Workbench third-party notices','FPGA Workbench Filelist third-party notices');
fs.writeFileSync(path.join(skillRoot,'THIRD_PARTY_NOTICES.txt'),notices);
