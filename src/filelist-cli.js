'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadProject, filelist } = require('./xpr');

const HELP = `FPGA Workbench: export a static XPR source filelist (Node.js 20+).

Usage:
  node export-filelist.cjs --xpr <project.xpr> --out <sources.f> [options]

Options:
  --fileset <name>  Select a fileset instead of the active design fileset.
  --top <module>    Record an explicit top module in the filelist header.
  --with-sim        Include the active simulation fileset in the static scope.
  --force           Replace an existing output; project inputs remain protected.
  --help            Show this help without exporting.

Paths are relative to the output file directory (absolute across Windows drives).
This does not run Vivado, elaborate a design, generate IP or determine compile order.
`;

function parseArgs(args) {
  const values = new Set(['--xpr', '--out', '--fileset', '--top']);
  const switches = new Set(['--with-sim', '--force', '--help']);
  const parsed = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!values.has(flag) && !switches.has(flag)) throw new Error(`未知参数：${flag}`);
    if (seen.has(flag)) throw new Error(`参数重复：${flag}`);
    seen.add(flag);
    if (values.has(flag)) {
      const value = args[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值。`);
      parsed[flag.slice(2)] = value;
    } else parsed[flag.slice(2)] = true;
  }
  if (parsed.help) {
    if (seen.size !== 1) throw new Error('--help 不能与导出参数同时使用。');
    return parsed;
  }
  if (!parsed.xpr || !parsed.out) throw new Error('必须提供 --xpr <project.xpr> 和 --out <sources.f>。');
  return parsed;
}

const canonical = file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

async function statOrMissing(file, options) {
  try { return await fs.stat(file, options); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// Resolve existing parents too, so a missing IP candidate reached through an
// alias directory remains protected before the output file has been created.
async function realComparable(file) {
  let current = path.resolve(file);
  const suffix = [];
  for (;;) {
    try { return canonical(path.join(await fs.realpath(current), ...suffix.reverse())); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function checkOutput(project, output, force) {
  const inputs = [...new Set([project.path,
    ...project.files.map(file => file.path),
    ...project.ipReferences.flatMap(reference => [reference.path, ...reference.artifactPaths]),
  ].filter(Boolean))];
  const outputPath = canonical(output);
  const actualOutput = await realComparable(output);
  const outputStat = await statOrMissing(output, { bigint: true });
  for (const input of inputs) {
    if (outputPath === canonical(input) || actualOutput === await realComparable(input)) {
      throw new Error(`输出路径指向工程输入文件或 IP 参考工件，拒绝覆盖：${output}`);
    }
    if (outputStat) {
      const inputStat = await statOrMissing(input, { bigint: true });
      if (inputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino) {
        throw new Error(`输出与工程输入文件或 IP 参考工件具有相同文件身份，拒绝覆盖：${output}`);
      }
    }
  }
  let existing;
  try { existing = await fs.lstat(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) throw new Error(`输出路径是符号链接，拒绝覆盖：${output}`);
  if (existing && !existing.isFile()) throw new Error(`输出路径不是普通文件：${output}`);
  if (existing && !force) throw new Error(`输出文件已存在；如需替换独立导出文件，请显式使用 --force：${output}`);
  const parent = await statOrMissing(path.dirname(output));
  if (!parent?.isDirectory()) throw new Error(`输出父目录不存在或不是目录：${path.dirname(output)}`);
}

async function main(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const options = parseArgs(args);
    if (options.help) { stdout.write(HELP); return 0; }
    const xpr = path.resolve(options.xpr);
    const output = path.resolve(options.out);
    const project = await loadProject(xpr, { fileset: options.fileset, includeSimulation: Boolean(options['with-sim']) });
    await checkOutput(project, output, Boolean(options.force));
    const text = filelist(project, path.dirname(output), { outputPath: output, top: options.top });
    if (options.force) {
      // Replace the directory entry instead of truncating an existing inode:
      // an output changed into a hard link or symlink during export cannot
      // make this write follow that alias into an input file.
      const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporary, output);
      } finally { await fs.rm(temporary, { force: true }); }
    } else await fs.writeFile(output, text, { encoding: 'utf8', flag: 'wx' });
    stdout.write(`已导出静态 XPR Filelist：${output}\n`);
    for (const warning of project.warnings) stderr.write(`警告（静态 XPR）：${warning}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Filelist 导出失败：${error.message}\n`);
    return 1;
  }
}

if (require.main === module) void main().then(code => { process.exitCode = code; });

module.exports = { main, parseArgs };
