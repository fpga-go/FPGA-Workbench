# FPGA Workbench

在 VS Code 中打开 Vivado 工程，浏览文件和模块层级，跳转 RTL 定义。

## 核心功能

- **工程浏览**：选择 `.xpr`，查看文件树、模块层级并导出 filelist。
- **代码导航**：跳转模块、端口和信号，支持速览定义和引用查询。
- **开箱即用**：自带 slang-server，支持 Verilog / SystemVerilog。

## 开始使用

1. 在 VS Code 扩展面板选择 **从 VSIX 安装**。
2. 点击左侧 **FPGA Workbench** 芯片图标，选择 `.xpr`。
3. 打开 RTL 文件，使用下列快捷键浏览代码。

| 操作 | 功能 |
|---|---|
| `Ctrl + 单击` / `F12` | 转到定义 |
| `Alt + F12` | 速览定义 |
| `Shift + F12` | 查找引用 |
| 右键 → **FPGA: 速览定义（当前工程）** | 仅查看本工程结果 |

**环境**：Windows x64 · VS Code 1.96+。综合、实现和硬件下载仍使用 Vivado。

[详细使用说明](docs/USAGE.md) · [反馈问题](https://github.com/fpga-go/FPGA-Workbench/issues) · [MIT 许可证](LICENSE.txt)
