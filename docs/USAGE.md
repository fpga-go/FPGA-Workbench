# FPGA Workbench 使用说明

在 VS Code 中选择 Vivado `.xpr`，浏览工程文件、编辑 RTL、查看模块层级，并跳转 Verilog/SystemVerilog 模块、端口和信号定义。

作者：**fpga-go** · 联系：[fpga_go@163.com](mailto:fpga_go@163.com)

Windows x64 安装包自带 slang-server v0.3.0，无需另装 Python、Ctags 或语言服务。插件负责编辑导航；综合、实现、时序分析和硬件下载继续使用 Vivado。

## 安装和开始使用

1. 在 VS Code 扩展面板右上角的 `…` 菜单中选择“从 VSIX 安装”，打开 `fpga-workbench-0.1.0-win32-x64.vsix`。
2. 打开日常使用的工作目录，点击左侧芯片图标 **FPGA Workbench**。
3. 点击“选择 Vivado 工程 (.xpr)”，选择工程。工程可以位于工作区内，也可以位于其他目录。
4. 展开“工程文件”查看文件集和目录，展开“模块层级”查看实例。点击文件或模块即可编辑。

“工程文件”标题栏的文件夹按钮用于**切换工程**，`×` 按钮用于**关闭工程**；右键工程名称也能执行这两个操作。取消选择会保留当前工程。关闭会清空两棵树、停止语义服务并清除工作区记住的工程；已打开文件和未保存内容保持原样。加载途中也可以关闭，之后可重新选择 `.xpr`。若选择的 XPR 读取失败，可刷新重试、切换或关闭。

选中的 XPR 保存在当前工作区状态中，优先按“工作区 → XPR”的相对路径恢复。侧栏工程节点和“查看工程路径与索引状态”显示路径及相对关系；跨盘符时保留绝对路径。

插件声明的最低 VS Code 版本为 **1.96**。最低版本及其他操作系统尚未完成全面兼容性回归。当前发布副本的验证范围见 [VERIFICATION.md](../VERIFICATION.md)。

## 跳转方式

| 操作 | 结果 |
|---|---|
| `Ctrl + 单击` 或 `F12` | 转到定义 |
| `Alt + F12`，或右键“速览定义” | 在当前编辑器中展开定义窗口 |
| 右键“FPGA: 速览定义（当前工程）” | 使用本插件当前 XPR 的查询结果展开定义 |
| `Shift + F12`，或右键“FPGA: 查找引用（当前工程）” | 查看符号的引用位置 |

对于 `child u_child (.clk(clk))`，点击 `child` 查看模块定义，点击左侧 `.clk` 查看子模块端口，点击右侧 `clk` 查看父模块的信号声明。默认由 slang 处理语义查询；内置结构索引支持常见模块、参数、非 ANSI 端口和实例路径。

同时启用 TerosHDL、slang 或其他 HDL 导航扩展时，VS Code 通用 F12 和速览窗口可能合并多个扩展的结果。需要只查看当前工程结果时，使用带 **FPGA** 前缀的右键命令。本插件不会自动修改其他扩展设置。

## 工程范围

- 文件树保留设计、IP、约束和仿真文件集，标记缺失文件、禁用条目和已生成的 IP 声明。
- 默认索引活动综合 run 指向的设计文件集及 BlockSrcs；可在侧栏菜单切换设计文件集和顶层。
- 默认不加入仿真文件；需要时启用 `fpgaWorkbench.includeSimulation`。
- XPR 中的 `$PPRDIR`、`$PSRCDIR`、`$PGENDIR` 等路径按当前 XPR 位置解析。
- 从 XPR 读取顶层、include 目录和宏定义；额外项通过插件设置补充。
- IP 使用精确路径找到的已有 stub 声明，避免同时索引同一 IP 的 stub 与仿真网表。
- “导出 Filelist”输出源文件清单，路径相对导出文件所在目录。清单保留静态选取顺序，不代表 Vivado elaboration 后的编译顺序，也不是完整仿真脚本。
- 语义服务的配置和 filelist 保存在 VS Code 插件存储区，不写入用户工程的 `.slang` 或 `.vscode` 设置。

## 设置和状态

| 设置 | 默认值 | 用途 |
|---|---|---|
| `fpgaWorkbench.backend` | `auto` | 优先启动语义服务；`builtin` 使用有限结构索引 |
| `fpgaWorkbench.slangPath` | 空 | 指定其他 slang-server 可执行文件的绝对路径 |
| `fpgaWorkbench.sourceEncoding` | `auto` | 先验证 UTF-8，失败时按 GB18030 解码，兼容常见 GBK/GB2312 源文件 |
| `fpgaWorkbench.includeSimulation` | `false` | 将仿真文件集加入索引 |
| `fpgaWorkbench.extraIncludeDirs` | `[]` | 额外 include 目录；相对路径以 XPR 所在目录为基准 |
| `fpgaWorkbench.extraDefines` | `[]` | 额外宏，例如 `SIMULATION`、`WIDTH=32` |
| `fpgaWorkbench.watchFiles` | `true` | 监听源文件和 XPR 在编辑器外的变动 |

修改配置后刷新工程。底部状态栏显示当前工程和后端；“查看工程路径与索引状态”在输出面板列出文件范围及问题。语义服务不可用时显示“结构索引”，层级树标为“未展开条件”；该模式不计算参数和宏条件。

索引读取现有 RTL，不转换磁盘编码。编辑器的显示和保存编码仍由 VS Code 控制。若中文注释显示异常，请在编辑器右下角选择与原文件一致的编码重新打开，再编辑和保存。

## 当前边界

加密 IP、未生成 HDL 的 XCI/BD、缺失 include、缺失器件仿真库，以及未纳入 XPR 的外部源文件，可能使层级或语义不完整。VHDL、XDC、BD 和 XCI 可从文件树打开；本版定义跳转面向 Verilog/SystemVerilog。

缺少模块时，先检查当前文件集、宏和 include 配置，再查看输出面板。多个同名定义可能返回多个候选位置。语义后端返回空结果时，不会使用未展开条件分支补出未经确认的跳转目标。

本版未将 Vivado IP 自动生成、完整 SystemVerilog/UVM 覆盖或 FPGA 功能验证列为已验证能力。导航成功不代表综合、仿真或硬件功能正确。

## 开发和验证

在项目根目录执行：

```powershell
npm ci
npm test
npm run build
npm run package
```

VSIX 输出到 `output/`。源码入口为 `src/extension.js`，工程解析、结构索引和语义服务分别位于 `src/xpr.js`、`src/indexer.js`、`src/slang.js`。

验证结果和未覆盖范围见 [VERIFICATION.md](../VERIFICATION.md)。准备上传源码或分发安装包时，按 [PUBLISHING.md](../PUBLISHING.md) 检查发布目录和归档内容。

## 参考和许可证

- [slang-server](https://github.com/hudson-trading/slang-server)：随包分发的语义后端。
- [TerosHDL](https://github.com/TerosTechnology/vscode-terosHDL)：参考工程和层级交互，未复制其 GPL 源码。
- [Digital IDE](https://github.com/Digital-EDA/Digital-IDE)：参考 FPGA 工程侧栏体验。
- [Verilog-HDL](https://github.com/mshr-h/vscode-verilog-hdl-support) 与 [SVLangserver](https://github.com/imc-trading/svlangserver)：比较语言支持与索引方式。

本项目原始代码沿用仓库的 **MIT** 许可证，版权归 **fpga-go**，见 [LICENSE.txt](../LICENSE.txt)。第三方组件保留各自许可证，见 [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) 和 `vendor/`。
