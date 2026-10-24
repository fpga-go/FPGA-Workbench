# FPGA Workbench · 工程导航

任意目录打开文件夹，选中.xpr，剩下的交给我吧。

在 VS Code 中打开现有 Vivado 工程，浏览文件、查看模块层级，跳转 Verilog/SystemVerilog 定义。

## 选中工程，即可导航

- **工程文件**：从 `.xpr` 读取文件集、路径、顶层、include 目录和宏定义；IP 归入所属的 `sources_1/ip`，源文件按实际目录逐级展开；导出 Filelist 时附工程信息及 IP 路径注释。
- **模块层级**：展开实例关系，点击模块进入源码。
- **长代码阅读**：使用 VS Code 原生 Sticky Scroll，将当前模块声明固定在编辑器顶部，单击标题返回声明行。
- **语法着色**：分别提供 Verilog / SystemVerilog 规则，覆盖宏、数值、实例、函数及常见 SV 类型和断言结构；颜色跟随当前主题。
- **定义与引用**：按住 `Ctrl` 并用鼠标左键点击：模块进入源码，信号列出本模块定义与引用，端口另列上一层实际实例的同名端口。模块名声明继续支持反查上层实例；右键 FPGA 速览菜单可查看实际连接信号。
- **切换与关闭**：在侧栏切换工程或关闭当前工程，保留已打开文件和未保存内容。

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
