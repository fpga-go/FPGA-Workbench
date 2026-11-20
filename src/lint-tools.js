'use strict';

const path = require('node:path');

const BACKENDS = Object.freeze({ iverilog: 'iverilog', modelsim: 'vlog', xsim: 'xvlog' });
const windowsPath = value => /^(?:[a-z]:[\\/]|\\\\)/i.test(value);
const pathApi = value => windowsPath(value) ? path.win32 : path;
const clean = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}不能为空或包含控制字符。`);
  }
  return value;
};
function absolute(value, cwd, label) {
  clean(value, label);
  return windowsPath(value) ? path.win32.normalize(value) : pathApi(cwd).resolve(cwd, value);
}
function unique(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = windowsPath(value) || process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function siblingExecutable(executable, name) {
  const api = pathApi(executable);
  const extension = /\.(?:exe|cmd|bat)$/i.exec(executable)?.[0] || '';
  return /[\\/]/.test(executable) ? api.join(api.dirname(executable), name + extension) : name + extension;
}

/** Build argv only. The caller owns executable lookup, processes and temporary directories. */
function buildLintPlan(options = {}) {
  const backend = options.backend || 'iverilog';
  if (!Object.hasOwn(BACKENDS, backend)) throw new Error('不支持此语法检查工具。');
  const cwd = absolute(options.cwd || process.cwd(), process.cwd(), '工程目录');
  const workDir = clean(options.workDir, '临时目录');
  if (!(path.isAbsolute(workDir) || windowsPath(workDir))) throw new Error('临时目录必须使用绝对路径。');
  const work = absolute(workDir, cwd, '临时目录');
  if (work === cwd) throw new Error('临时目录不能使用工程根目录。');
  const executable = clean(options.executable || BACKENDS[backend], '工具路径');
  const inputFiles = unique((options.files || []).map(file => absolute(file, cwd, '源文件路径')));
  const files = inputFiles.filter(file => /\.(?:v|sv|vhd|vhdl)$/i.test(file));
  if (!files.length) throw new Error('没有可检查的 Verilog、SystemVerilog 或 VHDL 源文件。');
  const identity = file => windowsPath(file) || process.platform === 'win32' ? file.toLowerCase() : file;
  const metadata = new Map();
  for (const entry of options.sourceEntries || []) {
    const file = absolute(entry.path, cwd, '源文件路径');
    if (!files.some(candidate => identity(candidate) === identity(file))) continue;
    const library = clean(entry.library || 'work', '逻辑库名称');
    // Logical names also become directory names beneath the private work directory.
    if (!/^[a-z][a-z0-9_]*$/i.test(library)) throw new Error('逻辑库名称必须以字母开头，只能包含字母、数字和下划线。');
    const value = { library: library.toLowerCase(), vhdl2008: /2008/.test(entry.type || '') };
    const previous = metadata.get(identity(file));
    if (previous && (previous.library !== value.library || previous.vhdl2008 !== value.vhdl2008)) {
      throw new Error(`源文件的逻辑库或语言版本不一致：${file}`);
    }
    metadata.set(identity(file), value);
  }
  const entries = files.map(file => ({ path: file, vhdl: /\.vhdl?$/i.test(file),
    library: 'work', vhdl2008: false, ...metadata.get(identity(file)) }));
  const hasVhdl = entries.some(entry => entry.vhdl);
  // Merge adjacent compatible inputs only. Regrouping by language or library would
  // move a package behind its consumer and change the order supplied by the XPR.
  const groups = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (previous && previous.vhdl === entry.vhdl && previous.library === entry.library && previous.vhdl2008 === entry.vhdl2008) {
      previous.files.push(entry.path);
    } else groups.push({ ...entry, files: [entry.path] });
  }
  // Compilers run outside the project. Preserve its default include root and header locations.
  const includes = unique([cwd, ...(options.includeDirs || []).map(dir => absolute(dir, cwd, '头文件目录')),
    ...inputFiles.map(file => pathApi(file).dirname(file))]);
  const defines = [...new Set((options.defines || []).map(value => {
    clean(value, '宏定义');
    if (!/^[a-z_$][\w$]*(?:=.*)?$/i.test(value)) throw new Error('宏定义必须使用 NAME 或 NAME=VALUE 格式。');
    return value;
  }))];
  const step = (command, args) => ({ executable: command, args, cwd: work });

  if (backend === 'iverilog') {
    if (hasVhdl) {
      const error = new Error('Icarus Verilog 不支持 VHDL。请选择 Vivado 或 ModelSim。');
      error.code = 'LINT_LANGUAGE_UNSUPPORTED';
      throw error;
    }
    return {
      steps: [step(executable, ['-g2012', '-Wall', ...(options.ignoreTimescaleWarnings === false ? [] : ['-Wno-timescale']), '-i', '-tnull',
        ...includes.flatMap(dir => ['-I', dir]), ...defines.flatMap(value => ['-D', value]), ...files])],
      notes: ['Icarus Verilog 需要 11.0 或更新版本。', '检查忽略缺失模块，不验证 IP 内部逻辑。']
    };
  }
  if (backend === 'modelsim') {
    // ModelSim interprets '+' inside these argv values as another directory/definition.
    // Reject that ambiguity rather than silently checking a different design.
    if (entries.some(entry => !entry.vhdl) && [...includes, ...defines].some(value => value.includes('+'))) {
      throw new Error('ModelSim 的头文件路径或宏定义不能包含加号。');
    }
    const libraries = unique(entries.map(entry => entry.library));
    const mapped = hasVhdl || libraries.some(library => library !== 'work');
    if (mapped) {
      const ini = pathApi(work).join(work, 'modelsim.ini');
      const vmap = clean(options.mapExecutable || siblingExecutable(executable, 'vmap'), '工具路径');
      const vcom = clean(options.vhdlExecutable || siblingExecutable(executable, 'vcom'), '工具路径');
      const vlib = clean(options.libraryExecutable || siblingExecutable(executable, 'vlib'), '工具路径');
      const steps = [step(vmap, ['-c'])];
      for (const library of libraries) {
        const directory = pathApi(work).join(work, library);
        steps.push(step(vlib, [directory]),
          step(vmap, ['-modelsimini', ini, library, directory]));
      }
      for (const group of groups) {
        steps.push(step(group.vhdl ? vcom : executable, ['-nologo', '-modelsimini', ini,
          ...(group.vhdl ? [group.vhdl2008 ? '-2008' : '-93'] : ['-sv']), '-lint', '-work', group.library,
          ...(group.vhdl ? [] : [...includes.map(dir => '+incdir+' + dir), ...defines.map(value => '+define+' + value)]),
          ...group.files]));
      }
      return { steps, notes: ['ModelSim 仅编译并检查源码，不启动仿真。',
        '文件按清单顺序编译。此顺序不是 Vivado 展开后的编译顺序。'] };
    }
    const library = pathApi(work).join(work, 'work');
    return {
      steps: [step(siblingExecutable(executable, 'vlib'), [library]),
        step(executable, ['-nologo', '-sv', '-lint', '-work', library,
          ...includes.map(dir => '+incdir+' + dir), ...defines.map(value => '+define+' + value), ...files])],
      notes: ['ModelSim 仅编译并检查源码，不启动仿真。']
    };
  }
  const xvhdl = clean(options.vhdlExecutable || siblingExecutable(executable, 'xvhdl'), '工具路径');
  return {
    steps: groups.map(group => step(group.vhdl ? xvhdl : executable,
      [...(group.vhdl ? group.vhdl2008 ? ['--2008'] : [] : ['--sv']), '--work', group.library,
        ...(group.vhdl ? [] : [...includes.flatMap(dir => ['--include', dir]), ...defines.flatMap(value => ['--define', value])]),
        ...group.files])),
    notes: [hasVhdl ? 'Vivado xvlog 和 xvhdl 仅编译源码，不启动仿真或综合。' : 'Vivado xvlog 仅编译并检查源码，不启动仿真或综合。',
      '文件按清单顺序编译。此顺序不是 Vivado 展开后的编译顺序。']
  };
}

function location(file, line, column, cwd, files) {
  let name = file.trim().replace(/^"(.*)"$/, '$1');
  if (!name || /^<.*>$/.test(name) || /[\x00-\x1f\x7f]/.test(name)) return undefined;
  // A bare basename can occur in compiler output. Resolve it only when unambiguous.
  if (!/[\\/]/.test(name) && !windowsPath(name)) {
    const matches = files.filter(candidate => {
      const basename = pathApi(candidate).basename(candidate);
      return process.platform === 'win32' || windowsPath(candidate) ? basename.toLowerCase() === name.toLowerCase() : basename === name;
    });
    if (matches.length > 1) return undefined;
    if (matches.length === 1) name = matches[0];
  }
  return { file: absolute(name, cwd, '诊断文件路径'), line: Math.max(0, Number(line) - 1), column: Math.max(0, Number(column || 1) - 1) };
}

const plainLine = line => line.replace(/\x1b\[[0-9;]*m/g, '').trim();
const timescaleSourceNote = message => /^\.\.\.:\s*The inherited timescale is here\.$/i.test(message);
const declarationSourceNote = message => /^:\s*It was declared here as .+\.$/i.test(message);

function locatedMessage(backend, line) {
  let match;
  if (backend === 'iverilog') {
    match = /^(.*?):(\d+)(?::(\d+))?:\s*(?:(error|warning|note|sorry):\s*)?(.+)$/i.exec(line);
    if (!match) return undefined;
    const auxiliary = !match[4] && (timescaleSourceNote(match[5]) || declarationSourceNote(match[5]));
    return { file: match[1], line: match[2], column: match[3], message: match[5],
      severity: /^warning$/i.test(match[4]) ? 'warning' : /^note$/i.test(match[4]) || auxiliary ? 'info' : 'error' };
  }
  if (backend === 'modelsim') {
    match = /^(?:#\s*)?\*\*\s*(Error|Warning|Note|Fatal)(?:\s*\([^)]*\))?:\s*(?:\(([^)]+)\)\s*)?(.+)\((\d+)(?:,(\d+))?\):\s*(?:\(((?:vlog|vcom)-[^)]+)\)\s*)?(.*)$/i.exec(line);
    if (!match) return undefined;
    return { file: match[3], line: match[4], column: match[5], message: match[7], code: match[2] || match[6],
      severity: /^warning$/i.test(match[1]) ? 'warning' : /^note$/i.test(match[1]) ? 'info' : 'error' };
  }
  match = /^(ERROR|WARNING|CRITICAL WARNING|INFO|FATAL):\s*(?:\[([^\]]+)\]\s*)?(.*)\s*\[(.+?):(\d+)(?::(\d+))?\]\s*$/i.exec(line);
  if (!match) return undefined;
  return { file: match[4], line: match[5], column: match[6], message: match[3], code: match[2],
    severity: /warning$/i.test(match[1]) ? 'warning' : /^info$/i.test(match[1]) ? 'info' : 'error' };
}

// Match the warning's meaning, never its file path or a quoted signal name.
// Unknown messages stay visible. Errors are not passed to this classifier.
const timeSetting = '(?:`?time\\s*scale|time\\s*unit(?:\\s*[/]\\s*time\\s*precision)?|time\\s*precision)';
const timescaleWarningPatterns = [
  /^timescale for .+ inherited from another file\.$/i,
  /^Some design elements have no explicit time unit(?:\s+and\/or(?:\s+time precision)?)?(?:\.|$)/i,
  new RegExp('^' + timeSetting + '\\s+(?:directive|specification|for|of|(?:(?:is|was)\\s+)?(?:missing|unspecified|ignored|inconsistent|inherited|undefined|different|differs|not specified|not defined|not set))\\b', 'i'),
  new RegExp('^(?:No|Missing|Inconsistent|Unspecified|Different)\\s+(?:explicit\\s+)?' + timeSetting + '\\b', 'i'),
  new RegExp('^(?:The\\s+)?(?:module|design unit|package|program|interface)\\s+.+?\\s+(?:has|have|does not have|doesn\'t have|has no|has not specified|does not specify)\\s+(?:(?:an?|no|explicit)\\s+)*' + timeSetting + '\\b', 'i'),
  new RegExp('^Found (?:modules|design units) with (?:explicit )?' + timeSetting + 's?\\b', 'i')
];
function isTimescaleWarning(message) {
  return timescaleWarningPatterns.some(pattern => pattern.test(message.trim()));
}
function globalWarning(backend, line) {
  if (backend === 'iverilog') return /^warning:\s*(.*)$/i.exec(line)?.[1];
  if (backend === 'modelsim') return /^(?:#\s*)?\*\*\s*Warning(?:\s*\([^)]*\))?:\s*(?:\([^)]+\)\s*)?(.*)$/i.exec(line)?.[1];
  return /^(?:CRITICAL )?WARNING:\s*(?:\[[^\]]+\]\s*)?(.*)$/i.exec(line)?.[1];
}

/** Hide only recognized timescale warnings and their known auxiliary lines. */
function filterLintOutput(backend, text, options = {}) {
  if (!Object.hasOwn(BACKENDS, backend)) throw new Error('不支持此语法检查工具。');
  const original = String(text);
  if (options.ignoreTimescaleWarnings === false) return original;
  const kept = [];
  let globalTimescale = false;
  for (const raw of original.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []) {
    const line = plainLine(raw);
    const record = locatedMessage(backend, line);
    const warning = record ? record.severity === 'warning' ? record.message : undefined : globalWarning(backend, line);
    if (warning !== undefined && isTimescaleWarning(warning)) {
      globalTimescale = backend === 'iverilog' && /^Some design elements have no explicit time unit/i.test(warning);
      continue;
    }
    if (backend === 'iverilog' && record?.severity === 'info' && timescaleSourceNote(record.message)) continue;
    if (globalTimescale && /^(?::\s*time precision\.(?: This may cause confusing timing results\.)?|:\s*Affected design elements are:|:\s*--\s+(?:module|package|program|interface|primitive)\s+.+\s+declared here:\s*.+:\d+)$/i.test(line)) continue;
    globalTimescale = false;
    kept.push(raw);
  }
  return kept.join('');
}

/** Parse located messages only; unlocated compiler failures remain in the caller's output log. */
function parseLintOutput(backend, text, options = {}) {
  const cwd = options.cwd || process.cwd();
  const files = options.files || [];
  const diagnostics = [];
  const seen = new Set();
  for (const raw of filterLintOutput(backend, text, options).split(/\r?\n/)) {
    const record = locatedMessage(backend, plainLine(raw));
    if (!record || !record.message.trim()) continue;
    const loc = location(record.file, record.line, record.column, cwd, files);
    if (!loc) continue;
    const item = { ...loc, severity: record.severity, message: record.message.trim(), ...(record.code ? { code: record.code } : {}) };
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); diagnostics.push(item); }
  }
  return diagnostics;
}

/** Preserve explicitly classified tool messages without inventing source locations. */
function unlocatedLintMessages(backend, text, options = {}) {
  const result = {error: [], warning: []};
  const cwd = options.cwd || process.cwd(), files = options.files || [];
  for (const raw of filterLintOutput(backend, text, options).split(/\r\n|\r|\n/)) {
    const line = plainLine(raw);
    const record = locatedMessage(backend, line);
    if (record && location(record.file, record.line, record.column, cwd, files)) continue;
    const match = backend === 'iverilog' ? /^(error|warning|fatal):\s*/i.exec(line)
      : backend === 'modelsim' ? /^(?:#\s*)?\*\*\s*(Error|Warning|Fatal)(?:\s*\([^)]*\))?:\s*/i.exec(line)
      : /^(ERROR|WARNING|CRITICAL WARNING|FATAL):\s*/i.exec(line);
    if (match) result[/warning/i.test(match[1]) ? 'warning' : 'error'].push(raw);
  }
  return result;
}

module.exports = { buildLintPlan, parseLintOutput, filterLintOutput, unlocatedLintMessages };
