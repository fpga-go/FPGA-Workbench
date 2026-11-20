'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const TOOL_NAMES = Object.freeze({ iverilog: 'iverilog', modelsim: 'vlog', xsim: 'xvlog' });
const envKey = (env, name) => Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) || name;
const envValue = (env, name) => env[envKey(env, name)];
async function regularFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
async function directory(file) {
  try { return (await fs.stat(file)).isDirectory(); } catch { return false; }
}
function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function spawnFailure(error) {
  return error.code === 'E2BIG'
    ? failure('LINT_COMMAND_TOO_LONG', '检查命令行过长。请减少检查文件范围。')
    : failure('LINT_SPAWN_FAILED', `无法启动检查工具：${error.message}`);
}

function vivadoEnvironment(root, inherited) {
  const env = { ...inherited };
  for (const [name, value] of Object.entries({
    RDI_APPROOT: root, HDI_APPROOT: root, XILINX_VIVADO: root,
    RDI_DATADIR: path.join(root, 'data'), RDI_BINROOT: path.join(root, 'bin'), RDI_PLATFORM: 'win64'
  })) env[envKey(env, name)] = value;
  const key = envKey(env, 'PATH');
  env[key] = [path.join(root, 'lib', 'win64.o'), path.join(root, 'bin'), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

async function resolveXsim(candidate, inherited) {
  if (process.platform !== 'win32') {
    const executable = await directory(candidate) ? path.join(candidate, 'bin', 'xvlog') : candidate;
    if (await regularFile(executable)) return { executable, env: { ...inherited } };
    return undefined;
  }
  let root;
  if (await directory(candidate)) root = candidate;
  else if (/^xvlog\.bat$/i.test(path.basename(candidate)) && /^bin$/i.test(path.basename(path.dirname(candidate)))) {
    root = path.dirname(path.dirname(candidate));
  } else if (/^xvlog\.exe$/i.test(path.basename(candidate)) && /^win64\.o$/i.test(path.basename(path.dirname(candidate))) &&
    /^unwrapped$/i.test(path.basename(path.resolve(candidate, '../..'))) && /^bin$/i.test(path.basename(path.resolve(candidate, '../../..')))) {
    root = path.resolve(candidate, '../../../..');
  }
  if (!root) return undefined;
  const executable = path.join(root, 'bin', 'unwrapped', 'win64.o', 'xvlog.exe');
  if (!await regularFile(executable)) return undefined;
  return { executable, env: vivadoEnvironment(root, inherited) };
}

function pathDirectories(inherited) {
  return String(envValue(inherited, 'PATH') || '').split(path.delimiter)
    .map(value => value.replace(/^"(.*)"$/, '$1'))
    .filter(value => value && path.isAbsolute(value));
}

async function findOnPath(backend, inherited, requireCompanion = false) {
  const name = TOOL_NAMES[backend];
  const names = process.platform === 'win32' ? backend === 'xsim' ? ['xvlog.exe', 'xvlog.bat'] : [name + '.exe'] : [name];
  for (const dir of pathDirectories(inherited)) {
    for (const filename of names) {
      const candidate = path.join(dir, filename);
      if (!await regularFile(candidate)) continue;
      if (backend === 'xsim') {
        const resolved = await resolveXsim(candidate, inherited);
        if (resolved) return resolved;
      } else {
        if (backend === 'modelsim' && requireCompanion &&
          !await regularFile(path.join(dir, process.platform === 'win32' ? 'vlib.exe' : 'vlib'))) continue;
        return { executable: candidate, env: { ...inherited } };
      }
    }
  }
  return undefined;
}

// Discovery inspects only inherited PATH entries. It neither launches candidates
// nor consults configured paths or installation variables or scans registry/drive trees.
async function discoverLintTools(options = {}) {
  const inherited = options.env || process.env;
  const discovered = [];
  for (const backend of ['iverilog', 'xsim', 'modelsim']) {
    const tool = await findOnPath(backend, inherited, true);
    if (tool) discovered.push({ backend, ...tool });
  }
  return discovered;
}

// Only tool executables are launched. Windows batch files are never passed to a shell.
async function resolveLintExecutable(backend, configured = '', options = {}) {
  const name = TOOL_NAMES[backend];
  if (!name) throw failure('LINT_BACKEND', '不支持该语法检查后端。');
  const inherited = options.env || process.env;
  const requested = String(configured || '').trim();
  if (requested) {
    if (!path.isAbsolute(requested) || /[\0\r\n]/.test(requested)) throw failure('LINT_TOOL_PATH', '请填写检查工具的绝对路径。');
    if (backend === 'xsim') {
      const resolved = await resolveXsim(path.normalize(requested), inherited);
      if (resolved) return resolved;
      throw failure('LINT_TOOL_PATH', '未找到标准 Vivado 安装中的 xvlog。');
    }
    if (process.platform === 'win32' && !/\.exe$/i.test(requested)) throw failure('LINT_TOOL_PATH', '检查工具必须是 exe 文件。');
    if (await regularFile(requested)) {
      if (backend === 'modelsim' && !await regularFile(path.join(path.dirname(requested), process.platform === 'win32' ? 'vlib.exe' : 'vlib'))) {
        throw failure('LINT_TOOL_MISSING', 'vlog 所在目录缺少 vlib。请使用完整的 ModelSim 或 Questa 安装。');
      }
      return { executable: path.normalize(requested), env: { ...inherited } };
    }
    throw failure('LINT_TOOL_MISSING', `检查工具不存在：${requested}`);
  }
  const found = await findOnPath(backend, inherited);
  if (found) return found;
  if (backend === 'xsim') {
    const root = envValue(inherited, 'XILINX_VIVADO');
    if (root && path.isAbsolute(root)) {
      const resolved = await resolveXsim(root, inherited);
      if (resolved) return resolved;
    }
  }
  throw failure('LINT_TOOL_MISSING', `找不到 ${name}。请安装工具或设置工具路径。`);
}

// Resolve language companions in the already selected installation only. A
// missing compiler must not switch a manually selected backend or borrow an
// executable (and incompatible libraries) from another PATH entry.
async function resolveLintCompanions(tool, requirements = {}) {
  if (!TOOL_NAMES[tool?.backend]) throw failure('LINT_BACKEND', '不支持该语法检查后端。');
  const resolved = { ...tool, env: { ...tool.env } };
  if (requirements.vhdl && tool.backend === 'iverilog') {
    throw failure('LINT_LANGUAGE_UNSUPPORTED', 'iverilog 不支持 VHDL。请改用 Vivado 或 ModelSim 检查该工程。');
  }
  const companions = {};
  if (requirements.vhdl) companions.vhdlExecutable = tool.backend === 'xsim' ? 'xvhdl' : 'vcom';
  if (tool.backend === 'modelsim' && (requirements.vhdl || requirements.libraryMapping)) {
    companions.mapExecutable = 'vmap';
    companions.libraryExecutable = 'vlib';
  }
  if (!Object.keys(companions).length) return resolved;
  if (typeof tool.executable !== 'string' || !path.isAbsolute(tool.executable) || /[\0\r\n]/.test(tool.executable)) {
    throw failure('LINT_TOOL_PATH', '请填写检查工具的绝对路径。');
  }
  for (const [property, name] of Object.entries(companions)) {
    const filename = process.platform === 'win32' ? name + '.exe' : name;
    const executable = path.join(path.dirname(tool.executable), filename);
    if (!await regularFile(executable)) {
      throw failure('LINT_TOOL_MISSING', `所选工具目录缺少 ${name}：${executable}`);
    }
    resolved[property] = executable;
  }
  return resolved;
}

function decodeOutput(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}

function terminateTree(child, spawnProcess = spawn) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let done = false, timer, killer;
    const finish = fallback => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fallback) { try { child.kill(); } catch {} }
      resolve();
    };
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      killer = spawnProcess(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => finish(true));
      killer.once('close', code => finish(code !== 0));
      timer = setTimeout(() => { try { killer.kill(); } catch {} finish(true); }, 5000);
      timer.unref?.();
    } catch { finish(true); }
  });
}

function runLintProcess(step, options = {}) {
  const { signal, env = process.env, timeoutMs = 30000, maxOutputBytes = 2 * 1024 * 1024 } = options;
  const spawnProcess = options.spawn || spawn;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(failure('LINT_LIMIT', '语法检查的时间或输出上限无效。'));
  }
  if (signal?.aborted) return Promise.reject(failure('ABORT_ERR', '语法检查已取消。'));
  return new Promise((resolve, reject) => {
    let child, timer, problem, terminating, settled = false, total = 0;
    // Keep streams independent: an stderr diagnostic can be split between chunks
    // while stdout emits progress. Interleaving those bytes corrupts file locations
    // and can even split UTF-8 characters before decoding.
    const stdout = [], stderr = [];
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    const stop = error => {
      if (problem || settled) return;
      problem = error;
      clearTimeout(timer);
      terminating = terminateTree(child, spawnProcess);
    };
    const aborted = () => stop(failure('ABORT_ERR', '语法检查已取消。'));
    const collect = (chunks, chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - total);
      if (remaining) chunks.push(bytes.subarray(0, remaining));
      total += bytes.length;
      if (total > maxOutputBytes) stop(failure('LINT_OUTPUT_LIMIT', '语法检查输出超过上限。'));
    };
    const finish = async code => {
      if (settled) return;
      settled = true;
      cleanup();
      await terminating;
      const output = [stdout, stderr].filter(chunks => chunks.length)
        .map(chunks => decodeOutput(Buffer.concat(chunks))).join('\n');
      if (problem) { problem.output = output; reject(problem); }
      else resolve({ code, output });
    };
    try {
      child = spawnProcess(step.executable, step.args, {
        cwd: step.cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout?.on('data', chunk => collect(stdout, chunk));
      child.stderr?.on('data', chunk => collect(stderr, chunk));
      child.once('error', error => { problem ||= spawnFailure(error); });
      child.once('close', finish);
      timer = setTimeout(() => stop(failure('LINT_TIMEOUT', '语法检查超时。')), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    } catch (error) { settled = true; cleanup(); reject(spawnFailure(error)); }
  });
}

module.exports = { discoverLintTools, resolveLintExecutable, resolveLintCompanions, runLintProcess, decodeOutput };
