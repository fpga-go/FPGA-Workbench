'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
const { minimatch } = require('minimatch');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const languages = ['verilog', 'systemverilog'];
const snippetsFor = language => {
  const contribution = manifest.contributes.snippets.find(item => item.language === language);
  assert(contribution, `Missing ${language} snippets`);
  return JSON.parse(fs.readFileSync(path.join(root, contribution.path), 'utf8'));
};
const snippetFor = (language, prefix) => {
  const snippet = Object.values(snippetsFor(language)).find(item =>
    (Array.isArray(item.prefix) ? item.prefix : [item.prefix]).includes(prefix));
  assert(snippet, `Missing ${language} snippet ${prefix}`);
  return snippet;
};
function expand(snippet, values = {}) {
  const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
  const text = body.replace(/\$\{(\d+):([^}]*)\}/g, (_, index, fallback) => values[index] ?? fallback)
    .replace(/\$(\d+)/g, (_, index) => values[index] ?? '');
  assert.doesNotMatch(text, /\$\{|\$\d/, 'Fixture expansion must not leave snippet placeholders');
  return text.split('\n');
}
function foldingRules(language) {
  const contribution = manifest.contributes.languages.find(item => item.id === language);
  const config = JSON.parse(fs.readFileSync(path.join(root, contribution.configuration), 'utf8'));
  return { start: new RegExp(config.folding.markers.start), end: new RegExp(config.folding.markers.end) };
}

let registry;
before(async () => {
  const wasm = fs.readFileSync(path.join(root, 'vendor/oniguruma/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: value => new oniguruma.OnigString(value) }),
    loadGrammar: async scope => {
      const contribution = manifest.contributes.grammars.find(item => item.scopeName === scope);
      assert(contribution, `Unexpected external grammar ${scope}`);
      const file = path.join(root, contribution.path);
      return textmate.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
    }
  });
});
after(() => registry?.dispose());

async function metadata(language, lines) {
  const id = languages.indexOf(language) + 1;
  const grammar = await registry.loadGrammarWithConfiguration(`source.${language}`, id, {});
  let state = textmate.INITIAL;
  return lines.map(line => {
    const result = grammar.tokenizeLine2(line, state, 1000);
    assert.equal(result.stoppedEarly, false);
    state = result.ruleStack;
    return { id, tokens: result.tokens };
  });
}
function metadataAt(row, offset) {
  let value;
  for (let index = 0; index < row.tokens.length; index += 2) {
    if (row.tokens[index] > offset) break;
    value = row.tokens[index + 1];
  }
  assert.notEqual(value, undefined, `Missing native metadata at ${offset}`);
  return { language: value & 0xff, type: (value >>> 8) & 3 };
}
// VS Code 1.96's fixed MARK contract, not a configurable extension regex:
// https://github.com/microsoft/vscode/blob/1.96.0/src/vs/editor/common/services/findSectionHeaders.ts#L39
// Native rendering additionally requires StandardTokenType.Comment at the label.
function markTitle(line, row) {
  const match = /\bMARK:\s*(.*)$/d.exec(line);
  if (!match || !match[1].trim()) return undefined;
  const token = metadataAt(row, match.indices[1][0]);
  return token.type === 1 && token.language === row.id ? match[1].trim() : undefined;
}

test('both HDL languages expose snippets whose expanded Chinese headings are actual native comment tokens', async () => {
  for (const language of languages) {
    const mark = expand(snippetFor(language, 'fpga-mark'));
    assert.equal(mark.length, 1);
    assert.match(mark[0], /^\s*\/\/\s*MARK:\s*\p{Script=Han}/u);
    const region = expand(snippetFor(language, 'fpga-region'), { 0: 'wire payload;' });
    assert.equal(region.length, 3);
    const rows = await metadata(language, [...mark, ...region]);
    for (const index of [0, 1, 3]) {
      const token = metadataAt(rows[index], [...mark, ...region][index].indexOf('//'));
      assert.equal(token.type, 1, `${language}: heading line must be Comment metadata`);
      assert.equal(token.language, rows[index].id);
    }
    assert.equal(metadataAt(rows[2], 0).type, 0, 'Region body remains ordinary HDL source');
    const title = region[0].replace(foldingRules(language).start, '').trim();
    assert.match(title, /\p{Script=Han}/u);
    assert.equal(markTitle(mark[0], rows[0]), mark[0].split('MARK:')[1].trim());
  }
});

test('native MARK labels preserve complete Chinese and UTF-16 text and reject strings, code and lowercase marks', async () => {
  for (const language of languages) {
    const title = '接收控制：状态与复位😀';
    const generated = expand(snippetFor(language, 'fpga-mark'), { 1: title })[0];
    const lines = [generated, `\t  ${generated}`, '// MARK:无空格标题', '// 普通中文说明', '// mark: 小写标题',
      '// XMARK: 非标记', 'initial $display("MARK: 字符串标题");', 'MARK: 裸标签'];
    const rows = await metadata(language, lines);
    assert.deepEqual(lines.map((line, index) => markTitle(line, rows[index])),
      [title, title, '无空格标题', undefined, undefined, undefined, undefined, undefined]);
  }
});

test('folding markers leave Chinese titles intact and endregion has a strict word boundary', async () => {
  for (const language of languages) {
    const rules = foldingRules(language), title = '报文处理：字段😀';
    const lines = expand(snippetFor(language, 'fpga-region'), { 1: title, 0: 'wire payload;' });
    for (const start of [lines[0], `\t${lines[0]}`, '//#region ' + title]) {
      const match = start.match(rules.start);
      assert(match, `${language}: missing region marker`);
      assert.equal(start.slice(match[0].length).trim(), title, 'Marker regex must not consume the section title');
      assert.equal(rules.end.test(start), false);
    }
    assert.equal(rules.end.test(lines[2]), true);
    assert.equal(rules.start.test(lines[2]), false);
    for (const text of ['// #regional 标题', '// #region_name 标题', '// #endregion_name', '// #endregional',
      '// #Region 标题', 'wire payload; // #region 标题', 'string value = "// #region 标题";']) {
      assert.equal(rules.start.test(text), false, text);
      assert.equal(rules.end.test(text), false, text);
    }
    const rows = await metadata(language, lines);
    assert.equal(metadataAt(rows[0], lines[0].indexOf(title)).type, 1);
    assert.equal(metadataAt(rows[2], lines[2].indexOf('#endregion')).type, 1);
  }
});

test('declarative integration ships its snippet source without changing minimap settings or existing bracket pairs', () => {
  const contributions = manifest.contributes.snippets.filter(item => languages.includes(item.language));
  assert.deepEqual(contributions.map(item => item.language).sort(), [...languages].sort());
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  for (const contribution of contributions) {
    const relative = contribution.path.replace(/^\.\//, '');
    assert(ignore.some(pattern => pattern.startsWith('!') && minimatch(relative, pattern.slice(1))),
      `Snippet file must be allowed into the VSIX: ${relative}`);
    const language = manifest.contributes.languages.find(item => item.id === contribution.language);
    const config = JSON.parse(fs.readFileSync(path.join(root, language.configuration), 'utf8'));
    assert.deepEqual(config.brackets, [['{', '}'], ['[', ']'], ['(', ')'], ['begin', 'end']]);
    assert.deepEqual(config.colorizedBracketPairs, config.brackets);
  }
  const keys = [];
  const walk = value => { if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { keys.push(key); walk(child); } };
  walk(manifest.contributes.configurationDefaults);
  walk(manifest.contributes.configuration);
  assert.equal(keys.some(key => /(?:^|\.)minimap(?:\.|$)/i.test(key)), false,
    'Native minimap visibility and section-header settings must remain under user control');
});
