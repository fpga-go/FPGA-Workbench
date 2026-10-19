# FPGA Workbench · 工程导航

任意目录打开文件夹，选中.xpr，剩下的交给我吧。

在 VS Code 中打开现有 Vivado 工程，浏览文件、查看模块层级，跳转 Verilog/SystemVerilog 定义。

## 选中工程，即可导航

- **工程文件**：从 `.xpr` 读取文件集、路径、顶层、include 目录和宏定义，可导出 Filelist。
- **模块层级**：展开实例关系，点击模块进入源码。
- **定义与引用**：跳转模块、端口和信号；区分实例连接中的子模块端口与父模块信号。
- **切换与关闭**：在侧栏切换工程或关闭当前工程，保留已打开文件和未保存内容。

![XPR 工程导航操作示意：选择工程、浏览文件和层级、跳转模块端口与信号](https://raw.githubusercontent.com/fpga-go/FPGA-Workbench/v0.2.2/media/navigation-overview.png)

*操作示意使用自拟模块和信号名。*

## 三步开始

1. 在 VS Code 中打开任意工作文件夹，点击左侧 **FPGA Workbench** 芯片图标。
2. 选择 Vivado `.xpr`，工程可以位于工作区内或其他目录。
3. 点击文件开始编辑：`F12` 转到定义，`Alt + F12` 速览定义，`Shift + F12` 查找引用。

同时安装其他 HDL 导航插件时，可使用右键菜单中带 **FPGA** 前缀的命令，只查询当前工程。

## 支持范围

当前安装包面向 **Windows x64 / VS Code 1.96+**，自带 slang-server，无需另装语言服务。定义跳转面向 **Verilog / SystemVerilog**；综合、实现、仿真和硬件下载继续使用 FPGA 工具链。

加密 IP、未生成的 HDL、缺失 include 或器件库可能影响导航。更多设置与限制见[使用说明](https://github.com/fpga-go/FPGA-Workbench/blob/v0.2.2/docs/USAGE.md)。

作者 **fpga-go** · 原始代码 **MIT** · [第三方许可](https://github.com/fpga-go/FPGA-Workbench/blob/v0.2.2/THIRD_PARTY_NOTICES.txt)

[仓库](https://github.com/fpga-go/FPGA-Workbench) · [问题](https://github.com/fpga-go/FPGA-Workbench/issues) · [许可证](https://github.com/fpga-go/FPGA-Workbench/blob/main/LICENSE.txt) · [主页](https://github.com/fpga-go/FPGA-Workbench/tree/develop#readme) · [市场](https://marketplace.visualstudio.com/items?itemName=fpga-go.fpga-workbench)
