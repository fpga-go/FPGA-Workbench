'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { readSource } = require('./encoding');
const { HdlIndex } = require('./indexer');

const HDL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);
const LATTICE_IP_EXTENSIONS = new Set(['.ipx', '.sbx', '.lpc']);
const LPF_KEYWORDS = new Set([
  'BLOCK', 'SYSCONFIG', 'LOCATE', 'IOBUF', 'FREQUENCY', 'MULTICYCLE', 'MAXDELAY',
  'INPUT_SETUP', 'CLOCK_TO_OUT', 'USE', 'UGROUP', 'PROHIBIT', 'DEFINE', 'COMMERCIAL',
  'INDUSTRIAL', 'TEMPERATURE', 'VOLTAGE', 'BANK', 'GSR_NET', 'SLEWRATE', 'DRIVE',
  'PULLMODE', 'OPENDRAIN', 'HYSTERESIS', 'CLAMP', 'DIFFRESISTOR', 'TERMINATION',
  'VREF', 'TRACEID', 'GROUP', 'REGION', 'USERCODE', 'RESERVE', ' PRIORITIZE', 'PRIORITIZE',
  'SCHEMATIC', 'PERIOD', 'OFFSET', ' Derate', 'DERATE', 'Skew', 'SKEW', 'HGROUP', 'PBBOX',
]);
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
    '.vhd': 'VHDL', '.vhdl': 'VHDL', '.xdc': 'XDC', '.lpf': 'LPF', '.sdc': 'SDC', '.prf': 'PRF',
    '.xci': 'IP', '.xcix': 'IP Core Container', '.bd': 'Block Design',
    '.ipx': 'IP', '.sbx': 'IP', '.lpc': 'IP' })[path.extname(file).toLowerCase()] || 'File';
}

function parseLpfKeyValues(tokens) {
  const attributes = {};
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    const eq = text.indexOf('=');
    if (eq > 0) {
      const name = text.slice(0, eq).trim();
      const rest = text.slice(eq + 1).trim();
      if (rest) attributes[name] = rest;
      else if (tokens[i + 1]) attributes[name] = tokens[++i].text;
    } else if (tokens[i + 1] && !tokens[i + 1].quoted && tokens[i + 1].text === '=' && tokens[i + 2]) {
      attributes[text] = tokens[i + 2].text;
      i += 2;
    } else if (tokens[i + 1] && !tokens[i + 1].quoted && tokens[i + 1].text.startsWith('=')) {
      attributes[text] = tokens[i + 1].text.slice(1);
      i += 1;
    }
  }
  return attributes;
}

/** Parse a Lattice Preference File (.lpf) without executing external tools. */
function parseLpf(text) {
  if (typeof text !== 'string' || /\0/.test(text)) throw new Error('LPF 包含不支持的空字符或二进制内容。');
  const source = text.replace(/^\uFEFF/, '');
  if (/^\s*</.test(source)) throw new Error('LPF 语法无效：检测到 XML 标签。');
  const rawStatements = [];
  let current = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 1);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('LPF 中存在未闭合的块注释。');
      i = end + 2;
      continue;
    }
    if (ch === ';') {
      if (current.length) { rawStatements.push(current); current = []; }
      i++;
      continue;
    }
    if (ch === '"') {
      let value = '';
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1]; i += 2; continue;
        }
        if (source[i] === '\r' || source[i] === '\n') break;
        if (source[i] === '"') { closed = true; i++; break; }
        value += source[i++];
      }
      if (!closed) throw new Error('LPF 中存在未闭合的引号。');
      current.push({ text: value, raw: source.slice(start, i), quoted: true });
      continue;
    }
    const start = i;
    while (i < source.length && !/[\s;"#]/.test(source[i]) && !source.startsWith('//', i) && !source.startsWith('/*', i)) i++;
    const raw = source.slice(start, i);
    current.push({ text: raw, raw, quoted: false });
  }
  if (current.length) {
    throw new Error(`LPF 语句缺少分号结尾：${current.map(token => token.raw).join(' ')}`);
  }
  const statements = [];
  const ports = [];
  const locates = [];
  const iobufs = [];
  const frequencies = [];
  const sysconfig = {};
  const blocks = [];
  for (const stmt of rawStatements) {
    const firstToken = stmt[0];
    const keyword = firstToken.text.toUpperCase();
    if (firstToken.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyword)) {
      throw new Error(`LPF 语句关键字无效：${firstToken.raw}`);
    }
    const raw = stmt.map(token => token.raw).join(' ');
    statements.push({ keyword, tokens: stmt.map(token => token.text), raw });
    if (keyword === 'LOCATE') {
      const targetType = (stmt[1]?.text || '').toUpperCase();
      const name = stmt[2]?.text || '';
      const siteIndex = stmt.findIndex((token, index) => index >= 3 && !token.quoted && token.text.toUpperCase() === 'SITE');
      const site = siteIndex >= 0 ? (stmt[siteIndex + 1]?.text || '') : '';
      locates.push({ targetType, name, site, raw });
      if (targetType === 'COMP' && name) ports.push(name);
    } else if (keyword === 'IOBUF') {
      const targetType = (stmt[1]?.text || '').toUpperCase();
      const hasName = targetType === 'PORT' || targetType === 'GROUP';
      const name = hasName ? (stmt[2]?.text || '') : '';
      const attributes = parseLpfKeyValues(stmt.slice(hasName ? 3 : 2));
      iobufs.push({ targetType, name, attributes, raw });
      if (targetType === 'PORT' && name) ports.push(name);
    } else if (keyword === 'FREQUENCY') {
      const targetType = (stmt[1]?.text || '').toUpperCase();
      const name = stmt[2]?.text || '';
      const value = stmt[3]?.text || '';
      const unit = stmt[4]?.text || '';
      frequencies.push({ targetType, name, value, unit, raw });
      if (targetType === 'PORT' && name) ports.push(name);
    } else if (keyword === 'SYSCONFIG') {
      Object.assign(sysconfig, parseLpfKeyValues(stmt.slice(1)));
    } else if (keyword === 'BLOCK') {
      blocks.push(stmt.slice(1).map(token => token.raw).join(' '));
    }
  }
  return { statements, ports: [...new Set(ports)], locates, iobufs, frequencies, sysconfig, blocks };
}

function latticeOptions(node) {
  const result = new Map();
  const add = (rawName, rawValue) => {
    const name = String(rawName || '').toLowerCase();
    if (!name) return;
    result.set(name, [...(result.get(name) || []), String(rawValue ?? '')]);
  };
  for (const item of array(node)) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item)) {
      if (k === 'Option' || k === 'Property') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') add(k, v);
    }
    for (const child of [...array(item.Option), ...array(item.Property)]) {
      if (child && typeof child === 'object') add(child.name ?? child.Name, child.value ?? child.Val ?? '');
    }
  }
  return result;
}

function latticeFileType(rawPath, typeShort, typeLong) {
  const inferred = inferredType(rawPath);
  if (inferred !== 'File') return inferred;
  const short = String(typeShort || '').toUpperCase();
  const long = String(typeLong || '');
  if (short === 'LPF' || /logic preference/i.test(long)) return 'LPF';
  if (short === 'SDC' || /constraints/i.test(long)) return 'SDC';
  if (['IPX', 'SBX', 'LPC'].includes(short)) return 'IP';
  if (/verilog/i.test(short) || /verilog/i.test(long)) return 'Verilog';
  if (/vhdl/i.test(short) || /vhdl/i.test(long)) return 'VHDL';
  return long || short || 'File';
}

async function candidateLatticeIpFiles(ipPath) {
  const dir = path.dirname(ipPath);
  const stem = path.basename(ipPath, path.extname(ipPath));
  const stubs = [];
  if (path.extname(ipPath).toLowerCase() === '.ipx' && await isFile(ipPath)) {
    try {
      const xml = await readSource(ipPath, 'auto');
      if (!/<!DOCTYPE\b|<!ENTITY\b/i.test(xml) && XMLValidator.validate(xml) === true) {
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
          parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
        const mod = parser.parse(xml).DiamondModule;
        for (const pkg of array(mod && mod.Package)) {
          for (const f of array(pkg && pkg.File)) {
            const type = String(f.type || '').toLowerCase();
            const name = String(f.name || '');
            if (name && (type === 'top_level_verilog' || type === 'top_level_systemverilog')) {
              stubs.push(resolveXprPath(name, ipPath));
            }
          }
        }
      }
    } catch (_) {}
  }
  stubs.push(path.join(dir, `${stem}.v`), path.join(dir, `${stem}_stub.v`));
  const netlist = path.join(dir, `${stem}_sim_netlist.v`);
  return { stubs: unique(stubs), netlist };
}

async function inferTopFromSources(sourceFiles, lpf, preferredName) {
  if (!sourceFiles.length) return '';
  const index = new HdlIndex();
  const portMap = new Map();
  for (const file of sourceFiles) {
    try {
      const text = await readSource(file, 'auto');
      index.update(file, text);
    } catch (_) {}
  }
  const mods = index.modules();
  if (!mods.length) return '';
  for (const file of index._files.values()) {
    for (const mod of file.modules) {
      const ports = new Set((mod.scopes[0]?.symbols || []).filter(s => s.kind === 'port').map(s => s.name));
      portMap.set(mod.name, ports);
    }
  }
  const called = new Set(mods.flatMap(m => m.instances.map(i => i.type)));
  const roots = mods.filter(m => !called.has(m.name));
  const candidates = roots.length ? roots : mods;
  if (lpf?.ports?.length) {
    let best = null;
    let bestScore = 0;
    for (const mod of candidates) {
      const declared = portMap.get(mod.name) || new Set();
      const score = lpf.ports.filter(p => declared.has(p)).length;
      if (score > bestScore) { bestScore = score; best = mod; }
    }
    if (best && bestScore > 0) return best.name;
  }
  if (preferredName) {
    const exact = candidates.find(m => m.name.toLowerCase() === preferredName.toLowerCase())
      || mods.find(m => m.name.toLowerCase() === preferredName.toLowerCase());
    if (exact) return exact.name;
  }
  return candidates[0].name;
}

async function findCompanionLdf(lpfPath) {
  const dir = path.dirname(lpfPath);
  const stem = path.basename(lpfPath, path.extname(lpfPath));
  const sameStem = path.join(dir, `${stem}.ldf`);
  if (await isFile(sameStem)) return sameStem;
  const searchDirs = [dir];
  const parentDir = path.dirname(dir);
  if (parentDir && parentDir !== dir) searchDirs.push(parentDir);
  for (const candidateDir of searchDirs) {
    let entries = [];
    try { entries = await fs.readdir(candidateDir, { withFileTypes: true }); } catch { continue; }
    const ldfs = entries.filter(e => e.isFile() && path.extname(e.name).toLowerCase() === '.ldf')
      .map(e => path.join(candidateDir, e.name))
      .sort((a, b) => a.localeCompare(b, 'en'));
    if (!ldfs.length) continue;
    for (const ldf of ldfs) {
      try {
        const xml = await readSource(ldf, 'auto');
        if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml) || XMLValidator.validate(xml) !== true) continue;
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
          parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
        const bali = parser.parse(xml).BaliProject;
        if (!bali) continue;
        for (const impl of array(bali.Implementation)) {
          for (const src of array(impl && impl.Source)) {
            try {
              if (key(resolveXprPath(String(src.name || src.Path || ''), ldf)) === key(lpfPath)) return ldf;
            } catch (_) {}
          }
          if (candidateDir === parentDir && impl?.dir) {
            try {
              if (key(resolveXprPath(String(impl.dir), ldf)) === key(dir)) return ldf;
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
    if (candidateDir === dir && ldfs.length === 1) return ldfs[0];
  }
  return null;
}

async function loadBaliProject(ldfPath, xml, root, options = {}) {
  const projectPath = options.selectedProjectPath ? path.resolve(options.selectedProjectPath) : ldfPath;
  const projectRoot = path.dirname(ldfPath);
  const implNodes = array(root.Implementation);
  if (!implNodes.length) throw new Error('Lattice 工程中没有 Implementation。');
  const warnings = [];
  const globalProps = latticeOptions(root.Options);
  const sets = implNodes.map(node => {
    const props = latticeOptions(node.Options);
    let sourceTop = '';
    for (const src of array(node.Source)) {
      const srcOpts = latticeOptions(src.Options);
      const enabled = ![src.excluded, ...(srcOpts.get('excluded') || []), ...(srcOpts.get('isdisabled') || []), ...(srcOpts.get('autodisabled') || [])].filter(Boolean).some(truth)
        && ![src.enabled, ...(srcOpts.get('enabled') || []), ...(srcOpts.get('isenabled') || [])].filter(Boolean).some(falsehood);
      if (enabled && !sourceTop) {
        sourceTop = first(srcOpts, 'top_module') || first(srcOpts, 'top') || String(src.top_module || '');
      }
    }
    const top = first(props, 'top') || first(props, 'topmodule') || first(props, 'top_module') || sourceTop || first(props, 'def_top');
    return {
      name: String(node.title || node.name || ''),
      type: 'DesignSrcs',
      dir: String(node.dir || node.title || node.name || ''),
      defaultStrategy: String(node.default_strategy || ''),
      top,
      node,
      props,
    };
  });
  if (new Set(sets.map(set => set.name)).size !== sets.length || sets.some(set => !set.name)) {
    throw new Error('Lattice Implementation 名称为空或重复。');
  }
  const byName = new Map(sets.map(set => [set.name, set]));
  let defaultImplName = String(root.default_implementation || first(globalProps, 'default_implementation') || '');
  if (!options.fileset && options.primaryLpfPath) {
    const lpfDir = path.dirname(options.primaryLpfPath);
    const matchingDirImpl = sets.find(set => {
      try { return key(resolveXprPath(set.dir, ldfPath)) === key(lpfDir); } catch { return false; }
    });
    if (matchingDirImpl) defaultImplName = matchingDirImpl.name;
  }
  const main = options.fileset ? byName.get(options.fileset) : (byName.get(defaultImplName) || sets[0]);
  if (!main) throw new Error(options.fileset ? `找不到 fileset：${options.fileset}` : 'Lattice 工程中没有可选的设计 Implementation。');
  const selected = new Set([main.name]);
  const includeSimulation = Boolean(options.includeSimulation);
  const defaultLibrary = first(globalProps, 'defaultlib', 'work') || 'work';
  const files = [];
  for (const set of sets) {
    for (const node of array(set.node.Source)) {
      const srcOpts = latticeOptions(node.Options);
      const rawPath = String(node.name || node.Path || '');
      let resolved = null;
      try { resolved = resolveXprPath(rawPath, ldfPath); }
      catch (error) { warnings.push(`${set.name}：${error.message}`); }
      const enabled = ![node.excluded, ...(srcOpts.get('excluded') || []), ...(srcOpts.get('isdisabled') || []), ...(srcOpts.get('autodisabled') || [])].filter(Boolean).some(truth)
        && ![node.enabled, ...(srcOpts.get('enabled') || []), ...(srcOpts.get('isenabled') || [])].filter(Boolean).some(falsehood);
      const synSim = String(node.syn_sim || first(srcOpts, 'syn_sim') || '').toLowerCase();
      const usedIn = /simonly|simulationonly|^sim$/i.test(synSim)
        ? ['simulation']
        : /synthesisonly|^syn$/i.test(synSim)
          ? ['synthesis']
          : ['synthesis', 'simulation'];
      const sourcePurpose = includeSimulation || usedIn.includes('synthesis');
      const library = String(node.work_lib || first(srcOpts, 'work_lib') || first(srcOpts, 'library') || defaultLibrary);
      files.push({
        path: resolved,
        rawPath,
        fileset: set.name,
        type: latticeFileType(rawPath, node.type_short, node.type),
        exists: false,
        existence: 'unknown',
        enabled,
        usedIn,
        library,
        generated: false,
        selected: selected.has(set.name) && sourcePurpose,
      });
    }
  }
  if (options.primaryLpfPath) {
    const primaryKey = key(options.primaryLpfPath);
    if (!files.some(file => file.path && key(file.path) === primaryKey && file.fileset === main.name)) {
      const relRaw = path.relative(projectRoot, options.primaryLpfPath).replace(/\\/g, '/');
      files.push({
        path: options.primaryLpfPath,
        rawPath: relRaw || path.basename(options.primaryLpfPath),
        fileset: main.name,
        type: 'LPF',
        exists: true,
        existence: 'exists',
        enabled: true,
        usedIn: ['synthesis', 'simulation'],
        library: defaultLibrary,
        generated: false,
        selected: true,
      });
    }
  }
  await Promise.all(files.map(async file => {
    if (file.path) {
      try { file.exists = await isFile(file.path); file.existence = file.exists ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查文件 ${file.path}：${error.message}`); }
    }
    if (file.path && !file.exists && file.enabled && file.selected) warnings.push(`工程文件不存在：${file.path}`);
  }));
  const isLatticeIp = file => LATTICE_IP_EXTENSIONS.has(path.extname(file.path || file.rawPath).toLowerCase());
  if (options.includeIpStubs !== false) {
    const seenIp = new Set();
    const known = new Set(files.filter(file => file.path && file.enabled && file.selected).map(file => key(file.path)));
    for (const file of [...files]) {
      if (!file.selected || !file.enabled || !file.exists || !isLatticeIp(file)) continue;
      if (seenIp.has(key(file.path))) continue;
      seenIp.add(key(file.path));
      const { stubs } = await candidateLatticeIpFiles(file.path);
      for (const candidate of stubs) {
        let exists = false;
        try { exists = await isFile(candidate); } catch (error) { warnings.push(`无法检查 IP 声明：${error.message}`); }
        if (!exists) continue;
        if (!known.has(key(candidate))) {
          files.push({ ...file, path: candidate, rawPath: candidate, type: 'Verilog IP Stub', exists: true, existence: 'exists', generated: true, origin: file.path });
          known.add(key(candidate));
        }
        break;
      }
    }
  }
  const ipReferences = [];
  const seenReferences = new Map();
  for (const file of files) {
    if (!file.selected || !file.enabled || !isLatticeIp(file)) continue;
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
      const { stubs, netlist } = await candidateLatticeIpFiles(file.path);
      reference.netlistPath = netlist;
      reference.artifactPaths = unique([...stubs, netlist]);
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
      if (!value || !String(value).trim()) continue;
      try { target.push(resolve ? resolveXprPath(String(value).trim(), ldfPath) : String(value).trim()); }
      catch (error) { warnings.push(error.message); }
    }
  };
  const strategies = array(root.Strategy);
  for (const set of sets.filter(set => selected.has(set.name))) {
    for (const [propertyName, target, resolve] of [
      ['include path', includeDirs, true],
      ['include_path', includeDirs, true],
      ['includedirs', includeDirs, true],
      ['search_path', includeDirs, true],
      ['hdl_param', defines, false],
      ['ver_directive', defines, false],
      ['verilogdefines', defines, false],
      ['verilogdefine', defines, false],
      ['defines', defines, false],
    ]) {
      for (const value of set.props.get(propertyName) || []) {
        try { addValues(listWords(value), target, resolve); } catch (error) { warnings.push(`${set.name} ${propertyName}：${error.message}`); }
      }
    }
    const strategyNode = strategies.find(item => String(item.name || '') === set.defaultStrategy) || strategies[0];
    if (strategyNode?.file) {
      try {
        const styPath = resolveXprPath(String(strategyNode.file), ldfPath);
        if (await isFile(styPath)) {
          const styRaw = await readSource(styPath, 'auto');
          if (!/<!ENTITY\b/i.test(styRaw)) {
            const styXml = styRaw.replace(/<!DOCTYPE[^>]*>/gi, '');
            if (XMLValidator.validate(styXml) === true) {
              const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
                parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
              const styProps = latticeOptions(parser.parse(styXml).Strategy);
              for (const propName of ['prop_lst_edfinlibpath', 'prop_syn_edfinlibpath', 'prop_syn_libpath', 'prop_bd_edfinlibpath']) {
                for (const val of styProps.get(propName) || []) {
                  if (val.trim()) try { addValues(listWords(val), includeDirs, true); } catch (error) { warnings.push(`${propName}：${error.message}`); }
                }
              }
              for (const propName of ['prop_lst_hashdefine', 'prop_syn_hashdefine', 'prop_pre_hashdefine']) {
                for (const val of styProps.get(propName) || []) {
                  if (val.trim()) try { addValues(listWords(val), defines, false); } catch (error) { warnings.push(`${propName}：${error.message}`); }
                }
              }
            }
          }
        }
      } catch (error) { warnings.push(`读取策略文件失败：${error.message}`); }
    }
  }
  addValues(array(options.includeDirs), includeDirs, true);
  addValues(array(options.defines), defines, false);
  for (const file of sourceFiles.filter(file => /\.(vh|svh)$/i.test(file))) includeDirs.push(path.dirname(file));
  let activeLpf = options.primaryLpf || null;
  let activeLpfPath = options.primaryLpfPath || null;
  for (const file of files) {
    if (!file.selected || !file.enabled || !file.exists || !file.path || path.extname(file.path).toLowerCase() !== '.lpf') continue;
    if (options.primaryLpfPath && key(file.path) === key(options.primaryLpfPath) && options.primaryLpf) {
      file.lpf = options.primaryLpf;
      continue;
    }
    try {
      const lpfText = await readSource(file.path, 'auto');
      const parsed = parseLpf(lpfText);
      file.lpf = parsed;
      if (!activeLpf) { activeLpf = parsed; activeLpfPath = file.path; }
    } catch (error) {
      warnings.push(`LPF ${path.basename(file.path)}：${error.message}`);
    }
  }
  if (files.some(file => file.selected && file.enabled && isLatticeIp(file))) {
    warnings.push('Lattice IP 仅索引工程已列出的源码及精确匹配的现有 IP 模块；未启动 Diamond 展开或生成输出。');
  }
  const projectName = String(root.title || path.basename(projectPath, path.extname(projectPath)));
  const top = main.top || await inferTopFromSources(sourceFiles, activeLpf, projectName);
  const version = String(root.version || '');
  return {
    path: projectPath,
    root: projectRoot,
    name: projectName,
    part: String(root.device || ''),
    vivadoVersion: version,
    diamondVersion: version,
    projectType: 'lattice',
    ldfPath,
    lpfPath: activeLpfPath,
    lpf: activeLpf,
    top,
    filesets: sets.map(({ name, type, top: setTop }) => ({ name, type, top: setTop || top, srcSets: [] })),
    selectedFilesets: [...selected],
    files,
    sourceFiles,
    ipReferences,
    includeSimulation,
    includeDirs: unique(includeDirs),
    defines: [...new Set(defines)],
    warnings: [...new Set(warnings)],
  };
}

async function collectStandaloneHdlFiles(rootDir) {
  const skipDirs = /^(\..*|node_modules|dist|output|test-tmp|impl\d*|syntmp|synwork|synlog|backup|.*_tcr\.dir|.*\.dir)$/i;
  const discovered = [];
  async function walk(currentDir, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = await fs.readdir(currentDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.test(entry.name)) await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (HDL_EXTENSIONS.has(ext) || ext === '.vhd' || ext === '.vhdl' || ext === '.sdc') {
          discovered.push(fullPath);
        }
      }
    }
  }
  await walk(rootDir, 0);
  return discovered;
}

async function loadStandaloneLpfProject(lpfPath, parsedLpf, options = {}) {
  const projectRoot = path.dirname(lpfPath);
  const projectName = path.basename(lpfPath, path.extname(lpfPath));
  const filesetName = options.fileset || 'impl1';
  if (options.fileset && !['impl1', 'sources_1', 'impl'].includes(options.fileset)) {
    throw new Error(`找不到 fileset：${options.fileset}`);
  }
  const warnings = [];
  const includeSimulation = Boolean(options.includeSimulation);
  const discovered = await collectStandaloneHdlFiles(projectRoot);
  const files = [];
  for (const filePath of discovered) {
    const base = path.basename(filePath);
    const isSim = /^(tb_|test_|.*_tb\.)/i.test(base);
    const usedIn = isSim ? ['simulation'] : ['synthesis', 'simulation'];
    const selected = includeSimulation || usedIn.includes('synthesis');
    files.push({
      path: filePath,
      rawPath: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      fileset: filesetName,
      type: inferredType(filePath),
      exists: true,
      existence: 'exists',
      enabled: true,
      usedIn,
      library: 'work',
      generated: false,
      selected,
    });
  }
  files.push({
    path: lpfPath,
    rawPath: path.basename(lpfPath),
    fileset: filesetName,
    type: 'LPF',
    exists: true,
    existence: 'exists',
    enabled: true,
    usedIn: ['synthesis', 'simulation'],
    library: 'work',
    generated: false,
    selected: true,
    lpf: parsedLpf,
  });
  const sourceFiles = unique(files.filter(file => file.enabled && file.selected && file.exists && HDL_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map(file => file.path));
  const includeDirs = [];
  const defines = [];
  const addValues = (values, target, resolve) => {
    for (const value of values) {
      if (!value || !String(value).trim()) continue;
      try { target.push(resolve ? resolveXprPath(String(value).trim(), lpfPath) : String(value).trim()); }
      catch (error) { warnings.push(error.message); }
    }
  };
  addValues(array(options.includeDirs), includeDirs, true);
  addValues(array(options.defines), defines, false);
  for (const file of sourceFiles.filter(file => /\.(vh|svh)$/i.test(file))) includeDirs.push(path.dirname(file));
  const top = await inferTopFromSources(sourceFiles, parsedLpf, projectName);
  return {
    path: lpfPath,
    root: projectRoot,
    name: projectName,
    part: '',
    vivadoVersion: '',
    diamondVersion: '',
    projectType: 'lattice',
    ldfPath: null,
    lpfPath,
    lpf: parsedLpf,
    top,
    filesets: [{ name: filesetName, type: 'DesignSrcs', top, srcSets: [] }],
    selectedFilesets: [filesetName],
    files,
    sourceFiles,
    ipReferences: [],
    includeSimulation,
    includeDirs: unique(includeDirs),
    defines: [...new Set(defines)],
    warnings: [...new Set(warnings)],
  };
}

async function loadLatticeProject(projectPath, options = {}) {
  const ext = path.extname(projectPath).toLowerCase();
  const content = await readSource(projectPath, 'auto');
  const trimmed = content.replace(/^\uFEFF/, '').trimStart();
  if (ext === '.ldf' || trimmed.startsWith('<')) {
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(content)) throw new Error('Lattice 工程不支持 DTD 或自定义实体声明。');
    const validity = XMLValidator.validate(content);
    if (validity !== true) throw new Error(`Lattice XML 无效：${validity.err.msg}（第 ${validity.err.line} 行）`);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
      parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
    const parsed = parser.parse(content);
    if (!parsed.BaliProject) throw new Error('XML 根节点不是 Lattice BaliProject。');
    return loadBaliProject(projectPath, content, parsed.BaliProject, options);
  }
  const parsedLpf = parseLpf(content);
  const companionLdf = await findCompanionLdf(projectPath);
  if (companionLdf) {
    const ldfContent = await readSource(companionLdf, 'auto');
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(ldfContent)) throw new Error('Lattice 工程不支持 DTD 或自定义实体声明。');
    const validity = XMLValidator.validate(ldfContent);
    if (validity !== true) throw new Error(`Lattice XML 无效：${validity.err.msg}（第 ${validity.err.line} 行）`);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
      parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
    const parsed = parser.parse(ldfContent);
    if (!parsed.BaliProject) throw new Error('XML 根节点不是 Lattice BaliProject。');
    return loadBaliProject(companionLdf, ldfContent, parsed.BaliProject, {
      ...options,
      selectedProjectPath: projectPath,
      primaryLpfPath: projectPath,
      primaryLpf: parsedLpf,
    });
  }
  return loadStandaloneLpfProject(projectPath, parsedLpf, options);
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

async function loadFilelistProject(filelistPath, options = {}) {
  const projectRoot = path.dirname(filelistPath);
  const projectName = path.basename(filelistPath, path.extname(filelistPath)) || path.basename(filelistPath);
  const filesetName = options.fileset || 'sources_1';
  if (options.fileset && !['sources_1', 'impl1', 'filelist'].includes(options.fileset)) {
    throw new Error(`找不到 fileset：${options.fileset}`);
  }
  const content = await readSource(filelistPath, 'auto');
  if (/\0/.test(content)) throw new Error('Filelist 包含不支持的空字符或二进制内容。');
  const source = content.replace(/^\uFEFF/, '');
  let commentTop = '';
  const topMatch = source.match(/^\s*\/\/\s*Top:\s*([A-Za-z_][A-Za-z0-9_$]*)\s*$/m);
  if (topMatch && topMatch[1] !== 'not') commentTop = topMatch[1];

  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 1);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Filelist 中存在未闭合的块注释。');
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length && source[i + 1] === '"') {
          value += '"'; i += 2; continue;
        }
        if (source[i] === '\r' || source[i] === '\n') break;
        if (source[i] === '"') { closed = true; i++; break; }
        value += source[i++];
      }
      if (!closed) throw new Error('Filelist 中存在未闭合的引号。');
      if (value.trim()) tokens.push(value.trim());
      continue;
    }
    const start = i;
    while (i < source.length && !/[\s"]/.test(source[i]) && !source.startsWith('//', i) && !source.startsWith('/*', i)) i++;
    const token = source.slice(start, i);
    if (token) tokens.push(token);
  }

  const warnings = [];
  const includeDirs = [];
  const defines = [];
  const rawFiles = [];
  let explicitTop = '';
  const addInclude = raw => {
    if (!raw || !raw.trim()) return;
    try { includeDirs.push(resolveXprPath(raw.trim(), filelistPath)); }
    catch (error) { warnings.push(error.message); }
  };
  const valueFlags = new Set(['--error-limit', '-timescale', '--timescale', '-work', '--work', '-L']);
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.startsWith('+incdir+')) {
      for (const dir of tok.slice('+incdir+'.length).split('+').filter(Boolean)) addInclude(dir);
    } else if (tok.startsWith('+define+')) {
      for (const def of tok.slice('+define+'.length).split('+').filter(Boolean)) defines.push(def);
    } else if (tok === '-I' || tok === '--incdir' || tok === '-incdir' || tok === '-y') {
      if (tokens[idx + 1]) addInclude(tokens[++idx]);
    } else if (tok.startsWith('-I') && tok.length > 2) {
      addInclude(tok.slice(2));
    } else if (tok === '-D' || tok === '--define' || tok === '-define') {
      if (tokens[idx + 1]) defines.push(tokens[++idx]);
    } else if (tok.startsWith('-D') && tok.length > 2) {
      defines.push(tok.slice(2));
    } else if (tok === '--top' || tok === '-top') {
      if (tokens[idx + 1]) explicitTop = tokens[++idx];
    } else if (tok === '-v') {
      if (tokens[idx + 1]) rawFiles.push(tokens[++idx]);
    } else if (valueFlags.has(tok)) {
      idx++;
    } else if (tok.startsWith('-') || tok.startsWith('+')) {
      continue;
    } else {
      rawFiles.push(tok);
    }
  }

  const includeSimulation = Boolean(options.includeSimulation);
  const files = [];
  for (const rawPath of rawFiles) {
    let resolved = null;
    try { resolved = resolveXprPath(rawPath, filelistPath); }
    catch (error) { warnings.push(`${filesetName}：${error.message}`); }
    files.push({
      path: resolved,
      rawPath,
      fileset: filesetName,
      type: inferredType(rawPath),
      exists: false,
      existence: 'unknown',
      enabled: true,
      usedIn: ['synthesis', 'simulation'],
      library: 'work',
      generated: false,
      selected: true,
    });
  }
  await Promise.all(files.map(async file => {
    if (file.path) {
      try { file.exists = await isFile(file.path); file.existence = file.exists ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查文件 ${file.path}：${error.message}`); }
    }
    if (file.path && !file.exists && file.enabled && file.selected) warnings.push(`工程文件不存在：${file.path}`);
  }));
  const sourceFiles = unique(files.filter(file => file.enabled && file.selected && file.exists && HDL_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map(file => file.path));
  for (const dir of array(options.includeDirs)) addInclude(String(dir));
  for (const def of array(options.defines)) if (def && String(def).trim()) defines.push(String(def).trim());
  for (const file of sourceFiles.filter(file => /\.(vh|svh)$/i.test(file))) includeDirs.push(path.dirname(file));
  const top = explicitTop || commentTop || await inferTopFromSources(sourceFiles, null, projectName);
  return {
    path: filelistPath,
    root: projectRoot,
    name: projectName,
    part: '',
    vivadoVersion: '',
    projectType: 'filelist',
    top,
    filesets: [{ name: filesetName, type: 'DesignSrcs', top, srcSets: [] }],
    selectedFilesets: [filesetName],
    files,
    sourceFiles,
    ipReferences: [],
    includeSimulation,
    includeDirs: unique(includeDirs),
    defines: [...new Set(defines)],
    warnings: [...new Set(warnings)],
  };
}

/** Read a project without launching Vivado/Diamond or modifying any project file. */
async function loadProject(xprPath, options = {}) {
  const projectPath = path.resolve(xprPath);
  const ext = path.extname(projectPath).toLowerCase();
  if (ext === '.lpf' || ext === '.ldf') return loadLatticeProject(projectPath, options);
  if (ext !== '.xpr') return loadFilelistProject(projectPath, options);
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
    ...(project.projectType === 'lattice' ? [
      `// Lattice LDF: ${slash(project.ldfPath)}`,
      `// Lattice LPF: ${slash(project.lpfPath)}`,
      ...(project.lpf ? [`// LPF constraints: locates ${project.lpf.locates.length}; iobufs ${project.lpf.iobufs.length}; frequencies ${project.lpf.frequencies.length}`] : []),
    ] : []),
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

module.exports = { loadProject, resolveXprPath, filelist, parseLpf };
