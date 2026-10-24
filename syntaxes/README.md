# Verilog and SystemVerilog grammars

These are independent TextMate grammars with the public scopes `source.verilog` and `source.systemverilog`. They provide lexical highlighting without requiring a project, Vivado, or a language server. They use familiar `comment`, `string`, `keyword`, `storage`, `entity`, and `constant` scopes for recognized syntax so the selected editor theme controls the colors. Ordinary identifiers whose role is unknown use neutral `meta.identifier` scopes rather than assigning every signal, port, parameter reference, and type reference to `variable`.

The baseline is [mshr-h/vscode-verilog-hdl-support, commit 4af5dc18fdf906d35577bbc0aa2937d09d964f5b](https://github.com/mshr-h/vscode-verilog-hdl-support/tree/4af5dc18fdf906d35577bbc0aa2937d09d964f5b). `UPSTREAM.json` records each original filename, immutable source URL, original SHA-256, local SHA-256, and local patches. The upstream Verilog file is installed here as `hdl.tmLanguage.json`. The SV grammar remains a separate rule set and does not include the Verilog grammar. Its `fileTypes` are narrowed to `sv` and `svh`; the extension manifest determines language registration.

The grammar notices are retained in `vendor/licenses/hdl-grammars.txt`: the repository MIT license, the VSCode-SystemVerilog MIT notice, and the TextMate Verilog Bundle permissive notice. The build incorporates this file into `THIRD_PARTY_NOTICES.txt`. Keep the persistent notice and source manifest when redistributing these grammars.

Local corrections cover signed based numbers and real exponents in Verilog, escaped identifiers, Verilog function/task declaration headers, whole-word macro/call exclusions, SV declaration ordering, and the assertion label scope. Ordinary/escaped identifiers and instance names are neutral, while recognized instance types use the same `entity.name.type.module` category as module declarations. The SV uppercase-only constant guesses are removed: capitalization alone does not establish a symbol's role. The full per-file patch list is in `UPSTREAM.json`. No global color or semantic-token settings are supplied.

Run the real VS Code tokenizer regression from the extension directory:

```text
node --test --test-isolation=none test/highlighting.test.js
```

The test uses pinned `vscode-textmate` and `vscode-oniguruma` development dependencies and the actual Oniguruma WASM engine. It checks multiline state, comment/string isolation and recovery, directives, signed/unsized/time literals, escaped names, declarations, instances, function/task headers, and common SV/SVA structures. A complete reset/state example is also checked against the unmodified, pinned MIT Atom One Light 2.3.0 theme in `test/fixtures/themes`: real `tokenizeLine2` metadata must keep ordinary signals at the theme's default foreground across ANSI/non-ANSI ports, declarations, uses, select expressions, and SV class/function bodies. Recognized syntax must retain multiple distinct categories, and identifiers cannot be disguised as parameters, functions, or types to obtain a different color. These tests do not read the user's theme installation or settings. A bounded workload reports elapsed time and token counts without a machine-specific speed threshold. Syntax tests neither compile nor simulate HDL.

These are lexical rules. They do not resolve typedefs, distinguish every identifier by its declaration, evaluate macro branches, or prove HDL validity. For example, `-32'sd1` has an external unary minus; `32'sd-1` is malformed and is tested only for tokenizer recovery. Deeply ambiguous type/call/instance contexts can retain generic identifier scopes. Signal navigation and project analysis are separate features.

To update the baseline, review the new commit and its component licenses first. Compare each original grammar with the pinned version, reapply only the documented corrections, update original/local hashes and immutable URLs, and run the tokenizer tests plus the extension's normal build checks. Do not overwrite a grammar from a moving branch or regenerate the SV JSON from a different YAML revision without recording that source.
