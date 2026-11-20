# FPGA Workbench 使用说明

在 VS Code 中选择 Vivado `.xpr`，浏览工程文件、编辑 RTL、查看模块层级，并跳转 Verilog/SystemVerilog 模块、端口和信号定义。

作者：**fpga-go** · 联系：[fpga_go@163.com](mailto:fpga_go@163.com)

Windows x64 安装包自带 slang-server v0.3.0，无需另装 Python、Ctags 或语言服务。插件负责编辑导航；综合、实现、时序分析和硬件下载继续使用 Vivado。

## 安装和开始使用

1. 在 VS Code 扩展面板搜索 **FPGA Workbench**，确认发布者为 **fpga-go** 后安装正式版。新功能试用时可另选预发布版本；已有 VSIX 也可通过扩展面板右上角的 `…` →“从 VSIX 安装”打开。
2. 打开日常使用的工作目录，点击左侧芯片图标 **FPGA Workbench**。
3. 点击“选择 Vivado 工程 (.xpr)”，选择工程。工程可以位于工作区内，也可以位于其他目录。
4. 展开“工程文件”查看文件集和目录，展开“模块层级”查看实例。点击文件或模块即可编辑。

“工程文件”标题栏的文件夹按钮用于**切换工程**，`×` 按钮用于**关闭工程**；右键工程名称也能执行这两个操作。取消选择会保留当前工程。关闭会清空两棵树、停止语义服务并清除工作区记住的工程；已打开文件和未保存内容保持原样。加载途中也可以关闭，之后可重新选择 `.xpr`。若选择的 XPR 读取失败，可刷新重试、切换或关闭。

选中的 XPR 保存在当前工作区状态中，优先按“工作区 → XPR”的相对路径恢复。侧栏工程节点和“查看工程路径与索引状态”显示路径及相对关系；跨盘符时保留绝对路径。

插件声明的最低 VS Code 版本为 **1.96**。最低版本及其他操作系统尚未完成全面兼容性回归。当前发布副本的验证范围见 [VERIFICATION.md](../VERIFICATION.md)。

## 跳转方式

| 操作 | 结果 |
|---|---|
| 模块的 `Ctrl + 单击` 或 `F12` | 转到模块定义；模块名声明处反查上层实例 |
| 信号的 `Ctrl + 单击` 或 `F12` | 列出本模块定义和引用；模块端口另列上一层实际实例的同名端口 |
| 右键“FPGA: 速览本地定义与上层连接（当前工程）” | 使用当前 XPR 的本地定义和上层连接结果展开速览 |
| `Shift + F12`，或右键“FPGA: 查找引用（当前工程）” | 查看符号的引用位置 |

对于 `child u_child (.clk(clk))`，点击 `child` 查看模块定义，点击左侧 `.clk` 查看子模块端口，点击右侧 `clk` 查看父模块的信号声明。默认由 slang 处理语义查询；内置结构索引支持常见模块、参数、非 ANSI 端口和实例路径。

在信号声明或使用位置按 `Ctrl + 单击` 或 `F12`。
列表包含本地定义和本模块内绑定同一声明的引用。
模块端口另列上一层真实实例的同名端口连接。
例如在 `child` 内点击 `clk`，上层候选包含 `.clk(sys_clk)`。
列表不追加父侧 `sys_clk` 的其他引用。
其他模块或遮蔽作用域中的同名信号不混入。
普通内部信号只列本模块结果。

多位置使用 VS Code 的多目标导航机制，默认展开速览；如果用户把 `editor.gotoLocation.multipleDefinitions` 改为 `goto`，通用操作遵循该设置。右键“FPGA: 转到定义与信号引用（当前工程）”明确打开信号候选速览。Ctrl+单击与F12共用定义入口，因此信号列表同时适用于两者。模块名进出和普通单击编辑保持。

主要操作为 `Ctrl + 鼠标左键`：模块跳转，信号展开本模块引用和上一层同名端口。点击候选列表中的位置查看源码，无需切换到另一个组合快捷键。

单行具名端口连接显示完整的 `.端口名(连接表达式)`。
原生速览高亮整条连接，光标定位到连接起点。
对齐空格或 Tab 不会挤掉候选中的端口名。
同一连接内的重复命中合并为一条候选。
同行的不同端口连接分别保留。
跨行、位置和隐式连接保持原有信号定位。

查看父侧连接时，在端口声明或使用位置打开右键菜单。
选择“FPGA: 速览本地定义与上层连接（当前工程）”。
本地定义排在首位，上层实例连接追加在列表中。
例如 `.clk(sys_clk)` 显示该端口及实际连接信号。
切片和拼接保留完整表达式，多个实例分别列出。
隐式 `.clk` 使用该连接的信号位置。
插件不猜测空连接、宏或预处理条件中的未知表达式。

语义模式只使用实际展开实例。Ctrl+单击的上层条目要求唯一、无条件的同名具名端口；位置连接、`.*` 或无法确认的端口来源不补造目标。FPGA连接速览遇到条件分支或重复连接而不能确认来源时，只提供已确认的实例位置。结构模式不猜测宏和 generate 条件。VS Code 原生右键“速览定义”使用上述默认信号候选；FPGA速览菜单用于实际连接表达式。

插件不再绑定 Alt+F12，也不修改 VS Code 自带或用户自定义的快捷键。

同时启用 TerosHDL、slang 或其他 HDL 导航扩展时，VS Code 通用 F12 和原生速览窗口可能合并多个扩展的结果。需要只查看当前工程结果时，使用带 **FPGA** 前缀的右键命令。本插件不会自动修改其他扩展设置。

## 长代码阅读与着色

加载工程后，向下滚动较长的模块，VS Code 原生 **Sticky Scroll** 会将模块声明所在行固定在顶部；用鼠标左键单击标题即可返回声明处。本版提供 `module` 的完整文档符号范围，大纲中的模块名称仍指向模块名。

顶部固定遵循 VS Code 设置。需要启用时，在设置中搜索 **Sticky Scroll**，打开 **Editor › Sticky Scroll: Enabled**。插件不会修改用户的开关或显示行数。模块内部未保存的编辑也用于更新范围；关闭工程后停止提供该工程的模块符号。

`.v/.vh` 使用 Verilog 着色，`.sv/.svh` 使用独立的 SystemVerilog 着色。规则覆盖注释、字符串、数值、宏、模块与实例、函数/任务，以及 SV 的 `interface/modport`、`package/class`、`typedef/enum/struct`、断言和序列等结构。文件右下角的语言模式决定使用的规则。

深色、浅色和高对比模式默认跟随当前主题。
插件提供语法分类，主题决定具体颜色。
主题模式不覆盖正文、注释或选中文字颜色。
背景和选中背景继续使用编辑器当前设置。

在设置中搜索 `fpgaWorkbench.highlighting.mode`。
修改该项后立即生效，无需重新加载窗口。

| 值 | 配色行为 |
|---|---|
| `theme`，默认 | 跟随当前主题，不应用插件固定前景色 |
| `fixed` | 使用此前的固定配色，按深浅类别选择色板 |
| `custom` | 使用自定义颜色，未填写类别沿用固定配色 |

也可运行“FPGA Workbench: 选择语法配色方案”。
选择“旧版固定配色”可恢复此前的颜色。
再次选择当前方案会重新应用颜色。
存在工作区覆盖时，命令更新工作区设置。
其他情况更新用户设置。
“编辑自定义颜色”会打开配色设置。

自定义示例：

```json
{
  "fpgaWorkbench.highlighting.mode": "custom",
  "fpgaWorkbench.highlighting.lightColors": {
    "comment": "#008000",
    "declaration": "#0000FF",
    "type": "#267F99"
  },
  "fpgaWorkbench.highlighting.darkColors": {
    "comment": "#6A9955",
    "declaration": "#C586C0",
    "type": "#569CD6"
  }
}
```

颜色格式为 `#RRGGBB`。
可设置类别为 text、comment、string、number。
其他类别为 declaration、type、assignment、keyword。
模块、函数和宏分别为 module、function、macro。
自定义模式的选中文字沿用主题字色。
切换方案不会移除已填写的自定义颜色。

没有颜色时，先确认文件的语言模式。
语言模式应为 Verilog 或 SystemVerilog。
再运行配色命令，选择“旧版固定配色”。
失败原因会显示在 FPGA Workbench 输出中。
本项没有 auto 选项。
工程后端的 auto 不控制语法配色。

固定模式无需安装其他主题扩展。
该模式区分模块声明、数据类型、赋值和流程控制。
reg、wire 和 logic 属于数据类型组。
assign 属于赋值组。
if、case 和 always 属于流程控制组。
固定模式的选中注释保留绿色特征。
其他选中文字使用主题默认字色。
各分栏独立处理自己的选区。
自定义主题可能需要另外检查对比度。
切回主题模式会移除旧颜色和注释选中色。
插件不自动修改主题或全局配色设置。

begin/end 使用原生括号配对着色。
同一对关键字使用相同颜色。
相邻嵌套层级循环使用不同颜色。
层级颜色使用编辑器主题的括号配色。
层级着色遵循原生括号配色开关。
插件不修改该开关。
注释、字符串和普通标识符不参与配对。
词法配对不展开宏或计算预处理条件。

未加载 XPR 时也能使用 HDL 着色。
文件的语言模式须为 Verilog 或 SystemVerilog。
编辑、滚动和切换主题时自动更新。
固定模式中，同一文档的分栏共享词法计算结果。
未保存文本也用于计算。
多行注释和字符串继承前文状态。

固定模式中，普通信号使用固定正文色。
该模式为关键字、数字、字符串和注释分别配色。
该模式也为明确的模块类型和函数独立配色。
词法着色不推断信号读写或时钟角色。
导航仍按当前工程查询。
工作区信任要求保持原有设置。

## 右侧缩略图标题

中文标题由 VS Code 原生缩略图显示。
无需安装其他注释插件。
普通中文注释不会自动放大。
标题需要使用大写 MARK 标记。

```verilog
// MARK: 接收状态机
```

在补全列表选择 `fpga-mark` 可插入该片段。
也可通过“插入代码片段”选择“FPGA 缩略图标题”。
该片段适用于 Verilog 和 SystemVerilog。

`fpga-region` 可插入折叠分区。
分区标题也会显示在缩略图中。

```verilog
// #region 接口与寄存器

// #endregion
```

显示遵循缩略图开关和标题开关。
字号遵循原生分节标题字号设置。
插件不修改这些设置。
插件不自动改写已有注释。
插入片段属于显式编辑，可直接撤销。

## 工程范围

- 文件树按设计、约束和仿真文件集组织。能够确认所属设计文件集的 IP 放入该集的 `ip` 目录；例如 `sources_1/new/xx_dir/xx.v` 与 `sources_1/ip/core/core.xci` 按实际目录逐层展开，IP 不再与 `sources_1` 并列。
- 目录仅由 XPR 引用的文件建立，不扫描并加入其他文件。缺失文件、禁用条目和已生成的 IP 声明保留状态；同一路径的 IP 记录合并显示，提示中保留各文件集的启用状态。无法确认归属的 IP 文件集继续独立显示，外部文件保留路径分组。
- 默认索引活动综合 run 指向的设计文件集及 BlockSrcs；可在侧栏菜单切换设计文件集和顶层。
- 默认不加入仿真文件；需要时启用 `fpgaWorkbench.includeSimulation`。
- XPR 中的 `$PPRDIR`、`$PSRCDIR`、`$PGENDIR` 等路径按当前 XPR 位置解析。
- 从 XPR 读取顶层、include 目录和宏定义；额外项通过插件设置补充。
- IP 使用精确路径找到的已有 stub 声明，避免同时索引同一 IP 的 stub 与仿真网表。
- “导出 Filelist”输出源文件清单，路径相对导出文件所在目录，跨盘保留绝对路径。头部记录实际输出路径、工程名、XPR、器件、XPR 中记录的 Vivado 版本、导出时间、顶层、文件集和范围。
- IP 的 XCI 原始路径、解析路径及 `<工程名>.gen/<设计文件集>/ip/<IP名>/<IP名>_sim_netlist.v` 候选路径仅以注释输出，附加载 XPR 时的存在状态。精确匹配的 IP stub 和仿真网表不再写入活跃路径；导航仍使用原有 stub。候选路径存在不代表网表已被选择或完整生成。
- 清单保留静态选取顺序，不代表 Vivado elaboration 后的编译顺序，也不是完整仿真脚本。
- 语义服务的配置和 filelist 保存在 VS Code 插件存储区，不写入用户工程的 `.slang` 或 `.vscode` 设置。

## 提供给其他工具的 Filelist Skill

VSIX 内包含标准目录 `skills/fpga-workbench-filelist/`，其中有 `SKILL.md` 和自包含脚本 `scripts/export-filelist.cjs`。在命令面板或“工程文件”侧栏菜单运行 **FPGA: 打开 Filelist Skill**，即可找到当前安装副本里的实际路径，无需先加载工程。

其他工具可以读取该 `SKILL.md` 并调用脚本；也可以把整个 `fpga-workbench-filelist` 目录复制到其支持的 skills 位置。不同工具的自动发现方式不同，插件不会修改其他工具的全局配置。

脚本需要 Node.js 20+，不需要启动 VS Code、Vivado，也不需要安装 npm 依赖。将下面的 `<Skill目录>` 替换为实际目录：

```powershell
node "<Skill目录>/scripts/export-filelist.cjs" --xpr "D:/design/project.xpr" --out "D:/exports/project.f"
```

输出路径的父目录须已存在。可用 `--fileset`、`--top` 和 `--with-sim` 调整范围；已有输出默认不覆盖，显式 `--force` 也不能覆盖 XPR、工程输入或已知 IP 工件。完整选项和边界以随包 `SKILL.md` 和 `--help` 为准。

## 设置和状态

语法检查默认关闭。
左侧 Lint 与工程文件、模块层级位于同一栏。
点击 Lint 的状态行可开启检查。
手动检查优先使用已加载 XPR 的文件清单。
工程内文件按当前语言选择检查范围。
Verilog/SV 检查不因其他 VHDL 文件而阻断。
工程检查无需先打开 HDL 文件。
支持 `.v`、`.sv`、`.vhd` 和 `.vhdl` 源文件。
启用后，保存 HDL 文件会触发语法检查。
插件自动从 PATH 查找编译器，也可手动选择工具文件。
优先顺序为 iverilog、Vivado xvlog、ModelSim vlog。
本次范围含 VHDL 时，自动模式选择兼容工具。
VHDL 检查使用 xvhdl 或 vcom。
明确选择 Icarus 时，VHDL 检查显示不支持原因。
开关和工具选择保存在插件状态中。
错误和警告在 Lint 中分组显示。
点击诊断可跳到源文件的对应行列。
“问题”面板也保留原有诊断。
检查输出末尾分别汇总错误和警告。
timescale 警告默认忽略。
检查命令、工具路径和范围见[语法检查说明](LINT.md)。

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

信号内部引用按当前源文件中模块的范围筛选。跨 include 文件的模块片段、结构索引尚不能确认的复杂语法或隐式连接的多重定义，可能不提供完整的内部引用列表；此时保留已确认的定义，不执行全文同名搜索。端口上一层结果通过实际实例关系补齐，不依赖语言服务返回的全局引用是否完整。

本版未将 Vivado IP 自动生成、完整 SystemVerilog/UVM 覆盖或 FPGA 功能验证列为已验证能力。导航成功不代表综合、仿真或硬件功能正确。

## 开发和验证

在项目根目录执行：

```powershell
npm ci
npm test
npm run build
npm run package
```

VSIX 输出到 `output/`，文件名自动采用 `package.json` 中的版本号。`feature` 测试版使用 `npm run package -- --pre-release` 打包；分支和发布规则见 [版本维护](RELEASING.md)。源码入口为 `src/extension.js`，工程解析、结构索引和语义服务分别位于 `src/xpr.js`、`src/indexer.js`、`src/slang.js`。

验证结果和未覆盖范围见 [VERIFICATION.md](../VERIFICATION.md)。准备上传源码或分发安装包时，按 [PUBLISHING.md](../PUBLISHING.md) 检查发布目录和归档内容。

## 参考和许可证

- [slang-server](https://github.com/hudson-trading/slang-server)：随包分发的语义后端。
- [TerosHDL](https://github.com/TerosTechnology/vscode-terosHDL)：参考工程和层级交互，未复制其 GPL 源码。
- [Digital IDE](https://github.com/Digital-EDA/Digital-IDE)：参考 FPGA 工程侧栏体验。
- [Verilog-HDL](https://github.com/mshr-h/vscode-verilog-hdl-support)：基础 Verilog/SV 着色规则来源；固定提交、原授权与本地补丁见源码 `syntaxes/UPSTREAM.json`、`syntaxes/README.md` 及随包第三方通知。
- [Verilog-HDL](https://github.com/mshr-h/vscode-verilog-hdl-support) 与 [SVLangserver](https://github.com/imc-trading/svlangserver)：比较语言支持与索引方式。

本项目原始代码沿用仓库的 **MIT** 许可证，版权归 **fpga-go**，见 [LICENSE.txt](../LICENSE.txt)。第三方组件保留各自许可证，见 [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) 和 `vendor/`。

## 精简候选列表

默认使用原生候选列表，不打开只读候选页。
以下候选页功能仅在 summary 模式下启用。
Ctrl+左键和 F12 保留原生跳转入口。
有多个候选时，跳转会打开候选页。
只有一个实例候选时，也会显示摘要。
只有一个模块定义时，直接跳到源码。

| 选中对象 | 实例摘要 |
|---|---|
| 模块 | `module_name #() u_inst_name (` |
| 参数 | `module_name #(.ADDR_WIDTH(11)) u_inst_name` |
| 端口 | `module_name u_inst_name (.i_data(w_data))` |

没有参数覆盖的模块摘要省略 `#()`。
参数摘要对应具名参数覆盖。
本地声明只显示模块名、类别和符号名。
摘要不会改写源码。

点击候选行上方的“跳转到源码”。
也可在候选行按 Ctrl+左键或 F12。
跳转会选中真实实例名、参数名或端口名。
按钮旁显示文件名和行号。
关闭 CodeLens 后，仍可使用 Ctrl+左键或 F12。
源码修改后，请返回源码重新查询。
关闭或刷新工程后，旧候选项也会失效。

设置项为 `fpgaWorkbench.navigation.candidateList`。

| 值 | 行为 |
|---|---|
| `summary` | 使用只读精简候选页 |
| `native`，默认 | 使用原生候选列表 |

修改设置后，下次查询生效。
插件不会修改日常编辑器设置。
候选页不替换真实文件的内容。
