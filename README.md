# Agent Studio

以会话为中心、统一管理本地与远程隔离开发环境的工作台。

**当前状态：已按授权完成 SDK／Gateway `0.2.1-rc.5` 来源基线迁移与可重复升级入口，并把开发预览重启到 rc.5；D01／D04／D05／D06 原 UI 通过，D02／D03 远端原 UI 在通道恢复后通过；D08 单任务同 Host 真实恢复执行一次并通过（合成程序、单次 detach/recover、无重放）。仍为 WIP，非验收／发布。D07 最终两次综合实跑失败、历史根因未全定位（2026-11-02 中断已定位为远端 Coder agent 连接断开，不回溯改写历史）；跨 Host／崩溃／restart 窗口恢复未验证。13 条历史 unknown（及其后 9 条远端不稳新增记录）不改写；M1-10 归一化旁路已由独立复验在声明技术范围关闭，但 M1 已于 2026-11-02 在声明技术范围由协调者放行，T-201 已启动（未交付／未验收）；review2 归档仍不完整。**

2026-10-30 开发例外：按可运行优先完成限定实现验证，**不是完整 T-201、M2 或发布的正式验收通过：M1 已在声明技术范围放行，T-201 仅启动做差距分析、尚未交付；review2 归档不完整，不等于完整独立 review3**。当前能力与延期项见[开发账本](docs/implementation/development-ledger.md)，下文既有 M1 进度和测试数字保留为历史记录。

上一轮处理三项本地收口：broker／transport 的超时、输出与最终清理边界；当前验证脚本的 schema 版本漂移；D08 合成命令的单行安全传输及实际原生 Terminal tab 接线。实现与离线结果见[开发账本第 15 节](docs/implementation/development-ledger.md#15-继续推进后的本地收口未部署未重跑真实恢复)。该轮未运行会重启预览或派发远端任务的 integration／browser 脚本，未提交／推送改动。

**rc.5 运行态与 UI 回归**：本轮先把 WIP 快照本地提交（未推送），在随机临时根验证 launcher `prepare` 的 rc.5 全链路投影（幂等、临时根已删），随后重启现有开发预览到 rc.5。运行预览必须在不限制 `/dev/ptmx` 的环境中启动；在受限文件沙箱内启动会使原生终端 `forkpty` 失败，这是启动环境限制，不是产品缺陷。原 UI 回归：**D01 通过；D04 local 11 项通过；D05 7 项通过（显式离线协议 fixture，非真实 LLM）；D06 7 项通过**；最初 D02／D03 远端因 `helper-call-disconnect` 未通过、D08 未执行，失败记录保留；随后远端恢复，D02／D03 远端原 UI 与 D08 单任务同 Host 恢复均执行并通过，详见[账本同节](docs/implementation/development-ledger.md#rc5-运行时原-ui-回归2026-11-02未验收)。

**SDK 持续升级基线**：按后续授权，已将 SDK／Gateway 的[来源锁](profiles/agent-studio-preview/sources.lock.json)迁移到当前安装的 `0.2.1-rc.5`，并复核更新 3 份 package manifest 摘要；**98/98 个受控资产、6 个包版本及原生 Terminal stock patch 均匹配，上一轮 rc.4／rc.5 的来源一致性阻断已解除**。锁记录的是可持续更新的兼容快照，不要求 DSH 永久停留在历史版本；其他包独立记录版本，不强行与根 SDK 同号。来源一致不等于完整兼容、部署或恢复验收；本轮没有安装依赖、执行 prepare／start 或重启预览。

## 截至 2026-10-31 暂停快照（历史，以下不是本轮执行指令）

- **暂停范围**：已清除自动持续开发目标。本次只更新状态、准备源码／测试／受控 profile／infra 与脱敏文档证据的 WIP 版本快照；不修 D08、不启动 UI 重试／新远端负载／断连实验，不重启预览或 D05 常驻 fixture。下文运行命令是已有实现的手动参考，**不是当前自动执行指令**。
- **D07**：真实只读发现、环境 API 与原 UI 新连接有通过证据；最终综合检查及唯一一次复测都失败，均未完成首项检查。历史 SSH255 与 helper timeout/EOF 的根因未全定位，TTL 守卫离线通过不能回写旧失败。[D07 阶段证据](docs/implementation/evidence/d07-environment-stage-selftest.json)不变。
- **D08**：恢复状态／私有 token 引用／固定受绑定身份探针／接口与部分 UI 接线已有初版；只读预检 6 项通过只证明连接、身份、能力与迁移，不是实际恢复。首轮原终端输入中的 Python 换行被 textarea 去掉，`SyntaxError` 退出 1；原 operation 已经原生 close 确认 `released`。尚未断开 transport、未做恢复、无 UI 重试；实际 native terminal tab 的恢复入口只定位到接缝，**未补接**，测试脚本也未修复该输入缺陷。
- **进程与数据**：暂停前最后只读 SQL 观察 `pending/running=0`；这不证明 13 条 unknown 的远端进程全部停止。旧身份、失败产物和 unknown 不重放／不重置。D05 常驻 fixture 保留，真实 Coder 生命周期请求为 0；真实外部模型／编程 CLI 未调用或验收，正式 M1／后续阶段门禁仍未通过。
- **开发机状态仅为当时观察**：预览 PID `1914320`、动态回环 `http://127.0.0.1:39261`，不是固定配置、远程可访问入口或当前在线保证。私有认证入口仅提供文件路径 `/home/ubuntu/workspace/agent-studio/.preview/agent-studio/login.url`，不发布其内容、token 或 cookie。
- **后续另行安排，不自动执行**：修复合成输入和实际原终端 tab 接线；完成单任务同身份恢复／原输出／单次副作用／取消及 release；补真实 local 同 Host 句柄闭环。跨 Host 持久恢复、ACP 业务协议 resume、真实模型／CLI、实际生命周期及正式门禁仍须各自授权与证据。

完整状态、历史原始产物摘要及本次仅本地验证范围见 [D08 暂停状态证据](docs/implementation/evidence/d08-paused-status.json)与[开发账本](docs/implementation/development-ledger.md)。`artifacts/` 中原始报告／截图留在开发机、按路径和 SHA256 引用，不随仓库发布；本快照不把旧测试冒充本次重跑或完整 D08 自测通过。

## 产品目标

只维护一套中央 dsh 和一套 Coder 控制面，在同一个入口选择本地项目或分布在不同机器上的远程项目环境。会话是主要操作界面；沿用 dsh 的侧边栏完成日常文件查看、搜索、编辑和修改审阅。需要完整传统研发能力时，第二阶段从当前项目打开中央 code-server。

“只部署一套”指每类产品只有一个逻辑服务和升级入口，不要求把所有服务塞进同一个进程，也不禁止未来为可用性增加副本。远端允许平台 Agent、容器运行时和自动管理的轻量 helper；不要求逐环境安装完整 dsh 或 code-server。

## 已确定的范围

- 采用 **方案 A**：中央 dsh 保留会话、模型配置和插件，文件与执行能力按项目环境路由。
- 第一阶段确定以 Coder 为环境平台，接入其管理的 Linux 隔离工作区，并保留本地项目体验；不在实施中静默替换平台。
- 模板是隔离、资源和实例身份的实际承载者，按版本化交付物管理，不使用一次性部署说明。
- 优先评估社区 SSH 工作区插件；不从零重写所有远程文件和终端协议。
- 保留并适配现有 dsh 侧边栏，不在第一阶段重做完整 IDE；侧边栏的“在系统打开”等本机入口在远程绑定下必须被拒绝或禁用。
- code-server 联动放在第二阶段，且保持单份中央部署目标。
- 不把 SSH 目录、Coder 工作区或 code-server 本身当成安全沙箱；隔离必须由明确的容器／VM 策略提供。
- 服务入口必须认证并加密；首期仍是单受信任使用者，不因开放公网而变成多租户。

## 文档导航

| 文档 | 内容 |
|---|---|
| [产品需求](docs/01-product-requirements.md) | 用户目标、范围、功能与非功能需求 |
| [核心功能与关键场景](docs/02-features-and-scenarios.md) | 用户操作、异常路径和可验证的场景 |
| [系统架构与边界](docs/03-system-architecture.md) | 中央／远端职责、环境绑定、生命周期、数据与安全边界 |
| [集成方案](docs/04-integration-plan.md) | Coder、社区插件、dsh 接口、版本门和第二阶段 IDE 接入 |
| [交付与验收](docs/05-delivery-and-acceptance.md) | 分阶段交付、验证矩阵、非功能映射和完成条件 |
| [决策与待验证项](docs/06-decisions-and-risks.md) | 已确定决策、技术风险、待用户决定事项 |
| [设计评审记录](docs/07-design-review.md) | v0.3 评审发现、外部事实复核与 v0.4 变更依据 |
| [执行路径与任务拆分](docs/08-execution-plan.md) | 6 条运行路径、6 条交付路径、31 项任务的依赖、产物、验收与授权边界 |
| [M1 只读核查与接入契约](docs/implementation/m1-readonly-audit.md) | T-101／T-102 的实际结果、固定来源、文件指纹、接口缺口与下一步授权范围 |
| [T-103 隔离安装与加载](docs/implementation/t103-isolated-load.md) | 固定摘要、原生卸载失败、显式入口及写权限／DNS 防护修正后的两次真实 profile 验证 |
| [T-104 Coder 部署与实例](docs/implementation/t104-coder-lab.md) | 自建 TLS 控制面、版本化模板、两个实例的 API／数据库／容器对照、浏览器登录与限制 |
| [M1 可执行收尾清单](docs/implementation/m1-closeout-tasks.md) | 已验证状态、现在可运行的复核命令，以及 T-105 → T-106 → T-107 的输入／产物／验收 |
| [前期调研档案](docs/research/README.md) | 平台对比、社区插件与 dsh 契约、IDE 可行性、历史研究摘录和容器实验报告快照 |

## 阅读时必须区分的三类信息

1. **用户确认的目标**：单一入口、中央维护、本地／远程项目切换、隔离环境、会话优先、code-server 第二阶段。
2. **已核对的外部事实**：截至 2026-10-30 的官方文档、插件源码或发布元数据；详见集成方案与评审记录。
3. **拟实现方案**：本文定义的环境路由、会话绑定、控制台集成和验收标准。它们不是当前 dsh 已具备的功能。

特别注意：code-server 官方 FAQ 列出 Microsoft Remote Extensions 不可用。因此“中央 code-server 通过扩展打开远端工作区”是第二阶段的独立可行性验证，不是当前已经成立的能力；也不能退回到每个环境运行一个 code-server 来冒充完成。

优先评估的社区插件 manifest 未枚举当时核查的 dsh 0.2.1-rc.4，但不能据此认定安装会失败。获准的隔离实验已实际通过固定 SSH 0.13.3 的归档／helper 摘要、依赖安装与模块导入；显式非构造器入口现已通过真实文件 profile 的启动、禁用／启用与整树卸载；未经包装的 Cordis 注册卸载失败仍保留，其原始 bundle 不启用。生产 CLI／web 的远端能力与完整侧边栏组合未验，不直接改生产。

## 隔离开发预览参考（D-01 至 D08 初版；真实实验仍暂停）

### DSH 持续升级

DSH 可以按正常发布节奏升级；[来源锁](profiles/agent-studio-preview/sources.lock.json)是本项目最近复核的兼容快照，不是永久版本限制。**版本不同表示基线待更新，不等于已经证实新版不兼容，也不要求回退旧版。** 使用[来源核对工具](scripts/dev/source-lock.mjs)定位版本／文件差异，再生成候选快照；以后将示例参数替换成实际安装的新版本：

```bash
node scripts/dev/source-lock.mjs --check
node scripts/dev/source-lock.mjs --candidate --sdk-version 0.2.1-rc.5
```

默认核对完全只读，差异退出码为 1；`--json` 可供自动化读取。候选模式也只向 stdout 输出 JSON，stderr 明确标为 **UNVERIFIED**，不覆盖当前锁、不安装依赖、不部署／启动服务。缺失文件、包身份不符或目标版本与实际安装不符时拒绝生成候选。复核 manifest、实际代码与投影接缝差异后再采用；遇到代码变化先适配，不能只刷新摘要就宣称兼容。保留已知文件清单，文件更名／新增依赖须人工补审，不自动扩大信任范围。不同包可以有各自版本，不强行跟随根 SDK 同号；helper bundle 身份也不能靠通用摘要刷新自动升级。

采用后重跑来源核对及离线回归（[来源工具测试](scripts/dev/source-lock.test.mjs)与[实际终端投影测试](scripts/dev/recovery-ui.test.mjs)均不写死发行版本）；部署和真实恢复验收仍单独安排。该流程不会因每次发布而要求永久停留旧版，也不会把“记录了新字节”误当成“新代码已通过兼容验证”。

### 启动与停止

当前源码兼容基线为 Node **24.22.1**（原生 ESM、`node:sqlite`）、dsh／Gateway **0.2.1-rc.5** 和 dsh-better-sidebar **0.28.2**；历史 rc.4 观察保留在原审计和账本中。当前 launcher 固定读取 `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh` 和 `/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar` 的受控包文件，并逐项核对[来源锁](profiles/agent-studio-preview/sources.lock.json)；不读取原 profile 配置／凭据。**来源一致性检查已通过，但以下手动参考不是部署／真实恢复通过保证或自动执行指令。** 本轮没有运行 `npm install` 或前端构建；开发预览已重启到 rc.5，但运行预览必须在不限制 `/dev/ptmx` 的环境中启动，否则原生终端 `forkpty` 会失败。换机器仍须显式调整来源并重新核验，不能跳过摘要与接缝检查。

```bash
cd /home/ubuntu/workspace/agent-studio
node scripts/dev/preview.mjs stop
node scripts/dev/preview.mjs register-local # 停服登记新的自有合成本地目标；重复执行只核验并复用
node scripts/dev/preview.mjs start --host 127.0.0.1
node scripts/dev/preview.mjs demo           # D01 元数据项目，仍不开放执行
node scripts/dev/preview.mjs local-demo     # D04 真本地项目，同一原 Web／侧边栏
node scripts/dev/preview.mjs remote-demo    # 已登记的 m1-a；幂等复用并显式连接
node scripts/dev/preview.mjs status
# 重启保留项目、绑定、原生 JSONL、Workspace 与认证材料，不自动重连或重跑任务
node scripts/dev/preview.mjs restart --host 127.0.0.1
node scripts/dev/preview.mjs local-demo     # 复用原绑定和会话；本地不依赖远程连接
node scripts/dev/preview.mjs remote-demo    # 新通道重新核验，仍使用同一版本目录
# 只向通过 PID、启动时刻、命令行校验的本预览进程发信号
node scripts/dev/preview.mjs stop
```

- 必须显式提供回环地址 `127.0.0.1` 或 `::1`；监听端口由系统分配，使用启动／`status` 输出的 `origin`，不要固定端口。这里只提供回环 HTTP 开发入口，不是公网／TLS 部署。
- 持久运行根是 `.preview/agent-studio/`，已 gitignore，目录 0700、敏感文件 0600。启动／重启不重置数据。测试另用随机 `/tmp/agent-studio-test-*` 根。
- 私有认证入口在 `/home/ubuntu/workspace/agent-studio/.preview/agent-studio/login.url`。由使用者在可信本机环境私下读取并在浏览器访问；**不要将内容、token 或 cookie 粘贴到终端日志、报告或聊天中**。普通 `origin` 本身不包含认证材料；无认证根页面返回 401。重启后认证入口随实际端口重新写入。
- `demo` 幂等建立合成项目 `D01 Preview Project`、local 环境、绑定和真正的 `D01 Native Session`。原 dsh 对尚无对话的 blank session 显示 **New Session**，其原生 list/title projection 保留真实标题；没有伪造模型对话。
- `bindings.sqlite` 是产品预览存储，不是搜索索引；当前 schema v8 增加不可变恢复快照、恢复状态／请求／事件，token 仅为中央私有 vault 引用，非 DB 明文。D08 只读迁移预检确认 schema7 的 21 张业务表完整行多重集及 13 条 unknown 不变；这是迁移 checkpoint，不声称后续合法新记录不存在。此前 schema6→7 在 D05 模型／D06 ACP 数据上增加环境观测、head、生命周期请求及连接 saga；17 表迁移旧行不变，随后新 Send 正常更新两行 model selection 的时间戳，身份／配置不变，已单独核对。dsh JSONL／Workspace 留在该根的 `dsh/` 下，ACP 不伪造 native model turn。`catalog.json` 追加独立 D06 policy／绑定，不放宽 D01–D05；客户端不能上传任意根路径。凭据仅由原认证 credentials 接口写入固定私有 vault，模型用 `STUDIO_MODEL_*`、ACP 用专用 `STUDIO_ACP_*`，不接受客户端凭据路径或继承中央秘密。
- `register-local` 只登记 `.preview/agent-studio/projects/d04-local-v1` 这个新合成目录，不扫描真实用户项目。显式 `kind=local`、`provider=local-managed`、`local_execution=true` 和不可变 `d04-trusted-local-v1` 策略才开放本地执行；D01 原策略不放宽。目录 dev/inode/realpath 变化拒绝；改变根或策略需新快照／绑定版本和会话，不可改旧行。`local-demo` 幂等复用项目、绑定、会话，非秘密 ID 在私有 `local-demo.json`。
- 首次登记已授权的现有 lab 时，先 `stop`，再执行 `node scripts/dev/preview.mjs register-remote`，然后 `start --host 127.0.0.1`、`remote-demo`。该命令只登记当前 **m1-a / lab-v3**，不会创建、stop、update 或 rebuild Coder 工作区；快照变化会拒绝，不能用它原地替换世代。当前持久根已登记，不需要重复登记。
- 中央 broker 程序化使用 `secrets/coder-lab` 的既有专用凭据；预览、浏览器、DB 和远端工具环境不接收该秘密。固定候选 `dsh-ssh-remote 0.13.3` 只复用已锁定 installer／RPC client／helper，不挂载其会回落本机的 runtime-router。
- `remote-demo` 复用 `D02 Remote Project` 和 `D02 Remote Session`，将非秘密身份写入私有 `remote-demo.json`。远端项目目录是 `/workspace/agent-studio-<binding_id>-v<version>`，helper HOME 为 `/workspace/.agent-studio-helper-<binding_id>-v<version>/home`，长期复用，不按测试 run 换 HOME，不删除已有目录／文件。
- 浏览器选择 **D04 Local Project · v1** 或 **D02 Remote Project · v1 → New Session → Files**，打开已有文本后编辑并点击 Save。新文件可通过已认证 `fs.write` 的 `expected_version:null` 创建，或在原生终端创建。右侧 **New tab → New terminal** 使用原 TerminalController；local 复用已安装 `LocalFileSystem`／`LocalSubprocessRuntime` 和真实 node-pty，接在实际 Agent realm，不是第二套页面。D01 项目仍是 metadata-only。
- 原 Files 搜索框输入普通文本查文件名／相对路径，输入 **`content:文本`** 查 UTF-8 字面内容；结果显示路径、行号及预览，点击打开同绑定文件，旁边 **@** 加入完整版本快照。遇到扫描限制会显示 `Partial search` 和具体原因，不能当完整结果。
- 原侧边栏 **New tab → Git** 显示当前绑定的真实 status；点击 Staged Changes 或 Changes 中的文件，再展开下方 Diff 文件头，分别审阅暂存区或工作树差异。Stage／Unstage／Commit／提交消息生成禁用；本切片只读。
- 原终端修改文件后回到编辑器：无草稿自动读回新内容，有未保存草稿显示冲突而保留草稿；Save 仍做强版本比较。编辑器在权威 watch frame 到达后注明 **Local／Remote polling: 2.5s**（另加请求耗时），不是原生文件事件。local↔remote 同名文件实测读取不同字节；旧标签、搜索结果、引用与任务保留原绑定，切换不迁移任务所有者。

### 实际接口与禁用范围

新增认证 RPC 为 `POST /agent-studio-rpc/<method>`，不是 stock `/api`。当前已锁定的 Gateway channel 必须为单段，不能注册原建议的 `/agent-studio/api`。请求体为 `{type:"client-request", rpcId, method, payload}`，URL method 必须相符，HTTP 200 后仍要检查 `result.ok`。

元数据接口包括 `project.create/get/list`、`environment.register/get/list`、`binding.create/get/list`、`session.create/get/list`、`dispatch.check` 和 `preview.status`。主体取自已认证 owner 并映射为稳定服务端 Principal；`session_id` 决定绑定，传入 binding/version 仅用于一致性断言。`dispatch.check` 始终是 `executed:false` 的**纯判定接口**，远端能力还须当前平台记录和活通道校验。

执行接口为 `remote.connect/status/disconnect`、`fs.list/read/write/mkdir`、`command.start`、`task.status/read/foreground/input/resize/signal/cancel/release`、`operation.get/list`。文件路径和命令 cwd 只允许绑定内相对路径；文件读写上限 196608 bytes，UTF-8／base64 完整读回。写入必须带 `operation_id`，`expected_version:null` 表示 create-if-absent，否则必须使用读回的强 version。local 写入只接受有效无 NUL 的 UTF-8 文本（base64 也必须解码为 UTF-8）；非文本写入明确拒绝。命令为 argv 数组，可带受限 env、相对 cwd 和 `tty:{rows,cols}`。task mutation 使用新的 `action_id`，针对原 `operation_id`。

重复 operation ID 拒绝，不自动重放。原生 terminal 的 session/tab ID 也映射为稳定 operation ID；重启后的旧终端标签不会静默新建 shell，应关闭旧标签并显式打开新终端。remote operation 保存真实 helper session/process ID、远端 PID、channel ID；local 使用独立 `execution_kind=local`、`local_runtime_id/local_process_id/local_pid/local_start_ticks`，remote 字段保持 NULL 且本地身份不可改。两者均保存请求摘要和未知结果；中央 SSH PID 不冒充任务 PID。断连任务保持 unknown，显式新连接不能接管旧任务；需要独立确认实际状态，不能把失联写成已取消。正常关闭依次停止并确认本轮受管进程、release、workspace/session close、传输关闭。

可用认证调用示例（不输出 cookie）在项目根目录运行：

```bash
node --input-type=module - <<'JS'
import { authenticate, requestRpc } from './scripts/dev/preview.mjs';
const auth = await authenticate();
console.log(await requestRpc(auth, 'project.list'));
console.log(await requestRpc(auth, 'preview.status'));
JS
```

已安装的原 Web／侧边栏包保持原字节。仅私有 profile 的 sidebar client chunks 经[唯一匹配投影](scripts/dev/sidebar-projection.mjs)增加搜索结果、快照引用、只读 Git 控件、编辑器轮询／冲突及同会话 ACP tasks／Environments／Original tasks 标签；D08 第四份 bottom-terminal chunk 接线已做语法检查，**实际原生 terminal tab 尚未补接、未验证恢复可操作**。没有独立演示页、依赖安装或前端重编。先校验原包摘要，再把 projector 与实际投影摘要写入私有 `projection.json`。Gateway 统一守卫在 owner bypass／receiver lookup 前覆盖 unary 和 stream。原 UI 的 `session/create` 只通过 owned Workspace 映射到真实绑定服务。冷会话 `session/follow` 自动激活之前也先创建绑定 Agent，避免原生默认执行环境抢占写句柄。

原 sidebar 的 `fs.tree/trees/read`、raw Save 和 Host `workspaceFiles` 的 read/readBytes/stat/list 已实际接 BoundProvider，而非只给 Agent 装 fs。原 UI 只传 mtime，服务端持久映射到读时强版本；相同 mtime 对应不同强版本永久视为歧义，保存拒绝，重启不抹掉冲突。仅在从已认证 session 解析权威绑定后，才把该绑定精确的空 anchor 别名转成实际目标路径；不会据 cwd 或 anchor 形状选择环境。原 TerminalController 读取真实 Agent realm 的独立 subprocess／workingDirectory provider，其余 subprocess 方法拒绝。只有权威 local-managed 才走 local；remote、unknown、失效绑定永不回落本机。

D03-core 的 `git.status/diff`、`fs.search`、`reference.create` 走已认证产品路由；Git／搜索以固定只读 worker 经真实 BoundProvider 命令通道执行，返回结构化结果和绑定／仓库身份，不把任意命令 stdout 充当产品接口。每次派发仍核验当前 provider 和绑定（remote 另核验活通道），取消保持原 operation ID，停止／释放失败报告 unknown。原 `/sidebar/ws/fs-watch` 接共享 provider 目录轮询，不监测中央 anchor。

当前能力边界：

- **Git**：非仓库明确返回 `isRepo:false`；unborn HEAD 可显示 status、暂存区／工作树 Diff；空 Diff 不偷偷换另一侧。每条 Git 子进程输出合计 ≤196608 bytes，status ≤1000 项，超限明确拒绝。linked worktree、历史／graph／show、所有 Git 写仍拒绝；unborn 的 `git.diff-head` gutter 明确不可用，不影响两类 Diff。禁用 hooks、external diff、textconv、全局配置及凭据交互。
- **搜索**：固定 Python、UTF-8、不区分大小写的字面匹配，**不是 rg、正则或完整 gitignore 语义**；本轮未安装／上传 rg。扫描 ≤5000 项、深度 ≤24、结果 ≤200 条、单文件 ≤196608 bytes、内容总量 ≤8 MiB。跳过二进制／非 UTF-8／symlink／大文件或触顶时明确返回 `complete:false` 和原因；没有完整分页或无限目录能力，应缩小查询／设置排除项。
- **watch**：共享、非递归、可关闭的 2.5 秒轮询，每目录 ≤1000 项，最多 32 目录／16 sockets；大目录拒绝。最后订阅关闭停止轮询，断连报告变化未知，关闭等待在途请求；重启不会自动恢复监测。
- **引用**：完整文件快照带原 session／binding／version、强版本、SHA256 和内容，不是动态本机 `@path`。原 dsh 会把空会话输入草稿携带到另一工作区；该 chip 明示 local／remote 原绑定，迁移后快照字节和原身份不变，不按新绑定重解释路径。D05 发送前校验快照，跨绑定拒发并保留可修正草稿；目录引用、原生 file/image 附件及未知内容分支仍拒绝。

仍禁用大文件编辑／上传／归档／批量文件操作、本机 opener、任意配置编辑、后台标题／sidechat／提交消息生成及未归属模型入口；只有下文 D05 显式模型配置和新策略会话开放。session-change history、Git history／branch／commit-model、unborn diff-head 的明确 HTTP 409，以及 `skills/list`、schedule 和自动 `llm/discoverModels` 的 disabled 保留。正常 Git status／Diff／搜索／watch 失败不属于预期忽略项。PTY shell 活动无法可靠观测时报告 unknown，不伪造 idle。当前只有 m1-a，不触碰 m1-b 负载。

预览进程清空继承环境并使用独立 HOME／DSH_HOME／XDG／cwd。local child 启动环境只有 `PATH=/usr/bin:/bin`、独立 `HOME=.preview/agent-studio/local/d04-local-v1/home`、`LANG/LC_ALL=C.UTF-8`、同级私有 tmp；公开 env 仅允许安全 `TERM/COLORTERM`。原 TerminalController 的 `DSH_SESSION_ID` 先与权威会话比对再移除，不传入本地 shell。local 启动限精确 argv/cwd/env、一次性且异步到期的受管 capability；只有固定 SDK containment probe 另获窄放行，原 broker 通道及直接网络／通用子进程／模型 fence 保持。合法本地 shell 自己启动的命令是可信用户行为，**不是 OS 沙箱或网络隔离**。

local 输出 ring ≤1 MiB、单次读取 ≤64 KiB，游标丢失明确 `truncated`；每 binding ≤8 个任务、每预览 ≤32，包含在途启动。正常停服等待启动与 task mutation，确认精确 PID/startTick 已停止后 release，再清理 watch；与原生 cancel 竞争不会把 released 降级。SDK 在本机使用 process-group/tree 管理，不声称强隔离。cwd 不是 containment，产品文件路径与执行权限分别检查；并发不可信代码仍不在威胁模型内。blocked 计数 0 **不代表没有合法执行／broker 活动**。依赖软链接不是强制只读挂载，不支持不受信任插件／多租户；未改生产／全局依赖／公网入口。

### D05：原生模型会话与工具

只给新增不可变 `d05-model-local-v1`／`d05-model-helper-v1` 策略开放；D01–D04 旧会话不会因配置模型而获得新权限。当前持久根已登记，运行 `model-local-demo`／`model-remote-demo` 幂等复用 **D05 Model Local／D05 Model Remote**，后者显式重新核验并连接已授权 m1-a。首次登记的步骤如下，只停本预览，不操作 Coder 生命周期：

```bash
node scripts/dev/preview.mjs stop
node scripts/dev/preview.mjs register-model-local
node scripts/dev/preview.mjs register-model-remote  # 仅现有已授权 m1-a
node scripts/dev/preview.mjs start --host 127.0.0.1
node scripts/dev/preview.mjs model-local-demo
node scripts/dev/preview.mjs model-remote-demo
node scripts/dev/preview.mjs status
```

- 原 **Account menu → Settings → Models → Add model provider → Custom model API** 登记显式路由；原 model picker 选择，原 Send／Stop generating 发送／取消。provider 为 `studio-model-*`，凭据 ref 为 `STUDIO_MODEL_*`；配置只存 provider/model/baseURL/ref 等非秘密元数据。新凭据由中央 credentials 服务写固定私有 `model-credentials.json`（0600）并按引用解析，describe 仅返回 configured/source/writable，不向浏览器返回值，也不进入 SQLite、日志或工具环境。不自动发现／复制生产 profile、OAuth 或真实 `.env`。
- `accepted:true` 只代表原生 inbox 入队。真正 installed `llm-pi-ai` adapter → native Agent loop → streaming／tool events → native JSONL；每次 `llm/stream` 核验来源、request/session/binding/version、当前配置 revision 与 settings 内容摘要。profile 配置 CAS 不放宽旧执行策略，后台标题／sidechat／提交消息、未知来源仍拒绝。
- 六项实际工具为 native **read／write／edit／bash／ask_user_question** 与接 BoundReads 的字面 **search**。读写和命令消费已绑定 Agent realm provider；未适配工具不开放，远端失效无中央后备。写／编辑／bash 每 call 原生 **Allow once**，批准后再次核验目标；已读文件强版本 CAS，未读写只能 create-if-absent。bash 仅前台、最长 60 秒，不自动转后台；可信单用户执行仍不是 OS 沙箱。
- 审批与问答复用原 UI，SQLite 保存 principal、session/binding/version、request/call/event/run、服务端 deadline、一次性状态及交付结果。正常 deadline 60 秒，显式 fixture 为 15 秒；跨会话／版本、重复、过期、取消／重启后的旧同意拒绝。通道断开后仍可取消自己已有的 native turn，但不因此启动新 provider 操作。自动化点击同意只覆盖自有合成测试，不是对真实任务的新授权。
- 一个 session 同时最多一个 admitting/queued/running 请求；`steer`／`updateQueue`、后台工具、自动重试、多模态／reasoning 和其它 adapter 协议未启用。持久配置 revision 与进程内 settings revision 不同；改配置前读最新 descriptor，不能把数字互换。

**接入真实模型尚需的输入与操作**：由使用者明确选定 HTTPS 的 OpenAI Chat Completions-compatible **baseURL、model ID、provider 别名、新受保护 API credential，以及允许发送的 prompt／项目绑定**；这里只复用 `openai-completions` wire protocol，不指定／迁移供应商。按上面的原 Models 页面手工填模型并保存（自动 Discover 明确禁用），在 D05 项目会话的原 picker 选择后发送。API 调用则先 `model.describe` 读取 `revision/settings_revision`，用两者 CAS 调 `model.configure`；原 `credentials/set` 写受控 ref，路由字段 `apiKeyEnv` 表示该 ref，不是从环境继承秘密。真实外部 endpoint、认证、兼容性与模型质量本轮均未调用或验收。

**离线复验**使用显式测试 fixture，不是真实 LLM，也不是工具 mock。它只提供受控 SSE／tool-call 协议，产品 adapter／Agent 执行真正工具并写原生日志。只有 fixture 的精确动态回环端点获得窄 POST 能力，默认网络／DNS／通用 subprocess fence 保留。当前 fixture 已运行，**不要重复启动**；只有另建自有测试根或明确停止旧 fixture 后，才运行 `node scripts/dev/model.fixture.mjs <owned-root> <explicit-loopback>`，再重启该预览加载测试配置。fixture 不由正常启动自动创建，端口从其私有配置读取。复跑命令：

```bash
node --test --test-reporter=tap scripts/dev/store.test.mjs
node scripts/dev/model.integration.mjs /home/ubuntu/workspace/agent-studio/.preview/agent-studio
node scripts/dev/model.remote.mjs
artifacts/m1/t104/browser-venv/bin/python -I scripts/dev/model.browser.py \
  --root /home/ubuntu/workspace/agent-studio/.preview/agent-studio \
  --out /home/ubuntu/workspace/agent-studio/artifacts/d05/ui-rerun-new \
  --browser /home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
node scripts/dev/core.verify.mjs --acp     # 当前 D06 根的完整核对；历史 D05 根才用 --models
node scripts/dev/preview.mjs model-remote-demo # 重启后显式重连，不重放旧任务
```

D05 交付 checkpoint（历史数字；本轮 D06 定向回归见下节）实测 **21 单测、10 本地集成、4 m1-a 集成、7 组原 UI、6 组最终核对**通过；D01–D04 的 76／25／4／11／3／10／5 项 API／生命周期及 11／8 组 local／remote 原 UI 也已重跑。配置与凭据确由原 UI 新建的证据在 `artifacts/d05/ui-settings-verified/browser.json`（后续 picker 测试失败保留）；最终 `artifacts/d05/ui-final/browser.json` 复用该持久路由并通过全链路，不冒称最终这次重新创建了 provider。原 Send→六工具→三次审批／一次问答→完成、本地／远端切换、跨绑定引用拒发并保留草稿、纠正后发送、流式取消与重开均已截图实看。

D05 交付时 readonly SQL→完整 API→ID/list 比较 **1356 条 operation、39 个模型请求、59 个 controls**；9 个实际完成过的 native session 物理 JSONL／压缩 JSONL 解码、inspect/list 及重启保持。schema v4 的 7 张旧表原行（含 928 条 operation）完全不变；integrity=ok，无活动 request／call／control／operation／watch。66 个来源锁、权限、30 ESM／7 Python 语法通过，新启动日志增量 0；180 文件 synthetic credential 扫描无泄漏。历史失败、2 个 interrupted request、6 条 unknown operation 保留，不回写成功。详见 [D05 简洁证据](docs/implementation/evidence/d05-model-session-development-selftest.json)及[开发账本](docs/implementation/development-ledger.md)。

### D06：受控 ACP 客户端与原会话交互

**已验证的是桥接实现及离线协议，不是真实编程 CLI。** 产品用已锁定 `@agentclientprotocol/sdk 1.4.0` 的 `client().connect(ndJsonStream(...))`，执行 `initialize → session/new → session/prompt`、接收 `session/update` 并支持 `session/cancel`。不是把 dsh-acp 服务端当客户端，不是 PTY 喂字，不只审批 CLI 启动；每个 peer 是经原 LocalProvider 或 m1-a BoundProvider 启动的真实受管进程。没有登记后端／专用凭据时明确未配置。

**当前可运行入口**：私下使用上文 `login.url` 登录，在原工作区选择 **D06 ACP Local · v1** 或 **D06 ACP Remote · v1 → New Session → 右侧 New tab → ACP tasks**。只选已登记 backend；在 **Task prompt** 输入任务，点 **Start ACP task**。运行中的权限／问题出现在同一会话原 **Allow once／Reject／Submit** 控件；侧栏显示进度、取消和历史，展开记录可查看 CLI 实例、实际 PID/startTick、流更新。ACP journal 明示不是 native model/tool history，中央 composer 不作为 ACP 发送入口。

当前两个 backend 都标注 **OFFLINE ACP PROTOCOL PEER — NOT A CODING CLI**。仅为手工离线复验，可输入 `{"case":"form","marker":"manual-offline-check"}`；peer 会请求一次写入批准及颜色／整数／布尔／备注问题，并将实际采用的回答写入本绑定的新 receipt 文件。也可用 `reject`、`timeout`、`cancel` 等 fixture case；这不是自然语言编程能力。正常登记后端的 prompt 则原样经 ACP 传入，不经过测试 peer 的 case 分支。

```bash
node scripts/dev/preview.mjs status
node scripts/dev/preview.mjs acp-local-demo   # 幂等复用新 D06 local 项目／会话
node scripts/dev/preview.mjs acp-remote-demo  # 显式重连现有 m1-a，不自动启动 CLI
# 以下只在首次登记／明确启用离线 peer 时执行；当前持久根已经完成，不必重复
node scripts/dev/preview.mjs stop
node scripts/dev/preview.mjs register-acp-local
node scripts/dev/preview.mjs register-acp-remote
node scripts/dev/preview.mjs enable-acp-peer-local
node scripts/dev/preview.mjs enable-acp-peer-remote
node scripts/dev/preview.mjs start --host 127.0.0.1
node scripts/dev/preview.mjs acp-local-demo
node scripts/dev/preview.mjs acp-remote-demo
```

- `register-acp-*` 只追加 `d06-acp-local-v1`／`d06-acp-helper-v1` 新快照；没有创建／重建 Coder 实例。backend catalog 是服务端私有 `.preview/agent-studio/acp-backends.json`（0600，`{version:1, backends:[...]}`），不接受浏览器传入可执行文件、argv、env 或秘密。当前 synthetic `STUDIO_ACP_OFFLINE_PEER` 已配置；新根需通过原已认证 `credentials/set` 写入新的 synthetic 值，缺失时 UI 拒绝启动；随机根集成测试会自行完成该步骤，不读取真实账号配置。
- 每个 catalog row 必须有 `id/name/version/protocol:"acp"`、允许的 `kinds/policies`、绝对 `executable` 及 SHA256、固定 `argv`、Python `bootstrap:{executable,sha256}`、`credential_refs`、非秘密 `environment`、`assets:[{name,sha256}]` 与 `offline_fixture`。argv 不含 executable，只有受控 `{root}` 占位替换；assets 来源固定为私有 `runtime/acp-assets/`。详见 [registry 验证](packages/dsh-agent-studio/acp-backends.mjs)。新增真实后端须先核验实际二进制／版本／协议参数／bootstrap 和许可，再停预览登记新 ID／版本并重启；不覆盖既有 peer manifest，不自动安装候选 CLI。
- dispatcher 从 authenticated principal/session 解析权威 binding/version/policy；payload binding/version 仅断言，A 会话不能在 B 启动子任务，即使声称已批准。版本化 launcher 在绑定内检查 binary/bootstrap/assets hash、cwd、专用 HOME 和 env；凭据只经一次性内部 capability 传入，新 CLI HOME 为绑定私有 HOME 下的 `acp/<backend-id>`，不继承中央 Coder／SSH／模型账号。冻结 helper 未修改，远端不安装完整 dsh；这是受管可信代码执行，**不是 OS sandbox**。
- controls 的授权真源为 SQLite，关联 task/request/RPC request、CLI session/instance、provider operation、principal/session/binding/version/run/deadline。只返回 CLI 实际提供的 `allow_once`／`reject_once` option ID，不把 once 升级为 always；typed form 按原 schema 验证。批准前没有业务 receipt，重复／跨任务／跨绑定／过期回复拒绝，实际 stdin 写入前再核验一次。`stdio-written-unconfirmed` 只表示已写输送，**不是 peer 已处理的确认**；本轮 peer 采用答案由实际 receipt／更新独立验证。
- 每 session 最多 1 个活动任务、每 task 最多 4 个待答控制。任务硬上限 180 秒，initialize／session/new 各 15 秒；普通控制 60 秒、显式 peer 15 秒。单帧 ≤64 KiB、stdout／事件 payload 总量各 ≤1 MiB、stderr ≤16 KiB、events ≤1000；超限、错误分帧和不完整 EOF 明确失败。fs/terminal callbacks 不广告、调用时明确 unsupported，绝不默认接中央文件服务；URL elicitation、schema pattern/format 等未实现分支拒绝。
- 正常完成／取消必须核实真实进程停止后 release。断连保留 unknown，不自动回落、重连或换 ID 重跑；显式 reconnect 也不接管旧实例。重启使旧控制失效且不重放批准。已测真实待审批 peer 的 graceful stop/restart；**尚未实现／验收 session resume、原任务恢复与崩溃窗口恢复**。

以下保留 D06 checkpoint 当时的复跑命令与结果，不是当前暂停快照的继续执行指令。旧 harness 的历史 schema 断言不能直接当作当前 schema8 验收；本次仅本地验证范围见 D08 暂停状态证据。不要重复启动常驻 D05 fixture 或自动执行远端／全 UI／生命周期测试。

```bash
node --test --test-reporter=tap scripts/dev/store.test.mjs
node scripts/dev/acp.integration.mjs  # 独立随机 local 根，最后精确停止、不删除数据
node scripts/dev/acp.remote.mjs       # 仅已授权 m1-a 自有新绑定
artifacts/m1/t104/browser-venv/bin/python -I scripts/dev/acp.browser.py \
  --root /home/ubuntu/workspace/agent-studio/.preview/agent-studio \
  --out /home/ubuntu/workspace/agent-studio/artifacts/d06/ui-rerun-new \
  --browser /home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
node scripts/dev/core.verify.mjs --acp # 会重启本预览，并显式重连既有 demo；不启动 CLI／模型
```

本轮实际 **27 单测、15 本地集成、4 m1-a 集成、7 原 ACP UI、7 最终核对**通过；受影响 D05 本地10／远端4／原 UI7 定向回归通过。最终 SQL→完整 API→ID/list／events→重启核对 **1587 operations、23 ACP tasks、26 ACP controls、320 ACP events**，以及52 model requests／78 model controls／11份原生会话日志；无活动任务／待答控制／watch。保留2个 unknown ACP任务及8条历史 unknown operation，不改写成成功。75个来源锁、38 ESM／10 Python语法、私有权限通过，新启动日志增量0；414文件扫描没有专用 synthetic ACP credential 外泄。最终远端审批／澄清／完成截图及390px布局已实看，无横向溢出；后者不是实际手机验收。详见 [D06 简洁证据](docs/implementation/evidence/d06-acp-client-development-selftest.json)和[开发账本](docs/implementation/development-ledger.md)。

**真实 CLI 尚缺的输入**：批准的实际工具及版本／可执行文件 hash／结构化协议 argv、允许的环境 kind／新 policy／项目绑定、专用 `STUDIO_ACP_*` 认证输入（及必要的非秘密 endpoint/model 配置）、允许执行的任务和副作用。仅只读盘点到本机 OpenCode1.2.20 的 ACP 标记；未运行它，m1-a managed PATH 尚无确认的编程 CLI。之后须另取实际版本、目标进程、输出、运行中阻塞审批／问答证据才能评估真实 CLI 与 SC-12；当前不宣称正式 M1/M2、SC-12、模型质量或整个 goal 完成。

### D07：环境发现、连接与阶段限制（历史阶段交接）

**阶段结论：环境发现及新 UI 链路有通过证据，最终综合实跑未通过。** 已停止新增远端负载及综合／全 UI 重试；不能用离线测试或后续本地存储检查抹去失败。源码、失败、完整身份和验证分类见 [D07 阶段证据](docs/implementation/evidence/d07-environment-stage-selftest.json)与[开发账本第 12 节](docs/implementation/development-ledger.md#12-d07-environment-阶段交接最终综合实跑未通过)。

- **原 UI 入口**：使用私有 `login.url` 登录后，右上 **Environments** 在未选会话时也可打开；原右侧 sidebar 同时有 Environments tab。点 **Discover now → m1-a**，查看 lifecycle、build/job、平台 Agent、观测时间／陈旧状态与注册对照。选择已有 binding/session，或显式新项目／绑定／新会话，再 **Connect and open session**，进入原 Files／Terminal，不造假会话或第二应用。当前已创建的 D07 binding 为 `binding-6113005c-b396-4807-b48a-90f697c1395e@1`，session 为 `session-e5dea400-7d8d-4f76-8296-4269325fdf30`；根为 `/workspace/agent-studio-binding-6113005c-b396-4807-b48a-90f697c1395e-v1`，保留长期使用，不删除。
- **真发现不等于注册**：新增 `environment.describe/discover/observations/open/link/prepare/confirm/request/poll`，均用原认证 RPC envelope。旧 `environment.list` 仅返回注册快照。中央 broker 以 owner＋产品 allowlist 查询固定 Coder API，并只读核对 current build/resources 与数据库关联；control-plane identity 与同 SSH/helper channel proof 分开。当前产品只返回获准 m1-a，不访问 m1-b workload。
- **控制面与执行边界**：核实部署 `v2.37.8+7ac93cf`／commit `7ac93cffea828ca2d9514cfc6c0ad6337834aebe`。真实 create executor 使用 `POST /api/v2/users/{owner_id}/workspaces`，start/stop 使用 `POST /api/v2/workspaces/{workspace_id}/builds`，均固定模板版本／operator 参数／目标并要求201；poll 只 GET 已持久 build ID。当前私有 `environment-policy.json` 为0600、`read_only:true, actions:[]`，UI禁用且服务端拒绝，浏览器不能扩权。未来真实实测仍需明确获准的目标、固定模板／参数／create name、资源上限、副作用及确认；本轮不修改策略来实跑，也不提供 delete/rebuild／凭据替换入口。
- **一次性请求**：prepare 保存 request ID、参数／policy hash、目标、副作用及期限；confirm 比对显式 phrase/hash，POST 前原子消费 attempted_at。相同目标并发拒绝，accepted 不等于 ready；依据真实 job／Agent／identity 继续观察。丢响应／超时保留 unknown／目标锁，不重新 POST、不自动重放。stop 不隐式删工作区或持久卷；控制面 stop 成功也不等于原任务已核实取消。
- **世代与失效**：build ID 不是 generation。同世代短停／断连／陈旧暂停派发并使旧 controls 失效，保留原 channel/process 身份；新世代／root／policy 变化撤销旧绑定资格，显式追加 InstanceRecord／绑定版本／anchor／新会话，不静默迁移旧任务。模型、ACP、普通任务统一接线。已连接 channel 也在半 TTL 触发真实只读刷新；临近过期新派发先等待有界刷新，失效仍 fail closed。同环境多绑定共享刷新，晚到旧观测不能覆盖较新 head／世代撤销，dispose 停止刷新。最后这些时序守卫经离线定向验证，**未再次做远端完整链路验收**。
- **迟到 ACK**：unknown 不因晚到 start ACK、status/read 或再次关闭自动回到 running。可信迟到 PID 可补入原 operation，原 request/channel/helper session/process ID 与失联原因保留在追加 audit；不恢复派发或取消权限。普通 connect 只建立新认证通道，不是原 helper session/task 恢复。
- **重启后的模型**：新的已认证 Send 在 prompt assembly 前重新安装同一已授权保存选择；仍核对 session/binding、当前 revision／credential ref。选择与 Send 串行，已加载会话的新选择不会被旧值覆盖。冷启动本地／远端六工具和流取消通过；历史失败 request `ff850703-40b9-45bc-943a-3c86b5d375ee` 保留 failed，不自动重发。

验证分层：最终 **45 项离线/状态单测＋5 项 Python executor transport 测试**通过；先前 **6 项真实只读 API／持久重启、8 项原 UI、8 项 D04–D06 定向协议回归**有通过证据。UI截图已查看，390px不是实际手机；`changes.ops` 的409为固定未开放 session-change history，发生在D02连接之后、后续会话切换之前，不是通道故障、也没有该路由恢复声明。401场景的JSONDecodeError来自测试监听器解析非JSON响应，页面正确显示HTTP401；不声称所有网络错误为0。

保留的五条 D07 unknown（另外八条属于更早历史）：

| 原因／阶段 | operation ID | 已知身份与结论 |
|---|---|---|
| 历史未定位 SSH255 | `966626f2-738a-4c34-a38d-2b90f8c12072` | process `fcf20fbe-6c6d-4791-af89-d4da27a3f6a5`／PID23134曾独立观察不存在；无原startTick/退出码，仍unknown |
| 同一SSH255窗口 | `408cf66d-9600-4792-a4c0-0409a6a2f457`、`a2d2adc8-17f4-419d-9be8-85646e7a3bdd` | process IDs保留，无PID确认不代表未启动；不是取消成功 |
| `D07_OBSERVATION_TTL_DISPATCH_RACE` | `90a931c8-55fe-4e7a-8982-638ea7aa3feb` | process `72ec1377-ab1f-4286-8cb0-94531c7b8e8d`／PID23731；派发跨陈旧窗口，原audit保留；修复守卫不改变旧unknown |
| `D07_HELPER_START_TIMEOUT_EOF` | `17e4b4af-a7ef-441b-a4e5-61e145a724a2` | process `b73ef497-d29d-4ad3-9c05-bbe5a4c437df`，PID未确认；10秒start超时后EOF，根因未定位，唯一综合复测仍失败 |

D07 当时仅最后精确重启自有预览以部署守卫并核对存储／认证／源码，没有再发远端任务。真实 create/start/stop、第三实例、模板／镜像／资源变更、m1-b负载、真实模型／CLI及原任务恢复均未做；全项目／正式阶段未完成。下列为 D07 的历史离线参考命令，当前暂停快照只运行 D08 影响范围集合，**不要据此自动追加远端综合复测**：

```bash
node --test scripts/dev/store.test.mjs scripts/dev/environment.test.mjs
python3 -I scripts/dev/test_environment_broker.py
node scripts/dev/preview.mjs status
```

### D08：同 Host 原任务恢复初版（WIP，已暂停）

已保留 [恢复状态](packages/dsh-agent-studio/recovery-state.mjs)、[恢复管理器](packages/dsh-agent-studio/task-recovery.mjs)、[固定只读探针](packages/dsh-agent-studio/adapters/task-observe.py)及原 task 接线。新增认证接口 `task.preflight/recovery/recoveries/recover/detach`；恢复代码区分原启动 channel 与新 transport 关联，要求原 client/session/epoch/process/PID/startTick、归属／绑定／世代／策略及固定窗口，不调用 `workspace/open`／`process/start` 替代任务，不重发命令／输入／审批。resume token 只存中央私有 `recovery-secrets.json`，DB／API／审计仅引用。仅同 Host 保留句柄，跨 Host／crash、ACP 业务协议 resume 不在本轮通过范围。

暂停前证据分层：**36/36 定向离线 Node 测试、4/4 固定 observer 单测、6 项真实只读预检通过**。预检实际 helper 0.13.1／retention 30000ms，`resume_supported:true` 是能力，不是已恢复 session；没有 workspace open／业务 process start。完整 21 表旧行迁移核对、13 unknown 保留、缺／错认证共 10 次401、来源部署和启动日志检查在该历史预检执行，不冒称本次提交准备重新执行。

**唯一真实 UI 尝试失败**：原 terminal operation `terminal-5f97a051068c5c6bd0e27ac7f85bfc7045cc636e6a9f54a660b84e63df650c49`／PID24266 已保存完整快照，但测试输入去掉换行后 Python `SyntaxError` 退出1，原 native close/release 已确认。没有执行 `task.detach` 或 `task.recover`、没有 UI 重试；[测试脚本](scripts/dev/recovery.browser.py)保持失败时的输入逻辑。原终端读循环暂停与 bottom-view 投影已有初版，实际 native terminal tab 入口只定位未补，原 UI 恢复／输出接续／取消闭环及真实 local SDK 同 Host 恢复均未验。细节和原始失败摘要见 [暂停状态证据](docs/implementation/evidence/d08-paused-status.json)；不是 D08 selftest 完成。

### D01–D04 复跑与历史结果

```bash
node --test scripts/dev/store.test.mjs
node scripts/dev/integration.mjs           # 新随机 local 根，76 项回归并停止
node scripts/dev/preview.mjs remote-demo
node scripts/dev/remote.integration.mjs    # 现有专用 m1-a，新增非敏感测试文件并保留
node scripts/dev/remote.restart.mjs        # 会重启本预览，确认本轮任务停止／释放
node scripts/dev/core.integration.mjs      # D03 Git／搜索／watch，生成新的自有 UI fixture
node scripts/dev/core.lifecycle.mjs        # 取消、断连与带 watch 的持久重启
node scripts/dev/local.integration.mjs     # local 字节/hash、SQL/API、Git/search/ref/watch/PTY
node scripts/dev/local.restart.mjs         # 停服保留／旧 tab 不重放／两绑定同名文件与断连
artifacts/m1/t104/browser-venv/bin/python -I scripts/dev/core.browser.py --local \
  --root /home/ubuntu/workspace/agent-studio/.preview/agent-studio \
  --out /home/ubuntu/workspace/agent-studio/artifacts/d04/browser-rerun-new \
  --browser /home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
# 去掉 --local 并选择另一个新 --out，复跑原 D03 远程 UI 8 条流程
node scripts/dev/core.verify.mjs --acp  # 当前 D06 根；历史 D05 用 --models，无模型的 D04 根才用 --local
```

上述 Python／Chromium 是已有测试环境，不自动安装依赖。远程 UI 先运行 core.integration；local UI 先运行 local.integration 和 local.restart，生成自有、两个绑定同名而字节不同的 fixture。再运行对应 core.browser 模式；每次选新的证据输出目录，保留失败。测试只在本绑定自有合成项目新增少量 Git index fixture，不 commit／push；只观察／清理精确自有任务／PID/startTick，不停止平台 Agent 或非本轮 daemon，不删除项目数据。

D04 交付时实测（历史数字，当前 D06 见上节）：**15 项单测、10 项 D04 local 集成、5 项 local 停服／重启／绑定切换、11 项原 local UI 流程通过**；同时重跑 **76 项 D01、25 项 D02、4 项 remote 停服／重启、11 项 D03-core、3 项取消／watch 生命周期及 8 项原 remote UI**。本地实际字节／独立 hash→完整读回→搜索，schema v3→v4 前 535 条旧 operation 原列 hash 不变。最终只读 SQL→完整 API→ID/list 比较 928 条 operation；pending/running=0、watch clients/directories=0，100 个历史 local 进程身份和 36 个历史 remote PTY PID 均独立确认不再运行。5 条历史 unknown 和 1 条已停止但曾落为 cancelled 的竞态失败保留，未伪改为成功。

Playwright 实跑原 Files 保存、搜索、两类 Git Diff、具名快照、真实 native PTY；local↔remote 同名文件不同字节，旧任务不能换 session 接管，引用保留原身份。原终端外部修改→clean 自动刷新／dirty 草稿保留及 Save409；物理文件与 PID/startTick 交叉核验，截图已查看。pageerror、非预期 console／RPC／HTTP、外部浏览器请求均为 0。44 个锁定来源（含 14 个 local SDK／PTY 文件）、私有权限与部署摘要通过，新启动日志增量 0，旧失败日志保留。

D04 历史命令／失败／源码摘要见 [D04-local 简洁证据](docs/implementation/evidence/d04-local-development-selftest.json)和[开发账本](docs/implementation/development-ledger.md)。[D03-core 旧证据](docs/implementation/evidence/d03-core-development-selftest.json)、[D02/D03 旧证据](docs/implementation/evidence/d02-d03-development-selftest.json)、[D01 历史证据](docs/implementation/evidence/d01-development-selftest.json)及 `artifacts/d02/d01-baseline/` 均不回写。D05 原生模型会话、D06 ACP 桥接历史结果及 D07 阶段限制见上节，原任务恢复由协调器另行调度；本轮仍不启用 Coder create/start/stop，不处理受阻 M1 审核，也不是全项目、真实模型、正式 OS 隔离或完整阶段验收。

## 文档校验与历史记录

以下 M1 记录保留当时结论；其中“待实现／T-201 阻断”不覆盖上文开发例外和 D01–D06 结果，也不因开发预览成功被改写为正式通过。

在项目根目录运行：

```bash
python3 -I scripts/check_docs.py
python3 -I scripts/test_check_docs.py
sha256sum --check docs/research/evidence/SHA256SUMS
sha256sum --check docs/implementation/evidence/SHA256SUMS
```

D06 收口静态检查通过：**20 份文档、224 个本地链接、39 项文档回归**；需求／场景／映射／执行任务计数未变，两份 SHA256SUMS（8 份调研、32 项实施记录）及 `git diff --check` 通过。实际命令输出、当前 README／ledger／D06证据摘要与保留服务状态见 `artifacts/d06/docs-validation.json`。D06未执行项见上节，不以文档校验代替运行验收。

D05 历史收口静态检查通过：20 份文档、14 项功能需求、8 项非功能要求、17 个场景、14 行验收映射、75 对双向一致的需求—场景关联、8 项非功能单向验证映射、3 个编号检查项、31 项执行任务及 214 个本地链接完整性；校验脚本的 39 个正向／负向测试、两份证据校验和清单与 `git diff --check` 通过（后续数量以实际校验输出为准）。校验会自动覆盖 `docs/` 下新增 Markdown 文档，测试包括映射遗漏／多余、缺少声明、重复验收行、非功能映射缺失／重复／无有效目标、检查项缺失／重复／非法引用、优先级与阶段不一致、任务重复／未定义前置／依赖环／阶段倒置／非法路径／缺少产物或验收目标、链接到的脚本或基础设施模板缺失，以及调研文档的断链和无效需求引用。45 个外部链接只由脚本计数，不由脚本逐一访问。

调研档案另保存 8 份历史研究／实验快照，已与来源内容读回比对并通过 SHA-256 检查。未归档秘密配置或完整会话日志；已拒绝的方案 B 在历史摘录中明确标为非现行方案。快照完整性通过不等于重新执行实验。实施记录保存原有 10 份 JSON：两份静态核查、两份历史 T-103 实验、T-103 防护纠正、T-104 Coder 汇总、T-105 实现及独立验收记录，以及 [T-106 历史分阶段自测](docs/implementation/evidence/t106-implementation-selftest.json)和[最终源码完整默认自测](docs/implementation/evidence/t106-final-implementation-selftest.json)，均有校验和；[T-106 首轮独立验收](docs/implementation/evidence/t106-independent-acceptance-review1.json)判定 repair-required，其[写后验证](docs/implementation/evidence/t106-independent-acceptance-review1-validation.json)保留；[两项修复自测](docs/implementation/evidence/t106-repair1-selftest.json)之后，[新增独立复验](docs/implementation/evidence/t106-independent-acceptance-review2.json)确认 IA-01／IA-02 修复及同一新 run 的 11 项完整默认检查，限定实验范围 gate=pass、t107Ready=true；T-107 已交付[逐门槛调查](docs/implementation/t107-m1-investigation.md)，M1-05／M1-10 阻断，待独立审核，M1 未通过。历史失败与旧源码摘要不回写；纠正证据区分保留源码和当前 harness。T-104 保存 API／数据库／容器／浏览器和资源审计结果；T-105 独立复验专用连接／身份门禁／helper，并重跑 12 项连接离线测试、8 项隔离测试（83 个网络 API 拒绝检查）和 13 项 Coder 契约测试。通过范围不扩大为生产、产品主会话远程项目能力、正式隔离或完整 M1。

v0.1 独立读者检查覆盖部署数量、阶段范围、环境切换、断线取消、安全责任、社区复用、实现状态和中央 IDE 可行性这 8 类问题。v0.2 按一致性审阅修订了 anchor／cwd、目标身份验证、CLI 运行中交互、双向映射、真实移动设备门槛和 Git 能力范围。v0.3 修订了子任务跨绑定规则、SC-02 创建链路和 NF-05 回滚实测门槛。

v0.4 结合主评审、未预先收到主评审结论的另一位评审者及后续复核：新增 FR-13（模板契约与实例身份）、FR-14（入口认证与授权）、NF-07／NF-08、SC-13 至 SC-17，补充生命周期、实例身份转换、PTY、路由旁路和非功能验证。复核撤回了插件“明确不兼容”的过度判断，区分受管保存与外部写入的保证，补齐请求去重条件，并将未确认的产品范围扩展移出 P0。评审过程不等于独立运行验证；逐条发现、纠偏与来源见[设计评审记录](docs/07-design-review.md)。

实施已拆成 M1–M5 的 31 项任务；T-101／T-102 的只读核查、T-103 的修正后隔离 profile、T-104 的本机 Coder／模板／两实例、T-105 专用连接／身份门禁／helper 及 T-106 限定实验远程能力已验证，T-107 已交付调查、仍待独立门槛审核，其余 24 项未开始，M1 尚未通过。Coder 已按用户新增授权自行搭建，不再等待用户提供控制面。T-106 首轮 repair-required、两次独立完整默认 exit 1 及历史实现自测 exit 0 均保留；观察响应发布竞争和工具缓存链接拒绝缺口现已独立复验通过，不改写旧反例。当前修复源码经真实发布器／consumer 确定性屏障、并发与失败发布、链接／替换／读取中篡改和不可变字节 staging 验证；同一新 run 的 11 项完整默认检查达到预期，controller／Node 均 exit 0。T-107 的 M1-05／M1-10 尚不满足，T-201 阻断。冻结镜像缺 ripgrep、初始 helper 状态 degraded；固定来源且独立校验的私有 rg 分别支持本次 Git／非 Git 文件名发现和显式命令内容匹配实验，不代表镜像部署或产品搜索集成已修复；具体命令、产物和退出条件见[可执行清单](docs/implementation/m1-closeout-tasks.md)。第一阶段门槛仍为 T-107 → T-208 → T-309 → T-404；原生 spawn 的远端生命周期、产品主会话集成、恢复／重传、正式隔离、跨主机和生产迁移均未通过。

文档静态检查不证明运行时兼容、安全隔离或产品功能已经实现；实验通过范围以上述独立证据为限。

## 当前没有做的事情

现有 dsh 包作为隔离 profile 的加载来源，未修改现有 web profile／全局依赖；T-103 的依赖软链接写边界已纠正并实测拒写。T-104 已新建独立 Coder／PostgreSQL 和两个同机工作区，专用账号自行生成且只留受限目录，四个实验容器与持久卷保留。T-105 已在独立探针中连接真实候选 SSH／helper；T-106 文件／命令／PTY／取消／断连拒绝回退及私有工具搜索的限定实验已独立验证，但真实 dsh 产品会话未验收；未部署 code-server、调用真实外部模型、开放公网或改生产；D05 仅显式离线协议驱动的原生模型链路、D06 仅真实 SDK／受管 stdio／原 UI 的离线 ACP 桥接已验证，未将协议 peer 当真实 CLI 或正式 SC-12 通过。普通容器与同 UID marker 不宣称强隔离；历史本机容器原型仍不能替代产品端到端验收。

## 工程验证与范围边界

兼容性、去重协议、移动 UI 和现有认证能力由 M1／M2 实验与设计核查，不作为五项用户问卷。草稿存储尚未选定；产品内重建／销毁／凭据替换入口、跨设备草稿同步、新身份服务或公网部署变更属于待确认扩展，未确认不进入 P0。未提供的破坏性接口仍须服务端拒绝，外部生命周期变化仍须使旧绑定失效。详见[决策与待验证项](docs/06-decisions-and-risks.md)。
