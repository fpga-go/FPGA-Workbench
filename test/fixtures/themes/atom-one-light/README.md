# Atom One Light tokenizer test fixture

`OneLight.json` is the complete unmodified theme from [akamud/vscode-theme-onelight, commit 5866e900db932d580e978a58db42f65cde07998b](https://github.com/akamud/vscode-theme-onelight/tree/5866e900db932d580e978a58db42f65cde07998b), version 2.3.0. It matches the installed 2.3.0 theme byte for byte. The original MIT `LICENSE` is saved here as `LICENSE.txt` with its full copyright and terms. `UPSTREAM.json` records the immutable paths and file hashes.

This fixture is used only for real `vscode-textmate` / Oniguruma regression tests. The test supplies the theme's `editor.foreground` and `editor.background` as TextMate defaults and its complete `tokenColors`, then checks actual `tokenizeLine2` metadata colors. It does not load user settings, rely on an installed theme, or change editor colors. The `test/` directory is excluded from the extension package.
