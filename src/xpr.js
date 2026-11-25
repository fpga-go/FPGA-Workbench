'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { readSource } = require('./encoding');
const { HdlIndex } = require('./indexer');

const HDL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);
const LATTICE_IP_EXTENSIONS = new Set(['.ipx', '.sbx', '.lpc']);
const LIBERO_IP_EXTENSIONS = new Set(['.cxf', '.sbx', '.cxz', '.ccz']);
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
    '.pdc': 'PDC', '.fdc': 'FDC', '.ndc': 'NDC', '.gcf': 'GCF',
    '.xci': 'IP', '.xcix': 'IP Core Container', '.bd': 'Block Design',
    '.ipx': 'IP', '.sbx': 'IP', '.lpc': 'IP', '.cxf': 'IP', '.cxz': 'IP', '.ccz': 'IP' })[path.extname(file).toLowerCase()] || 'File';
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

/** Read a project without launching Vivado/Diamond/Libero or modifying any project file. */
function splitLiberoFileValue(rawValue) {
  const text = String(rawValue || '').trim();
  const comma = text.lastIndexOf(',');
  if (comma > 0 && /^[A-Za-z0-9_]+$/.test(text.slice(comma + 1))) {
    return { rawPath: text.slice(0, comma).trim(), fileKind: text.slice(comma + 1).toLowerCase() };
  }
  return { rawPath: text, fileKind: '' };
}

function parseQuotedCsv(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /[\s,]/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length && line[i + 1] === '"') { val += '"'; i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        val += line[i++];
      }
      fields.push(val);
    } else {
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      fields.push(line.slice(start, i).trim());
    }
  }
  return fields;
}

/** Parse a Microsemi / Microchip Libero Physical Design Constraints (.pdc) file. */
function parsePdc(text) {
  if (typeof text !== 'string' || /\0/.test(text)) throw new Error('PDC 包含不支持的空字符或二进制内容。');
  const source = text.replace(/^\uFEFF/, '');
  if (/^\s*</.test(source)) throw new Error('PDC 语法无效：检测到 XML 标签。');
  let headerDie = '';
  const dieMatch = source.match(/^\s*#\s*Family\s*:\s*[^,\r\n]+\s*,\s*Die\s*:\s*([^\s,\r\n]+)/im);
  if (dieMatch) headerDie = dieMatch[1].trim();
  const joined = source.replace(/\\\r?\n/g, ' ');
  const ios = [];
  const iobanks = [];
  const ports = [];
  for (const rawLine of joined.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const commentIdx = trimmed.indexOf(' #');
    const clean = (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim();
    if (!clean) continue;
    let tokens;
    try { tokens = listWords(clean); } catch { continue; }
    if (!tokens.length) continue;
    const cmd = tokens[0].toLowerCase();
    if (cmd === 'set_io') {
      const attributes = {};
      let port = '';
      let idx = 1;
      if (tokens[idx] && !tokens[idx].startsWith('-')) port = tokens[idx++];
      while (idx < tokens.length) {
        const flag = tokens[idx];
        if (flag.startsWith('-') && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
          const flagName = flag.slice(1).toLowerCase();
          attributes[flagName] = tokens[idx + 1];
          idx += 2;
        } else {
          attributes[flag.replace(/^-/, '').toLowerCase()] = 'true';
          idx++;
        }
      }
      if (!port) port = attributes.port_name || attributes.portname || '';
      const pin = attributes.pinname || attributes.pin_name || '';
      const iostd = attributes.iostd || attributes.io_std || '';
      if (port) {
        ios.push({ port, pin, iostd, attributes, raw: clean });
        ports.push(port.replace(/\[.*$/, ''));
      }
    } else if (cmd === 'set_iobank') {
      const attributes = {};
      let bank = '';
      let idx = 1;
      if (tokens[idx] && !tokens[idx].startsWith('-')) bank = tokens[idx++];
      while (idx < tokens.length) {
        const flag = tokens[idx];
        if (flag.startsWith('-') && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
          attributes[flag.slice(1).toLowerCase()] = tokens[idx + 1];
          idx += 2;
        } else idx++;
      }
      if (!bank) bank = attributes.bank_name || attributes.bankname || '';
      if (bank) iobanks.push({ bank, vcci: attributes.vcci || '', attributes, raw: clean });
    }
  }
  return { ios, iobanks, ports: [...new Set(ports.filter(Boolean))], headerDie };
}

/** Parse a Microsemi / Microchip Libero (.prjx) project file without running Libero. */
function parsePrjx(text) {
  if (typeof text !== 'string' || /\0/.test(text)) throw new Error('PRJX 包含不支持的空字符或二进制内容。');
  const source = text.replace(/^\uFEFF/, '');
  if (/^\s*</.test(source)) throw new Error('PRJX 语法无效：检测到 XML 标签。');
  const keys = new Map();
  const rootLists = [];
  const stack = [];
  let currentFile = null;
  let sawDirective = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const keyMatch = !stack.length && line.match(/^KEY\s+([^\s"]+)\s+"((?:\\.|[^"])*)"$/);
    if (keyMatch) {
      sawDirective = true;
      keys.set(keyMatch[1].toLowerCase(), keyMatch[2].replace(/\\"/g, '"'));
      continue;
    }
    if (/^LIST(?:\s+|$)/.test(line)) {
      sawDirective = true;
      const header = line.slice(4).trim();
      const node = { header, lines: [], files: [], children: [] };
      if (stack.length) stack.at(-1).children.push(node);
      else rootLists.push(node);
      stack.push(node);
      continue;
    }
    if (line === 'ENDLIST') {
      if (!stack.length) throw new Error('PRJX 语法无效：存在多余的 ENDLIST。');
      if (currentFile && stack.at(-1).header === 'FileManager') {
        throw new Error('PRJX FileManager 中存在未闭合的 VALUE 条目（缺少 ENDFILE）。');
      }
      stack.pop();
      continue;
    }
    if (!stack.length) continue;
    const topList = stack.at(-1);
    if (topList.header === 'FileManager') {
      const valMatch = line.match(/^VALUE\s+"((?:\\.|[^"])*)"$/);
      if (valMatch) {
        if (currentFile) throw new Error('PRJX FileManager 中存在嵌套或未闭合的 VALUE 条目。');
        const { rawPath, fileKind } = splitLiberoFileValue(valMatch[1].replace(/\\"/g, '"'));
        currentFile = { rawValue: valMatch[1], rawPath, fileKind, props: new Map() };
        continue;
      }
      if (line === 'ENDFILE') {
        if (!currentFile) throw new Error('PRJX FileManager 中存在多余的 ENDFILE。');
        topList.files.push(currentFile);
        currentFile = null;
        continue;
      }
      if (currentFile) {
        const eqMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*"((?:\\.|[^"])*)"$/);
        const spMatch = !eqMatch && line.match(/^([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"$/);
        const m = eqMatch || spMatch;
        if (m) currentFile.props.set(m[1].toLowerCase(), m[2].replace(/\\"/g, '"'));
        continue;
      }
    }
    topList.lines.push(line);
  }
  if (stack.length) throw new Error(`PRJX 中存在未闭合的 LIST 块：${stack.at(-1).header}`);
  if (!sawDirective || (!keys.has('libero') && !rootLists.some(item => item.header === 'FileManager' || item.header === 'REVISIONS'))) {
    throw new Error('PRJX 语法无效：未检测到 Libero 工程结构。');
  }
  const revisions = [];
  let curRev = '';
  for (const revList of rootLists.filter(item => item.header === 'REVISIONS')) {
    for (const line of revList.lines) {
      const revMatch = line.match(/^VALUE\s*=\s*"([^"]+)"\s*,\s*NUM\s*=\s*(\d+)$/i);
      if (revMatch) revisions.push({ name: revMatch[1].trim(), num: revMatch[2] });
      const curMatch = line.match(/^CURREV\s*=\s*(\d+)$/i);
      if (curMatch) curRev = curMatch[1];
    }
  }
  const collectValues = listNode => {
    const out = [];
    const walk = node => {
      for (const l of node.lines) {
        const m = l.match(/^(?:VALUE|FILE)\s+"((?:\\.|[^"])*)"$/i);
        if (m) out.push(m[1].replace(/\\"/g, '"'));
      }
      for (const child of node.children) walk(child);
    };
    if (listNode) walk(listNode);
    return out;
  };
  const findRoot = name => rootLists.find(item => item.header === name);
  const fileManager = findRoot('FileManager')?.files || [];
  const stimulusValues = [
    ...collectValues(findRoot('AssociatedStimulus')),
    ...collectValues(findRoot('IncludeModuleForSimulation')),
    ...collectValues(findRoot('ActiveTestBenchList')),
  ];
  const simOnlyValues = collectValues(findRoot('ExcludePackageForSynthesis'));
  const synOnlyValues = collectValues(findRoot('ExcludePackageForSimulation'));
  const subBlocks = [];
  for (const child of findRoot('ModuleSubBlockList')?.children || []) {
    const fields = parseQuotedCsv(child.header);
    if (fields.length >= 2) {
      subBlocks.push({
        moduleSpec: fields[0],
        rawPath: fields[1],
        isCore: truth(fields[2]),
        isTestbench: truth(fields[3]),
      });
    }
  }
  const newModuleFiles = collectValues(findRoot('NewModulesInfo'));
  return { keys, revisions, curRev, fileManager, stimulusValues, simOnlyValues, synOnlyValues, subBlocks, newModuleFiles };
}

function resolveLiberoCandidatePaths(raw, prjxPath, recordedProjectLocation) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('PRJX 路径为空。');
  if (/[\0\r\n]/.test(raw)) throw new Error(`PRJX 路径包含不支持的控制字符：${JSON.stringify(raw)}`);
  const winProject = /^[a-z]:[\\/]/i.test(prjxPath) || /^\\\\/.test(prjxPath);
  const api = winProject ? path.win32 : path;
  const projectRoot = api.dirname(api.resolve(prjxPath));
  const trimmed = raw.trim();
  const projectToken = trimmed.match(/^<project>(?:[\\/](.*))?$/i);
  if (projectToken) {
    const suffix = (projectToken[1] || '').replace(/\\/g, '/');
    return [api.resolve(projectRoot, suffix)];
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (/^[a-z]:[^/]/i.test(normalized)) throw new Error(`不支持依赖当前盘目录的路径：${raw}`);
  const isWinAbs = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  const isPosixAbs = normalized.startsWith('/') && !normalized.startsWith('//');
  if (!isWinAbs && !isPosixAbs) {
    return [api.resolve(projectRoot, normalized)];
  }
  let rebased = null;
  if (isWinAbs && recordedProjectLocation && (/^[a-z]:[\\/]/i.test(recordedProjectLocation) || /^\\\\/.test(recordedProjectLocation))) {
    const oldRoot = path.win32.resolve(recordedProjectLocation.replace(/\\/g, '/'));
    const targetWin = path.win32.resolve(normalized);
    const rel = path.win32.relative(oldRoot, targetWin);
    if (rel === '') rebased = projectRoot;
    else if (!path.win32.isAbsolute(rel)) rebased = api.resolve(projectRoot, rel.replace(/\\/g, '/'));
  } else if (isPosixAbs && recordedProjectLocation?.startsWith('/')) {
    const oldRoot = path.posix.resolve(recordedProjectLocation);
    const rel = path.posix.relative(oldRoot, path.posix.resolve(normalized));
    if (rel === '') rebased = projectRoot;
    else if (!path.posix.isAbsolute(rel)) rebased = api.resolve(projectRoot, rel);
  }
  const direct = isWinAbs ? (winProject ? path.win32.resolve(normalized) : null) : (!winProject ? path.resolve(normalized) : null);
  const candidates = unique([rebased, direct].filter(Boolean));
  if (!candidates.length) throw new Error(`当前平台无法访问绝对路径：${raw}`);
  return candidates;
}

async function resolveLiberoPath(raw, prjxPath, recordedProjectLocation) {
  const candidates = resolveLiberoCandidatePaths(raw, prjxPath, recordedProjectLocation);
  if (candidates.length === 1) return candidates[0];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return candidates[0];
}

async function candidateLiberoIpFiles(cxfPath) {
  const dir = path.dirname(cxfPath);
  const stem = path.basename(cxfPath, path.extname(cxfPath));
  const stubs = [];
  if (path.extname(cxfPath).toLowerCase() === '.cxf' && await isFile(cxfPath)) {
    try {
      const xml = await readSource(cxfPath, 'auto');
      if (!/<!DOCTYPE\b|<!ENTITY\b/i.test(xml) && XMLValidator.validate(xml) === true) {
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
          parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
        const comp = parser.parse(xml).Component;
        for (const fset of array(comp?.fileSets?.fileSet)) {
          const fsetId = String(fset?.fileSetId || '').toUpperCase();
          if (fsetId && !fsetId.includes('HDL')) continue;
          for (const f of array(fset?.file)) {
            const name = String(f?.name || '').trim();
            const ftype = String(f?.fileType || '').toLowerCase();
            if (!name) continue;
            const ext = path.extname(name).toLowerCase();
            if (HDL_EXTENSIONS.has(ext) || /verilog/i.test(ftype)) {
              stubs.push(path.resolve(dir, name.replace(/\\/g, '/')));
            }
          }
        }
      }
    } catch (_) {}
  }
  stubs.push(path.join(dir, `${stem}.v`), path.join(dir, `${stem}.sv`));
  const netlist = path.join(dir, `${stem}_sim_netlist.v`);
  return { stubs: unique(stubs), netlist };
}

async function readSynplifyOptions(synPrjPaths, prjxPath, recordedProjectLocation) {
  const result = { part: '', top: '', includeDirs: [], defines: [] };
  for (const synPath of synPrjPaths) {
    if (!synPath || !await isFile(synPath)) continue;
    let content = '';
    try { content = await readSource(synPath, 'auto'); } catch { continue; }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('set_option') && !line.startsWith('hdl_param')) continue;
      let words;
      try { words = listWords(line); } catch { continue; }
      if (words[0] === 'set_option') {
        const opt = words[1];
        const val = words[2] === '-set' ? words[3] : words[2];
        if (opt === '-part' && val && !result.part) result.part = val;
        else if (opt === '-top_module' && val && !result.top) result.top = val.replace(/::.*$/, '');
        else if (opt === '-include_path' && val) {
          for (const part of val.split(/[;]+/).map(s => s.trim()).filter(Boolean)) {
            try { result.includeDirs.push(await resolveLiberoPath(part, prjxPath, recordedProjectLocation)); } catch (_) {}
          }
        } else if ((opt === '-hdl_define' || opt === '-vlog_define') && val) {
          try { result.defines.push(...listWords(val)); } catch { result.defines.push(val); }
        }
      } else if (words[0] === 'hdl_param' && words[1] === '-set' && words[2]) {
        result.defines.push(words[3] !== undefined ? `${words[2]}=${words[3]}` : words[2]);
      }
    }
  }
  return result;
}

function liberoFileType(rawPath, fileKind) {
  const inferred = inferredType(rawPath);
  if (inferred !== 'File') return inferred;
  if (['actgen_cxf', 'sd_cxf', 'cxf', 'sbx', 'cxz', 'ccz'].includes(fileKind)) return 'IP';
  if (fileKind === 'pdc' || fileKind === 'io_pdc' || fileKind === 'fp_pdc') return 'PDC';
  if (fileKind === 'sdc') return 'SDC';
  if (fileKind === 'fdc') return 'FDC';
  if (fileKind === 'ndc') return 'NDC';
  if (['hdl', 'tb_hdl', 'stimulus', 'sim_hdl'].includes(fileKind)) return 'Verilog';
  return fileKind || 'File';
}

async function loadLiberoProject(prjxPath, options = {}) {
  const projectRoot = path.dirname(prjxPath);
  const projectName = path.basename(prjxPath, path.extname(prjxPath));
  const content = await readSource(prjxPath, 'auto');
  const parsed = parsePrjx(content);
  const warnings = [];
  const recordedLocation = parsed.keys.get('projectlocation') || '';
  const liberoVersion = parsed.keys.get('libero') || parsed.keys.get('capture') || '';
  const activeRootRaw = parsed.keys.get('activeroot') || '';
  const activeRootTop = activeRootRaw ? activeRootRaw.split('::')[0].trim() : '';

  const sets = parsed.revisions.length
    ? parsed.revisions.map(rev => ({ name: rev.name, num: rev.num, type: 'DesignSrcs', top: activeRootTop }))
    : [{ name: 'Impl1', num: '1', type: 'DesignSrcs', top: activeRootTop }];
  if (new Set(sets.map(set => set.name)).size !== sets.length || sets.some(set => !set.name)) {
    throw new Error('Libero 工程 Revision 名称为空或重复。');
  }
  const byName = new Map(sets.map(set => [set.name, set]));
  const defaultRev = sets.find(set => set.num === parsed.curRev) || sets[0];
  const main = options.fileset ? byName.get(options.fileset) : defaultRev;
  if (!main) throw new Error(`找不到 fileset：${options.fileset}`);
  const selected = new Set([main.name]);
  const includeSimulation = Boolean(options.includeSimulation);

  const resolveSetPaths = async rawList => {
    const resolvedSet = new Set();
    for (const rawItem of rawList) {
      const { rawPath } = splitLiberoFileValue(rawItem);
      if (!rawPath) continue;
      try { resolvedSet.add(key(await resolveLiberoPath(rawPath, prjxPath, recordedLocation))); } catch (_) {}
    }
    return resolvedSet;
  };
  const stimulusSet = await resolveSetPaths(parsed.stimulusValues);
  const simOnlySet = await resolveSetPaths(parsed.simOnlyValues);
  const synOnlySet = await resolveSetPaths(parsed.synOnlyValues);
  for (const sb of parsed.subBlocks) {
    if (sb.isTestbench && sb.rawPath) {
      try { stimulusSet.add(key(await resolveLiberoPath(sb.rawPath, prjxPath, recordedLocation))); } catch (_) {}
    }
  }

  const designKinds = new Set([
    'hdl', 'tb_hdl', 'stimulus', 'sim_hdl', 'verilog', 'vhdl', 'systemverilog',
    'actgen_cxf', 'sd_cxf', 'cxf', 'sbx', 'cxz', 'ccz',
    'pdc', 'io_pdc', 'fp_pdc', 'sdc', 'fdc', 'ndc', 'gcf',
  ]);
  const synPrjPaths = [];
  const rawEntries = [];
  for (const entry of parsed.fileManager) {
    if (entry.fileKind === 'prj') {
      try { synPrjPaths.push(await resolveLiberoPath(entry.rawPath, prjxPath, recordedLocation)); } catch (_) {}
      continue;
    }
    const ext = path.extname(entry.rawPath).toLowerCase();
    const relevant = entry.fileKind ? designKinds.has(entry.fileKind)
      : (HDL_EXTENSIONS.has(ext) || ['.vhd', '.vhdl', '.pdc', '.sdc', '.fdc', '.ndc', '.gcf', '.cxf', '.sbx'].includes(ext));
    if (!relevant) continue;
    rawEntries.push(entry);
  }
  if (!rawEntries.length) {
    const fallbackValues = [
      ...parsed.newModuleFiles,
      ...parsed.subBlocks.map(sb => `${sb.rawPath},${LIBERO_IP_EXTENSIONS.has(path.extname(sb.rawPath).toLowerCase()) ? 'actgen_cxf' : sb.isTestbench ? 'tb_hdl' : 'hdl'}`),
    ];
    const seenRaw = new Set();
    for (const val of fallbackValues) {
      const { rawPath, fileKind } = splitLiberoFileValue(val);
      if (!rawPath || seenRaw.has(rawPath.toLowerCase())) continue;
      seenRaw.add(rawPath.toLowerCase());
      rawEntries.push({ rawPath, fileKind, props: new Map() });
    }
  }

  const files = [];
  const seenFileKeys = new Set();
  for (const entry of rawEntries) {
    let resolved = null;
    try { resolved = await resolveLiberoPath(entry.rawPath, prjxPath, recordedLocation); }
    catch (error) { warnings.push(`${main.name}：${error.message}`); }
    if (resolved) {
      const fKey = key(resolved);
      if (seenFileKeys.has(fKey)) continue;
      seenFileKeys.add(fKey);
    }
    const disabled = [entry.props.get('disabled'), entry.props.get('is_disabled'), entry.props.get('excluded')].filter(Boolean).some(truth);
    const enabled = !disabled;
    const relToRoot = resolved ? path.relative(projectRoot, resolved).replace(/\\/g, '/') : '';
    const inStimulusDir = /^stimulus(\/|$)/i.test(relToRoot) || /^<project>[\\/]stimulus[\\/]/i.test(entry.rawPath);
    const isSimOnly = ['tb_hdl', 'stimulus', 'sim_hdl'].includes(entry.fileKind)
      || truth(entry.props.get('simulation_only'))
      || inStimulusDir
      || Boolean(resolved && (stimulusSet.has(key(resolved)) || simOnlySet.has(key(resolved))));
    const isSynOnly = Boolean(resolved && synOnlySet.has(key(resolved)));
    const usedIn = isSimOnly ? ['simulation'] : isSynOnly ? ['synthesis'] : ['synthesis', 'simulation'];
    const sourcePurpose = includeSimulation || usedIn.includes('synthesis');

    let parentOrigin;
    const rawParent = entry.props.get('parent');
    if (rawParent) {
      try { parentOrigin = await resolveLiberoPath(rawParent, prjxPath, recordedLocation); } catch (_) {}
    }
    const isGeneratedStub = Boolean(parentOrigin && LIBERO_IP_EXTENSIONS.has(path.extname(parentOrigin).toLowerCase()) && HDL_EXTENSIONS.has(path.extname(entry.rawPath).toLowerCase()));
    files.push({
      path: resolved,
      rawPath: entry.rawPath,
      fileset: main.name,
      type: isGeneratedStub ? 'Verilog IP Stub' : liberoFileType(entry.rawPath, entry.fileKind),
      exists: false,
      existence: 'unknown',
      enabled,
      usedIn,
      library: 'work',
      generated: isGeneratedStub,
      ...(parentOrigin ? { origin: parentOrigin } : {}),
      selected: selected.has(main.name) && sourcePurpose,
    });
  }

  await Promise.all(files.map(async file => {
    if (file.path) {
      try { file.exists = await isFile(file.path); file.existence = file.exists ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查文件 ${file.path}：${error.message}`); }
    }
    if (file.path && !file.exists && file.enabled && file.selected) warnings.push(`工程文件不存在：${file.path}`);
  }));

  const isLiberoIp = file => LIBERO_IP_EXTENSIONS.has(path.extname(file.path || file.rawPath).toLowerCase());
  if (options.includeIpStubs !== false) {
    const seenIp = new Set();
    const known = new Set(files.filter(file => file.path && file.enabled && file.selected).map(file => key(file.path)));
    const coveredOrigins = new Set(files.filter(file => file.generated && file.origin && file.enabled && file.selected && file.exists).map(file => key(file.origin)));
    for (const file of [...files]) {
      if (!file.selected || !file.enabled || !file.exists || !isLiberoIp(file)) continue;
      const ipKey = key(file.path);
      if (seenIp.has(ipKey) || coveredOrigins.has(ipKey)) continue;
      seenIp.add(ipKey);
      const { stubs } = await candidateLiberoIpFiles(file.path);
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
    if (!file.selected || !file.enabled || !isLiberoIp(file)) continue;
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
      const { stubs, netlist } = await candidateLiberoIpFiles(file.path);
      const childStubs = files.filter(f => f.generated && f.origin && f.path && key(f.origin) === key(file.path)).map(f => f.path);
      reference.netlistPath = netlist;
      reference.artifactPaths = unique([...childStubs, ...stubs, netlist]);
      try { reference.netlistExistence = await isFile(reference.netlistPath) ? 'exists' : 'missing'; }
      catch (error) { warnings.push(`无法检查 IP 仿真网表候选路径 ${reference.netlistPath}：${error.message}`); }
    }
    seenReferences.set(identity, reference);
    ipReferences.push(reference);
  }

  let activePdc = null;
  let activePdcPath = null;
  for (const file of files) {
    if (!file.selected || !file.enabled || !file.exists || !file.path || path.extname(file.path).toLowerCase() !== '.pdc') continue;
    try {
      const pdcText = await readSource(file.path, 'auto');
      const parsedPdc = parsePdc(pdcText);
      file.pdc = parsedPdc;
      if (!activePdc) { activePdc = parsedPdc; activePdcPath = file.path; }
    } catch (error) {
      warnings.push(`PDC ${path.basename(file.path)}：${error.message}`);
    }
  }

  if (!synPrjPaths.length && activeRootTop) {
    const candidateSyn = path.join(projectRoot, 'synthesis', `${activeRootTop}_syn.prj`);
    if (await isFile(candidateSyn)) synPrjPaths.push(candidateSyn);
  }
  const synOpts = await readSynplifyOptions(synPrjPaths, prjxPath, recordedLocation);

  const sourceFiles = unique(files.filter(file => file.enabled && file.selected && file.exists && HDL_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map(file => file.path));
  const includeDirs = [...synOpts.includeDirs];
  const defines = [...synOpts.defines];
  for (const dir of array(options.includeDirs)) {
    if (!dir || !String(dir).trim()) continue;
    try { includeDirs.push(resolveXprPath(String(dir).trim(), prjxPath)); }
    catch (error) { warnings.push(error.message); }
  }
  for (const def of array(options.defines)) {
    if (def && String(def).trim()) defines.push(String(def).trim());
  }
  for (const file of sourceFiles.filter(file => /\.(vh|svh)$/i.test(file))) includeDirs.push(path.dirname(file));

  if (files.some(file => file.selected && file.enabled && isLiberoIp(file))) {
    warnings.push('Libero IP/SmartGen 仅索引工程已列出的源码及精确匹配的现有生成模块；未启动 Libero 展开或生成输出。');
  }

  const family = parsed.keys.get('vendortechnology_family') || '';
  const die = synOpts.part || activePdc?.headerDie || parsed.keys.get('vendortechnology_die') || '';
  const pkg = parsed.keys.get('vendortechnology_package') || '';
  const speed = parsed.keys.get('vendortechnology_speed') || '';
  const part = [family, [die, pkg].filter(Boolean).join('-'), speed.replace(/^-/, '') ? speed : '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+-/g, '-');

  const top = activeRootTop || synOpts.top || await inferTopFromSources(
    sourceFiles,
    activePdc?.ports?.length ? { ports: activePdc.ports } : null,
    projectName
  );

  return {
    path: prjxPath,
    root: projectRoot,
    name: projectName,
    part,
    vivadoVersion: liberoVersion,
    liberoVersion,
    projectType: 'libero',
    prjxPath,
    pdcPath: activePdcPath,
    pdc: activePdc,
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

async function loadProject(xprPath, options = {}) {
  const projectPath = path.resolve(xprPath);
  const ext = path.extname(projectPath).toLowerCase();
  if (ext === '.lpf' || ext === '.ldf') return loadLatticeProject(projectPath, options);
  if (ext === '.prjx') return loadLiberoProject(projectPath, options);
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
    ...(project.projectType === 'libero' ? [
      `// Libero PRJX: ${slash(project.prjxPath || project.path)}`,
      `// Libero PDC: ${slash(project.pdcPath)}`,
      ...(project.pdc ? [`// PDC constraints: ios ${project.pdc.ios.length}; iobanks ${project.pdc.iobanks.length}`] : []),
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

module.exports = { loadProject, resolveXprPath, resolveLiberoPath, filelist, parseLpf, parsePdc, parsePrjx };
