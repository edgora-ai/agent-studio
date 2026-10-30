# 社区插件与 dsh 契约调研

调研基线：2026-10-29。性质：发布信息、README、部分源码及当时安装产物核对；没有安装这里的社区远程插件，没有升级生产 dsh，也没有验证完整 Coder 接入。

## 候选版本与用途

| 候选 | 当时观察 | 复用方向与限制 |
|---|---|---|
| `CrazyShout/dsh-ssh-remote` | GitHub 0.13.2，MIT，系统 OpenSSH，版本化 Python helper | 优先验证的远程执行底座；文档描述文件、编辑、PTY、引用和恢复，不代表当前 dsh／侧边栏全部兼容 |
| `xiray-xia/dsh-remote-vs` | 0.11.0，MIT，要求 dsh >=0.2.2-alpha.2；默认分支 `master` | 文件／进程路由及 better-sidebar 远程页值得参考；不能直接安装到当时的 0.2.1-rc.4 |
| `jinsiyu/dsh-code-server-app` | 浏览器 IDE 集成，非 Coder 工作区控制面插件 | 第二阶段编辑器入口参考，不负责全链路环境路由 |
| `dsh-coder-preset` | 名称中的 coder 指编码预设 | 不能据名称认定是 Coder.com 平台连接器 |

这些是调查时的版本，不是最终依赖锁。没有核实到现成的“一体化 Coder 控制台 + dsh 全工具远程化”插件，并不等于证明社区中绝无此类项目。

### 同名 npm 包不是同一个项目

当时 npm 的 `dsh-ssh-remote` 是 0.1.5，仓库指向 `kkutysllb/dsh-kylin-ssh-tunnel`，不是 CrazyShout 的 GitHub 0.13.2。

CrazyShout 的 Release 提供 `dsh-ssh-remote-0.13.2.tgz`、`release-manifest.json` 和 `SHA256SUMS`。因此不能只凭包名安装；实施时从已核实的固定发布资产取包，记录来源与校验和，在隔离 profile 测试。这里没有复制或安装第三方发布包。

## OpenSSH 与 Coder 连接的复用点

CrazyShout 的 `src/ssh-config.ts` 当时使用 `ssh -G` 读取有效配置，并保留 Host 别名、ProxyCommand 和 ProxyJump。Coder 官方 `coder config-ssh` 可以生成标准 OpenSSH 工作区配置，`--no-wildcard` 有助于使用具体 Host 条目的工具发现。

这构成可实验的路径：中央 dsh → 远程插件 → Coder SSH 别名 → 工作区 helper。配置字段能被读取，不证明 ProxyCommand 实际启动、身份匹配、helper、文件、PTY、取消与重连都能运行。

remote-vs 的连接池使用 `ssh2`；当时检查的代码没有处理 OpenSSH ProxyCommand，不能将其当成系统 OpenSSH 的等价替代。其 FS 路由区分本地／远程，远程错误不直接在本地重试；但诊断模式及所用版本仍需锁定，不能把这次局部源码观察推广到所有入口。

## 当时的 dsh 安装基线

安装版本是 `0.2.1-rc.4`，安装目录与检出源码存在接口差异：

- 安装版 FS 多出 watch／字节范围读取接口。
- 普通 subprocess 句柄不再公开同步 PID，增加 control 通道；终端接口也存在差异。
- 源码中的 E2B 三包说明了“环境 owner + FS + subprocess／PTY”的适配思路，但不是已安装、已兼容的后端。
- 某个源码后端依赖同步 PID，不代表上游 ACP／SDK 协议永久不支持远程。

原始定位保留在历史研究摘录中，包括安装目录 `~/.npm-global/lib/node_modules/@deepseek-ai/dsh/` 和检出目录 `~/code/deepseek-harness/` 的文件与行号。它们是当时的路径证据；后续升级可能使行号失效。

## 需要适配的层，不只是 subprocess

### 服务解析与项目身份

提供方按 Cordis context／隔离 realm 解析，不是简单的全局替换，也不是已有的完整逐会话环境选择器。provider 与 consumer 必须在正确 group 内；Host API 或侧边栏可能仍解析到 Host realm。共享 preset 组合也不等于每个 session 自动拥有独立环境。

当时工作区注册还直接进行中央 `realpath/stat` 检查。cwd 只是一个执行世界中的目录，不是主机／工作区身份。当前产品采用显式绑定及必要的内部 anchor 兼容层；精确规则以正式架构为准。

### 文件、搜索、终端

远端适配必须覆盖元数据、稳定目标／版本、读写／编辑、监听、错误、取消和路径边界，不是只有上传下载。进程接口还需真实退出状态、原始协议管道、流式与有界输出、超时及受管清理；普通 exec 不能替代 PTY。

当时内置搜索路径会先解析中央 npm 包中的 ripgrep 绝对路径，再交给 subprocess。即使调用走了抽象接口，也不能把中央二进制路径直接发送到另一台机器。

### better-sidebar

当时静态核对发现：

- `src/fs-tree.ts:19-21` 直接使用 Node FS。
- `src/fs-watch.ts:20` 直接使用 `fs.watch`。
- `src/git.ts:14-17`、`:429` 直接启动本地 Git。

这些路径位于 `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/`。它们不会因为替换 Agent 内的 FS／subprocess 自动迁移。Windows 远程镜像路径的特例也不是通用远程工作区实现。

### 编程 CLI 后端

当时所读的 ACP／Claude Code SDK 后端存在中央 cwd 检查、PID 或平台载荷等假设；需要按实际安装版核对启动及控制契约。当前 v0.3 规范另外要求真实会话内审批／澄清和严格绑定继承；这些不是早期静态调研已经证明的能力。

## 工程判断的修正

早期只看到 dsh 的底层抽象时，对自建远程执行层的工作量估计偏大。发现社区插件后，方向修正为“复用已有文件／进程／PTY／helper，再补 Coder 控制面、项目绑定及兼容适配”。是否 fork、是否改核心及最终版本组合，必须由 M1 实验决定。

## 来源

- [CrazyShout 仓库](https://github.com/CrazyShout/dsh-ssh-remote)
- [技术说明](https://github.com/CrazyShout/dsh-ssh-remote/blob/main/docs/TECHNICAL.md)
- [0.13.2 发布](https://github.com/CrazyShout/dsh-ssh-remote/releases/tag/v0.13.2)
- [OpenSSH 配置实现](https://github.com/CrazyShout/dsh-ssh-remote/blob/main/src/ssh-config.ts)
- [remote-vs 仓库](https://github.com/xiray-xia/dsh-remote-vs)
- [版本要求](https://github.com/xiray-xia/dsh-remote-vs/blob/master/package.json)
- [FS 路由](https://github.com/xiray-xia/dsh-remote-vs/blob/master/src/p2/router-fs.ts)
- [连接池](https://github.com/xiray-xia/dsh-remote-vs/blob/master/src/pool.ts)
- [code-server 集成插件](https://github.com/jinsiyu/dsh-code-server-app)
- [Coder config-ssh](https://coder.com/docs/reference/cli/config-ssh)
- [历史原始报告](evidence/historical-research-excerpts.txt)：会话记录第 1744、1765、1932 行对应文本，含较详细的本地源码定位。

返回[调研索引](README.md)。
