# 编译器语法检查

语法检查默认关闭。
左侧 FPGA Workbench 中提供 Lint 视图。
Lint 与工程文件、模块层级位于同一栏。
点击状态行可打开检查菜单。
启用后，保存 HDL 文件会自动检查语法。
插件自动查找 PATH 工具，也可手动选择工具文件。
优先顺序为 iverilog、Vivado xvlog、ModelSim vlog。
本次范围含 VHDL 时，自动模式跳过 Icarus。
错误和警告在 Lint 视图中分组显示。
“问题”面板也保留原有诊断。
点击诊断可跳到源码位置。
没有源码位置的消息保留在检查输出中。
状态栏只统计已定位的诊断。
语法着色与检查后端相互独立。

## 开始使用

1. 安装 Icarus、Vivado 或 ModelSim。
2. 加载 XPR，或打开已保存的 HDL 源文件。
3. 在左侧 Lint 中选择检查工具。
4. 点击状态行，选择“启用语法检查”。
5. 点击 Lint 标题栏的检查按钮。
6. 查看错误和警告分组。

插件不随包提供编译器。
工具缺失时，插件显示“检查未完成”。
修改 PATH 后，可能需要重启 VS Code。

命令面板提供以下命令。

- `FPGA: 语法检查开关与工具`：打开快捷设置。
- `FPGA: 启用语法检查`：开启检查。
- `FPGA: 关闭语法检查`：关闭检查并清除诊断。
- `FPGA: 检查当前文件或工程语法`：手动检查。
- `FPGA: 查看语法检查输出`：查看检查结果。
- `FPGA: 选择语法检查工具`：选择自动、PATH 或手动工具。
- `FPGA: 手动选择语法检查工具路径`：选择工具文件。

编辑器右键菜单也提供检查命令。
Lint 标题栏提供检查、工具选择和输出入口。
底部 Lint 状态项也显示当前检查结果。
点击状态项可切换开关和工具。
关闭状态下，手动命令也不会启动编译器。
开关保存在当前工作区的插件状态中。
重开同一工作区时，插件恢复该状态。
未保存过开关状态时，默认关闭。

## 查看诊断

Lint 视图分别提供“错误”和“警告”分组。
辅助定位消息显示在“信息”分组。
每组按文件整理诊断。
点击诊断可跳到源文件的对应行列。
错误组默认展开，警告组可以单独展开或折叠。
关闭检查或编辑源码后，旧诊断清除。
未完成的检查会显示原因，不作为检查通过。

## 选择工具

| 查找顺序 | 使用的工具 | 检查方式 |
|---|---|---|
| 1 | Icarus Verilog 的 `iverilog` | 空目标编译，启用警告 |
| 2 | Vivado 的 `xvlog`、`xvhdl` | 分别编译 Verilog/SV 和 VHDL |
| 3 | ModelSim 或兼容 Questa 的 `vlog`、`vcom` | vlib 建库，分别检查两类语言 |

Icarus 需要 11.0 或更新版本。
Icarus 使用 SystemVerilog 2012 模式。
ModelSim 和 xvlog 使用 SystemVerilog 模式。
VHDL 支持 `.vhd` 和 `.vhdl` 扩展名。
插件读取 XPR 中的逻辑库和 VHDL 2008 标记。
未标记的 VHDL 使用编译器默认标准或 VHDL 93。
独立 VHDL 文件没有 XPR 标记，使用相同规则。
ModelSim 库映射只写入检查临时目录。
此功能不增加 VHDL 导航或着色。
三个后端均不运行测试平台。
Vivado xvlog 不调用综合 Lint。
不同编译器的语言支持和警告规则不同。
Questa 尚未完成本版实机验证。

自动模式只需启用 Lint，无需选择工具。
点击 Lint 工具行可打开工具菜单。
菜单提供自动选择、PATH 工具和手动路径。
没有 PATH 工具时，仍可手动选择工具。
开关和工具路径保存在插件状态中。
这些操作不写入工作区设置。
已选的 PATH 工具消失时，插件自动回退。
手动指定的工具失效时，插件显示检查未完成。
手动模式不会静默切换到其他工具。
明确选择 Icarus 时，VHDL 检查会报告不支持。
Verilog/SV 范围不受工程内其他 VHDL 文件影响。
自动模式会查找具备 VHDL 编译器的兼容工具。
编译出错时，插件保留该工具的诊断。
它不会因为源码错误而换工具重试。

手动指定 Vivado xvlog：

1. 运行“FPGA: 手动选择语法检查工具路径”。
2. 选择 xvlog。
3. 选择 Vivado 的 `bin/xvlog.bat`。

也可选择 `bin/unwrapped/win64.o/xvlog.exe`。
插件将标准安装中的 bat 路径解析为实际 exe。
含 VHDL 时，插件查找同目录的 xvhdl。
ModelSim 使用同目录的 vcom、vmap 和 vlib。
配套工具缺失时，检查显示未完成。
取消选择或路径检查失败时，原选择保持不变。
重开同一工作区后，手动路径自动恢复。
选择“自动选择”可恢复 PATH 自动发现。

旧版的后端和工具路径设置不再参与选择。
启用状态也不再通过 `lint.enabled` 设置项保存。

## 可选高级设置

日常检查无需修改以下设置。

| 设置 | 默认值 | 用途 |
|---|---|---|
| `fpgaWorkbench.lint.ignoreTimescaleWarnings` | `true` | 忽略时间尺度警告 |
| `fpgaWorkbench.lint.verbose` | `false` | 显示完整编译命令 |
| `fpgaWorkbench.lint.runOnSave` | `true` | 保存时自动检查 |
| `fpgaWorkbench.lint.timeoutMs` | `30000` | 每个步骤的超时毫秒数 |

自动发现只读取 VS Code 继承的 PATH。
它不搜索磁盘中的其他安装目录。
只有 XILINX_VIVADO 环境变量时，不视为发现工具。
Windows 的 vlib 应与 vlog 位于同一目录。
缺少 vlib 时，ModelSim 不列入可用工具。
手动选择 vlog 时也检查同目录的 vlib。
Windows 的 xvlog 使用 PATH 中的标准 bin 目录。
插件识别该目录内的 `xvlog.bat`。
插件将该路径解析为实际 xvlog.exe。
插件不通过命令解释器拼接源码参数。
非标准 Vivado 布局可能需要另外设置环境。

仅手动检查时，关闭 `lint.runOnSave`。
底部菜单的关闭命令会停用所有检查。

## 时间尺度和输出

合法的 `` `timescale 1ns / 1ps `` 可以保留。
默认忽略时间尺度继承和缺失警告。
Icarus 同时关闭对应的警告类别。
错误的 timescale 语法仍会报告。
其他错误和警告保持检查。
辅助来源位置不再计入错误数量。

关闭 `lint.ignoreTimescaleWarnings` 可恢复该类警告。
默认输出源码数量、诊断和结果摘要。
每次检查结束后，日志末尾分别列出错误和警告。
日志开头和末尾显示本次语言及源码数量。
未检查的其他语言源码单独统计。
部分语言检查不代表整个混合语言工程通过。
已定位诊断带有文件路径和行列号。
无位置消息另列为未定位错误或未定位警告。
辅助定位信息单独列出。
原始编译输出保留在汇总之前。
检查未完成时，末尾保留失败原因。
手动检查不自动弹出输出面板。
点击“查看语法检查输出”可打开日志。
启用 `lint.verbose` 可查看完整命令参数。

## 检查范围

手动检查优先使用已加载 XPR 的文件清单。
工程成员按当前文件的扩展名选择语言范围。

| 触发场景 | 本次检查范围 |
|---|---|
| 工程内 `.v/.sv/.vh/.svh` 文件 | 工程 Verilog/SV 编译单元与头文件依赖 |
| 工程内 `.vhd/.vhdl` 文件 | 工程 VHDL 编译单元 |
| 手动检查时没有打开源码 | 整个 XPR 的 HDL 文件 |
| 手动检查时打开非工程成员 | 整个 XPR 的 HDL 文件 |
| 保存工程外的 HDL 文件 | 所保存的文件 |

保存触发使用所保存文件的语言。
当前编辑器切换不会改变待检查文件的语言。
检查 Verilog/SV 时，不调用 xvhdl 或 vcom。
没有源码编辑器时，仍可从侧栏检查整个工程。
清单只包含选中且启用的 HDL 文件。
本次范围内的源文件缺失时，检查显示未完成。
本次范围内的路径无效时，检查显示未完成。
其他语言的缺失或未保存文件不阻断本次检查。
保存工程成员时，检查工程中同语言的文件集。
保存工程外的文件时，只检查该文件。
插件复用工程源码、include 目录和宏定义。
现有 IP stub 可以参与检查。
插件不生成或升级 IP。
头文件通过引用它的编译单元接受检查。

未加载 XPR 时，插件检查当前源文件。
此时也使用 `extraIncludeDirs` 和 `extraDefines`。
相对 include 路径以工作区文件夹为基准。
没有工作区文件夹时，以源文件目录为基准。
独立头文件需要加载工程后检查。

检查读取磁盘内容。
范围内有未保存文件时，插件等待保存。
编辑内容会撤销旧诊断并取消旧任务。
连续保存会合并为一次检查。
结果对应最近一次检查的文件或工程。
编译产物写入临时目录，结束后清理。
编译过程不改写源码编码或 XPR。

## 检查边界

Icarus 忽略缺失模块，方便检查含 IP 的工程。
这不会证明 IP、端口连接或整个工程正确。
ModelSim vlog 和 Vivado xvlog 可能报告缺少库或模块。
工程静态文件列表不等于 Vivado 编译顺序。
包文件必须位于引用文件之前。
插件不启动 Vivado 推导编译顺序。
加密 IP、预编译器件库可能需要额外设置。
混合语言检查只编译源码，不验证跨语言绑定。
大量源码超过系统命令行长度时，检查会失败。
插件不会静默截断源码列表。

超时和工具启动失败不计为检查通过。
单步输出超过 2 MiB 时，插件取消检查。
编译成功不代表功能、CDC 或时序正确。
本版不运行仿真、综合、实现或硬件操作。

## 工具参考

- [Icarus 命令参数](https://steveicarus.github.io/iverilog/usage/command_line_flags.html)
- [Icarus 空目标](https://steveicarus.github.io/iverilog/targets/tgt-null.html)
- [ModelSim 命令参考](https://ww1.microchip.com/downloads/aemdocuments/documents/fpga/ProductDocuments/SupportingCollateral/modelsim_reference_manual_v101c.pdf)
- [AMD xvlog 说明](https://docs.amd.com/r/en-US/ug900-vivado-logic-simulation/Parsing-Design-Files-xvhdl-and-xvlog)
