# 远程 IDE 与方案演进

调研与归档基线：2026-10-29。此文解释设计取舍，不增加当前需求范围。code-server 的远程接入仍属于第二阶段未验证能力。

## 为什么桌面 VS Code 看起来只需要一个插件

VS Code 的远程开发有 UI 与远程扩展宿主之分。工作区扩展、语言服务和终端可以运行在远端，UI 留在本地。Coder 的 VS Code 扩展利用远程 SSH 能力连接工作区，远端仍有受管理的服务组件。

因此“用户只装一个入口插件”不等于“远端无需任何组件”。这支持一个中央入口加自动管理 helper 的产品方向，但不能证明 dsh 已有完整的远程扩展宿主，也不能把任意 Node FS／child_process 调用自动路由出去。

## code-server 并不自动继承桌面 Remote SSH

立项时核对的 code-server 官方 FAQ 明确列出 Microsoft Remote Extensions（SSH、Containers、WSL）不可用。桌面 VS Code + Coder 扩展的使用体验，不能直接作为中央 code-server 已具备相同能力的证据。

单份中央 code-server 要提供真正远程研发，必须同时证明：

- 文件对应正确环境，而不是中央镜像或同名目录。
- 终端、任务、Git、语言服务及工作区扩展在正确位置执行。
- 扩展／连接层的许可、浏览器兼容和升级路径可维护。
- 深链接经过认证与绑定检查，与 dsh 并发编辑时不覆盖未保存草稿。

仅有 FileSystemProvider 或 SSHFS 挂载，不等于终端与工具也远程化。“每工作区一个 code-server，再通过统一代理入口访问”也不符合用户的单份中央 IDE 目标。

## 方案演进记录

| 阶段 | 当时判断 | 当前处理 |
|---|---|---|
| 只看现有插件的本地假设 | 远端完整 dsh worker 更容易保留插件兼容性，即方案 B | 已被用户明确否决：每环境维护完整 dsh 成本过高，且状态并不自动集中 |
| 确认中央维护目标 | 方案 A：一个中央 dsh，文件与执行能力按环境路由 | 保持；接受必要插件适配或最小核心扩展 |
| 发现社区实现 | SSH/helper、文件、进程、PTY 已有可复用底座 | 不再按全部从零开发估算；先做固定版本兼容实验 |
| 明确移动端痛点 | Agent 通过会话操作，避免必须在 IDE 终端交互 | 会话优先；侧边栏承担基本编辑／搜索／Diff |
| 明确一套 IDE 的目标 | 需要传统研发时打开单份中央 code-server | 第二阶段独立可行性门槛，不阻断第一阶段 |

历史摘录中曾有“项目切换让相关会话一起切换”的宽泛表述。当前规范已经收紧：切换可见项目不修改已有会话、任务、终端或草稿的绑定；不能将旧表述用作迁移运行任务的依据。

## 产品边界为什么这样确定

用户管理的是项目和环境，不应靠记忆多个服务器地址。dsh 负责会话、任务、审批及结果；现有侧边栏用于日常查看与编辑，不在首期重造完整 IDE。手机可以全宽切换会话、文件、搜索和 Diff，而不是把桌面编辑器压进窄边栏。

隔离由容器／VM、挂载、账号、网络、凭据和资源策略提供。code-server 是 IDE，Coder 是控制面，两者本身都不是完整的隔离证明。中央部署与远端隔离是两个独立问题。

早期讨论中的搜索、编辑、Git 等功能描述是设计探索，不代表全部属于首期必需。尤其首期结构化 Git 的 P0 范围与 CLI 交互门槛，均以当前正式需求／场景文档为准。

## 来源

- [VS Code 远程扩展架构](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Coder VS Code 扩展](https://github.com/coder/vscode-coder)
- [code-server FAQ](https://coder.com/docs/code-server/FAQ)
- [dsh-code-server-app](https://github.com/jinsiyu/dsh-code-server-app)
- [历史研究摘录](evidence/historical-research-excerpts.txt)：包含方案比较和移动端目标讨论，不是现行规范。
- [当前决策](../06-decisions-and-risks.md)
- [当前 IDE 集成门槛](../04-integration-plan.md)

本轮只归档已有调查，没有验证任何新的远程 IDE 扩展方案。

返回[调研索引](README.md)。
