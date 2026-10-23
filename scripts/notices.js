'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const seen=new Set();
const notices=['FPGA Workbench third-party notices','Bundled slang-server: see vendor/slang/LICENSE and additional license files in that directory.'];
function visit(name) {
  if(seen.has(name))return;seen.add(name);
  const dir=path.join(root,'node_modules',name);
  const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const license=fs.readdirSync(dir).find(n=>/^licen[sc]e(?:\..*)?$/i.test(n));
  const licensePath=license ? path.join(dir,license) : path.join(root,'vendor/licenses',name.replace(/^@/,'').replace(/[^a-zA-Z0-9._-]+/g,'-')+'.txt');
  if(!fs.existsSync(licensePath))throw new Error(`Missing license for ${name}`);
  notices.push(`${name} ${pkg.version} (${pkg.license})\n${fs.readFileSync(licensePath,'utf8')}`);
  for(const dep of Object.keys(pkg.dependencies || {}))visit(dep);
}
visit('fast-xml-parser');
notices.push('HDL syntax grammars:\n'+fs.readFileSync(path.join(root,'vendor/licenses/hdl-grammars.txt'),'utf8'));
fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n----------------------------------------\n\n'));
