# FPGA Workbench · 工程导航

任意目录打开文件夹，选中.xpr，剩下的交给我吧。

在 VS Code 中打开现有 Vivado 工程，浏览文件、查看模块层级，跳转 Verilog/SystemVerilog 定义。

## 选中工程，即可导航

- **工程文件**：从 `.xpr` 读取文件集、路径、顶层、include 目录和宏定义；IP 归入所属的 `sources_1/ip`，源文件按实际目录逐级展开；导出 Filelist 时附工程信息及 IP 路径注释。
- **模块层级**：展开实例关系，点击模块进入源码。
- **长代码阅读**：使用 VS Code 原生 Sticky Scroll，将当前模块声明固定在编辑器顶部，单击标题返回声明行。
- **缩略图标题**：输入 `fpga-mark` 插入中文标题。
  原生缩略图会放大显示该标题。
  `fpga-region` 插入可折叠的中文分区。
- **语法着色**：深色、浅色和高对比模式默认跟随当前主题。
  插件提供语法分类，主题决定具体颜色。
  Verilog 和 SystemVerilog 使用独立词法规则。
  原生括号配色区分 begin/end 嵌套层级。
  选中文字和选中背景沿用主题设置。
  `fpgaWorkbench.highlighting.mode` 可切换为 `fixed`。
  固定模式保留此前的深浅配色和选中注释色。
  运行“选择语法配色方案”可切换方案。
  `custom` 模式支持自定义深浅配色。
- **定义与引用**：按住 `Ctrl` 并用鼠标左键点击：模块进入源码，信号列出本模块定义与引用，端口另列上一层实际实例的同名端口。模块名声明继续支持反查上层实例；右键 FPGA 速览菜单可查看实际连接信号。
- **切换与关闭**：在侧栏切换工程或关闭当前工程，保留已打开文件和未保存内容。
- **语法检查**：默认关闭，可在左侧 Lint 中启用。
  手动检查优先使用已加载 XPR 的文件清单。
  工程内文件按当前语言选择检查范围。
  检查 Verilog/SV 时不启动 VHDL 编译器。
  工程检查无需先打开 HDL 文件。
  启用后，保存 HDL 文件会自动检查。
  支持 Verilog、SystemVerilog 和 VHDL 编译检查。
  自动查找 PATH 工具，也可手动指定工具文件。
  错误和警告在左侧分组显示。
  日志末尾分别汇总错误和警告。
  默认忽略 timescale 警告。
  工具需要单独安装，详见[语法检查说明](docs/LINT.md)。

## 三步开始

1. 在 VS Code 中打开任意工作文件夹，点击左侧 **FPGA Workbench** 芯片图标。
2. 选择 Vivado `.xpr`，工程可以位于工作区内或其他目录。
3. 点击文件开始编辑：`Ctrl + 鼠标左键` 跳转模块，或展开信号的本模块引用及上一层同名端口列表；点击列表中的位置即可查看源码。

同时安装其他 HDL 导航插件时，可使用右键菜单中带 **FPGA** 前缀的命令，只查询当前工程。

## Filelist 也可供其他工具使用

命令面板或“工程文件”侧栏菜单中的 **FPGA: 打开 Filelist Skill** 可打开安装目录内的 `skills/fpga-workbench-filelist/SKILL.md`。该目录包含独立导出脚本，可用 Node.js 20+ 调用，也可完整复制到其他工具支持的 skills 目录；不依赖运行中的 VS Code 或 Vivado。读取 XPR 的静态列表不等于 Vivado 编译顺序。

## 支持范围

当前安装包面向 **Windows x64 / VS Code 1.96+**，自带 slang-server，无需另装语言服务。定义跳转面向 **Verilog / SystemVerilog**；综合、实现、仿真和硬件下载继续使用 FPGA 工具链。

加密 IP、未生成的 HDL、缺失 include 或器件库可能影响导航。更多设置与限制见[使用说明](https://github.com/fpga-go/FPGA-Workbench/blob/v0.2.11/docs/USAGE.md)。

作者 **fpga-go** · 原始代码 **MIT** · [第三方许可](https://github.com/fpga-go/FPGA-Workbench/blob/v0.2.11/THIRD_PARTY_NOTICES.txt)

[仓库](https://github.com/fpga-go/FPGA-Workbench) · [问题](https://github.com/fpga-go/FPGA-Workbench/issues) · [许可证](https://github.com/fpga-go/FPGA-Workbench/blob/main/LICENSE.txt) · [主页](https://github.com/fpga-go/FPGA-Workbench/tree/develop#readme) · [市场](https://marketplace.visualstudio.com/items?itemName=fpga-go.fpga-workbench)

### 精简候选列表

默认使用原生跳转和候选列表。
选择 summary 后，才会打开只读候选页。
模块、参数和端口分别显示精简摘要。
点击“跳转到源码”可定位原文件。
`fpgaWorkbench.navigation.candidateList` 可切换显示方式。
设为 `native` 可恢复原生候选列表。
