# 集成方案

版本：v0.4；首次核对日期：2026-10-29，复核日期：2026-10-30。下述源码／文档核对不等于安装验证。v0.3 → v0.4 的变更依据见[设计评审记录](07-design-review.md)。

## 1. 总体策略

采用“控制台连接器 + 社区远程工作区底座 + dsh 环境路由与侧边栏适配”，而不是重新实现完整远程协议。

```text
Coder REST：认证、发现、模板、创建／启动／停止、外部生命周期变化观察
                         |
模板登记与实例记录：templateVersion/generation -> binding
                         |
标准 OpenSSH 目标：由 Coder 支持的连接方式生成／确认
                         |
社区远程插件／受管 helper：FS、shell、subprocess、PTY
                         |
dsh 工具、Host API、文件引用、搜索、侧边栏 Git
```

所有箭头都需要真实验证。不能因为 SSH 可连接，就认定文件编辑、Agent、PTY、侧边栏和取消都已兼容。

## 2. 候选与已知事实

| 候选 | 已核对事实 | 本项目用途与限制 |
|---|---|---|
| `CrazyShout/dsh-ssh-remote` | GitHub 源码；MIT；系统 OpenSSH、版本化 Python helper；2026-10-30 复核：最新发布为 v0.13.3（2026-10-29），0.13.2／0.13.3 的 release-manifest 中 `dshVersions` 为 0.2.0-rc.2、0.2.1-rc.2、0.2.1-rc.3；TECHNICAL.md 亦称面向 0.2.0-rc.2 与 0.2.1-rc.2 | 优先兼容性验证候选；**rc.4 未列入 manifest，整体远端兼容仍未验证**。T-103 已通过显式入口的真实隔离文件 profile 启动、禁用／启用与整树卸载；未经包装的 Cordis 注册卸载失败仍保留，原始 bundle 不启用，见[隔离实验](implementation/t103-isolated-load.md)。不能据枚举遗漏推断安装必然失败，也不能以指定 profile 通过宣布完整底座可用；不直接改生产 |
| `xiray-xia/dsh-remote-vs` | 0.11.1，MIT；2026-10-30 复核 `package.json` 仍要求 dsh ^0.2.2-alpha.2；`src/pool.ts` 使用 ssh2，未处理 ProxyCommand／ProxyJump | 参考路由和侧边栏实现；当前组合须隔离验证，不因依赖差异预告安装必然失败；ssh2 连接不等于支持 OpenSSH ProxyCommand |
| `jinsiyu/dsh-code-server-app` | 集成 coder/code-server 编辑界面；并非 Coder 工作区控制面插件 | 第二阶段参考 IDE 入口和文件打开桥接，不作为远程执行底座 |
| Coder | 开源核心（AGPLv3）；控制台、REST、模板、工作区 Agent／SSH／Web 应用访问；外部 provisioner 页面标注 Premium | 管环境与连接；不能假定所有 Premium 能力免费，也不是代码隔离策略的替代物 |
| dsh | 首轮审计时安装 0.2.1-rc.4；2026-10-30 复核 npm 最新为 0.2.1-rc.5（2026-10-29 发布），alpha 通道为 0.2.2-alpha.2；后续已授权将本项目源码基线迁移到本机安装的 0.2.1-rc.5 | 按持续发布维护兼容快照，不永久停留历史版本；当前组合见[来源锁](../profiles/agent-studio-preview/sources.lock.json)，用[只读核对／候选工具](../scripts/dev/source-lock.mjs)列出差异，复核实现与投影回归后更新；不以元数据对齐代替真实兼容验收 |
| better-sidebar | 本机 0.28.2；`src/fs-tree.ts`、`src/fs-watch.ts`、`src/git.ts` 直接使用 Node FS、`fs.watch` 与本地 `git`；另有 `src/open-external.ts` 在本机 spawn 打开器 | 需改造或显式禁用远程模式入口 |
| OpenSandbox | Apache-2.0；生命周期／执行 API，Docker 和 K8s；主分支有基础 Console | 可作为未来平台适配器；不进入第一阶段双平台实现 |

上述版本只是核对基线，不是已经选定并验证的依赖锁。实施时记录仓库、提交／tag、发布资产、完整性和本地测试组合后再锁定。

### 安装来源必须核实

2026-10-30 复核：npm 同名 `dsh-ssh-remote` 仍为 0.1.5，仓库指向 `kkutysllb/dsh-kylin-ssh-tunnel`，不是 CrazyShout 的项目。

因此不允许仅凭包名执行安装。应核实目标资产和哈希，采用固定版本的可追溯来源；下载物放入独立目录，静态检查后才在隔离 profile 中安装，不直接替换生产依赖。

### 版本门（M1 前置）

版本门区分发布枚举、依赖约束和运行结果，不能由一个列表代替三者。

1. 记录固定 tag 的 `dshVersions`、peerDependencies、安装产物和来源。v0.13.2 的相关 peer 约束为 `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-rc.2 <0.3.0`；manifest 未枚举 rc.4 不等于实测不兼容，peer 范围允许也不等于实测兼容。
2. 优先在隔离 profile／测试实例验证当前 dsh 与候选组合，覆盖安装、服务解析及真实 FS／进程／PTY；不为了取得“列表内版本”先升级生产。
3. 出现具体符号、调用或依赖错误后，才比较升级 dsh、适配插件或更换候选版本；记录迁移与回滚范围，按 NF-05 验证。
4. 实跑前保持“待验证候选”；不能预告安装必然失败，也不能宣布底座已经可用。

## 3. Coder 控制面适配

### 最小能力

- 受保护地保存控制面连接和认证引用，校验当前身份与主体归属。
- 列出有权访问的工作区、模板和 Agent；保留平台真实 ID 与 build／实例世代。
- 创建受控模板工作区，启动、停止并观察构建与 Agent 状态。产品服务端必须校验允许的模板范围与版本；创建与启动两条链路均按 SC-02 验证。重建／销毁／凭据替换的产品入口待范围确认；未提供时服务端明确拒绝，仍须检测平台外部变化并按 SC-13 处理失效。
- 从工作区确定 SSH 目标；连接完成后验证实际 workspace、世代、根目录和运行策略标记。
- 将平台失败、权限失败、配额失败、Agent 不在线与执行通道失败分别呈现。
- 停止及后续获准启用的重建／销毁接口必须经过 FR-14 的授权与确认；未提供的接口服务端拒绝且无平台副作用。已执行动作和外部生命周期变化均同步到绑定、运行任务和待答请求的级联规则。

具体 HTTP 路径、字段和枚举由锁定版本的官方 API／客户端文档确定；本文没有发明通用 `createSandbox()` SDK，也不将 Coder API 当成跨平台统一标准。

T-104 已在用户授权后自行搭建固定 Coder 2.37.8 的本机 TLS 实验控制面、独立 PostgreSQL、lab-v3 模板及两个工作区；登录／API／数据库和实例身份对照通过，详见[部署与实验记录](implementation/t104-coder-lab.md)。Terraform `coder_agent.id` 与 REST Agent ID 实测不同，分别保存 resource reference 与 platformAgentId，再由当前 build resource／数据库关联。marker 属 UID 1000，不防同 UID 篡改；工作区 PID／磁盘限额和完整隔离仍未通过；T-105 的专用实验当前 SSH 通道／helper 门禁已通过独立复核，见[收尾清单](implementation/m1-closeout-tasks.md)。实验 allowlist validator 不冒充 T-202 的产品服务端创建接口。

### 模板与实例记录

模板不是部署备注，而是受版本管理的交付物（FR-13／SC-17）：

- 模板声明隔离、资源、允许根目录、运行账号、网络策略版本与镜像摘要。
- 模板在构建时生成随机实例标记，并把标记、workspace／agent ID、build、世代、模板版本写入可独立读取的构建记录；中央在项目访问开放前读取该记录。
- 中央保存 Template 与 InstanceRecord；绑定记录 `instanceGeneration` 与 `verifiedGeneration`。世代不符时拒绝派发。
- 模板版本、允许根目录或镜像变化必须产生新的可识别版本；已撤销或未获准的版本在允许范围校验中被拒绝，而不是靠 UI 隐藏；仍获准的回滚版本不因版本较旧而被拒绝。

### 多主机和 K8s

初始跨主机验证可采用 Coder 模板控制的两个远程 Linux Docker 目标；后续增加 K8s 模板并记录实际节点。两种模板共享上层环境接口，不为每种基础设施复制 dsh。

Coder 官方文档描述 Terraform Docker provider 通过 SSH／TCP 连接远程 Docker 主机；外部 provisioner 页面标注 Premium。首期不把外部 provisioner 当免费必需条件；若选定部署离不开付费能力，应在实施前更换路径或明确许可约束。

“添加一台机器”是配置受控基础设施／模板的过程，不承诺已有裸主机自动注册、负载均衡和故障迁移。

## 4. 连接层：先验证 Coder SSH 别名

Coder 官方 `coder config-ssh` 可以生成 OpenSSH 工作区条目；`--no-wildcard` 便于依赖具体 Host 条目的工具发现。

CrazyShout 插件的 `src/ssh-config.ts` 使用 `ssh -G` 获取有效配置，保留 Host 别名、ProxyCommand 和 ProxyJump。它与 Coder 的连接方式有可复用基础，但还必须验证实际执行路径，而不是只读到配置字段就宣布兼容。

连接验证顺序：

1. 从已认证的 Coder 控制面及冻结模板的构建记录取得预期身份，关联控制面、workspace ID、agent ID、构建／实例世代、独立生成的随机实例标记、允许的项目根目录、运行账号和策略版本。它们是本项目的核验记录，不是假定 Coder 原生具有这些同名字段。
2. Coder CLI／官方连接方式能在中央建立到目标工作区的非交互连接。
3. 经插件使用同一别名连接，正确处理 ProxyCommand、Host key 和认证。
4. 用最小只读探针获取目标预置标记、实际账号和目标目录事实，与步骤 1 的预期记录比对；身份通过后才引导正式 helper 和开放项目操作。
5. 上传／启动匹配 helper，验证其版本、能力、Python 依赖和校验和。
6. 独立执行随机文件写入／读回，再分别验证命令、PTY、取消、重连和停止后的拒绝行为。

身份验证与普通读写验证必须分开：

- 实例标记由模板构建过程在工作区可用前预置，期望值经构建记录取得。不能先通过待测 SSH 通道写入一个值，再原路读回并将其当成身份通过。
- 必须测试错误工作区、错误账号、错误根目录或过期实例记录。即使这些目标也能成功读写随机文件，身份不匹配仍必须阻断；测试只使用专用工作区和无敏感内容的标记。
- 工作区重建或实例世代变化后，旧身份探针结果失效，必须重新核验；旧任务不能仅凭相同路径或 PID 关联到新实例。
- Host key／官方连接链负责传输端身份认证，实例记录负责核对预期工作区映射。项目工具可写的普通标记文件不能证明环境未被恶意篡改；同 UID 风险仍按安全边界审计。
- M1 若无法形成独立可信的预期记录，应记录身份验证阻断，不能退化为“读写成功即目标正确”。

优先使用受控的 SSH 配置片段和连接缓存，避免覆盖用户全局配置。生成配置、首次 Host key 信任或登录是明确操作，不能自动忽略 Host key 检查。不得让模型输入决定任意 ProxyCommand 或中央执行器路径。

远端只要求模板提供的基础工具、Coder Agent 和自动管理 helper；不要求完整 dsh。helper 引导、缓存、校验和升级归中央版本策略管理，不成为逐机器人工维护的应用。

## 5. dsh 内部接入

### 5.1 版本契约先行

首轮审计时环境为 dsh 0.2.1-rc.4，当时发现安装类型与检出源码并非完全一致：FS 有 watch／字节范围能力，subprocess 的句柄与控制接口也存在差异。这是历史接口观察，不是永久要求保持 rc.4；源仓库 E2B POC 仍只能作设计参考，不可直接认定兼容。

当前已按后续授权将源码兼容快照迁移到 `0.2.1-rc.5`，以[来源锁](../profiles/agent-studio-preview/sources.lock.json)、实际安装接口及离线回归为依据，未重新安装或部署。后续正常跟进 DSH 发布：先用[来源核对工具](../scripts/dev/source-lock.mjs)检查版本与字节差异，再显式生成未验证候选、复核接缝和依赖变化并运行回归，最后更新快照；不把任何一个历史版本永久固化。新代码的来源对齐仍不等于运行兼容或 M1 验收。候选插件的声明范围若不包含实际版本，按第 2 节版本门区分声明与运行结果，不据列表遗漏宣称必然不兼容。

### 5.2 环境绑定和服务解析

- 在现有工作区／会话模型旁维护环境身份、实例世代和绑定版本，不用远程目录字符串代替身份。
- 若保留本地 anchor，限定为空的内部兼容目录；先核对受信任的工作区上下文与当前绑定，再转换内部 cwd。内部上下文的识别使用带外标记或专用登记 API，不靠路径比较。公开工具 cwd 只按目标环境路径解析，不用其查找 anchor 或选择环境；失效映射故障关闭。
- 在正确 Cordis context／realm 绑定 provider 与 consumer；覆盖 Agent 工具之外的 Host API、文件引用、搜索和侧边栏调用。
- 本地绑定走原 provider；远程绑定走目标执行世界。一个远程 provider 的异常不能被误解释为本地路径。
- 若插件接口不能覆盖工作区注册或 Host API，增加最小、可审查的核心扩展，不采用全局 monkey patch 拦截所有 Node FS。

### 5.3 文件、命令和工具

对照当前接口实现读取、写入、版本守卫、watch、搜索、受管进程、PTY 与清理。测试优先覆盖实际 dsh 模型请求中的工具目录和真实调用，不以仅有 provider 独立探针作为验收。

还需专门验证：

- 远端 `rg`／Git／解释器的发现，而非中央二进制绝对路径。
- cwd 存在性检查、文件引用 URI 和输出 spill 的所属环境。
- 后台作业身份、退出事实、取消和中央重启后的重查。
- ACP／Claude Code SDK／其他编程 CLI 的启动接口、平台载荷、环境变量及权限模式。
- PTY 的尺寸、信号、前台进程组、断线游标与清理（SC-14）。
- 同一绑定下的两条执行通道：候选 TECHNICAL.md 描述其同步桥接／本机传输 PID 与每进程 system SSH 兼容路由，正常模型 Shell 与终端走 helper；这不是所有 dsh 版本的句柄契约。本机 rc.4 的 `spawn()` 同步返回普通 `SubprocessHandle`，没有公开 pid；PTY 有独立接口与 pid。接口定位及指纹见[只读执行记录](implementation/m1-readonly-audit.md)，桥接是否兼容仍须隔离加载和真实调用验证。M1 核对当前组合实际存在和启用的路径；每条已启用通道分别验收取消与恢复，未启用路径必须拒绝。候选实现有两条通道不意味着产品必须交付两条。另须按架构的去重契约验证每种操作的安全重传，不能把上游“最多重放一次”直接当作副作用最多执行一次。

若某个已有子代理后端只能使用中央本地 cwd，优先做明确的受管远程运行适配器；不能声称“替换 subprocess 就全都兼容”。首期至少打通一个真实编程 CLI，其余按兼容矩阵开放或明确禁用。远程会话中的通用子代理、本地专用 CLI 和后台任务必须继承主会话的绑定 ID 与版本，否则拒绝启动。首期不提供显式授权后跨绑定委派的例外；另一个环境的任务从其对应会话发起，不能保留一个绕过路由的中央执行入口。

CLI 的“已支持”还必须满足架构文档的会话内交互契约：运行中实际权限请求和必要澄清可回传、在中央会话作答，并按 request ID／任务／绑定确认结果；批准启动不是批准所有后续动作。SC-12 覆盖批准、拒绝、澄清、超时、断线及旧响应拒绝；仅靠 PTY 输入或全局自动批准的后端不能通过此门槛。M2 可用桌面会话验证协议，M3 再于真实移动设备复用该链路。

### 5.4 侧边栏与其他插件

当前 better-sidebar 有直接 Node FS、fs.watch 和 child_process Git 调用；`src/open-external.ts` 还会在本机启动打开器。改造或上游协作的目标是让这些操作通过绑定环境接口，或按路由不变式显式禁用；也可评估 remote-vs 的远程标签页，但要核对其所需 dsh 版本。

优先级：

1. 当前环境文件树、打开、保存与 Diff。
2. 远端搜索与结果定位、选区引用。
3. Git status、工作树／暂存区 Diff 与文件变更监听；写操作遵循首期能力表，不将通用命令计为结构化支持。
4. 本机打开器、URL scheme 与快捷键的拦截或禁用；只隐藏按钮不算完成。
5. 其余插件逐个审计：纯 UI／中央会话插件通常无需迁移，直接操作宿主文件和进程的插件需要适配或显式禁用远程模式。

不在第一阶段重写完整 IDE，不同时保留多个相互冲突的文件真值或独立远程连接面板。

## 6. 第二阶段：单份 code-server 的可行性门槛

用户目标保持不变：从 dsh 点链接，进入一份中央 code-server，打开对应环境的项目。不能以“每个 Coder 工作区启动一个 code-server，再统一代理地址”替代。

但 code-server 官方 FAQ 明确列出 Microsoft Remote Extensions（SSH、Containers、WSL）不可用。因此桌面版 VS Code + Coder Remote 的行为不能直接当作 code-server 已支持的方案。

第二阶段单独验证一个受许可允许、可维护的 code-server 兼容远程扩展／连接方案，至少覆盖：

- 远程文件系统与项目身份，不是只把文件复制到中央。
- 远端终端、任务、Git、语言服务与扩展执行位置。
- 深链接的环境、根目录、文件和行号、授权检查与过期规则。
- 与 dsh 并发编辑时，分别验证受管保存冲突和 code-server 直接磁盘写入的边界；未实现全写入路径约束时不得声称三方任意竞争都无覆盖。
- 单份部署、浏览器限制、扩展许可与升级兼容性。

仅有 FileSystemProvider 能读文件，不足以完成传统远程研发；SSHFS 只挂载文件也不代表终端和工具远程化。若门槛未通过，应记录阻断并保留第一阶段独立可用，不偷偷转为每环境 IDE。

## 7. 复用和修改的工程边界

优先顺序是：公开接口组合 → 候选插件小范围适配／上游协作 → 必要的最小 dsh 核心扩展。只有在来源、兼容和安全验证后才决定是否 fork；记录许可与升级策略，避免维护多个互相分叉的远程协议。

实验已固定 SSH 0.13.3 的显式入口和 Coder 2.37.8／lab-v3 组合；T-105 已独立复验官方连接、当前通道身份门禁及真实 helper 0.13.1，但未选定最终生产矩阵，远程项目能力仍未验收。[执行路径与任务拆分](08-execution-plan.md)按契约、依赖和验收边界分解任务；T-106 的最小绑定 helper-RPC 适配层已独立复验通过；[T-107 逐门槛调查](implementation/t107-m1-investigation.md)已交付，NF-07 恢复／时限和实际打开器旁路仍阻断完整 M1，待独立门槛审核，T-201 不放行。不是重新等待 Coder 授权。非 Git 文件名发现和显式命令内容匹配使用经过独立摘要校验的每次运行私有 rg；冻结镜像缺依赖的部署缺口仍在。原生 `ctx.subprocess.spawn` 的本机 SSH PID 不能冒充远端生命周期；本次未完成产品主会话／provider 集成。不沿用“从零实现全部后端”的估算，也不承诺只装一个包就零改动完成。

## 8. 来源与核对范围

首次核对日期 2026-10-29；版本事实复核 2026-10-30。引用主分支的内容会变动，实施需锁定提交。

- [Coder 架构](https://coder.com/docs/install/plan/architecture)：控制面、Agent、工作区与 API。
- [Coder 远程 Docker provider 认证](https://coder.com/docs/admin/templates/extending-templates/provider-authentication)：SSH／TCP 远程 Docker。
- [Coder provisioners](https://coder.com/docs/install/operate/provisioners)：外部 provisioner 的 Premium 标记。
- [Coder config-ssh](https://coder.com/docs/reference/cli/config-ssh)：OpenSSH 配置与具体 Host 发现；`--no-wildcard` 生成逐工作区条目。
- [CrazyShout 插件](https://github.com/CrazyShout/dsh-ssh-remote)、[技术说明](https://github.com/CrazyShout/dsh-ssh-remote/blob/main/docs/TECHNICAL.md)、[发布](https://github.com/CrazyShout/dsh-ssh-remote/releases/tag/v0.13.2)：来源、helper、dshVersions、两条执行通道和本机打开限制。
- [OpenSSH 配置实现](https://github.com/CrazyShout/dsh-ssh-remote/blob/main/src/ssh-config.ts)：读取有效配置不等于连接已验收。
- [remote-vs](https://github.com/xiray-xia/dsh-remote-vs)、[package.json](https://github.com/xiray-xia/dsh-remote-vs/blob/master/package.json)、[FS 路由](https://github.com/xiray-xia/dsh-remote-vs/blob/master/src/p2/router-fs.ts)、[SSH pool](https://github.com/xiray-xia/dsh-remote-vs/blob/master/src/pool.ts)：版本、路由与 ssh2 边界。
- [dsh-code-server-app](https://github.com/jinsiyu/dsh-code-server-app)：编辑器集成，不是 Coder 控制面插件。
- [code-server FAQ](https://coder.com/docs/code-server/FAQ)：Microsoft Remote Extensions 不可用的许可／产品边界。
- [VS Code 远程扩展架构](https://code.visualstudio.com/api/advanced-topics/remote-extensions)：本地与远程扩展宿主，不能直接套用到 code-server。
- [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)：未来平台候选，不在首期双适配范围。
