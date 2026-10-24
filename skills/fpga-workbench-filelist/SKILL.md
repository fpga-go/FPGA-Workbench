---
name: fpga-workbench-filelist
description: 从已有 Vivado .xpr 只读导出静态 RTL Filelist。适用于不启动 VS Code 或 Vivado 的源文件清单导出；不提供 Vivado 编译顺序、IP 生成或仿真执行。
---

# FPGA Workbench Filelist

需要 **Node.js 20 或更新版本**。本目录随 VSIX 安装，包含独立脚本 `scripts/export-filelist.cjs`，无需安装 npm 依赖、VS Code 或 Vivado 即可运行。使用者可直接读取本文件，或把**整个技能目录**复制到其他工具支持的 skills 位置；不要仅复制 `SKILL.md`，不要擅自修改全局配置。

将下例中的技能目录、XPR 与输出路径替换为实际路径，并为含空格的路径保留引号：

```text
node "<技能目录>/scripts/export-filelist.cjs" --xpr "<工程目录>/design.xpr" --out "<已有输出目录>/design-sources.f"
```

脚本只读取工程，默认使用活动设计文件集及 BlockSrcs。RTL 路径相对于输出文件所在目录；Windows 跨盘路径保留绝对路径。输出头部包含工程、器件、XPR 记录的工具版本、导出时间与静态范围。它不启动 Vivado，不展开设计，不代表实际使用情况或 elaboration 后的编译顺序。

可选参数：

- `--fileset <名称>`：改用指定文件集。
- `--top <模块名>`：在头部记录指定顶层，不执行 elaboration 或筛除不可达模块。
- `--with-sim`：把活动仿真文件集加入静态范围。
- `--force`：允许替换已有的独立导出文件。默认拒绝覆盖；即使指定此项，也拒绝覆盖 XPR、工程登记文件和 IP 参考工件。
- `--help`：只显示用法。

输出父目录必须已经存在。参数错误或导出失败返回非零退出码；成功返回 `0`，警告写入标准错误输出。缺失源文件或 include 等警告应连同导出结果说明。

每个选中且启用的 XCI 及其推导的 `_sim_netlist.v` 路径仅作为注释，标记存在、缺失或未知；对应 IP stub 和仿真网表不会成为活跃条目。脚本不生成 IP。文件存在状态以读取 XPR 时的检查为准，候选路径存在也不证明 Vivado 已采用该网表。需要实际编译顺序或功能结论时，另行使用用户授权的 FPGA 工具链。
