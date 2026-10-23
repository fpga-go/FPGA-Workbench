'use strict';

const path = require('node:path');

function fileKey(filePath) {
  // URI.fsPath and XPR paths can differ in slash direction and drive casing.
  // Preserve the source spelling in locations, but use one absolute map key.
  const windowsPath = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
  return windowsPath ? path.win32.resolve(filePath).toLowerCase() : path.resolve(filePath);
}

// A deliberately bounded structural index. This is not an elaborator: conditional
// source and generate blocks remain possible source branches, never elaborated nets.
const DECLARATIONS = new Set(('input output inout ref wire tri tri0 tri1 wand wor triand trior trireg uwire supply0 supply1 reg logic bit byte shortint int longint integer time real realtime shortreal parameter localparam genvar').split(' '));
const DIRECTIONS = new Set(['input', 'output', 'inout', 'ref']);
const KEYWORDS = new Set(('module endmodule interface endinterface program endprogram package endpackage class endclass virtual automatic static signed unsigned const var rand randc struct union enum packed typedef type void function endfunction task endtask begin end generate endgenerate if else for foreach while repeat forever case casex casez endcase default assign always always_comb always_ff always_latch initial final return break continue fork join join_any join_none wait disable force release deassign specify endspecify import export modport clocking endclocking property endproperty sequence endsequence assert assume cover restrict bind alias defparam new local protected extern pure context do unique unique0 priority inside dist matches with let checker endchecker').split(' ').concat([...DECLARATIONS]));
const TYPE_WORDS = new Set([...KEYWORDS, 'string', 'event', 'chandle']);

function location(path, token, kind, extra = {}) {
  return { path, start: token.start, end: token.end, name: token.value, kind, ...extra };
}
function key(loc) { return `${loc.path}\u0000${loc.start}\u0000${loc.end}`; }
function unique(locations) { return [...new Map(locations.map(loc => [key(loc), loc])).values()]; }

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let conditionalDepth = 0;
  let hasDirectives = false;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue;
    }
    const start = i;
    if (ch === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') break;
      }
      tokens.push({ value: '', start, end: i, kind: 'literal', conditional: conditionalDepth > 0 });
      continue;
    }
    if (ch === '`') {
      i++;
      while (/[A-Za-z0-9_$]/.test(text[i] || '') && i < text.length) i++;
      const word = text.slice(start + 1, i);
      const directives = new Set(['define', 'undef', 'ifdef', 'ifndef', 'elsif', 'else', 'endif', 'include', 'timescale', 'default_nettype', 'resetall', 'celldefine', 'endcelldefine', 'line', 'pragma', 'begin_keywords', 'end_keywords', 'unconnected_drive', 'nounconnected_drive']);
      if (directives.has(word)) {
        hasDirectives = true;
        if (word === 'ifdef' || word === 'ifndef') conditionalDepth++;
        if (word === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1);
        let end;
        do {
          end = text.indexOf('\n', i);
          if (end < 0) { i = text.length; break; }
          const continued = text.slice(i, end).replace(/\r$/, '').endsWith('\\');
          i = end + 1;
          if (!continued) break;
        } while (i < text.length);
        continue;
      }
      tokens.push({ value: text.slice(start, i), start, end: i, kind: 'macro', conditional: conditionalDepth > 0 });
      continue;
    }
    let kind = 'punctuation';
    let value;
    if (ch === '\\') {
      i++;
      while (i < text.length && !/\s/.test(text[i])) i++;
      value = text.slice(start + 1, i); kind = 'identifier';
    } else if (/[A-Za-z_$]/.test(ch)) {
      i++;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) i++;
      value = text.slice(start, i); kind = 'identifier';
    } else if (/[0-9]/.test(ch) || (ch === "'" && /[sSbBoOdDhH01xXzZ]/.test(text[i + 1] || ''))) {
      i++;
      while (i < text.length && /[A-Za-z0-9_'?.]/.test(text[i])) i++;
      value = text.slice(start, i); kind = 'literal';
    } else if (text.startsWith('::', i)) {
      i += 2; value = '::';
    } else { i++; value = ch; }
    tokens.push({ value, start, end: i, kind, conditional: conditionalDepth > 0 });
  }
  return { tokens, hasDirectives };
}

function matchingPairs(tokens) {
  const pairs = new Map();
  const stack = [];
  const expected = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (['(', '[', '{'].includes(value)) stack.push(i);
    else if (expected[value] && stack.length && tokens[stack.at(-1)].value === expected[value]) {
      const start = stack.pop(); pairs.set(start, i); pairs.set(i, start);
    }
  }
  return pairs;
}

function split(tokens, pairs, start, end, separator = ',') {
  const parts = [];
  let from = start;
  for (let i = start; i < end; i++) {
    if (['(', '[', '{'].includes(tokens[i].value) && pairs.has(i)) { i = pairs.get(i); continue; }
    if (tokens[i].value === separator) { parts.push([from, i]); from = i + 1; }
  }
  parts.push([from, end]);
  return parts;
}

function statementEnd(tokens, pairs, start, limit) {
  for (let i = start; i < limit; i++) {
    if (['(', '[', '{'].includes(tokens[i].value) && pairs.has(i)) { i = pairs.get(i); continue; }
    if (tokens[i].value === ';') return i;
  }
  return limit;
}

function addSymbol(mod, scope, token, kind, extras = {}) {
  const symbol = location(mod.path, token, kind, { scopeId: scope.id, conditional: !!token.conditional, ...extras });
  const existing = scope.symbols.filter(s => s.name === symbol.name);
  const replace = existing.find(s => s.provisional);
  if (replace && !symbol.provisional) {
    scope.symbols.splice(scope.symbols.indexOf(replace), 1);
    mod.symbols.splice(mod.symbols.indexOf(replace), 1);
  } else if (existing.length && (!symbol.conditional || existing.some(s => s.start === symbol.start))) {
    // A non-ANSI port may be declared as both output and reg. Keep its port declaration.
    const old = existing[0];
    if (kind === 'port' && old.kind !== 'port') { old.kind = 'port'; old.direction = extras.direction; }
    return old;
  }
  scope.symbols.push(symbol); mod.symbols.push(symbol);
  return symbol;
}

function declarations(mod, scope, start, end, defaultKind, provisional = false) {
  const { tokens, pairs } = mod.file;
  let kind = defaultKind;
  let direction;
  for (const [from, to] of split(tokens, pairs, start, end)) {
    let candidate;
    let sawMacro = false;
    for (let i = from; i < to; i++) {
      const token = tokens[i];
      if (token.value === '=') break;
      if (['(', '[', '{'].includes(token.value) && pairs.has(i)) { i = pairs.get(i); continue; }
      if (DIRECTIONS.has(token.value)) { kind = 'port'; direction = token.value; continue; }
      if (['parameter', 'localparam'].includes(token.value)) { kind = 'parameter'; continue; }
      if (token.kind === 'macro') sawMacro = true;
      if (token.kind === 'identifier' && !TYPE_WORDS.has(token.value)) candidate = token;
    }
    if (candidate && !sawMacro) addSymbol(mod, scope, candidate, kind || 'signal', { ...(direction ? { direction } : {}), ...(provisional ? { provisional: true } : {}) });
  }
}

function newScope(mod, parent, token, kind, name) {
  const scope = { id: mod.scopes.length, parent, kind, name, start: token.start, end: mod.bodyEnd, symbols: [], instances: [], children: [], generated: kind === 'generate' || !!parent?.generated };
  mod.scopes.push(scope);
  if (parent) parent.children.push(scope);
  return scope;
}

function parseModule(file, moduleStart, nameIndex, headerEnd, moduleEnd) {
  const { tokens, pairs } = file;
  const nameToken = tokens[nameIndex];
  const mod = {
    ...location(file.path, nameToken, 'module'), bodyStart: tokens[moduleStart].start,
    bodyEnd: tokens[moduleEnd]?.end ?? file.text.length, instances: [], symbols: [], warnings: [],
    conditional: !!nameToken.conditional, file, scopes: [], tokenScopes: new Map(), excluded: new Set(), portAliases: []
  };
  const root = newScope(mod, null, tokens[moduleStart], 'module', mod.name);
  let i = nameIndex + 1;
  if (tokens[i]?.value === '#' && tokens[i + 1]?.value === '(' && pairs.has(i + 1)) {
    const end = pairs.get(i + 1); declarations(mod, root, i + 2, end, 'parameter'); i = end + 1;
  }
  if (tokens[i]?.value === '(' && pairs.has(i)) {
    const end = pairs.get(i);
    const ansi = tokens.slice(i + 1, end).some(t => DIRECTIONS.has(t.value));
    declarations(mod, root, i + 1, end, 'port', !ansi);
    if (!ansi) mod.portAliases = root.symbols.filter(symbol => symbol.kind === 'port').map(symbol => ({ ...symbol }));
  }
  for (let n = moduleStart; n <= headerEnd; n++) mod.tokenScopes.set(n, root);
  const stack = [root];
  const closes = { end: 'block', endgenerate: 'generate', endfunction: 'function', endtask: 'task', endclass: 'class', endproperty: 'property', endsequence: 'sequence', endclocking: 'clocking', endspecify: 'specify' };
  for (i = headerEnd + 1; i < moduleEnd; i++) {
    const token = tokens[i];
    let current = stack.at(-1);
    if (closes[token.value]) {
      let match = stack.length - 1;
      while (match > 0 && stack[match].kind !== closes[token.value]) match--;
      if (match > 0) {
        while (stack.length > match) stack.pop().end = token.end;
        current = stack.at(-1);
      }
      mod.tokenScopes.set(i, current); continue;
    }
    if (['function', 'task', 'class', 'property', 'sequence', 'clocking', 'specify'].includes(token.value)) {
      const end = statementEnd(tokens, pairs, i + 1, moduleEnd);
      let name;
      let paren = -1;
      for (let n = i + 1; n < end; n++) {
        if (tokens[n].value === '(') { paren = n; break; }
        if (tokens[n].kind === 'identifier' && !TYPE_WORDS.has(tokens[n].value)) name = tokens[n];
      }
      const nested = newScope(mod, current, token, token.value, name?.value);
      if (name && ['function', 'task'].includes(token.value)) addSymbol(mod, current, name, token.value);
      if (paren >= 0 && pairs.has(paren)) declarations(mod, nested, paren + 1, pairs.get(paren), 'port');
      stack.push(nested);
      for (let n = i; n <= end; n++) { mod.tokenScopes.set(n, nested); mod.excluded.add(n); }
      i = end; continue;
    }
    if (token.value === 'begin' || token.value === 'generate') {
      const label = tokens[i + 1]?.value === ':' ? tokens[i + 2]?.value : undefined;
      current = newScope(mod, current, token, token.value === 'begin' ? 'block' : 'generate', label);
      stack.push(current);
      if (label) { mod.excluded.add(i + 1); mod.excluded.add(i + 2); }
    }
    mod.tokenScopes.set(i, current);
  }
  // Do not manufacture symbols inside unsupported class/assertion sublanguages.
  const unsupported = scope => {
    for (let current = scope; current; current = current.parent) {
      if (['class', 'property', 'sequence', 'clocking', 'specify'].includes(current.kind)) return true;
    }
    return false;
  };
  for (i = headerEnd + 1; i < moduleEnd; i++) {
    if (mod.excluded.has(i)) continue;
    const scope = mod.tokenScopes.get(i) || root;
    if (unsupported(scope)) continue;
    if (tokens[i].value === 'typedef') {
      i = statementEnd(tokens, pairs, i + 1, moduleEnd); continue;
    }
    if (DECLARATIONS.has(tokens[i].value)) {
      const end = statementEnd(tokens, pairs, i + 1, moduleEnd);
      declarations(mod, scope, i, end, 'signal'); i = end; continue;
    }
    if (tokens[i].kind !== 'identifier' || KEYWORDS.has(tokens[i].value) || ['.', '::'].includes(tokens[i - 1]?.value)) continue;
    if (['function', 'task'].some(kind => {
      for (let s = scope; s; s = s.parent) if (s.kind === kind) return true;
      return false;
    })) continue;
    const parsed = parseInstances(mod, scope, i, moduleEnd);
    if (parsed) i = parsed - 1;
  }
  if (tokens.slice(moduleStart, moduleEnd).some(t => t.conditional)) mod.warnings.push('Preprocessor branches are indexed as possible source; conditions are not evaluated.');
  if (tokens.slice(moduleStart, moduleEnd).some(t => t.kind === 'macro')) mod.warnings.push('Macro expansion is unavailable in the structural index.');
  if (mod.scopes.some(s => s.generated)) mod.warnings.push('Generate blocks are source hierarchy; loop iterations and branch conditions are not elaborated.');
  return mod;
}

function namedConnections(mod, start, end, kind) {
  const { tokens, pairs } = mod.file;
  const result = [];
  for (const [from, to] of split(tokens, pairs, start, end)) {
    if (tokens[from]?.value !== '.' || tokens[from + 1]?.kind !== 'identifier') continue;
    const name = tokens[from + 1];
    result.push({ ...location(mod.path, name, kind), conditional: !!name.conditional, expressionStart: tokens[from + 2]?.end ?? name.end, expressionEnd: tokens[to - 1]?.start ?? name.end, implicit: tokens[from + 2]?.value !== '(' });
  }
  return result;
}

/** Return one complete parent-side expression, without expanding source text.
 * Empty connections and unresolved macro / preprocessor expressions have no
 * safe expression target. An implicit .port uses the port token itself.
 */
function connectionExpression(text, port) {
  if (typeof text !== 'string' || !port || port.conditional) return undefined;
  if (port.implicit) {
    if (!Number.isInteger(port.start) || !Number.isInteger(port.end) || port.start < 0 || port.end <= port.start || port.end > text.length) return undefined;
    // A macro or directive after the name can change the connection syntax;
    // only whitespace/comments followed by the actual delimiter are implicit.
    let cursor = port.end;
    while (cursor < text.length) {
      if (/\s/.test(text[cursor])) { cursor++; continue; }
      if (text.startsWith('//', cursor)) {
        const end = text.indexOf('\n', cursor + 2);
        if (end < 0) return undefined;
        cursor = end + 1; continue;
      }
      if (text.startsWith('/*', cursor)) {
        const end = text.indexOf('*/', cursor + 2);
        if (end < 0) return undefined;
        cursor = end + 2; continue;
      }
      return [',', ')'].includes(text[cursor]) ? { ...port } : undefined;
    }
    return undefined;
  }
  const start = port.expressionStart, end = port.expressionEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return undefined;
  if (text[start - 1] !== '(' || text[end] !== ')') return undefined;
  const { tokens, hasDirectives } = tokenize(text.slice(start, end));
  if (!tokens.length || hasDirectives || tokens.some(token => token.kind === 'macro' || token.conditional)) return undefined;
  return { ...port, start: start + tokens[0].start, end: start + tokens.at(-1).end };
}

function parseInstances(mod, scope, start, limit) {
  const { tokens, pairs } = mod.file;
  const type = tokens[start];
  let i = start + 1;
  let parameters = [];
  if (tokens[i]?.value === '#') {
    if (tokens[i + 1]?.value !== '(' || !pairs.has(i + 1)) return undefined;
    const end = pairs.get(i + 1);
    parameters = namedConnections(mod, i + 2, end, 'parameter'); i = end + 1;
  }
  const instances = [];
  do {
    const name = tokens[i];
    if (!name || name.kind !== 'identifier' || KEYWORDS.has(name.value)) return undefined;
    i++;
    while (tokens[i]?.value === '[' && pairs.has(i)) i = pairs.get(i) + 1;
    if (tokens[i]?.value !== '(' || !pairs.has(i)) return undefined;
    const end = pairs.get(i);
    if (end >= limit) return undefined;
    instances.push({ ...location(mod.path, name, 'instance'), type: type.value, typeStart: type.start, typeEnd: type.end,
      scopeId: scope.id, conditional: !!type.conditional || scope.generated, ports: namedConnections(mod, i + 1, end, 'port'), parameters,
      bodyStart: type.start, bodyEnd: tokens[end].end });
    i = end + 1;
    if (tokens[i]?.value !== ',') break;
    i++;
  } while (i < limit);
  if (tokens[i]?.value !== ';') return undefined;
  mod.instances.push(...instances); scope.instances.push(...instances);
  return i + 1;
}

function parseFile(path, text) {
  const { tokens, hasDirectives } = tokenize(text);
  const file = { path, text, tokens, hasDirectives, pairs: matchingPairs(tokens), modules: [] };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'module') continue;
    let name = i + 1;
    if (['automatic', 'static'].includes(tokens[name]?.value)) name++;
    if (tokens[name]?.kind !== 'identifier') continue;
    const headerEnd = statementEnd(tokens, file.pairs, name + 1, tokens.length);
    let end = headerEnd + 1;
    while (end < tokens.length && tokens[end].value !== 'endmodule') end++;
    file.modules.push(parseModule(file, i, name, headerEnd, end));
    i = end;
  }
  return file;
}

function symbolsIn(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const matches = current.symbols.filter(s => s.name === name);
    if (matches.length) return matches;
  }
  return [];
}
function instanceIn(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const matches = current.instances.filter(s => s.name === name);
    if (matches.length) return matches;
  }
  return [];
}
function tokenAt(tokens, offset) {
  let low = 0; let high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1; const token = tokens[mid];
    if (offset < token.start) high = mid - 1;
    else if (offset >= token.end) low = mid + 1;
    else return mid;
  }
  // VS Code also requests definitions with the caret immediately after a word.
  if (high >= 0 && tokens[high].end === offset && tokens[high].kind === 'identifier') return high;
  return -1;
}

// Find a source item's extent only to reject unelaborated generate branches in
// reverse navigation. No condition is evaluated and normal definition lookup is
// unaffected, including when the optional generate/endgenerate wrapper is absent.
function sourceItemEnd(tokens, pairs, start, limit) {
  const word = tokens[start]?.value;
  if (word === 'if' || word === 'for') {
    if (tokens[start + 1]?.value !== '(' || !pairs.has(start + 1)) return limit;
    let end = sourceItemEnd(tokens, pairs, pairs.get(start + 1) + 1, limit);
    if (word === 'if' && tokens[end]?.value === 'else') end = sourceItemEnd(tokens, pairs, end + 1, limit);
    return end;
  }
  if (word === 'begin' || ['case', 'casex', 'casez'].includes(word)) {
    const opening = word === 'begin' ? new Set(['begin']) : new Set(['case', 'casex', 'casez']);
    const closing = word === 'begin' ? 'end' : 'endcase';
    let depth = 1;
    for (let i = start + 1; i < limit; i++) {
      if (opening.has(tokens[i].value)) depth++;
      if (tokens[i].value === closing) depth--;
      if (depth === 0) {
        return tokens[i + 1]?.value === ':' ? Math.min(i + 3, limit) : i + 1;
      }
    }
    return limit;
  }
  return Math.min(statementEnd(tokens, pairs, start, limit) + 1, limit);
}

function conditionalSourceRanges(mod) {
  const { tokens, pairs } = mod.file;
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].start < mod.bodyStart || tokens[i].end > mod.bodyEnd) continue;
    if (!['if', 'for', 'case', 'casex', 'casez'].includes(tokens[i].value)) continue;
    const end = sourceItemEnd(tokens, pairs, i, tokens.length);
    ranges.push([tokens[i].start, tokens[Math.max(i, end - 1)]?.end ?? mod.bodyEnd]);
  }
  return ranges;
}

function localConditionalRanges(mod) {
  const { tokens, pairs } = mod.file;
  const procedural = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].start < mod.bodyStart || tokens[i].end > mod.bodyEnd) continue;
    if (!['always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final'].includes(tokens[i].value)) continue;
    let start = i + 1;
    while (['@', '#'].includes(tokens[start]?.value)) {
      start++;
      if (tokens[start]?.value === '(' && pairs.has(start)) start = pairs.get(start) + 1;
      else start++;
    }
    while (tokens[start]?.value === 'forever' || ['repeat', 'while', 'foreach'].includes(tokens[start]?.value)) {
      if (tokens[start].value === 'forever') start++;
      else if (tokens[start + 1]?.value === '(' && pairs.has(start + 1)) start = pairs.get(start + 1) + 1;
      else break;
    }
    const end = sourceItemEnd(tokens, pairs, start, tokens.length);
    procedural.push([tokens[i].start, tokens[Math.max(i, end - 1)]?.end ?? mod.bodyEnd]);
  }
  // An if/for/case inside a procedural statement is a runtime use, not an
  // unelaborated generate branch. Preserve those ordinary signal references.
  return conditionalSourceRanges(mod).filter(([start]) => {
    for (let scope = mod.tokenScopes.get(tokenAt(tokens, start)); scope; scope = scope.parent) {
      if (scope.kind === 'function' || scope.kind === 'task') return false;
    }
    return !procedural.some(([from, to]) => start >= from && start < to);
  });
}

class HdlIndex {
  constructor() { this._files = new Map(); this._modules = []; this._byName = new Map(); }
  update(filePath, text) {
    this._files.set(fileKey(filePath), parseFile(filePath, text)); this._rebuild();
    return this.modules().filter(mod => mod.path === filePath);
  }
  remove(filePath) { this._files.delete(fileKey(filePath)); this._rebuild(); }
  clear() { this._files.clear(); this._rebuild(); }
  _rebuild() {
    this._modules = [...this._files.values()].flatMap(file => file.modules);
    this._byName = new Map();
    for (const mod of this._modules) {
      if (!this._byName.has(mod.name)) this._byName.set(mod.name, []);
      this._byName.get(mod.name).push(mod);
    }
  }
  modules() {
    return this._modules.map(({ file, scopes, tokenScopes, excluded, portAliases, ...mod }) => ({ ...mod }));
  }
  _moduleLocations(name) { return (this._byName.get(name) || []).map(mod => location(mod.path, { start: mod.start, end: mod.end, value: mod.name }, 'module')); }
  _connectionDefinitions(instance, connection) {
    return (this._byName.get(instance.type) || []).flatMap(mod => mod.scopes[0].symbols.filter(symbol => symbol.name === connection.name && symbol.kind === connection.kind));
  }
  localSignal(filePath, offset) {
    const file = this._files.get(fileKey(filePath));
    if (!file) return undefined;
    let tokenIndex = tokenAt(file.tokens, offset);
    if (tokenIndex > 0 && file.tokens[tokenIndex].start === offset && file.tokens[tokenIndex].kind === 'punctuation' && file.tokens[tokenIndex - 1].end === offset && file.tokens[tokenIndex - 1].kind === 'identifier') tokenIndex--;
    if (tokenIndex < 0 || file.tokens[tokenIndex].kind !== 'identifier') return undefined;
    const token = file.tokens[tokenIndex];
    const mod = file.modules.find(item => token.start >= item.bodyStart && token.end <= item.bodyEnd);
    if (!mod) return undefined;
    const explicitPorts = new Set(mod.instances.flatMap(instance => instance.ports.filter(port => !port.implicit).map(port => port.start)));
    if (explicitPorts.has(token.start)) return undefined;
    const localTargets = start => unique(this.definitions(file.path, start).filter(target =>
      ['port', 'signal'].includes(target.kind) && fileKey(target.path) === fileKey(file.path) && target.start >= mod.bodyStart && target.end <= mod.bodyEnd));
    const targets = localTargets(token.start);
    if (targets.length !== 1) return undefined;
    const declaration = targets[0], declarationKey = key(declaration);
    const conditions = localConditionalRanges(mod);
    const uncertain = (candidate, index) => candidate.conditional || mod.tokenScopes.get(index)?.generated || conditions.some(([start, end]) => candidate.start >= start && candidate.end <= end);
    const hasMacro = file.tokens.some(candidate => candidate.start >= mod.bodyStart && candidate.end <= mod.bodyEnd && candidate.kind === 'macro');
    const references = [];
    for (let index = 0; index < file.tokens.length; index++) {
      const candidate = file.tokens[index];
      if (candidate.kind !== 'identifier' || candidate.value !== declaration.name || candidate.start < mod.bodyStart || candidate.end > mod.bodyEnd || candidate.start === declaration.start || explicitPorts.has(candidate.start) || uncertain(candidate, index)) continue;
      const resolved = localTargets(candidate.start);
      if (resolved.length === 1 && key(resolved[0]) === declarationKey) references.push(location(file.path, candidate, 'reference'));
    }
    return { declaration,
      module: { name: mod.name, path: mod.path, start: mod.start, end: mod.end, bodyStart: mod.bodyStart, bodyEnd: mod.bodyEnd },
      references: unique(references), certain: !mod.conditional && !declaration.conditional && !hasMacro && !uncertain(token, tokenIndex) };
  }
  parentConnections(filePath, offset, options = {}) {
    const file = this._files.get(fileKey(filePath));
    if (!file) return undefined;
    let tokenIndex = tokenAt(file.tokens, offset);
    if (tokenIndex > 0 && file.tokens[tokenIndex].start === offset && file.tokens[tokenIndex].kind === 'punctuation' && file.tokens[tokenIndex - 1].end === offset && file.tokens[tokenIndex - 1].kind === 'identifier') tokenIndex--;
    if (tokenIndex < 0 || file.tokens[tokenIndex].kind !== 'identifier') return undefined;
    const token = file.tokens[tokenIndex];
    const mod = file.modules.find(item => token.start >= item.bodyStart && token.end <= item.bodyEnd);
    if (!mod) return undefined;
    let declaration;
    if (token.start === mod.start) declaration = location(mod.path, token, 'module', { conditional: mod.conditional });
    else {
      const ports = mod.scopes[0].symbols.filter(symbol => symbol.kind === 'port' && symbol.direction && !symbol.provisional);
      declaration = ports.find(symbol => symbol.start === token.start);
      if (!declaration) {
        const alias = mod.portAliases.find(symbol => symbol.start === token.start);
        const matches = alias ? ports.filter(symbol => symbol.name === alias.name) : [];
        if (matches.length === 1) declaration = matches[0];
      }
    }
    if (!declaration) return undefined;
    const module = { name: mod.name, path: mod.path, start: mod.start, end: mod.end, bodyStart: mod.bodyStart, bodyEnd: mod.bodyEnd };
    const connections = [];
    // Source indexing cannot select a library definition or evaluate preprocessing.
    // The semantic backend can still use this exact declaration and owner to query
    // its actual elaborated instances when these conservative candidates are empty.
    if ((this._byName.get(mod.name) || []).length !== 1 || mod.conditional || declaration.conditional) return { declaration, module, connections };
    for (const parent of this._modules) {
      if (parent.conditional) continue;
      const parentTokens = parent.file.tokens.filter(item => item.start >= parent.bodyStart && item.end <= parent.bodyEnd);
      if (parentTokens.some(item => item.kind === 'macro')) continue;
      const conditionalRanges = conditionalSourceRanges(parent);
      for (const instance of parent.instances) {
        if (instance.type !== mod.name || instance.conditional) continue;
        if (conditionalRanges.some(([start, end]) => instance.start >= start && instance.bodyEnd <= end)) continue;
        const extras = { parentModule: parent.name, instance: instance.name, type: instance.type };
        if (declaration.kind === 'module') {
          connections.push(location(parent.path, { start: instance.start, end: instance.end, value: instance.name }, 'instance', extras));
        } else {
          const ports = instance.ports.filter(port => port.name === declaration.name && !port.conditional);
          if (options.target === 'expression') {
            const expression = ports.length === 1 ? connectionExpression(parent.file.text, { ...ports[0], ...extras }) : undefined;
            if (expression) connections.push(expression);
          } else if(options.target==='port') {
            if(ports.length===1)connections.push({...ports[0],...extras});
          } else connections.push(...ports.map(port => ({ ...port, ...extras })));
        }
      }
    }
    return { declaration, module, connections: unique(connections) };
  }
  definitions(filePath, offset) {
    const file = this._files.get(fileKey(filePath));
    if (!file) return [];
    const tokenIndex = tokenAt(file.tokens, offset);
    if (tokenIndex < 0 || file.tokens[tokenIndex].kind !== 'identifier') return [];
    const token = file.tokens[tokenIndex];
    const mod = file.modules.find(item => token.start >= item.bodyStart && token.end <= item.bodyEnd);
    if (!mod) return [];
    if (token.start === mod.start) return this._moduleLocations(mod.name).filter(loc => fileKey(loc.path) === fileKey(filePath) && loc.start === token.start);
    const scope = mod.tokenScopes.get(tokenIndex) || mod.scopes[0];
    for (const instance of mod.instances) {
      if (token.start === instance.typeStart || token.start === instance.start) return this._moduleLocations(instance.type);
      const connection = [...instance.ports, ...instance.parameters].find(p => p.start === token.start);
      if (connection) {
        const targets = this._connectionDefinitions(instance, connection);
        if (connection.implicit && connection.kind === 'port') targets.push(...symbolsIn(scope, connection.name));
        return unique(targets);
      }
    }
    if (file.tokens[tokenIndex - 1]?.value === '::' || file.tokens[tokenIndex + 1]?.value === '::') return [];
    const chain = [token.value];
    let cursor = tokenIndex;
    while (file.tokens[cursor - 1]?.value === '.') {
      let previous = cursor - 2;
      while (file.tokens[previous]?.value === ']' && file.pairs.has(previous)) previous = file.pairs.get(previous) - 1;
      if (file.tokens[previous]?.kind !== 'identifier') return [];
      chain.unshift(file.tokens[previous].value); cursor = previous;
    }
    if (chain.length > 1) return unique(this._hierarchical(mod, scope, chain));
    const symbols = symbolsIn(scope, token.value);
    if (symbols.length) return unique(symbols);
    const instances = instanceIn(scope, token.value);
    return unique(instances.flatMap(instance => this._moduleLocations(instance.type)));
  }
  _hierarchical(mod, scope, chain) {
    let contexts = [{ mod, scope }];
    for (let i = 0; i < chain.length; i++) {
      const name = chain[i];
      const final = i === chain.length - 1;
      const next = []; const locations = [];
      for (const context of contexts) {
        if (i === 0 && name === context.mod.name) { next.push({ mod: context.mod, scope: context.mod.scopes[0] }); continue; }
        const instances = i === 0 ? instanceIn(context.scope, name) : context.scope.instances.filter(instance => instance.name === name);
        for (const instance of instances) {
          if (final) locations.push(...this._moduleLocations(instance.type));
          else for (const child of this._byName.get(instance.type) || []) next.push({ mod: child, scope: child.scopes[0] });
        }
        let scopes = context.scope.children.filter(child => child.name === name);
        // An explicit generate region has no HDL path component.
        scopes = scopes.concat(context.scope.children.filter(child => child.kind === 'generate').flatMap(child => child.children.filter(nested => nested.name === name)));
        if (i === 0) {
          for (let parent = context.scope.parent; parent && !scopes.length; parent = parent.parent) scopes = parent.children.filter(child => child.name === name);
        }
        for (const child of scopes) next.push({ mod: context.mod, scope: child });
        if (final) locations.push(...context.scope.symbols.filter(symbol => symbol.name === name));
      }
      if (final) return locations;
      contexts = next;
      if (!contexts.length) return [];
    }
    return [];
  }
  references(filePath, offset, includeDeclaration = false) {
    const targets = this.definitions(filePath, offset);
    if (!targets.length) return [];
    const targetKeys = new Set(targets.map(key));
    const results = [];
    for (const file of this._files.values()) {
      for (const token of file.tokens) {
        if (token.kind !== 'identifier') continue;
        const loc = location(file.path, token, 'reference');
        if (!includeDeclaration && targetKeys.has(key(loc))) continue;
        if (this.definitions(file.path, token.start).some(target => targetKeys.has(key(target)))) results.push(loc);
      }
    }
    return unique(results);
  }
}

module.exports = { HdlIndex, connectionExpression };
