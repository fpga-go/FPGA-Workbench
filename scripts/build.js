'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
require('./notices');
fs.mkdirSync(path.join(__dirname, '../output'), {recursive:true});
esbuild.buildSync({entryPoints:[path.join(__dirname, '../src/extension.js')],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:path.join(__dirname,'../dist/extension.js')});
