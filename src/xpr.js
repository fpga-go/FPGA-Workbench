'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const HDL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);
const truth = value => /^(1|true|yes)$/i.test(String(value));
const falsehood = value => /^(0|false|no)$/i.test(String(value));
const array = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const unique = values => [...new Map(values.map(value => [key(value), value])).values()];

/** Resolve only documented project-directory tokens; never evaluate environment or Tcl. */
function resolveXprPath(raw, xprPath) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('XPR 路径为空。');
  if (/[\0\r\n]/.test(raw)) throw new Error(`XPR 路径包含不支持的控制字符：${JSON.stringify(raw)}`);
  const api = /^[a-z]:[\\/]/i.test(xprPath) || /^\\\\/.test(xprPath) ? path.win32 : path;
  const project = api.resolve(xprPath);
  const root = api.dirname(project);
  const stem = api.basename(project, api.extname(project));
  const tokens = {
    PPRDIR: root,
    PROJECT_DIR: root,
    PRJ_DIR: root,
    PSRCDIR: api.join(root, `${stem}.srcs`),
    PGENDIR: api.join(root, `${stem}.gen`),
    PRUNDIR: api.join(root, `${stem}.runs`),
    PCACHEDIR: api.join(root, `${stem}.cache`),
    PIPUSERFILESDIR: api.join(root, `${stem}.ip_user_files`),
  };
  const expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g, (_, braced, plain) => {
    const name = braced || plain;
    if (!Object.hasOwn(tokens, name)) throw new Error(`未知 XPR 路径变量 $${name}：${raw}`);
    return tokens[name];
  });
  if (expanded.includes('$')) throw new Error(`无法解析 XPR 路径表达式：${raw}`);
  const normalized = expanded.replace(/\\/g, '/');
  if (api !== path.win32 && (/^[a-z]:/i.test(normalized) || normalized.startsWith('//'))) {
    throw new Error(`当前平台无法访问 Windows 绝对路径：${raw}`);
  }
  // Drive-relative paths depend on hidden process state and are not portable.
  if (/^[a-z]:[^/]/i.test(normalized)) throw new Error(`不支持依赖当前盘目录的路径：${raw}`);
  return api.resolve(root, normalized);
}

function properties(node, tag) {
  const result = new Map();
  for (const item of array(node && node[tag])) {
    const name = String(item.Name || '').toLowerCase();
    result.set(name, [...(result.get(name) || []), String(item.Val ?? '')]);
  }
  return result;
}

function first(propertiesMap, name, fallback = '') {
  return (propertiesMap.get(name.toLowerCase()) || [])[0] ?? fallback;
}

// Vivado stores include directories / macro definitions as Tcl lists. This reads
// list grouping only; no Tcl commands or variable substitutions are executed.
function listWords(value) {
  const words = [];
  let word = '';
  let depth = 0;
  let quote = false;
  let started = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && /[{}"\s;\\]/.test(value[i + 1] || '') && value[i + 1]) {
      word += value[++i]; started = true; continue;
    }
    if (ch === '{' && !quote && (depth || !started)) { if (depth++) word += ch; started = true; continue; }
    if (ch === '}' && !quote && depth) {
      if (--depth) word += ch;
      continue;
    }
    // A quote inside NAME="value" is macro content, not Tcl list grouping.
    if (ch === '"' && !depth && (quote || !started)) { quote = !quote; started = true; continue; }
    if (/[\s;]/.test(ch) && !depth && !quote) {
      if (started) words.push(word);
      word = ''; started = false;
    } else { word += ch; started = true; }
  }
  if (depth || quote) throw new Error(`列表中存在未闭合的引号或花括号：${value}`);
  if (started) words.push(word);
  return words.filter(Boolean);
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

function inferredType(file) {
  return ({ '.v': 'Verilog', '.vh': 'Verilog Header', '.sv': 'SystemVerilog', '.svh': 'SystemVerilog Header',
    '.vhd': 'VHDL', '.vhdl': 'VHDL', '.xdc': 'XDC', '.xci': 'IP', '.xcix': 'IP Core Container', '.bd': 'Block Design' })[path.extname(file).toLowerCase()] || 'File';
}

function candidateStubs(xci, xpr) {
  const root = path.dirname(xpr);
  const stem = path.basename(xpr, path.extname(xpr));
  const srcRoot = path.join(root, `${stem}.srcs`);
  const relative = path.relative(srcRoot, xci);
  const name = path.basename(xci, path.extname(xci));
  const candidates = [];
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    candidates.push(path.join(root, `${stem}.gen`, path.dirname(relative), `${name}_stub.v`));
  }
  candidates.push(path.join(path.dirname(xci), `${name}_stub.v`));
  return unique(candidates);
}

function candidateNetlist(xci, xpr, designFileset) {
  const root = path.dirname(xpr);
  const stem = path.basename(xpr, path.extname(xpr));
  const relative = path.relative(path.join(root, `${stem}.srcs`), xci);
  const name = path.basename(xci, path.extname(xci));
  // Preserve a known .srcs layout, including non-default design filesets.
  // External IPs have no such mapping: report the conventional generated path
  // as a candidate, never as proof that Vivado generated or selected it.
  const directory = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? path.dirname(relative) : path.join(designFileset, 'ip', name);
  return path.join(root, `${stem}.gen`, directory, `${name}_sim_netlist.v`);
}

/** Read a project without launching Vivado or modifying any project file. */
async function loadProject(xprPath, options = {}) {
  const projectPath = path.resolve(xprPath);
  if (path.extname(projectPath).toLowerCase() !== '.xpr') throw new Error('请选择 Vivado .xpr 工程文件。');
  const xml = await fs.readFile(projectPath, 'utf8');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new Error('XPR 不支持 DTD 或自定义实体声明。');
  const validity = XMLValidator.validate(xml);
  if (validity !== true) throw new Error(`XPR XML 无效：${validity.err.msg}（第 ${validity.err.line} 行）`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
    parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
  const root = parser.parse(xml).Project;
  if (!root) throw new Error('XML 根节点不是 Vivado Project。');
  const nodes = array(root.FileSets && root.FileSets.FileSet);
  if (!nodes.length) throw new Error('XPR 中没有 FileSet。');
  const warnings = [];
  const config = properties(root.Configuration, 'Option');
  const sets = nodes.map(node => {
    const props = properties(node.Config, 'Option');
    return { name: String(node.Name || ''), type: String(node.Type || ''), top: first(props, 'topmodule'), node, props };
  });
  if (new Set(sets.map(set => set.name)).size !== sets.length || sets.some(set => !set.name)) {
    throw new Error('XPR FileSet 名称为空或重复。');
  }
  const isDesign = set => /^(designsrcs|design)$/i.test(set.type) || (!set.type && /^sources?_1$/i.test(set.name));
  const isSimulation = set => /^simulationsrcs$/i.test(set.type);
  const byName = new Map(sets.map(set => [set.name, set]));
  const runs = array(root.Runs && root.Runs.Run);
  const activeRun = runs.find(run => run.Id === root.Runs?.SynthRun)
    || runs.find(run => /synth/i.test(run.Type || '') && run.State === 'current' && isDesign(byName.get(run.SrcSet) || {}));
  const activeName = first(config, 'activesrcset') || first(config, 'activesourceset') || activeRun?.SrcSet;
  const main = options.fileset ? byName.get(options.fileset)
    : (byName.get(activeName) && isDesign(byName.get(activeName)) ? byName.get(activeName) : null)
      || sets.find(set => set.name === 'sources_1' && isDesign(set)) || sets.find(isDesign);
  if (!main) throw new Error(options.fileset ? `找不到 fileset：${options.fileset}` : 'XPR 中没有可选的设计 fileset。');
  if (!isDesign(main) && !isSimulation(main) && !/^blocksrcs$/i.test(main.type)) {
    throw new Error(`fileset ${main.name} 不包含设计或仿真源文件。`);
  }
  const selected = new Set([main.name, ...sets.filter(set => /^blocksrcs$/i.test(set.type)).map(set => set.name)]);
  const visit = (set, stack = new Set()) => {
    if (stack.has(set.name)) throw new Error(`fileset SrcSet 存在循环：${[...stack, set.name].join(' → ')}`);
    const next = new Set([...stack, set.name]);
    for (const name of set.props.get('srcset') || []) {
      const dependency = byName.get(name);
      if (!dependency) { warnings.push(`fileset ${set.name} 引用了不存在的 SrcSet：${name}`); continue; }
      selected.add(name); visit(dependency, next);
    }
  };
  if (isSimulation(main)) visit(main);
  if (options.includeSimulation) {
    const activeSim = byName.get(first(config, 'activesimset')) || sets.find(isSimulation);
    if (activeSim && isSimulation(activeSim)) { selected.add(activeSim.name); visit(activeSim); }
  }
  const includeSimulation = Boolean(options.includeSimulation || isSimulation(main));
  const defaultLibrary = first(config, 'defaultlib', 'xil_defaultlib');
  const files = [];
  for (const set of sets) {
    for (const node of array(set.node.File)) {
      const attrs = properties(node.FileInfo, 'Attr');
      const rawPath = String(node.Path || '');
      let resolved = null;
      try { resolved = resolveXprPath(rawPath, projectPath); }
      catch (error) { warnings.push(`${set.name}：${error.message}`); }
      const enabled = ![...(attrs.get('autodisabled') || []), ...(attrs.get('isdisabled') || [])].some(truth)
        && !(attrs.get('isenabled') || []).some(falsehood);
      const usedIn = [...new Set((attrs.get('usedin') || []).flatMap(value => value.toLowerCase().split(/[\s,;]+/)).filter(Boolean))];
      const sourcePurpose = includeSimulation || ((!usedIn.length || usedIn.some(value => ['synthesis', 'implementation'].includes(value)))
        && !(attrs.get('usedinsynthesis') || []).some(falsehood));
      files.push({ path: resolved, rawPath, fileset: set.name, type: first(attrs, 'filetype', inferredType(rawPath)),
        exists: false, existence: 'unknown', enabled, usedIn, library: first(attrs, 'library', defaultLibrary), generated: false,
        selected: selected.has(set.name) && sourcePurpose });
    }
  }
  await Promise.all(files.map(async file => {
    if (file.path) {
      try { file.exists = await isFile(file.path); file.existence = file.exists ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查文件 ${file.path}：${error.message}`); }
    }
    if (file.path && !file.exists && file.enabled && file.selected) warnings.push(`工程文件不存在：${file.path}`);
  }));
  if (options.includeIpStubs !== false) {
    const seenIp = new Set();
    const known = new Set(files.filter(file => file.path && file.enabled && file.selected).map(file => key(file.path)));
    for (const file of [...files]) {
      if (!file.selected || !file.enabled || !file.exists || path.extname(file.path).toLowerCase() !== '.xci') continue;
      if (seenIp.has(key(file.path))) continue;
      seenIp.add(key(file.path));
      for (const candidate of candidateStubs(file.path, projectPath)) {
        let exists = false;
        try { exists = await isFile(candidate); } catch (error) { warnings.push(`无法检查 IP 声明：${error.message}`); }
        if (!exists) continue;
        if (!known.has(key(candidate))) {
          files.push({ ...file, path: candidate, rawPath: candidate, type: 'Verilog IP Stub', exists: true, generated: true, origin: file.path });
          known.add(key(candidate));
        }
        break; // One declaration per IP; never index the matching simulation netlist.
      }
    }
  }
  const designFileset = isDesign(main) ? main.name : sets.find(set => selected.has(set.name) && isDesign(set))?.name || 'sources_1';
  const ipReferences = [];
  const seenReferences = new Map();
  for (const file of files) {
    if (!file.selected || !file.enabled || path.extname(file.path || file.rawPath).toLowerCase() !== '.xci') continue;
    const identity = file.path ? key(file.path) : `raw:${file.rawPath}`;
    const previous = seenReferences.get(identity);
    if (previous) {
      previous.rawPaths = [...new Set([...previous.rawPaths, file.rawPath])];
      previous.filesets = [...new Set([...previous.filesets, file.fileset])];
      continue;
    }
    const reference = { path: file.path, rawPaths: [file.rawPath], filesets: [file.fileset],
      existence: file.existence, netlistPath: null, netlistExistence: 'unknown', artifactPaths: [] };
    if (file.path) {
      const name = path.basename(file.path, path.extname(file.path));
      reference.netlistPath = candidateNetlist(file.path, projectPath, designFileset);
      reference.artifactPaths = unique([...candidateStubs(file.path, projectPath),
        path.join(path.dirname(reference.netlistPath), `${name}_stub.v`), reference.netlistPath,
        path.join(path.dirname(file.path), `${name}_sim_netlist.v`)]);
      try { reference.netlistExistence = await isFile(reference.netlistPath) ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查 IP 仿真网表候选路径 ${reference.netlistPath}：${error.message}`); }
    }
    seenReferences.set(identity, reference);
    ipReferences.push(reference);
  }
  const sourceFiles = unique(files.filter(file => file.enabled && file.selected && file.exists && HDL_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map(file => file.path));
  const includeDirs = [];
  const defines = [];
  const addValues = (values, target, resolve) => {
    for (const value of values) {
      try { target.push(resolve ? resolveXprPath(value, projectPath) : value); }
      catch (error) { warnings.push(error.message); }
    }
  };
  for (const set of sets.filter(set => selected.has(set.name))) {
    for (const [propertyName, target, resolve] of [['includedirs', includeDirs, true], ['verilogdefines', defines, false], ['verilogdefine', defines, false]]) {
      for (const value of set.props.get(propertyName) || []) {
        try { addValues(listWords(value), target, resolve); } catch (error) { warnings.push(`${set.name} ${propertyName}：${error.message}`); }
      }
    }
  }
  addValues(array(options.includeDirs), includeDirs, true);
  addValues(array(options.defines), defines, false);
  for (const file of sourceFiles.filter(file => /\.(vh|svh)$/i.test(file))) includeDirs.push(path.dirname(file));
  const version = xml.match(/Product Version:\s*Vivado\s+v?([^\s<(]+)/i)?.[1] || first(config, 'simulatorversionxsim');
  if (files.some(file => file.selected && file.enabled && /\.(xci|xcix|bd)$/i.test(file.path || file.rawPath))) {
    warnings.push('IP 和 Block Design 仅索引工程已列出的源码及精确匹配的现有 IP stub；未启动 Vivado 展开或生成输出。');
  }
  return { path: projectPath, root: path.dirname(projectPath), name: path.basename(projectPath, path.extname(projectPath)),
    part: first(config, 'part'), vivadoVersion: version, top: main.top,
    filesets: sets.map(({ name, type, top, props }) => ({ name, type, top, srcSets: [...(props.get('srcset') || [])] })), selectedFilesets: [...selected],
    files, sourceFiles, ipReferences, includeSimulation,
    includeDirs: unique(includeDirs), defines: [...new Set(defines)], warnings: [...new Set(warnings)] };
}

/** Static source list with comment-only IP references; never a Vivado compile order. */
function filelist(project, baseDirectory, options = {}) {
  const comment = value => value === undefined || value === null || value === '' ? 'not recorded' : String(value).replace(/[\r\n\0]/g, ' ');
  const slash = value => comment(value).replace(/\\/g, '/');
  const displayPath = file => {
    const api = /^[a-z]:[\\/]/i.test(file) || /^\\\\/.test(file) ? path.win32 : path;
    let display = baseDirectory ? api.relative(api.resolve(baseDirectory), file) : file;
    // Windows relative() keeps an absolute path when the drives differ.
    display = display.replace(/\\/g, '/');
    if (/[\r\n\0"]/.test(display)) throw new Error(`无法将路径写入单行 filelist：${JSON.stringify(display)}`);
    return /[\s#]/.test(display) ? `"${display}"` : display;
  };
  const references = project.ipReferences || [];
  const artifacts = new Set(references.flatMap(reference => reference.artifactPaths).filter(Boolean).map(key));
  // Match only artifacts belonging to known XCIs. An unrelated user source
  // named *_stub.v remains an ordinary source file.
  for (const file of project.files || []) if (file.generated && file.origin && file.path) artifacts.add(key(file.path));
  const sources = project.sourceFiles.filter(file => !artifacts.has(key(file)));
  const lines = [
    '// FPGA Workbench: static XPR source filelist; XPR order, NOT elaborated compile order.',
    `// Output file: ${slash(options.outputPath)}`,
    `// Project: ${comment(project.name)}`,
    `// XPR: ${slash(project.path)}`,
    `// Part: ${comment(project.part)}`,
    `// XPR-recorded Vivado version: ${comment(project.vivadoVersion)} (not the installed tool version).`,
    `// Exported at (ISO 8601 with timezone): ${comment(options.exportedAt || new Date().toISOString())}`,
    `// Selected filesets: ${comment(project.selectedFilesets?.join(', '))}`,
    `// Top: ${comment(options.top || project.top)}`,
    `// Scope: enabled, selected, existing Verilog/SystemVerilog sources and headers; simulation indexing ${project.includeSimulation ? 'included' : 'excluded'}.`,
    '// IP stubs and matching simulation netlists are excluded from active paths; XCI/netlist references below are comments only.',
    '// Candidate netlist paths are inferred from XPR layout; existence does not establish generation, usage or compile order.',
    `// Counts: active source paths ${sources.length}; XCI references ${references.length}.`,
    '// Include directories and macro definitions remain available in project status information.',
    baseDirectory ? '// Paths relative to this filelist directory.' : '// Absolute source paths.',
    '',
    '// ---------------- Active RTL sources and headers ----------------',
  ];
  for (const file of sources) lines.push(displayPath(file));
  if (references.length) lines.push('', '// ---------------- IP references (comments only; checked when XPR was loaded) ----------------');
  for (const reference of references) {
    for (const raw of reference.rawPaths) lines.push(`// XCI original path: ${comment(raw)}`);
    lines.push(`// XCI resolved [${comment(reference.existence)}]: ${reference.path ? displayPath(reference.path) : 'unresolved'}`);
    lines.push(`// Simulation netlist candidate [${comment(reference.netlistExistence)}]: ${reference.netlistPath ? displayPath(reference.netlistPath) : 'unresolved'}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { loadProject, resolveXprPath, filelist };
