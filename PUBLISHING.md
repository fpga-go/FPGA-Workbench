# 发布说明

本目录是独立发布副本。
源码仓库和发布归档以本目录为根。
不要包含上级目录或其他工程资料。

作者为 **fpga-go**。
联系邮箱为 **fpga_go@163.com**。

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
| 原创代码许可证 | `MIT` |

`publisher` 和 `name` 共同组成扩展标识。
介绍更新保留显示名和这两个值。
既有安装和扩展选项继续沿用。
Git 提交身份与 Marketplace 发布者分别配置。
发布状态以 Marketplace 实际结果为准。

源码仓库为 [fpga-go/FPGA-Workbench](https://github.com/fpga-go/FPGA-Workbench)。
`package.json` 记录仓库、主页和问题报告地址。

## 当前版本

| 项目 | 目标值 |
|---|---|
| 正式版本 | `0.2.11` |
| 平台 | Windows x64 |
| 打包分支 | `develop` |
| 源码标签 | `v0.2.11` |
| 正式基线 | `main` |

本版本沿用 0.2.9 已验收的功能。
验证范围见 [VERIFICATION.md](VERIFICATION.md)。
实际发布状态以 Marketplace 和 GitHub 为准。

发布前检查[分支与版本维护规范](docs/RELEASING.md)。
维护者批准每次合并和发布。
批准范围限于指定版本和分支。
合并必须遵循仓库保护规则。
没有批准，不得合并或发布。

| 分支 | 发布规则 |
|---|---|
| `develop` | 构建正式包 |
| `feature` | 仅发布 Pre-release |
| `main` | 同步正式基线，不直接打包 |

GitHub Release 必须附带以下文件：

- 对应版本的 `.vsix`。
- 对应 VSIX 的 SHA256 文件。

自动源码归档不能替代安装包。

## 初始化独立 Git 仓库

在本目录根目录打开终端。
目录没有独立 Git 仓库时，执行以下命令：

```powershell
git init
git config --local user.name "go"
git config --local user.email "fpga_go@163.com"
git rev-parse --show-toplevel
git status --short
```

`--show-toplevel` 的结果必须是本目录。
检查结果后再暂存文件。
这些身份配置仅作用于当前仓库。
这些命令不修改全局 Git 配置。
本说明不表示已执行这些命令。
本说明不表示已上传仓库。

首次暂存后，检查待提交文件：

```powershell
git add .
git diff --cached --name-only
git diff --cached --check
```

远程仓库使用上方 GitHub 地址。
发布副本不得加入以下资料：

- 个人工程。
- 原始测试记录。
- 旧归档。

## 构建和打包

在本目录执行以下命令：

```powershell
npm ci
npm test
npm run build
npm run package
```

正式打包命令仅允许从 `develop` 执行。
`feature` 预发布使用 `npm run package -- --pre-release`。
脚本拒绝以下打包请求：

- `feature` 正式包。
- `main` 发布包。
- 未知分支的发布包。
- 分离 HEAD 的发布包。

不得绕过打包脚本。
预发布和正式版使用不同版本号。
安装包写入 `output/`。
验证范围见 [VERIFICATION.md](VERIFICATION.md)。
构建 VSIX 不代表导航功能通过验证。

从本目录创建经过检查的源码 ZIP。
分发 VSIX 时，使用此目录重新构建的包。
不要复用其他目录的旧包。

从 `v0.2.10` 起，源码归档排除 output 产物。
规则来自已提交的 `.gitattributes`。
规则为 `output/** export-ignore`。
仓库保留历史安装包和旧标签。
不得改写历史文件。

仍须下载新源码归档。
检查归档中的实际文件。

## 检查实际归档内容

`.gitignore` 控制 Git 忽略规则。
`.vscodeignore` 控制 VSIX 排除规则。
规则不能代替实际归档检查。

源码 ZIP 须保留以下内容：

- 产品源码。
- 通用自动化测试。
- 构建脚本。
- 资源。
- 依赖锁文件。
- 发布文档。

VSIX 须保留以下内容：

- 扩展必需文件。
- 随包二进制。
- 使用文档。
- 第三方许可证。

两种归档不得包含以下内容：

- 个人 FPGA 工程。
- 演示工程。
- 工程缓存。
- 原始验证日志。
- 编辑器个人数据。
- 旧安装包。
- 依赖安装目录。
- `.git` 历史。

检查以下文本中的私有信息：

- 文档。
- 脚本。
- 清单。
- 构建后的 JavaScript。
- 机器可读文件。

检查范围包括以下内容：

- 个人绝对路径。
- 用户名。
- 主机信息。
- 工程名。
- 私有仓库地址。

检查 JSON 转义路径。
检查文件 URI。
检查百分号编码路径。

检查以下文件中的作者与 publisher：

- `package.json`。
- VSIX 清单。
- 构建文档。

发布身份必须符合本说明。
保留以下文件中的完整许可和来源记录：

- `LICENSE.txt`。
- `THIRD_PARTY_NOTICES.txt`。
- `vendor/` 下的组件许可。

不得删除第三方作者署名。

通用测试可以在临时目录创建输入文件。
这些测试产物不得进入源码 ZIP 或 VSIX。
归档完成后必须再次扫描。
不要只检查打包前目录。

## 许可和分发状态

原创代码采用本仓库的 MIT 许可证。
版权归 fpga-go。
许可正文见 [LICENSE.txt](LICENSE.txt)。
源码和安装包须保留完整版权声明。
源码和安装包须保留完整许可。

第三方组件遵循各自许可证。
必须保留这些声明。
GitHub 源码提交不代表 Marketplace 上架。
若更换原创代码许可证，更新以下内容：

- 清单。
- 许可文件。
