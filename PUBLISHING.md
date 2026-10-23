# 发布说明

作者为 **fpga-go**，联系邮箱为 **fpga_go@163.com**。此目录是独立发布副本；源码仓库和发布归档应以此目录为根，不包含上级目录或其他工程资料。

## 发布身份

| 项目 | 当前值 |
|---|---|
| 插件作者 | `fpga-go` |
| 插件显示名 | `FPGA Workbench · 工程导航` |
| 扩展唯一标识 | `fpga-go.fpga-workbench` |
| 联系邮箱 | `fpga_go@163.com` |
| Git 提交用户名 | `go` |
| Git 提交邮箱 | `fpga_go@163.com` |
| 扩展清单中的 publisher | `fpga-go` |
| 原始代码许可证声明 | `MIT` |

`package.json` 中的 publisher 与 name 共同组成扩展标识。介绍更新保留显示名及这两个值，原有安装与设置继续沿用。Git 提交身份与 Marketplace 发布者是不同配置；发布状态以市场实际结果为准。

源码仓库：[fpga-go/FPGA-Workbench](https://github.com/fpga-go/FPGA-Workbench)。`package.json` 已填写对应的 repository、homepage 和 bugs 地址。

本次版本为 **0.2.9 / Windows x64 / Pre-release**，来源分支 `feature`，源码标签为 `v0.2.9`。商店更新使用已核对的预发布 VSIX；普通信号着色、模块顶部固定与导航功能的验证范围见 [VERIFICATION.md](VERIFICATION.md)。

发布前先核对[分支与版本维护规范](docs/RELEASING.md)。只有 `develop` 可以发布 Marketplace 正式版；`feature` 在 GitHub 和 Marketplace 均只能发布 Pre-release；`main` 暂不发布。GitHub Release 必须同时上传对应版本的 `.vsix` 和 SHA256 校验文件，自动生成的源码归档不能替代安装包。合并到 `develop` 须由用户在 GitHub 网页确认。

## 建立独立 Git 仓库

在**本目录根目录**打开终端。若此目录还没有独立 Git 仓库，可执行：

```powershell
git init
git config --local user.name "go"
git config --local user.email "fpga_go@163.com"
git rev-parse --show-toplevel
git status --short
```

确认 `--show-toplevel` 返回当前独立目录后再暂存文件。以上身份配置仅作用于当前仓库，不修改全局 Git 配置。本文列出操作步骤，不表示已执行 Git 初始化、配置或上传。

首次暂存后检查将要进入提交的文件：

```powershell
git add .
git diff --cached --name-only
git diff --cached --check
```

远程仓库使用上述 GitHub 地址。不要将个人工程、原始测试记录或旧归档补入发布副本。

## 构建和打包

在此目录安装依赖、执行验证并生成安装包：

```powershell
npm ci
npm test
npm run build
npm run package
```

上述正式打包命令只允许在 `develop` 执行。`feature` 测试版将最后一行改为 `npm run package -- --pre-release`。脚本拒绝 feature 正式包、main 发布包、未知分支及分离 HEAD；不提供绕过选项。已发布的预发布版本不能用同版本号转为正式版。

安装包生成在 `output/`。验证范围以 [VERIFICATION.md](VERIFICATION.md) 为准；生成 VSIX 本身不证明导航功能通过验证。

分发源码 ZIP 时，从此独立目录中经过审查的文件生成归档。分发 VSIX 时，使用此副本重新构建的安装包。不要复用其他目录中生成的旧包。

## 检查实际归档内容

`.gitignore` 控制 Git 忽略规则，`.vscodeignore` 控制 VSIX 排除规则；两者都不能代替对最终 ZIP 或 VSIX 的检查。

发布前检查文件列表和解压内容：

- 源码 ZIP 保留产品源码、通用自动化测试、构建脚本、资源、依赖锁文件和发布文档。
- VSIX 保留运行所需文件、随包二进制、用户文档及第三方许可证。
- 两种归档均不包含个人 FPGA 工程、演示工程、工程缓存、原始验证日志、编辑器用户数据、旧安装包、依赖安装目录或 `.git` 历史。
- 搜索文档、脚本、清单、生成的 JavaScript 和机器可读文件中的个人绝对路径、用户名、主机信息、工程名及私有仓库地址。注意 JSON 转义路径、文件 URI 和百分号编码路径。
- 核对 `package.json`、VSIX 清单及生成文档中的作者和 publisher，确认与当前发布身份一致。
- 保留 `LICENSE.txt`、`THIRD_PARTY_NOTICES.txt` 和 `vendor/` 下对应组件的完整许可及来源记录，不删除第三方作者署名。

通用自动化测试可以在运行时创建临时输入文件；这些运行产物应留在临时目录，不进入源码 ZIP 或 VSIX。最终归档应再次扫描，不能只检查打包前的目录。

## 许可和分发状态

原始代码沿用本仓库的 MIT 许可证，版权归 fpga-go。许可正文见 [LICENSE.txt](LICENSE.txt)，源码与安装包均保留完整版权及许可声明。

随包第三方组件遵循各自许可证，相关声明必须保留。GitHub 源码提交与 Marketplace 上架是独立步骤；后续更换原始代码许可证时，应同步更新清单与许可文件。
