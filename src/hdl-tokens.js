'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const languages = { verilog: 'hdl.tmLanguage.json', systemverilog: 'systemverilog.tmLanguage.json' };
const LINE_TIME_LIMIT = 25;
const YIELD_LINES = 128;
const YIELD_MS = 8;
const DECLARATION_WORDS = new Set(('module macromodule endmodule primitive endprimitive interface endinterface ' +
  'program endprogram package endpackage class endclass checker endchecker config endconfig function endfunction ' +
  'task endtask property endproperty sequence endsequence clocking endclocking covergroup endgroup modport ' +
  'typedef parameter localparam specparam genvar').split(' '));
const TYPE_WORDS = new Set(('bit logic reg byte shortint int longint integer time shortreal real realtime string ' +
  'chandle event void wire uwire wand wor tri tri0 tri1 triand trior trireg supply0 supply1 input output inout ref').split(' '));
const ASSIGNMENT_WORDS = new Set(['assign', 'deassign', 'force', 'release', 'alias']);

function keywordCategory(text) {
  const word = typeof text === 'string' ? text.trim() : '';
  if (word === 'begin' || word === 'end') return 'bracket';
  if (DECLARATION_WORDS.has(word)) return 'declaration';
  if (TYPE_WORDS.has(word)) return 'type';
  if (ASSIGNMENT_WORDS.has(word)) return 'assignment';
  return 'keyword';
}

async function createTokenizer(extensionPath) {
  const bytes = await fs.readFile(path.join(extensionPath, 'vendor/oniguruma/onig.wasm'));
  await oniguruma.loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  let disposed = false;
  const pending = new Map();
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: value => new oniguruma.OnigString(value)
    }),
    loadGrammar: async scope => {
      const language = scope.startsWith('source.') ? scope.slice(7) : '';
      if (!Object.hasOwn(languages, language)) throw new Error(`Unsupported HDL grammar: ${scope}`);
      const file = path.join(extensionPath, 'syntaxes', languages[language]);
      const source = await fs.readFile(file, 'utf8');
      if (disposed) throw new Error('HDL tokenizer is disposed');
      return textmate.parseRawGrammar(source, file);
    }
  });
  return {
    grammar(languageId) {
      if (disposed) return Promise.reject(new Error('HDL tokenizer is disposed'));
      if (!Object.hasOwn(languages, languageId)) return Promise.reject(new Error(`Unsupported HDL language: ${languageId}`));
      if (!pending.has(languageId)) pending.set(languageId, registry.loadGrammar(`source.${languageId}`).then(grammar => {
        if (disposed) throw new Error('HDL tokenizer is disposed');
        if (!grammar) throw new Error(`Missing HDL grammar: ${languageId}`);
        return grammar;
      }));
      return pending.get(languageId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registry.dispose();
      pending.clear();
    }
  };
}

function tokenCategory(scopes, text) {
  if (!Array.isArray(scopes)) return 'text';
  const names = scopes.filter(scope => typeof scope === 'string');
  if (names.some(scope => /^comment(?:\.|$)/.test(scope))) return 'comment';
  if (names.some(scope => /^string\.quoted(?:\.|$)/.test(scope))) return 'string';
  // This exact legacy SV scope is used only for compiler directive words.
  if (names.includes('string.regexp.systemverilog')) return 'macro';
  if (names.some(scope => /^string(?:\.|$)/.test(scope))) return 'string';
  const preprocessor = names.some(scope => /^meta\.preprocessor(?:\.|$)/.test(scope));
  // Prefer the concrete innermost token over an enclosing declaration scope.
  for (let i = names.length - 1; i >= 0; i--) {
    const scope = names[i];
    if (/^meta\.(?:identifier|instance\.name)(?:\.|$)/.test(scope)) return 'text';
    if (/^constant\.numeric(?:\.|$)/.test(scope)) return 'number';
    if (/^(?:keyword\..*compiler\.directive|punctuation\.definition\.directive)(?:\.|$)/.test(scope)
      || /^variable\.other\.constant\.preprocessor(?:\.|$)/.test(scope)
      || scope === 'variable.other.constant.verilog') return 'macro';
    // The grammar labels named formal ports this way; they are not functions.
    if (/^support\.function\.port(?:\.|$)/.test(scope)) return 'text';
    if (/^entity\.name\.type\.module(?:\.|$)/.test(scope)) return 'module';
    if (/^(?:entity\.name\.function|support\.function)(?:\.|$)/.test(scope)) return 'function';
    if (/^storage\.type\.(?:module|function|task|class|interface|package)(?:\.|$)/.test(scope)) return 'declaration';
    if (/^(?:storage\.type|support\.type|support\.class|entity\.name\.type|entity\.other\.inherited-class)(?:\.|$)/.test(scope)) return 'type';
    if (/^(?:keyword|storage\.modifier)(?:\.|$)/.test(scope)) return preprocessor ? 'macro' : keywordCategory(text);
    if (/^meta\.preprocessor(?:\.|$)/.test(scope)) return 'macro';
  }
  return 'text';
}

class HdlTokenDocument {
  constructor(grammar) {
    if (!grammar || typeof grammar.tokenizeLine !== 'function') throw new TypeError('An HDL grammar is required');
    this.grammar = grammar;
    this.lines = [];
    this.version = undefined;
    this.generation = 0;
    this.cache = [];
  }
  update(lines, version, firstChangedLine = 0) {
    if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new TypeError('HDL lines must be strings');
    const next = lines.slice();
    const hint = Number.isFinite(firstChangedLine) ? Math.max(0, Math.floor(firstChangedLine)) : 0;
    const limit = Math.min(hint, this.cache.length, this.lines.length, next.length);
    let keep = 0;
    while (keep < limit && this.lines[keep] === next[keep]) keep++;
    this.generation++;
    this.version = version;
    this.lines = next;
    this.cache = this.cache.slice(0, keep);
  }
  async ensure(endLine, isCancelled = () => false) {
    if (!Number.isFinite(endLine)) throw new TypeError('An HDL end line is required');
    const generation = this.generation, version = this.version;
    const lines = this.lines, cache = this.cache;
    const current = () => generation === this.generation && version === this.version && !isCancelled();
    const target = Math.min(Math.floor(endLine), lines.length - 1);
    let count = 0, started = Date.now();
    while (cache.length <= target) {
      if (!current()) return false;
      const index = cache.length, line = lines[index];
      const state = index ? cache[index - 1].state : textmate.INITIAL;
      const result = this.grammar.tokenizeLine(line, state, LINE_TIME_LIMIT);
      if (!current()) return false;
      if (result.stoppedEarly) {
        const error = new Error(`HDL tokenization exceeded its time limit at line ${index + 1}`);
        error.code = 'HDL_TOKENIZE_TIMEOUT';
        error.line = index;
        throw error;
      }
      const tokens = [];
      const append = (startIndex, endIndex, category) => {
        if (endIndex <= startIndex) return;
        const previous = tokens[tokens.length - 1];
        if (previous && previous.category === category && previous.endIndex === startIndex) previous.endIndex = endIndex;
        else tokens.push({ startIndex, endIndex, category });
      };
      for (const token of result.tokens) {
        const startIndex = Math.max(0, token.startIndex), endIndex = Math.min(line.length, token.endIndex);
        if (endIndex <= startIndex) continue;
        const text = line.slice(startIndex, endIndex), category = tokenCategory(token.scopes, text);
        // Preserve lexical islands as complete tokens. In source text, release
        // only bracket glyphs to VS Code's native incremental pair colorizer.
        const protectedToken = category === 'comment' || category === 'string' || category === 'macro' ||
          token.scopes?.some(scope => /^meta\.identifier\.escaped(?:\.|$)/.test(scope));
        if (protectedToken || category === 'bracket') {
          append(startIndex, endIndex, category);
          continue;
        }
        let cursor = startIndex;
        for (let offset = startIndex; offset < endIndex; offset++) {
          if (!'()[]{}'.includes(line[offset])) continue;
          append(cursor, offset, category);
          append(offset, offset + 1, 'bracket');
          cursor = offset + 1;
        }
        append(cursor, endIndex, category);
      }
      cache.push({ state: result.ruleStack, tokens });
      if (++count >= YIELD_LINES || Date.now() - started >= YIELD_MS) {
        if (cache.length <= target) await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return false;
        count = 0;
        started = Date.now();
      }
    }
    return current();
  }
  tokens(line) {
    return this.cache[line]?.tokens || [];
  }
}

module.exports = { createTokenizer, HdlTokenDocument, tokenCategory };
