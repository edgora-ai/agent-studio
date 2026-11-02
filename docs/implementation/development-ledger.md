# 开发决策与账本

基线日期：2026-10-31 暂停快照（WIP）。收到后续“继续推进”后，仅恢复一轮有界的本地可靠性、schema 验证与 D08 UI／harness 源码修复；**不重新部署／重启预览，不执行远端负载、Coder 生命周期或真实断连／恢复，不改写 13 条 unknown**。此前 `/goal clear` 的暂停事实保留在第 14 节；本轮范围与本地验证另记第 15 节，不能用新源码或离线通过覆盖旧失败，也不自动恢复此前无限连续开发安排。

## 1. 开发预览与正式验收分开

采用可运行优先的**隔离开发次序例外**：M1 独立审核中断与已登记遗留项暂缓处理，不再阻止 T-201 及后续隔离开发。**D-01／T-201 的限定开发实现已验证，正式 T-201／M1 仍未验收通过。** 开发预览／实现验证只说明实际运行过的限定能力，不等于正式阶段验收或发布；[执行计划](../08-execution-plan.md)的任务编号、依赖及正式完成条件和[验收标准](../05-delivery-and-acceptance.md)保持不变。

此前按“持久绑定 → 远程文件／命令／PTY → 现有侧边栏 → local provider → 原生模型 → ACP → 环境管理”推进。D-01 至 D06已做各自限定验证；D07阶段结论仍为**环境发现及新UI链路有通过证据，最终综合两次实跑未通过，根因未全定位**。之后 D08 初版已部署并完成只读预检，但唯一真实 UI 尝试失败，尚未执行 transport 断连／恢复；该真实实验仍保持暂停，本轮只做第 15 节的本地源码修复与离线回归。离线 fixture 不是实际 LLM 或外部 CLI；全项目及正式门禁未通过。生产、全局配置、额外资源或基础设施变更仍须对应授权。

## 2. 当前开发切片

| 切片／关联任务 | 状态 | 实现验证出口（不是阶段通过） |
|---|---|---|
| D-01：持久绑定，T-201 | **限定开发验证通过**；不是正式任务／阶段通过 | 原 Web／侧边栏真实加载；SQLite 完整读回和 native JSONL／Workspace 关联；重启保留身份并协调 pending；3 项单测、76 项集成及 Playwright 通过，范围见下文 |
| D-02：远程文件／命令／PTY，T-203、T-204 | **限定开发验证通过**，仅现有 m1-a | 25 项真实远程集成：字节／强版本、命令／PTY／SIGINT／取消、unknown 不重放、中央 canary；4 项运行中停止／重启／身份保留检查；不是正式任务验收 |
| D-03：现有侧边栏，T-205、T-207、T-208 | **D03-core 限定开发验证通过**，仅已授权 m1-a | 原 Files／Terminal 保留；只读 Git status／暂存区与工作树 Diff、文件名／内容搜索、共享远端轮询与 dirty 冲突、具名原绑定文件快照引用；11 集成 + 3 生命周期 + 8 原 UI 流程，详情与限制见第 8 节，不是完整 M2 验收 |
| D04-local：真实本地 provider | **限定开发验证通过**，仅新的受控合成目录 | 与原远程共用 Bindings／Host Files／Agent terminal／BoundReads／Watch；10 集成 + 5 生命周期 + 11 原 local UI，local↔remote 同名文件和旧任务所有权实测；见第 9 节 |
| D05-model-session：原生模型会话与绑定工具 | **限定开发验证通过**，显式离线协议 fixture；非真实 LLM 验收 | 原 Models／picker／Send／Stop／审批／问答 UI、真实本地及 m1-a 六工具、SQL／JSONL／重启；21 单测 + 10 本地 + 4 远端 + 7 原 UI + 6 最终检查，见第 10 节 |
| D06-ACP-client | 限定桥接／离线协议验证通过 | 真实installed SDK、local/m1-a stdio、原审批／问答／取消／持久历史；不是真实CLI或SC-12通过，见第11节 |
| D07-environment，含 T-202 | **阶段交接，最终综合实跑未通过** | 真实只读发现、原环境UI、一次性生命周期executor和世代失效有分层证据；历史SSH255／TTL／helper timeout五条unknown保留，见第12节 |
| D08：同 Host 原任务恢复，含 T-206 | **WIP；本轮仅本地源码修复，真实恢复仍暂停** | 历史离线36项／observer4项、只读预检6项有通过证据；唯一UI尝试输入换行丢失、SyntaxError退出1并released，无断连恢复或UI重试；本轮修复单行输入与实际原terminal tab入口但未部署，离线范围见第15节，历史记录见第13、14节 |

## 3. 延期问题与保留门槛

| 延期项 | 当前处理 | 仍阻断的正式出口／补齐条件 |
|---|---|---|
| L-01：M1 独立审核归档、repair2 独立验证（T-107） | 登记延期；review2 被 HTTP400 中断且无最终 validation，repair2 只有本地自测；不阻止上述开发 | **正式 M1／T-107 完成及依赖它的正式阶段完成、发布仍受阻**；需完整有效的独立验证与归档；不恢复受阻审核或换通道规避拦截 |
| L-02：U-03 镜像依赖、资源配额与隔离 | 不改写成已支持，也不视为永久禁止；待资源范围审议 | **对应搜索、资源／隔离验收及依赖这些 P0 能力的正式发布仍受阻**；需获准的镜像／存储／策略交付和真实行为验证，私有实验依赖不能冒充镜像已满足 |
| L-03：完整 M3 多机／真实手机（T-301 至 T-309） | 留待后续，不能用同机容器或模拟视口代替 | **正式 M3 与第一阶段发布仍受阻**；需真实多机、故障／生命周期／持久化等完整证据及真实触屏手机闭环 |
| L-04：第二阶段 IDE（T-501 至 T-503） | 保留单份中央 code-server 目标，按第二阶段推进 | **正式第二阶段／IDE 发布仍受阻**；需合格连接方案和真实研发回归；它不是第一阶段新增门槛，不能用逐环境 IDE 或仅文件挂载替代 |

这些是延期登记，不是全部 P0 的永久豁免。历史报告、失败、源码快照和 checksum 保留；开发验证成功不能回写旧验收结论。既有证据入口见[M1 收尾记录](m1-closeout-tasks.md)。

## 4. 开发预览也不可跳过

- **实际绑定与当前身份**：派发目标来自真实绑定和当前通道核验，不信任公开 cwd、路径形状或旧缓存相等。
- **主体权限**：主体、环境、会话和操作权限必须匹配；未知／无权请求拒绝，不能为演示绕过授权。
- **远端失败无中央回退**：连接、身份或能力不可用时明确失败，不把本地文件服务／执行器当后备。
- **未知任务不自动重跑**：保持未知状态及原任务身份，不换操作 ID 或新任务冒充恢复。
- **真实数据读回／检索**：写入后直接检查存储，再完整读回并按 ID／名称检索，不能只看 API 成功值。
- **没有真实运行不得宣称可用**：接口存在、单测或旧探针只证明各自范围；只有实际隔离 profile 的闭环证据才能标记对应预览能力可用。

## 5. D-01 实际交付与验证

2026-10-30，单一实现者完成，无再委派、安装、远程连接或生产变更。实现入口为 [Store](../../packages/dsh-agent-studio/store.mjs)、[绑定服务](../../packages/dsh-agent-studio/bindings.mjs)、[插件 RPC](../../packages/dsh-agent-studio/index.mjs)、[Host 适配](../../packages/dsh-agent-studio/adapters/host.mjs) 和 [launcher](../../scripts/dev/preview.mjs)。启动／停止／重启、认证文件位置和测试命令见 [README](../../README.md)。

- **持久数据**：原生 SQLite schema v1、WAL／事务／外键／不可变快照触发器；项目、环境、实例记录、绑定版本、会话与审计真实落盘。owner 来源是已认证 dsh peer，绑定根及凭据引用来自私有 operator catalog，不接收客户端路径／秘密。
- **原生会话**：真正 Agent factory → 显式 flush → native persistence/inspect → Workspace attach → SQLite ready；跨存储先 pending，重启协调同一 ID，10 分钟过期置失败。ready anchor 不重建，inode／dev／空目录／native cwd／Workspace 归属核对；旧版本不可派发，历史会话仍可读。
- **边界**：`POST /agent-studio-rpc/<method>` 使用原认证与 envelope。`dispatch.check` 只判定 local metadata，不执行。未核验 remote、FS、命令、PTY 均拒绝。Gateway owner/unary/stream 守卫与 sidebar HTTP／升级守卫覆盖服务端旁路；原 UI 选择／创建会话转到同一绑定服务。只有精确的原生欢迎确认允许配置元数据写，其余配置变更和所有模型入口禁用。
- **复用来源**：初轮基线为 dsh 0.2.1-rc.4、原侧边栏 0.28.2，来源 hash／许可证及确切改动列于 [sources.lock.json](../../profiles/agent-studio-preview/sources.lock.json)；当前 SDK／Gateway 基线已按后续授权迁移到 0.2.1-rc.5，见第 15 节。私有 Gateway 投影只改守卫 seam，并保留原 dual-face manifest/client；侧边栏保留原 manifest、client chunks、locale、LICENSE，只替换 Host wrapper；未挂载候选 SSH 整包。
- **真实验证**：8 个 ESM 文件语法通过；3 项 Store 单测；[集成测试](../../scripts/dev/integration.mjs) 76 项（新随机根，测试后仅停止自有进程）；另对持久 `.preview/agent-studio` 完整 SQL→RPC→list 及重启前后逐字段相等验证，`PRAGMA integrity_check=ok`。有效认证成功，公开 health 200，受保护页面／接口缺失和无效认证 401，错误 Origin 403，HTTP 200 的失败 RPC 被识别。
- **浏览器**：[Playwright](../../scripts/dev/browser.py) 使用已有 Python/Chromium 登录新 profile，显示 `D01 Preview Project · v1`、原 blank session 和原 Files 面板；截图已查看。pageerror 0、非预期 console/RPC 错误 0、外部浏览器请求 0。FS/Git 409、fs-watch 403、skills/list disabled 如实保留。模型路由为空、进程 network/subprocess/generation 拦截计数为 0，拒绝操作前后 JSONL 不变、目标项目目录为空；这是无模型集成，不是实际模型对话验证。
- **隔离限定**：私有持久根 0700、敏感文件 0600；子进程环境精确白名单，不继承 canary；动态回环地址；新测试根两次启动日志为空。进程内防护和依赖 symlink **不等于 OS 沙箱或强制只读挂载**，不承诺恶意代码／多租户隔离。持久日志仍保留早期失败，不能声称历史全绿。

简洁新证据为 [d01-development-selftest.json](evidence/d01-development-selftest.json)，只引用本轮源码／产物路径和 hash，不嵌套旧报告。早期 Gateway owner 守卫未替换、Gateway 客户端 manifest 缺失、JSONL 压缩路径与 terminal 测试参数问题的失败产物均保留；已修正后以新测试根重跑，不用旧成功替代当前源码验证。文档夹具遗漏新增源码目录曾导致 2 项失败，已保留记录并补复制范围／负例；最终 20 份文档、185 个本地链接、39 项文档回归及 `git diff --check` 通过。

## 6. D-01 交付时的 D-02 接续契约（历史）

本节保留 D01 当时状态；下节记录后续实际实现，未完成项不能据此误读为已经验收。

1. **稳定入口**：沿用 `agentStudio` 服务、服务端 Principal、`session_id` 权威解析、`(binding_id, version)` 不可变快照和 native session／Workspace 关联。请求中的 binding/version/cwd 不得选择另一环境。新世代、root 或 policy 必须形成新实例快照／绑定版本和新会话；当前 D-01 无外部生命周期登记／更新接口，不能原地修改旧记录。
2. **接入面**：在 `Bindings.check` 的权威校验之后接真实通道身份／当前能力校验与 provider；保留 `dispatch.check` 的纯判定语义，真实文件／命令／PTY 另设执行接口。当前返回的 `local-metadata` 不能冒充远程可用。远端失败明确拒绝，不回落中央服务，不按 anchor／路径形状选路。
3. **守卫面**：按 provider 的实际完成项逐条接入 Gateway 和 sidebar Host 适配，默认未知方法拒绝。继续保留原客户端；禁止整包挂中央 root，自动标题／sidechat／提交消息和本机 opener 不随文件能力自动放开。当前 UI 仍可见不可用按钮／disabled 提示，改善交互不应先于服务端能力。
4. **当时仍待开发**：真实 remote FS／命令／PTY／取消和生命周期、环境管理、模型调用、会话内审批／澄清、完整原侧边栏闭环、OS 隔离及后续正式多机／手机验收。凭据仅受控引用，任何新增连接／资源／依赖仍按授权边界推进。D-01 不扩大为全部 M2，不解除第 3 节正式门槛。

## 7. D-02／D-03 最小闭环交付（历史）

2026-10-30，同一实现者写测，无再委派、npm 安装、模型调用、commit/push 或生产变更。只连接已授权的现有 **m1-a / lab-v3**（workspace `ff136352-6a92-41d4-9c2c-6cc783cb989b`）；未 create/stop/update/rebuild Coder 实例，未操作 m1-b 负载。原始用户授权已核对，不把协调代理消息当新授权。

### 已实现

- [中央 broker](../../packages/dsh-agent-studio/adapters/coder_broker.py) 仅固定 register/check/install/connect/proxy 流程，受控 binding/version 解析；当前 Coder API／SQL 记录、严格已登记 Host key、同一 SSH 进程 observation→ACK→exec。凭据只在中央官方 CLI 网络通道使用，未进入预览／浏览器／DB／远端工具环境。helper 来源、组合 SHA 和许可锁定；不挂候选全包或 runtime-router。
- [BoundProvider](../../packages/dsh-agent-studio/adapters/bound-provider.mjs) 每次派发经 Bindings 权威身份、当前平台记录和活通道；固定版本根与 ownership marker，重连不换 HOME、不删除旧目录。真实文件 list/read/write/mkdir、强版本 CAS，命令 argv/cwd/env/output/exit、PTY input/resize/foreground signal/cancel/release。未知操作无自动重放，新通道不能接管旧任务。
- SQLite v2 迁移保留 D01，增加不可变 operation ID／请求摘要／channel／helper session／remote process ID／远端 PID／状态；v3 增加持久 `file_read_versions`。重复运行 ID 不能移除原进程跟踪；取消状态不被读取伪装成普通完成。
- [Host Files](../../packages/dsh-agent-studio/adapters/host-files.mjs) 实接原 sidebar 树、UTF-8 编辑保存和 Host workspaceFiles，而非只给 Agent 装 fs。原 mtime 协议映射到已读的强 version；同 timestamp 多版本永久拒绝，不因重启抹去歧义。session 权威解析之后才允许其精确 anchor 别名，不从公开路径猜环境。单文件上限 196608 bytes。
- [Agent terminal](../../packages/dsh-agent-studio/adapters/agent-terminal.mjs) 在真实 factory setup、发布前提供独立 Agent realm subprocess／workingDirectory；原 TerminalController 与原 Web／sidebar 客户端保持。冷 `session/follow` 的 stock promotion 之前完成绑定 Agent 创建。原生 terminal 的 session/tab ID 确定性映射到 durable operation ID，重启后相同标签不能新建 operation 或自动重跑 shell；该负例已实测，新的终端须显式新标签。未知 subprocess 方法拒绝；shell 活动无法证明时为 unknown。正常关闭先确认本轮进程终止并 release，再关闭 workspace/session/transport；断连绝不声称已取消。
- [launcher](../../scripts/dev/preview.mjs) 增加 `register-remote`（要求本预览已停止）和幂等 `remote-demo`。不更改旧世代；显式重连核验，稳定根及 D01 行保留。启动入口、认证私有路径及操作步骤见 README。

### 实际验证

- **6 单测 + 76 local 回归 + 25 remote 集成 + 4 持久重启检查**。local 新随机根已停止。远端真实 UTF-8／二进制写入后独立观察 hash、完整读回与 list；operation 独立 readonly SQL→完整 API→ID/list；强版本冲突保留原内容。
- 真正命令 cwd/env/stdout/stderr/exit 7 与远端 PID；PTY isatty、输入、resize、前台 PGID／SIGINT 由子进程实际观察。独立精确 PID/startTick、cwd 和 Coder 凭据缺失布尔检查；未用中央 SSH PID 充当远端 PID。
- 仅中断本轮精确自有 broker，已开始任务变 unknown，原 ID／请求／任务身份保留，重复 ID 拒绝且不回退中央；中央 canary 不变。失联任务有测试自身的有限生命周期，随后独立观察停止，**不是取消成功声明**。
- 在原生终端与命令运行时正常停止自有预览，独立确认 PID/startTick 已停止、记录 released；随后重启逐字段比较 D01/D02 项目／环境／实例／绑定／会话／强版本基线，全部 operation 身份保留、unknown 不重跑。未显式重连时文件拒绝，remote-demo 再核验后复用根，native terminal 再次创建／关闭成功，SQLite integrity_check=ok。
- [Playwright](../../scripts/dev/remote.browser.py) 冷启动原 Web，选择同一 D02 session/binding，原 Files 编辑保存→独立实际字节→完整读回/list；原生终端键盘输入→真实远端输出回到浏览器→独立文件/PID；原生关闭后再次观察 PID。3 个闭环通过，截图已查看；JS、非预期 console／RPC／HTTP、外部请求均 0。Git／changes 409、watch 403、skills disabled 为明确延期，不掩盖为成功。
- [简洁证据](evidence/d02-d03-development-selftest.json) 只引用新产物和 hash。D01 交付源码在 `artifacts/d02/d01-baseline/` 冻结，旧证据不回写。没有全套重跑 M1，也不签正式阶段通过。

### 失败与修复记录

1. 初次命令使用 lab 不存在的 `/usr/bin/python3`，operation 实际 failed/E_NOT_FOUND、无远端 PID；核对已有环境后改为 PATH 的 `python3`，一次有依据重试通过，失败文件保留。
2. Agent setup 中 strict Cordis lookup 在 fiber 尚未 active 时返回 undefined；改为安装断言用非 strict 查询，实际执行仍取 active 服务。失败命名 `D03_AGENT_SETUP_STRICT_LOOKUP`，有依据重试通过。
3. 浏览器第一次选择了未显示的 Terminal 按钮，截图证实原菜单名为 New terminal；修正选择器。第二次实际输入成功，但测试将原生 void close 响应误当含 value，修正解析；已有真实输出截图和失败报告保留。
4. 冷浏览器发现 session/follow 后台 promotion 先取得 native 写句柄；在该入口前发布绑定 Agent 后，新的冷启动 UI 完整通过。Files 初始请求带 native anchor，权威绑定解析后增加精确 alias 映射，未开放任意 cwd/anchor。

### 当时仍未完成／接续

该最小闭环交付时 Git、搜索／watch 尚未实现；下节记录随后 D03-core 的实际接入，旧证据不回写。大文件／上传／归档／批量操作、真正 local provider、环境管理与受控生命周期／新世代版本迁移、真实模型和 CLI 会话内审批／澄清、正式 OS／资源隔离、多机、真实手机、第二阶段 IDE 仍待开发和验证。当前单可信用户预览的 shell 不是根目录沙箱，依赖 symlink 不是强制只读；合法 broker 活动不计为 blocked，不能以 blocked=0 宣称没有任何网络／进程活动。长期 helper daemon／稳定目录保留，不宣称平台上所有远端进程均已清空。

## 8. D03-core 交付（历史）

2026-10-30，同一实现者继续写测，无再委派、依赖下载／安装、模型调用、commit/push 或 Coder 生命周期操作。范围仍是现有 m1-a 及本绑定自有合成目录，原持久根、远端 HOME、DB schema v3、D01 行与旧 operation 身份均保留。

### 产品实现

- [BoundReads](../../packages/dsh-agent-studio/adapters/bound-reads.mjs) + [固定只读 worker](../../packages/dsh-agent-studio/adapters/remote-read.py)：已认证 session→权威 binding/version→当前真实 BoundProvider 命令通道。产品 Git／搜索参数固定，客户端不提交脚本；结果带绑定／仓库身份与持久 operation ID，结束后停止／release，取消不换 ID 重跑，清理无法确认时明确 unknown。没有中央仓库／文件后备。
- **Git 只读**：status、暂存区与工作树 Diff、原 Changes UI；空 Diff 保持所选侧，中文／空格路径、非仓库、unborn HEAD 已实跑。每条 Git 子进程 stdout+stderr ≤196608 bytes、status ≤1000 项，超限拒绝而非假完整。禁用 hooks、fsmonitor、external diff、textconv、全局配置和凭据交互；绑定内真实 `.git` 与 repo_id 校验。linked worktree、历史／graph／show、写入口仍禁用；unborn 的 diff-head gutter 明确 unavailable。原 Stage／Unstage／Commit／生成控件已禁用，后端仍最终拒绝。
- **搜索**：文件名／路径与 `content:` UTF-8 字面匹配，结构化路径／行号／预览及每项 identity。未安装／上传 rg，不声称正则或完整 gitignore；扫描 ≤5000 项、≤200 hits、深度 ≤24、文件 ≤196608 bytes、内容 ≤8 MiB。binary／encoding／symlink／大文件等跳过或触顶有 `complete:false`／具体原因。没有完整分页能力；原 UI 明示 partial。
- [BoundWatch](../../packages/dsh-agent-studio/adapters/bound-watch.mjs)：原 fs-watch 升级路由接真实 helper 共享目录轮询，周期 2500 ms 加请求耗时，不冒充原生事件。非递归，每目录 ≤1000 项，≤32 目录／16 sockets；大目录拒绝。每轮重新核验所有订阅 session 与通道；最后订阅关闭移除定时器，断连发送 incomplete，dispose 等待在途 poll，不监测中央 anchor。
- [私有 client 投影](../../scripts/dev/sidebar-projection.mjs)只改三个锁定 chunk，保留原 dsh／原 sidebar UI 和已安装包，不另造页面。原 editor clean 自动读回；dirty 保留草稿并显示 conflict，Save 仍用持久强版本 CAS。先词法校验相对路径，再 repoRoot join，不能用 `../` 被 normalize 吞掉。
- **打开／引用绑定**：搜索／Git 结果打开原编辑器；引用为带原 session／binding／version、path、strong_version、SHA256 和全文的快照，label 与 clipboard 明示 remote 原绑定，不设本机 file appearance。原 dsh 会把 blank 输入草稿携带到另一 workspace；实测迁移后 native Lexical chip 的 ref 字节不变，不按新绑定重新找文件，旧搜索结果不显示、foreign path resolve 拒绝。目录引用不支持，模型仍禁用。

### 最新源码验证

| 实跑 | 通过项 | 证据 |
|---|---:|---|
| Store／scope／worker／projection 单测 | 10 | `artifacts/d03/unit-final.tap` |
| D01 独立随机根回归，结束后停止 | 76 | `artifacts/d02/local-regression-9bb48bdd-b994-472b-a2b2-f5cabb79386e/integration.json` |
| D02 远端文件／PTY／transport 回归 | 25 | `artifacts/d02/integration-69073e77-b7a0-433f-b51c-6c67c1fa7c03.json` |
| 运行中任务停止／持久重启回归 | 4 | `artifacts/d02/restart-99f62b76-7eb9-4d20-9905-0457f5187b6c.json` |
| D03-core Git／搜索／watch／认证／负例 | 11 | `artifacts/d03/integration-c84e592b-4984-4b0a-9a56-906f59fa725f.json` |
| 取消／断连／带订阅重启 | 3 | `artifacts/d03/lifecycle-9f41a681-3929-4b7a-9b60-447840b4fa1a.json` |
| 最新重启后的原 UI 全链路 | 8 | `artifacts/d03/browser-final-5/browser.json` |
| 最终认证／全量 SQL-API-list／部署／权限／语法 | 5 | `artifacts/d03/final-verification-6c7ba240-d4fe-4469-9c5c-5334b3508f20.json` |

测试命令见 README 和 [D03-core 简洁证据](evidence/d03-core-development-selftest.json)。独立 readonly SQL→完整 operation API→ID/list、实际远端 hash→完整读回/list 均通过；取消后精确远端 PID 独立观察停止。重启逐字段比较项目／环境／实例／绑定／会话／强版本基线和全部 operation 身份；没有重置 DB、改旧世代或自动重放。

原 UI 从真实认证登录开始，依次搜索→编辑器→引用→跨 workspace 快照不变；两类 Diff 实际展开→Git context 打开原 editor；原 native terminal 外部写→clean 刷新／dirty 冲突并 Save409。引用 native Lexical JSON 已直接读回；真实 terminal 输出与远端文件/PID 交叉核验，终端关闭后精确 PID/startTick 已停止。最终 8 流程及截图已查看；JS、非预期 HTTP／RPC／console、外部浏览器请求均 0。只允许精确尚未适配 history／generation 等错误，不能宽泛忽略 Git／搜索／watch 错误。

### 保留失败与纠正

- `D03_GIT_RESERVED_MARKER`：新合成 repo 的 ownership marker 成 untracked，status 路径守卫拒绝整份结果；只跳过精确保留行，未放宽直接路径守卫。
- `D03_EDITOR_WATCH_SYMBOL`：editor chunk 无 main bundle 的 helper；改用该 chunk 已有 hostRouteUrl 并转换 ws/wss，真实 UI 重跑通过。
- 投影 seam 缩进不匹配先明确失败，改为唯一计数校验；Files native tab、中文 CSS selector、Diff 默认折叠与 PTY 换行的测试假设均经实际 DOM／截图／输出修正，失败产物保留。
- 原 blank 草稿跨工作区不会自动清空；撤回该测试假设，改为具名快照且验证 ref 字节／原身份不变，不掩盖原生 transfer 行为。
- `D03_UI_SIDEBAR_TRANSITION`：切回 workspace 的临时打开按钮在自动恢复时 detach；改等实际 native 标签栏。
- `D03_UI_TERMINAL_NOT_WRITABLE`：测试在 emulator 存在但 native 输入控制尚未 ready 时键入；改等 xterm 反映 native writable 的 textarea 状态，没有重放未知命令。最后两轮完整 8 流程均通过。
- `D03_FINAL_OBSERVER_BATCH_LIMIT`：最终测试把 29 个本预览历史 PTY PID 一次交给上限 20 的只读观察器，请求被拒绝；保持观察器限制，分批一次有依据重试。最终 29 个 PID 均独立观察为不存在／zombie，pending/running=0、watch clients/directories=0。私有权限、30 个锁定来源文件、16 个 D01 冻结文件、部署源码／投影摘要及旧证据均核对；本轮新启动日志增量 0，历史 5360 bytes 失败日志保留。

原 D01／D02 证据及冻结源码保留，新增证据只引用实际产物和摘要，不回写历史失败。本轮 D03-core 可交付继续调度 **local provider → 模型／会话交互**；Git 写／历史、完整大目录与分页、大文件／上传、正式隔离等仍按原范围补齐，**不宣布全项目或正式 M1/M2 完成**。

## 9. D04-local 交付（历史）

2026-10-30，同一实现者写测，无再委派、下载／安装、模型／外部 CLI 会话、commit/push、全局／生产修改或 Coder 生命周期操作。只修改本机产品和自有持久预览，回归沿用已授权 m1-a；未碰 m1-b。原 D01 metadata-only、D02 remote 数据和不可变策略保留，不把 agent 消息作为新增权限。

### 产品实现与可重复入口

- [LocalProvider](../../packages/dsh-agent-studio/adapters/local-provider.mjs) 只在已认证 principal/session/version 权威解析及 `kind=local`、`provider=local-managed`、显式 execution policy 之后进入。remote、unknown、失效绑定无本地后备。目录 dev/inode/realpath、相对路径／逐级 symlink 与本地执行授权分别检查；cwd 不是 containment。
- 复用已安装并锁定的 `LocalFileSystem`、`LocalSubprocessRuntime` 和 native node-pty；装在**实际 factory Agent** 的派生服务 scope，由该 Agent 的 guarded fs/subprocess 和同一 Host Files 消费。没有第二个页面、第二套 factory 或 metadata-only 假执行。原 list/read/write/mkdir、强版本保存、BoundReads Git/search/reference、BoundWatch 与 TerminalController 均复用。
- `preview.mjs stop → register-local → start --host <loopback> → local-demo`，具体命令见 [README](../../README.md)。登记仅创建新的自有 `.preview/agent-studio/projects/d04-local-v1`；catalog 为 `local-managed-d04-v1`／`d04-trusted-local-v1`。重复登记核验并复用，local-demo 不重复创建绑定和会话。独立 HOME/tmp 在 `.preview/agent-studio/local/d04-local-v1`，不读真实用户项目／生产 profile。根／策略改变仍需新快照、版本及会话。
- [fence](../../scripts/dev/fence.mjs) 仅给受管 local 启动一次精确 argv/cwd/env capability，跨异步续段到期；保留 broker 和 generic subprocess/network/model 默认拒绝。child 启动只含 PATH、独立 HOME、LANG、LC_ALL、TMPDIR，public env 只允许 TERM/COLORTERM；native DSH_SESSION_ID 验证后剥离。SDK systemd probe 只获得固定短时探测权限，不开放任意 systemd 启动。
- schema **v4** 在旧表追加 `execution_kind` 和独立 local runtime/process/PID/startTick；SQL trigger 禁止本地身份更改或混入 remote helper/channel 字段。旧 operation 不重写，unknown／旧 native tab 重启不能新建 shell 冒充恢复。normal shutdown 等待在途启动和同一 mutation queue，独立确认进程停止后 release，watch 先清理；晚到 cancel 不降级 released。
- local 文件写仅无 NUL 的 UTF-8，读写上限 196608 bytes。真实输出 ring ≤1 MiB、每 read ≤64 KiB，过期游标明确 truncated；每 binding ≤8／全局 ≤32 个任务（包含启动中）。Git／搜索／watch 的既有限制与 partial 原样保留。引用和轮询明确 local/remote；原 blank 草稿迁移保留原快照，而非按新环境重新读路径。
- **这是受信任单用户执行，不是 OS 沙箱**。SDK 当前使用 process-group/tree 管理；shell 可执行可信用户命令，cwd/文件 guard/独立 HOME 不等于 root、网络或同 UID 强隔离。全局 fence 未撤销，但不承诺阻止可信 shell 自行启动网络命令。

### 当前源码真实验证

| 实跑 | 通过项 | 产物 |
|---|---:|---|
| Store／local authority／identity／ring／shutdown race／fence | 15 | `artifacts/d04/unit-final.txt` |
| local API、物理字节/SHA、SQL/full API/list、Git/search/ref/watch/PTY | 10 | `artifacts/d04/integration-e7453830-d295-4c9d-82a4-9b2ff5649da4.json` |
| local native PTY+command 停服、持久重启、旧 tab、remote断连／同名文件 | 5 | `artifacts/d04/restart-7cba53ed-fb59-4cc0-ae05-37deddcf5e08.json` |
| 原 local UI Save／Git／search／ref／PTY／两绑定切换／冲突 | 11 | `artifacts/d04/browser-final/browser.json` |
| D01 新随机根回归（已停止） | 76 | `artifacts/d02/local-regression-63b39e06-d447-4050-aa38-f0ec3b128aeb/integration.json` |
| D02 remote API／停止重启 | 25 + 4 | `artifacts/d02/integration-0c33c960-69fd-4381-8b9f-fb9147f822ef.json`；`artifacts/d02/restart-5bad7b0e-8a96-40bd-a615-9258f917cc6f.json` |
| D03-core／取消与watch生命周期 | 11 + 3 | `artifacts/d03/integration-146aba32-490b-466f-bb1a-ee8a80408410.json`；`artifacts/d03/lifecycle-e7a425f4-aa43-4c07-a64b-822cb773dbbe.json` |
| 原 remote UI 完整回归 | 8 | `artifacts/d04/remote-browser-regression/browser.json` |
| 最终全量 SQL/API/list、进程／来源／权限／语法／认证 | 5 | `artifacts/d04/final-verification-76cf91b9-7043-428d-842b-f37c179af2f1.json` |

- schema v3→v4 前 535 条旧 operation 及全部旧元数据原列 hash 不变。local 写入后独立物理字节/hash→完整 API→list/search；新增 identity 直接 readonly SQL→完整 API→list；停服重启保留。未删除测试数据或 reset DB。
- 本轮最后完整 checkpoint 比较 **928 条 operation**；integrity_check=ok，pending/running=0、watch clients/directories=0。独立观察 **100 个 local PID/startTick 身份、36 个 remote PTY PID**，均已停止或 PID 身份已变化。保留 5 条历史 unknown 与 1 条早期竞态 cancelled（其进程也已停止），没有回写假绿。全部 local operation 的 remote 字段为 NULL。
- public health200、local/remote 新读接口无／错 auth401、正常 auth200，原浏览器登录到数据加载。两绑定同一相对文件名显示不同字节，remote 断连 read/write/command/search/reference 拒绝且 local canary hash 不变；旧 local task 换成 remote session 拒绝。原 Files 保存、staged/worktree Diff、native PTY 输入输出／resize／cancel、clean polling 刷新／dirty 保留与 Save409 均实跑；截图已查看。两个浏览器结果的 pageerror、非预期 HTTP/RPC/console、外部请求均 0。
- 44 个锁定来源（含 14 个 local SDK／PTY 文件）、部署源码及投影、16 个冻结 D01 文件和三份 D01–D03 旧证据 hash 通过。23 个 ESM／6 个 Python 语法通过；私有根 0700、敏感文件 0600-or-stricter、gitignore 通过。新启动日志增量 0，历史 5360 bytes 日志保留。ESM＋预编译原客户端没有额外 build；本轮不改容器／镜像，因此不执行未授权的 Docker rebuild。

### 失败保留与纠正

1. `D04_FIXTURE_GIT_SYMLINK_UNTRACKED`：负例 symlink 成为 untracked，原 Git worker 正确拒绝；只在自有 fixture 新增精确 `.gitignore`，不删除链接／数据、不放宽产品。保留 `integration-f90640f3-54f0-42f0-867f-61a5ea6b9195.json`。
2. `D04_NATIVE_TERMINAL_SESSION_ENV`：实际原 TerminalController 传 DSH_SESSION_ID 被 local whitelist 拒绝；核对上游后由 adapter 先验证权威 session 再剥离，public env 权限不扩大。保留 `restart-c8caf28c-b0c8-477a-b056-f641a29f34e7.json`。
3. `D04_SHUTDOWN_CANCEL_RELEASE_RACE`：进程实际已停，但晚到 native cancel 将 released 降回 cancelled；改为与 dispose 共用 operation queue，新增确定性单测并真实停服复验。保留 `restart-31b9ce7b-2a27-4939-9386-da4aec5acedc.json` 及原 cancelled DB 行，不事后改状态。
4. `D04_UI_HIDDEN_WORKSPACE_SELECTORS`：原 UI 保留隐藏 pane，测试 strict selector 找到两个搜索框；查看失败截图后仅给当前 workspace selector 加 `:visible`，一次有依据重试通过。保留 `artifacts/d04/browser-1/browser.json`，后续 `browser-2` 与 `browser-final` 均 11 项通过。

新 [D04 简洁证据](evidence/d04-local-development-selftest.json) 保存真实命令、输出／失败路径及 hash，不嵌套旧报告。运行预览继续保留；本轮只是 D04-local 出口，**不是全项目、正式 M1/M2 或发布完成**。

### D04 当时的下一切片交接（历史，仅记录）

- 后续环境调查指出 `coder_broker.current()` 只接受 running+connected；`register()` 写 catalog 并拒绝快照变化，二者都不是实时环境发现。已有 `scripts/m1/coder_template.py` 的 owner:me workspace 列表查询仍须产品授权过滤。Store `newBinding(binding_id+expected_version)` 可追加版本；environment 重复登记当前仅返回旧行，后续需可信实例观测／失效处理。
- 协调器读到的 Coder v2.37.8 公开源码说明：创建 build 为 `POST /api/v2/workspaces/{id}/builds`、预期 201、transition=start|stop；可选 template_version_id/rich_parameter_values；查询 build 为 `GET /api/v2/workspacebuilds/{id}`。**这只是公开接口依据，尚未校验 tag/commit/部署镜像对应关系，未执行生命周期**。下一实现应核对确切版本、接真实执行器；缺少某动作实跑授权只限制该动作／验收，不应用永久 stub 冒充功能。
- UI 候选为原 sidebar `betterSidebar.registerTab/openTab`，无会话首次入口还需核对。D04 当时不实现发现，不启用／运行 create/start/stop，不改 m1-a/m1-b 生命周期；当时待调度的模型／会话交互现见第 10 节，旧 M1 受阻审核保持不动。

## 10. D05-model-session 交付（历史 checkpoint）

2026-10-31，同一实现者写测，无再委派、依赖安装、真实外部模型／编程 CLI 调用、commit/push、生产／全局修改或 Coder 生命周期操作。只使用新的自有本地合成项目和已授权现有 m1-a；不碰 m1-b。保留原持久根、旧不可变策略和所有失败。**本节是离线协议驱动的真实 native 路径验证，不是模型质量、真实供应商连接、正式 M1/M2 或全项目通过。**

### 产品实现与入口

- [ModelSessions](../../packages/dsh-agent-studio/model-session.mjs) 复用 settings revision、原 provider/modelCatalog、credentials.resolve、sessionController 与 Agent loop。原 Models／picker／composer／Stop 原样使用；显式 `studio-model-*` 路由和 `STUDIO_MODEL_*` 引用，HTTPS 的 `openai-completions` wire 有真实 installed adapter 调用路径，不用永久 disabled 或 fixture 回答替代产品实现。只开放 text、无 reasoning；自动发现、其它协议与后台生成仍拒绝。
- [私有 credentials](../../packages/dsh-agent-studio/credentials.mjs) 只接新显式受保护凭据，固定 vault 0600、固定浏览器认证 record；不接客户端路径／生产发现，describe 不返回值，损坏 vault 的诊断不引用原始秘密。配置 SQL／日志／工具环境不存凭据值。
- `register-model-local`／`register-model-remote` 停预览后追加新快照 `d05-model-local-v1`／`d05-model-helper-v1`；`model-local-demo`／`model-remote-demo` 幂等复用。旧 D01–D04 权限不放宽，m1-a 目录仍按新 binding/version 长期拥有。具体使用／真实模型所需输入及命令见 [README](../../README.md)。
- 每次真实 `llm/stream` 再核验 Agent-loop 来源、权威 principal/session/binding/version、active request/native signal、provider/model、配置 revision 及规范化 settings SHA。accepted 仅入队；真实完成／失败／中断及消息落原生 JSONL。每 session 最多一个未终结请求；steer/updateQueue 未开放。
- [Agent tools](../../packages/dsh-agent-studio/adapters/agent-tools.mjs) 安装在真实 Agent realm，native read/write/edit/bash/questions 与 scoped literal search 消费已绑定 provider，未适配工具不可用。mutation 逐 call 原生审批、批准后再核验、读前强版本 CAS、未读 create-if-absent；bash 仅前台 ≤60 秒。SQL＋AsyncLocalStorage 关联 request→call→真实 operation／远端身份，断连不回退、不换 ID 重放。
- [ModelState](../../packages/dsh-agent-studio/model-state.mjs) 的 schema v5 保存配置／选择／请求／tool call／operation 关联及 controls。原 approval/userQuestions UI 和已认证 reply 接 principal/session/binding/version/request/call/event/run、硬 deadline、一次性转换与 delivery；正常 60 秒，显式 fixture 15 秒。取消／重启使旧允许失效；已有 native turn 断连后仍可取消，不要求活执行通道，也不产生新 provider 操作。
- D03/D04 快照保持原身份／版本／内容／SHA，不按新 cwd 解释。跨绑定发送在入队前拒绝，原 UI 留可修正 chip 草稿；原生 file/image/未知内容分支拒绝。fixture 只发受控 SSE／tool call，不执行工具或写产品 JSONL；窄网络能力限显式动态回环 POST，默认 DNS／网络／generic subprocess fence 保留。可信单用户不是 OS 沙箱。

### 最新源码实际验证

| 实跑 | 通过项 | 产物 |
|---|---:|---|
| 单测：旧 Store/local 加 controls、revision、vault、取消、窄网络能力 | 21 | `artifacts/d05/unit-21.tap` |
| 本地原生 adapter／Agent／六工具、审批／问答、错误／截断／取消／重启 | 10 | `artifacts/d05/integration-d7642d1f-d749-4943-933a-3306248c89a8.json` |
| m1-a 六工具／独立物理字节／中央 canary／断连拒发与取消 | 4 | `artifacts/d05/remote-39a2f340-21f3-47ae-a8ae-923aeea64e39.json` |
| 原 UI Models／picker／local+remote Send／审批／问答／取消／引用草稿 | 7 | `artifacts/d05/ui-final/browser.json` |
| 重启后全量 SQL/API/list、物理 JSONL、来源／权限／认证／语法 | 6 | `artifacts/d05/final-verification-23c45808-d571-4fea-b131-b69b2aa95d27.json` |
| D01 新随机根（已停止） | 76 | `artifacts/d02/local-regression-ac5c6ceb-eb8d-47b9-bdc8-e98420f4acf4/integration.json` |
| D02 remote／停服重启 | 25 + 4 | `artifacts/d02/integration-759e999f-cad4-4a90-82c5-9f2c330c299c.json`；`artifacts/d02/restart-a0bc8188-acfb-405d-be99-c363ff2d4688.json` |
| D03 core／生命周期 | 11 + 3 | `artifacts/d03/integration-5cc3eafe-052a-42bf-b62c-bb5eb42e2231.json`；`artifacts/d03/lifecycle-376e7de4-99a4-4d70-80bc-595b55c6c432.json` |
| D04 local／重启 | 10 + 5 | `artifacts/d04/integration-6da63395-56d3-40e1-a394-7bc7765338f6.json`；`artifacts/d04/restart-c4773a05-001d-484f-ada8-f3c067bd5199.json` |
| 原 local／remote UI 旧功能回归 | 11 + 8 | `artifacts/d05/d04-ui-regression/browser.json`；`artifacts/d05/d03-ui-final/browser.json` |

- **存储闭环**：直接 SQL→完整 API→list 检查 1356 operations、39 model requests、59 controls；9 个完成过会话的物理 JSONL（含 zstd）→解析→native inspect/list→重启保持。schema v4 的 7 表旧行完全不变，含 928 operations；integrity=ok，无 active operation/request/call/control/watch。178 个历史 local PID/startTick、45 个 remote PTY PID 独立观察已停止／zombie／身份变化。6 条 unknown operation、9 failed／2 interrupted request 和 failed config revision2 原样保留。
- **认证与 UI**：public health200，model/config/control/native 保护端点无／错认证401，正常认证成功；原浏览器登录到数据加载。三次 Allow once＋一次 question Submit 均真实到达 native tools；未批准无写、一次批准至多一次、跨主体／会话／绑定／版本、重复／过期／重启拒绝，断连后批准不能生成工具副作用。流式错误／截断不当完成。自动化同意仅为 synthetic fixture 授权。
- **UI 创建证据区分**：`ui-settings-verified/browser.json` 第一项确由原 Models UI 新建 route／credential，后续 picker timing 失败保留；最终 `ui-final` 复用该已持久化配置完成 7 组，不冒称这次重新创建。跨绑定 chip 的 native Lexical ref 字节不变、拒发前 request 数不增，纠正草稿在新 remote session 实际使用 native default。approval／question／cross-binding／cancel-reopened 截图已查看，最终非预期 JS/HTTP/RPC/console 与外部浏览器请求均 0。
- **运行与边界**：66 来源锁（新增 22 native model/settings/tool/control/UI 文件）、16 冻结 D01 文件、D01–D04 证据不变；30 ESM／7 Python 语法通过。293 私有文件／89 目录权限通过，保留历史 5360-byte log、新启动增量0。`closeout-data.json` 扫描 180 文件无 synthetic model credential 泄漏，vault0600、两个 ref 的实际值仅私下比较。回环扫描仅显式测试 host、动态端口及 endpoint guard；未读真实 `.env`，未改容器／镜像，不执行授权外 Docker rebuild。

### 保留失败及修复

- `D05_CREDENTIAL_RECORD_CONTRACT`／`D05_CONFIG_SCHEMA_DEFAULTS`：核对 native 浏览器认证 record 与 settings 规范化，不用猜测 API。工具严格 Cordis 注入、bash description／shellEnv、取消等待真实 in-flight 请求、remote full-read 强版本均实际修正；原失败 integration／remote JSON 保留。
- `D05_UI_MODEL_DEFAULT_ARRAY`：原表单省略 input，schema 规范化成 []；写前明确 text-only／reasoning=false，失败 revision2 不改写。`D05_SETTINGS_VIEW_INJECTION`：settings/mutate 返回原 namespace view 并补真实 settingsController 注入，经独立 RPC 后再 UI 验证。
- `D05_NATIVE_DEFAULT_NOT_INSTALLED`：只存 SQL fallback 会导致新会话 `{{model}}` 缺值；现在先调用真正 native selectModel 安装，再持久选择。原 `ui-native-selection` 失败及后续两轮完整 UI 成功都保留。
- `D05_CANCEL_BINDING_LOOKUP`：断连取消修复误用不存在的 studio.binding；改 Store.binding，增加 ownership/no-live-provider 单测，本地10＋远端4＋UI7均复验。失败 `integration-4413480a-3bff-414a-a05b-7b92db046729.json` 不覆盖。
- UI harness 的隐藏 custom fields、workspace scope 切换、menuitemradio／当前模型 no-op、文件名查询与 `.written` 重复匹配均按实际 DOM 纠正，失败目录保留。D03 回归8个功能已过后仅 schedule/catalog disabled 未列预期；只补该精确拒绝，`d03-ui-final` 再完整通过，不忽略其它 Git/search/watch 错误。

简洁 [D05 证据](evidence/d05-model-session-development-selftest.json) 保存实际命令、产物／失败路径及 SHA；未嵌套改写历史报告。文档检查为 20 份文档／214 本地链接、39 项回归通过，两份 SHA256SUMS 与 `git diff --check` 通过，实际输出留在 `artifacts/d05/docs-validation.json`。最终只读认证再核对 9 个模型／控制／原生端点的无／错认证，共 18 个401，正常 descriptor revision9 与 health200；记录在 `artifacts/d05/final-auth.json`。预览与显式 fixture 保留运行，私有登录入口路径见 README，不发布 token/cookie。**下一切片仍为 ACP 会话交互、环境管理与恢复；真实模型接入需要自选 HTTPS endpoint／model／受控新 credential／明确 prompt 与绑定后另做验收。** 本轮不恢复受阻 M1 审核，不宣布全目标完成。

## 11. D06-ACP-client 本轮交付

2026-10-31，分类 build、采用 loop；同一唯一写入者完成协议核对、实现、逐步验证与文档收口，没有再委派。**限定结论：桥接实现及本地／m1-a 离线 ACP 协议验证通过；真实外部编程 CLI／模型、正式 SC-12 和原任务恢复未执行／验收。** 不恢复受阻 M1 审核，不宣布整个 goal 完成。仅操作新自有 local 项目及既有授权 m1-a 的新绑定目录；无依赖安装、生产／全局／镜像修改、Coder 生命周期、m1-b 操作、真实秘密复制、commit/push 或公网开放。

### 实现与真实路径

- [AcpSessions](../../packages/dsh-agent-studio/acp-session.mjs) 直接用 installed `@agentclientprotocol/sdk` **1.4.0** 的 client builder／`ndJsonStream`，执行 initialize／能力协商／session/new／prompt／update／cancel。不是 dsh-acp 服务端、PTY 喂字或只批准启动。SDK 合作式 cancellation 外另设硬 deadline；task180秒，initialize/new各15秒，普通control60秒、peer15秒，清理有界。
- [受控 backend registry](../../packages/dsh-agent-studio/acp-backends.mjs) 从私有0600 catalog加载固定 executable/version/hash/argv、协议、kind/policy、专用 `STUDIO_ACP_*` refs、bootstrap和assets。客户端仅提交backend ID、prompt和身份断言。新 `d06-acp-local-v1`／`d06-acp-helper-v1` 与绑定／会话不放宽旧快照；按 authenticated principal/session 解析后才派发，A→B及payload自称批准均在零operation时拒绝。
- [版本化 launcher](../../packages/dsh-agent-studio/adapters/acp-launch-v1.py) 通过同一 Provider 安装／完整读回 hash，核验 bootstrap/binary/assets、cwd、专用 HOME/env。内部 WeakMap 一次性 capability 传专用secret，不进持久input／manifest／operation。exec保持真实PID/startTick；首帧identity关联task/instance/binding/version/manifest/operation。新私有XDG/HOME不读旧账号配置。受管可信代码执行仍不是OS sandbox。
- [有界 stdio](../../packages/dsh-agent-studio/adapters/acp-stdio.mjs) 复用 frozen helper 既有stdin pipe／write／read／status／terminate，新增产品内部EOF适配，不修改冻结helper、不在远端装完整dsh。真实7-byte分片／UTF-8、JSON-RPC分帧、序号／base64、stdout1MiB／stderr16KiB／frame64KiB／event1000及总payload1MiB限制；不完整EOF、异常退出、超限明确失败。fs/terminal不广告且明确unsupported，无中央默认文件服务。
- [AcpState](../../packages/dsh-agent-studio/acp-state.mjs) 复用 D05 ControlState，schema6保存task／stream event／operation lineage／controls及不可变response。原scope的 approval/question事件和server-owned WeakMap接原UI，不伪造native model turn。control绑定principal/session/binding/version/run/task、CLI session/instance、RPC request与deadline；一次消费，实际Provider写stdin前再次核验迟到／取消／重复。仅CLI原提供的once选项；typedform按schema验证，unsupported不吞掉。
- [原 sidebar ACP tasks](../../packages/dsh-agent-studio/acp-sidebar.mjs) 由hash-locked投影装入原会话：选登记backend、Start／进度／Cancel／history，权限和问题仍由原Allow once／Reject／Submit处理。ACP journal不是native模型历史。`stdio-written-unconfirmed`不冒充peer ack；实际使用回答由本轮receipt和流更新另证。
- 退出／取消核对真实进程已停后release；断连保留unknown且不fallback、不换ID、不重放旧决定。graceful restart真实阻塞peer被停止、旧control失效、不启动替代CLI；crash recovery、session/load/resume及原任务恢复不在通过范围。每session1个活动task、每task至多4个待答control；URL elicitation、pattern/format等明确不支持。

### 最新源码实际验证

| 实跑 | 通过项 | 产物 |
|---|---:|---|
| Store／共享controls／backend／实际mutation gate／重复RPC | 27 | `artifacts/d06/unit-27.tap` |
| installed SDK＋真实LocalProvider stdio／错误／一次性批准／typed form／真实待审批重启 | 15 | `artifacts/d06/local-71034b28-3607-46fc-9e9a-989e4c1c5bd1.json` |
| m1-a form／分帧／取消／精确broker断连，独立字节与PID观察 | 4 | `artifacts/d06/remote-4cd09830-e4b9-4e12-9bdd-db4841420a25.json` |
| 原ACP UI local+remote／拒绝／超时／取消／reload／390px | 7 | `artifacts/d06/ui-final/browser.json` |
| D05原生本地／m1-a定向回归 | 10 + 4 | `artifacts/d05/integration-6ae4aa0b-e275-443b-beb0-018a2544d114.json`；`artifacts/d05/remote-83a894de-79a2-40f2-a758-2d6db97b82da.json` |
| D05原UI配置读回／picker／local+remote六工具与controls／引用／取消 | 7 | `artifacts/d06/d05-ui-regression/browser.json` |
| 重启后SQL/API/list、真实日志、auth、来源、权限、语法 | 7 | `artifacts/d06/final-verification-dc9c4700-c4b9-425b-92aa-fa5efbff92d2.json` |

- **迁移 checkpoint**：`pre-migration-snapshot.json`→`schema6-preservation.json`，13表旧行完全一致，含1356 operations／39 requests／59 controls；schema6、integrity=ok。后续D05回归合法新增revision／更新选择，不能把迁移时比较冒充当前所有模型配置字段永不改变。最终另验证schema4的7张基线表旧行（含928 operations）仍不变。
- **最终存储闭环**：1587 operations、23 ACP tasks、26 ACP controls、320 events直接只读SQL→完整API→ID/list/events→重启读回；52 model requests／78 controls及11个完成过会话的物理JSONL／zstd→native inspect/list保持。D06 sessions的model_requests为0，无active operation/task/control/watch。203个local身份、45个旧remote PTY PID及10个ACP remote身份独立核对已停／zombie／身份已变。2个unknown ACP tasks、8条unknown operations及早期失败保留。
- **认证／凭据**：public health200；8个ACP端点无／错auth均401，正常登录→原UI→读写成功。synthetic ACP credential由原credentials/set写固定vault→私下直接读回→describe/backend readiness，414个非vault文件扫描不含该值；357文件／111目录私有权限通过。客户端不能伪造WeakMapticket或用MODELref替代ACPref。
- **真实副作用**：批准前无业务receipt，once只对应原实例；拒绝／超时／晚答不写。form的string/integer/boolean答案真正进入peer文件；本地完整bytes/hash/API/search，m1-a独立只读Docker观察实际文件hash、cwd、PID/startTick，与API/SQL一致。远端失败同名中央canary不变。断连只终止经cmdline/PPID/startTick核对的本轮broker，不动平台Agent；旧remotePID后来独立确认消失，但task仍unknown，不冒称cancelled。
- **原UI**：最终local/remote真实Start→原审批→原typed question→完成；reject／timeout／cancel及reload历史通过。最终远端approval/question/complete和390px截图已实看，document scroll390、panel宽389，无横向溢出；不是实际手机验收。JS/console/非预期RPC/HTTP/外部请求均0，skills/list disabled按原边界保留。D05回归local/remote完成截图已查看；该轮复用已有provider（created=false），不冒称重新建配置。
- **来源与运行**：75个来源锁（含9个ACP SDK文件）、16个冻结D01文件及旧证据不改写；38 ESM／10 Python语法通过。新启动log增量0，历史5360-byte日志保留。配置扫描只见显式回环测试host／动态端口和endpoint guard，无新增固定目标端口；未读真实.env，未进行授权外Docker rebuild。没有为凑数重跑无关M1；D01–D05受影响Store、身份／来源／文件读接口及native controls/UI完成定向回归。

### 保留失败及修复

- `D06_TEST_SCHEMA_EXPECTATION`：首次schema6单测20/21，旧断言仍预期5；修正断言并补ACP测试，阶段24/24、最终27/27。失败 `unit-schema6-regression.tap` 和各阶段通过TAP均保留。
- `D06_UI_PAREN`：首次sidebar语法检查报 `Unexpected token ')'`，移除多余闭括号后syntax及24单测通过；错误来自当时命令输出，未伪造失败TAP。另一次credentials helper批量替换造成的中间递归在部署／运行前定点修正，后续vault真实链路通过。
- `D06_TEST_NATIVE_QUESTION_AUTOADVANCE`：原单选控件已自动下一题，测试又点Next导致空整数题超时；按实际原组件去掉多点，业务receipt未写、deadline正常。`artifacts/d06/ui-first/browser.json`及failure截图保留，包括原cleanup_error；后续cleanup先确认任务仍live。
- `D06_TEST_HIDDEN_SESSION_PANES`：第二轮local四组已过，切remote后locator误匹配保留的hidden pane；改为visible panel内定位，非修改产品绕过。`ui-native-questions/browser.json`／failure截图保留；之后`ui-visible-scope`和最终`ui-final`各7组完整通过。

### 交接与未执行项

简洁 [D06 证据](evidence/d06-acp-client-development-selftest.json)索引8条实际测试命令、39个产物引用、40个源码指纹、12张最终截图及保留失败；README给出入口、显式登记与复跑命令。JSON完整读回与全部引用hash核对通过，旧D05 evidence SHA不变。文档20份／本地链接224个／文档回归39项、8份调研和32项实施SHA、`git diff --check`通过；实际输出与最终文件摘要保存在 `artifacts/d06/docs-validation.json`。最终 `final-auth.json` 再核对health200、匿名根页401、8个ACP端点无／错auth共16个401，已认证descriptor／完整task list与SQL一致；D05常驻fixture cmdline/startTick也已核对，不输出秘密。

保留可运行预览 PID1234150、run `32ba1cd1-8817-4d8d-9287-dd78447ea8e7`，当前origin `http://127.0.0.1:35047`（动态值，后续以status为准）；私有认证文件 `/home/ubuntu/workspace/agent-studio/.preview/agent-studio/login.url`，不输出token/cookie。D05模型协议fixture PID538557／任务`bit7syyr7`是必要常驻测试服务，不重复启动／等待退出；D06peer按task启动，最终没有活动peer／待完成测试。

只读inventory保存于 `backend-inventory-local.json`／`backend-inventory-remote.json`：本机OpenCode1.2.20仅查到ACP binary markers，Codex／Claude Code仅元数据，没有调用这些CLI；m1-a managed PATH没有node/opencode/codex/claude，Python3.13已核验。真实外部CLI还缺批准的实际可执行版本/hash/协议argv、允许kind/policy/绑定、专用认证与必要非秘密配置、允许的任务／副作用；未自动安装或运行真实模型。**正式SC-12、真实模型、实际手机、强隔离、crash recovery／原任务恢复均未通过；下一切片继续环境管理与原任务恢复，不结束总goal。**

## 12. D07-environment 阶段交接（最终综合实跑未通过）

2026-10-31，build／fix采用loop，同一唯一写入者，无再委派。**阶段结论：环境发现及新UI链路有通过证据，最终综合实跑未通过。** 遵照收敛指令停止追加远端负载、综合／全UI重试；最后只做离线时序、源码、存储及认证核查并保留预览。未启动D08，不以阶段报告冒充D07完整交付或正式验收。

### 已实现的路径与边界

- [环境状态](../../packages/dsh-agent-studio/environment-state.mjs)／[Manager](../../packages/dsh-agent-studio/environment-manager.mjs)：schema7保存不可变observations、head revision、lifecycle requests和connection links。注册快照不冒充live status，lifecycle/build/job/platform Agent/helper/channel/identity与观测时效分别显示。query失败／陈旧明确拒绝派发；旧17表及原实例／绑定历史保留。
- [中央执行器](../../packages/dsh-agent-studio/adapters/coder_environment.py)复用原broker专用凭据，owner＋org＋workspace/template allowlist过滤，current build/resources与直接只读SQL关联。已核对运行版本`v2.37.8+7ac93cf`、commit `7ac93cffea828ca2d9514cfc6c0ad6337834aebe`，Coder server镜像digest `sha256:8514c20c3c7811a9835eb903c5123b0090ba6538dc8bcc8281624d0bdedd9063`；不要与workspace image `sha256:35749aeb9ddb29fa2e5213a531d81f8827d8d29ea4348488d2155a27a95a40b5`混淆。
- 固定commit公开源码确认create为`POST /api/v2/users/{owner_id}/workspaces`，start/stop为`POST /api/v2/workspaces/{workspace_id}/builds`，201；poll只GET持久build ID。真实写executor存在但本轮仅受控transport执行；private policy为0600、read_only=true/actions=[]，真实lifecycle请求／attempt均0，客户端不能改scope。固定参数不收secret，不开放delete/rebuild/credentials/state/orphan等旁路。
- prepare/confirm绑定认证主体、目标、固定模板、参数／policy hash、副作用、phrase与期限，确认CAS＋POST前attempted_at一次消费；同目标锁防并发。accepted不等于ready；job失败／deadline／未知提交分开，unknown/timeout不POST重试且保留锁。stop不隐式删数据，不冒称原进程取消成功。
- [原环境面板](../../packages/dsh-agent-studio/environment-sidebar.mjs)由hash-locked原sidebar投影挂入全局native dialog及tab。未选会话可用；选择m1-a→注册对照→已有/新binding→已有/新native session→原Files/terminal。`environment.open`持久saga，request ID异参数拒绝、不自动重做。新增project `project-13c95874-8a7b-40d7-82a3-2510430e05fd`，binding `binding-6113005c-b396-4807-b48a-90f697c1395e@1`，session `session-e5dea400-7d8d-4f76-8296-4269325fdf30`及其受管子目录保留。
- buildId不作generation。同世代停／断连／陈旧只暂停、撤销旧controls并保留恢复身份；新generation/root/policy撤销旧版本，用户显式追加InstanceRecord／version／anchor／新session，不改旧任务。模型、ACP、普通operation与controls统一级联。普通remote.connect只是新认证，不是旧任务恢复；仅保留D08恢复资格失效接缝。

### 实际验证分层

| 证据 | 结果／范围 | 产物 |
|---|---|---|
| 最终离线状态／时序／旧回归 | **45/45** | `artifacts/d07/unit-stage-45.tap` |
| Python真实executor代码＋隔离transport | **5/5**；不访问真实POST | `artifacts/d07/python-stage-5.txt` |
| 真实readonly API／auth／SQL／独立broker及restart | **6项**，17表迁移旧行完整；后续新Send时间戳变化单列 | `artifacts/d07/integration-1841027f-251e-43b5-84c6-d678f7102139.json`、`integration-a3d78e7e-caad-45af-a8ad-df95f17e5ed5.json` |
| 原Web新成功链路 | **8项**；无会话入口、原Files/terminal、新native session/newbinding、390px、Escape、401；5张截图实看 | `artifacts/d07/ui-new-path/browser.json` |
| D04–D06定向真实provider／离线模型/ACP | **8项**；local命令/文件、cold local/remote六工具/审批、流取消、local/remote ACP typed form | `artifacts/d07/regression-8a70d6fc-4aa5-498f-9ee7-6d90b13815e2.json` |
| 最终综合检查及唯一一次复测 | **均未通过，0项检查完成**；前者TTL，后者helper start timeout/EOF | `artifacts/d07/final-verification-dad2d917-5207-44df-9b73-6091924d0432.json`、`final-verification-7131584c-e5b3-49c1-8f1d-e20cc07611e3.json` |
| 最后本地源码／存储／认证收口 | **5项**；不执行远端任务、不代替失败的综合检查 | `artifacts/d07/stage-closeout-final.json` |

1. migration时schema6的17表完整行均保留。D07新Send正常更新两行`model_selections.updated_at`，provider/model/revision与配置不变；时间戳与新request对应核验，不回填旧值假装immutable。随后当前17表逐字段重启比较、全部operation SQL→full API/list及links读回通过；model/ACP/native历史在前一restart检查完整重读。真实lifecycle request始终0。
2. 本地／远端冷Send分别用新request `ccb670c0-771d-494e-b93a-1a75eff630bd`／`8bc3de37-98a0-439a-88fa-b588156790df`，未经picker重选，六工具、4controls、真实字节／hash／搜索及operation lineage通过；远端流`98a9c39e-4a05-47d9-901b-032e1001daaf`真正cancelled。新ACP两任务均真实PID/startTick核对停止并release；不是外部编程CLI。
3. UI不是零网络错误：03:18:22.298 D02 channel.connected后，03:18:30.350出现`changes.ops`409/provider-unavailable；它走Host固定禁用session-change history的拒绝分支，在新session/newbinding切换前出现，不是通道故障，不声称此route恢复。原Files/terminal随后成功。清cookie场景401返回非JSON，JSONDecodeError来自harness `r.json()`监听器，原UI正确显示HTTP401。对原报告的HTTP/RPC/decode错误精确分类断言，没有笼统忽略409；JS错误和外部请求确为0。390px不是实际手机。
4. 最后部署当前源码、来源锁／projection、全部JS/Python语法、私有权限／gitignore、startup日志增量与自有preview认证值排除检查均有输出。只检查受控preview配置；不读生产.env、不读取/复制Coder秘密到产品，不做授权外Docker rebuild。常驻fixture PID538557/startTicks634479748未重启。

### 独立保留的失败与修复

- `D07_TEST_BASELINE_KEY`：无PK表不能按PK比较，改完整行多重集，旧失败保留。`D07_UI_DISCOVERY_SELECTION_RACE`：异步refresh旧闭包清空selection，改functional update＋busy禁止选择；新UI已实际越过该步骤。`D07_UNIT_NULL_PROTO`及`D07_STAGE_OBSERVATION_COLUMN`为新测试的SQLite null-prototype比较／字段名错误，定点修正一次后通过，失败文件仍保留。
- `D07_COLD_MODEL_SELECTION_NOT_INSTALLED`：已保存SQL选择的冷Agent没有原生selection，assembly报`{{model}}`缺值，request `ff850703-40b9-45bc-943a-3c86b5d375ee`实际failed、未产生工具调用。新Send先按当前权威scope/revision/credential ref安装原生同一选择；select/Send串行，撤销/过期/跨主体/aborted/mismatch/replay与已加载新选择均有定向负例。原失败不重发，不改真实供应商／配置。
- `D07_REMOTE_SEARCH_SSH_255`：历史三条unknown及原channel `aeeff644-1035-425e-886d-6a3ac7867ca0`、helper session `9f544479c7ab7ac69854247e0cdd12a7`保留。`966626f2-738a-4c34-a38d-2b90f8c12072`的process `fcf20fbe-6c6d-4791-af89-d4da27a3f6a5`／PID23134后来只读观察不存在，无原startTick/exitcode故仍unknown；`408cf66d-9600-4792-a4c0-0409a6a2f457`／`a2d2adc8-17f4-419d-9be8-85646e7a3bdd`的process分别`a42a019c-4b12-4a7c-a3c6-82203c5ee72c`／`083f3139-0930-4131-bb73-f4ce5df48be8`，无PID不等于未启动。stderr已丢失、40秒窗口脱敏分类不足定因，明确未定位，不无限扫描。`failure-ssh255-original-observation.json`保存边界；新single-read／UI成功不是历史修复。
- `D07_OBSERVATION_TTL_DISPATCH_RACE`：综合检查的`90a931c8-55fe-4e7a-8982-638ea7aa3feb`／process `72ec1377-ab1f-4286-8cb0-94531c7b8e8d`／PID23731，channel `09428b92-52ab-43fd-b0e1-7388ee8c5e8d`、helper session `14f59478188ed6f7e638e84905a00b12`，03:41:28派发期间观测过期，原cleanup未确认。已改连接空闲期也半TTL真实刷新、near-expiry派发先等刷新；失败仍拒绝，超期仍立即失效。随后定向离线证明共享刷新、刷新失败拒发、迟到旧观测不能覆盖新世代撤销、dispose停止timer/忽略在途响应。停止追加负载前已发生的真实空闲期控制面观测跨TTL保存于最后report；不是仅更新时间戳。原operation仍unknown，未追加远端证明其结果。
- 同时补 **unknown单调保护**：旧代码late start ACK可把失联记录写回running，后续关闭又改变error；当前保持unknown，可信迟到PID只作原身份补充，追加`operation.late-result`关联原request hash/channel/helper session/process/PID/旧原因，不恢复权限。status/read和晚到error不清除unknown。45项离线结果覆盖该竞态；未把历史error字段改回假造的原因，原audit链保留。
- `D07_HELPER_START_TIMEOUT_EOF`：唯一综合复测新增`17e4b4af-a7ef-441b-a4e5-61e145a724a2`，channel `0a9c8ae3-0633-46b0-ab6a-efa2d9329574`、helper session `946b442ca297fa4222056ba64a4b7a06`、process `b73ef497-d29d-4ad3-9c05-bbe5a4c437df`，PID未确认；03:44:16.798 start至03:44:26.805超时，03:44:30.770 helper EOF。该次没有把TTL当原因，仍属未定位传输/响应故障，不能确认原进程未启动。`final-retry-diagnostic.json`保留，未第三次综合重试、未广域清理。

### 交接与未完成项

[D07简洁阶段证据](evidence/d07-environment-stage-selftest.json)分别引用真实readonly/UI、离线executor、冷Send修复、最终45项守卫、两次综合失败及最后本地收口，不嵌套旧报告、不改D01–D06 evidence。总计13条unknown（早期8＋本轮5），无pending/running记录并不证明未知远端进程全部结束。只清理已确认自有任务；无PID的3条及PID23731当前结果仍未知，原PID23134缺退出事实。未停止平台Agent/workspace，未删除项目数据。

当前policy只读，真实create/start/stop/rebuild/delete、第三实例、模板／镜像／资源变更、m1-b负载、真实模型／外部CLI、手机/多机/强隔离及D08恢复均未做。保留预览与原D05fixture；认证文件仍是私有`/home/ubuntu/workspace/agent-studio/.preview/agent-studio/login.url`，实际无token origin见`stage-closeout-final.json`或status。由协调器核验本阶段结果后再接续恢复／传输可观测性，不宣布整个goal完成。

## 13. D08 同 Host 原任务恢复窄闭环（初版 WIP 已暂停）

D07阶段结果已由协调器核验，仍不是完整验收。D08 开发期间唯一写入者、无再委派，按build/fix＋loop执行；D05常驻fixture及13条历史unknown不改写／重放。首个计划出口仅是同Host内短暂transport丢失后，显式恢复原helper session／process，接续原输出，核验单次副作用，再取消并release；不扩到跨Host crash、ACP业务协议resume、真实模型／编程CLI或后台任务体系。**该出口尚未完成，以下为暂停前的开发计划，不自动继续执行。**

1. 先补有限脱敏broker／SSH／helper RPC／观测暂停诊断，做只读身份／能力预检，不用新负载掩盖不稳。
2. schema7增量迁移，保存不可变启动身份、实际retention、任务deadline、首次失联固定恢复deadline及独立游标／事件；resume token只在中央私有vault，旧身份缺失明确拒绝。
3. 独立显式恢复入口与原task接口关联；不调用workspace/open或process/start替代，不重发输入／审批。提交前再次核验原绑定／世代／策略，恢复同helper session串行化。原终端读循环可暂停，未核验禁止输入；输出缺口与native frame序号分开。
4. 先离线身份／期限／并发／撤销负例和本地同Host句柄验证，再在m1-a既有自有根做一个有截止时间的合成任务及原UI流程。只断自有transport，不停平台／Agent／daemon。SQL→完整API→列表、schema旧行、认证、语法／部署／启动日志逐项核对；实测若阻断按命名、一次定点重试、换方案保留失败，不无限重试。

### 暂停前实际进展（不是恢复验收）

- 初版已实现 [RecoveryState](../../packages/dsh-agent-studio/recovery-state.mjs) schema8、[TaskRecovery／私有 vault](../../packages/dsh-agent-studio/task-recovery.mjs)、[固定受绑定只读探针](../../packages/dsh-agent-studio/adapters/task-observe.py)，以及 `task.preflight/recovery/recoveries/recover/detach` 和原 task status/read/cancel/release 关联。原 operation 身份不被 current transport 覆盖，首次失联期限固定、helper session恢复串行；不重发命令／输入／审批，不调用 workspace/open 或 process/start 替代原任务。token仅私有 vault，DB/API/audit只引用；首轮不声称 fsync crash-durability 或跨 Host 恢复。
- 历史定向 Node **36/36**（含D08及受影响D07守卫）、固定 observer Python **4/4**、四个原 sidebar chunk seam／语法通过。本地只验证进程内保留句柄／缺句柄拒绝，未做真实 SDK 同 Host 恢复端到端。
- 真实只读 preflight **6项通过**，run `db970a50-ad64-4de9-89c0-28b37272e51b`：schema7 的21张业务表完整行多重集及13条unknown迁移后不变；原官方transport／同channel身份／helper0.13.1、retention30000ms、resume capability核验；workspace/open=0、process/start=0。缺／错auth共10次401，public health200、匿名根页401；12个部署源码匹配，新启动log增量0。**能力预检不是一次原session恢复**。
- 唯一真实UI run `ff60899a-dd0e-4b6d-b3e7-96cc30c67abd` 失败，原报告 `D08_SINGLE_TASK_UI_FAILED`、完成检查0。诊断命名 `D08_HARNESS_MULTILINE_TEXT_INPUT`：Playwright insert_text经原textarea移除Python换行，`exec python3` 在同PID24266中 `SyntaxError` 退出1。operation `terminal-5f97a051068c5c6bd0e27ac7f85bfc7045cc636e6a9f54a660b84e63df650c49`，原channel `31aad43d-8d26-4b8a-a2bc-21ceafb8463e`、helper session `3c90a39f0f87747bcc05b861a0547fc8`、process `8be121dd-2df7-414c-b7c9-79b156051c49`。已保存complete启动快照；失败后原native close/readback确认released，暂停前最后SQL的pending/running=0。
- **没有执行task.detach/task.recover，没有UI重试**。初版只接原bottom-terminal投影；实际原生terminal tab组件不同，恢复入口仅定位、未补。`scripts/dev/recovery.browser.py`仍保留失败时的输入逻辑，不能作为已修复或通过的测试。原终端读循环暂停虽已接线，没有真实断连／输出接续／单次副作用／取消恢复闭环证据。

## 14. 截至 2026-10-31 暂停快照

`/goal clear` 后在安全点暂停，后续仅准备文档／代码 WIP 版本快照。未启动拟议的UI重试、transport断连／恢复、新远端负载或下一切片；本次不修功能、不重启预览／D05fixture、不动平台Agent/workspace/daemon、不重置DB或13条unknown，不删除项目／历史失败数据。**pending/running=0只说明记录中无活动测试，不证明未知远端进程全部停止**。

暂停前最后部署观测为PID1914320、run `b478c159-9a65-4fca-950b-0ecf9b6391c4`、动态回环 `http://127.0.0.1:39261`；这是开发机历史观察，不是固定端口、远程入口或本次在线保证。认证入口只给私有路径 `/home/ubuntu/workspace/agent-studio/.preview/agent-studio/login.url`，不发布内容／token／cookie。D05常驻fixture PID538557保留、不重复启动。真实Coder生命周期request仍0，真实外部模型／编程CLI未验，正式M1/M2／SC-12／全项目／发布门禁未通过。

本次版本快照只运行无远端负载的本地验证：文档检查与39项文档测试、D08受影响Node集合、Python executor／observer隔离单测、源码／projection语法、校验和与git diff --check；**不重跑真实远端端到端、UI、生命周期，也不重建未改的冻结容器**。完整命令、实际结果及历史产物SHA见 [d08-paused-status.json](evidence/d08-paused-status.json)；原始artifacts／截图／运行数据不随仓库发布。公开提交前另对每个拟暂存文件读全、检查类型／大小并扫描秘密，引用vault路径或synthetic测试字段须分类，不等于真实凭据值可发布。

后续待办仅登记、不自动接续：

1. 修复合成输入的单行传输与实际原生terminal tab恢复入口，再按授权做单任务同helper/session/process/PID/startTick恢复、原输出／缺口、单次副作用、取消/status退出/release。
2. 补真实local SDK同Host句柄闭环及缺句柄／换Host拒绝，实际SQL→完整API→列表与新增请求／事件读回。
3. 另外安排跨Host持久恢复、ACP业务resume和传输未定位故障调查；不把新成功回写D07两次失败或13条unknown。
4. 真实生命周期、外部模型／CLI、强隔离、多机／手机及正式门禁仍各需相应授权和独立证据；WIP提交／推送不代表验收通过。

## 15. 继续推进后的本地收口（未部署、未重跑真实恢复）

收到“继续推进”后，在原暂停源码基线上恢复有限本地开发。只使用临时测试目录、受控本地子进程和显式离线协议 fixture；不启动新预览／服务，不调用 Coder、SSH 或真实模型／CLI，不变更运行数据库、13 条 unknown 或历史证据。工作树改动未提交／推送。

### 当前 schema 门禁

[Store](../../packages/dsh-agent-studio/store.mjs) 导出 `CURRENT_SCHEMA_VERSION=8`，四个当前运行验证脚本 [local](../../scripts/dev/local.integration.mjs)、[ACP](../../scripts/dev/acp.integration.mjs)、[environment](../../scripts/dev/environment.integration.mjs)、[core](../../scripts/dev/core.verify.mjs) 的版本断言和当前报告元数据统一引用它。编号迁移 1–8、历史迁移 fixture 及 [recovery preflight](../../scripts/dev/recovery.preflight.mjs) 的 schema7→8 基线断言保持不变。

新增 [schema 回归](../../scripts/dev/schema-version.test.mjs) 验证新库完整迁移序列、重开后 principal／迁移历史保持及四个脚本的静态门禁；**只读脚本源码，不 import／执行这些有部署或负载副作用的入口**。该 6 项与既有 Store／environment／recovery 的 69 项合计 75 项通过。

### broker／transport 的有限收口

新增 [child boundary](../../packages/dsh-agent-studio/adapters/child-boundary.mjs)，由 [EnvironmentBroker](../../packages/dsh-agent-studio/adapters/environment-broker.mjs) 与 [helper channel](../../packages/dsh-agent-studio/adapters/helper-channel.mjs) 共同使用。只托管本次固定 launcher 返回的原 child，不接管 PID、不操作远端任务或平台 daemon；超时先 TERM、再 KILL、最后独立截止。真实 `close` 才确认 transport 关闭；`exit`、发出信号、`.killed` 或最终 unref 都不能证明业务停止。没有 close 时返回 uncertain／unknown，提交响应丢失不重放。

stdout／proof 在解码前按字节固定容量收集，首次超限后停止收集；Environment stdout 上限 1 MiB、stderr 末尾 4 KiB，helper read 64 KiB、proof 8 KiB，helper stderr 只增量记录字节数／摘要。安装只上传经双重摘要核对的原样完整 bundled helper asset，不再与另一个 installer 生命周期竞争。初始化保留真实 RPC 的原始 stdio；detach 幂等且只关闭 transport，不调用业务 cancel／release。终态清除活动监听与定时器、销毁自有本地管道；每个 emitter 仅留一个共享无闭包的 error sink 防御已排队迟到错误，原有监听保留。

operation timeout 与清理预算必须分开：默认 TERM 宽限 15 秒、最终等待 1 秒；Environment 为 80+16 秒，helper check 20+16 秒、initialize 60+16 秒、install 120+16 秒（之后才进入 connect／initialize），detach 默认另有 1 秒 EOF grace。它们依赖 Node event loop 调度，不是 OS 硬实时保证；KILL 后缺少 close 仍不确认远端取消或释放。[新增 50 项回归](../../scripts/dev/child-boundary.test.mjs)覆盖永不 close、信号失败、输出与 proof、安装／初始化／detach、迟到错误与资源清理，并用两只本次自有短寿命 Node child 验证真实 close／TERM→KILL。

### 原生 Terminal 与合成输入

[单行 command helper](../../scripts/dev/recovery_command.py)将完整 Python 源码字节 base64 编码后放入一行 `exec python3 -I -u -c` 命令，规避 textarea 移除源码换行；仍是原 shell 的 exec，不重发命令或创建替代恢复任务。[离线 Python 回归](../../scripts/dev/test_recovery_command.py)验证多行／Unicode／引号／CRLF 字节，以及仅在自有临时目录执行一次短合成计数任务。[真实 browser harness](../../scripts/dev/recovery.browser.py)已引用该 pure helper，但未执行。

[原生投影](../../scripts/dev/sidebar-projection.mjs)实际接入 SDK 的 `TerminalBody`，不把 better-sidebar bottom view 误当作原生 tab。采用真实 `model.sessionId`／`model.id`，以 `terminal-SHA256(sessionId + NUL + model.id)` 对齐 Host 原 operation，不使用 tab／content ID。保留原 model、xterm 生命周期、输出 frame／ACK；初始关闭输入，输入回调也核对当前可写／可见 gate。恢复 panel 对原 session／operation／kind 和当前 view generation 做 fail-closed 检查；失联、动作进行中、身份／可见性变化及迟到响应不能沿用旧输入授权，A→B→A 也不能复用旧 proof。

[profile patch](../../profiles/agent-studio-preview/cordis.patch.yml)禁用准确 stock plugin `ui-sidebar-terminal`、只插入一个 profile-local native-terminal Host；[launcher](../../scripts/dev/preview.mjs)在受控私有目录投影，保留原 manifest、Host、client factory、locale、许可证及类型，不写穿 SDK namespace symlink。新来源锁与唯一 seam 均需通过；[UI 离线回归](../../scripts/dev/recovery-ui.test.mjs)测试当前安装 Registry 的 Host→本地 manifest→原 client lazy factory→投影 chunk 解析和实际 model 分配身份，但不启动插件／服务或浏览器，不构成完整兼容基线或真实恢复 E2E 验证。

### 最终合并复查与纯本地检查

两路实现停止写入后复查合并差异；新增的三组 Node 回归共 73 项、Python 回归 3 项。最终执行：

- `node --test scripts/dev/schema-version.test.mjs scripts/dev/store.test.mjs scripts/dev/environment.test.mjs scripts/dev/recovery.test.mjs scripts/dev/child-boundary.test.mjs scripts/dev/recovery-ui.test.mjs`：**142/142**，无失败／跳过／取消。
- `python3 -I -B scripts/dev/test_environment_broker.py`：5/5；`python3 -I -B scripts/dev/test_task_observe.py`：4/4；`python3 -I -B scripts/dev/test_recovery_command.py`：3/3，合计 **12/12**。`-B` 避免产生 bytecode 文件。
- `scripts/` 与 `packages/` 范围：**74 个 MJS** 通过 `node --check`、**45 个 Python** 通过源码 `compile`；没有 import／执行 integration、browser 或其他 operational 入口。
- `python3 -I -B scripts/check_docs.py` 与 `python3 -I -B scripts/test_check_docs.py`：20 份文档结构校验与 **39/39** 回归通过；45 条外链只计数、不联网逐一核验。
- 两份历史 `SHA256SUMS`：8 项调研 + 34 项实施证据共 **42/42** 通过；没有重写旧证据或改成新的验收结论。
- `git diff --check` 通过；变更仅限源码／测试／受控 profile／状态文档，未提交／推送。

### 部署前来源一致性阻断（上一轮观察，已由下文迁移解除）

最终只读审计按[来源锁](../../profiles/agent-studio-preview/sources.lock.json)检查 **98 个资产，95 个匹配、3 个不匹配**；native Terminal 的全部 23 项及单独的 stock patch 均匹配。SDK／Gateway 安装为 `0.2.1-rc.5`，锁仍要求 `0.2.1-rc.4`；不匹配清单为 Gateway、local filesystem、local subprocess 的 package manifest。sidebar `0.28.2`、native UI `0.2.1-rc.5` 与本地 helper artifact `0.13.3` 的各自版本锁匹配，不能抵消根 SDK／Gateway 不一致，也不能把本地 artifact 版本当成当前远端 helper 版本。

来源准入检查为 **fail（exit 1）**，与上面的离线回归通过分别报告；当时 launcher 会拒绝该组合，也未执行 prepare／start。该阻断保留为上一轮观察，后续按明确授权迁移基线（见下）解除；它不构成真实验收结论。

### rc.5 基线迁移与持续升级入口（未部署）

按“升级到 `0.2.1-rc.5`、版本会持续更新”的授权，把根 SDK／Gateway 兼容基线从 `0.2.1-rc.4` 提升到本机实际安装的 `0.2.1-rc.5`。改动限定在[来源锁](../../profiles/agent-studio-preview/sources.lock.json)：两个版本字段、Gateway 与 local filesystem／subprocess 的两份 package manifest 摘要，以及把 native Terminal 的 `change` 文案从“根锁保持 rc.4”改为“独立可升级基线”。全部实现文件摘要、sidebar `0.28.2`、native Terminal `0.2.1-rc.5`、ACP `1.4.0`、helper artifact `0.13.3` 与唯一 Gateway seam 均未改；没有安装／升级依赖、修改上游安装、执行 prepare／start 或重启预览。

新增[来源核对／候选工具](../../scripts/dev/source-lock.mjs)：默认 `--check` 完全只读，逐项输出 6 个包版本、98 个受控资产及单独的 stock patch，漂移 exit 1，`--json` 供自动化读取；`--candidate --sdk-version VERSION` 要求目标与实际安装一致，只向 stdout 输出结构化候选，stderr 标记 **UNVERIFIED**，不覆盖当前锁。缺失／不可读／无效 JSON／包名不符的源不能进入候选；源码路径必须是来源根内相对路径；重复的 Gateway 来源摘要必须一致；每个绝对路径只读取并复制一次，版本与摘要取同一字节快照，避免并发替换 manifest 时混合旧版本与新摘要；所有已锁定 `package.json`（不只 6 个版本根）都要通过 JSON、包名与有效版本校验。候选仍只是字节记录，代码／接缝／helper 变化必须另行适配复核。

[launcher](../../scripts/dev/preview.mjs) 的 SDK 版本错误改为 `Unverified dsh baseline`，明确差异代表基线待复核而非新版永不受支持；包身份与完整摘要检查仍失败关闭。[UI 回归](../../scripts/dev/recovery-ui.test.mjs) 不再写死 rc.4／rc.5 数字，断言当前锁与真实安装一致、未知漂移与错误包名被拒，并保留原生 Terminal 23 项资产摘要、唯一 stock seam 与私有投影检查。

最终离线复核（未部署）：7 个 Node 文件 **157/157** 通过（新增[来源工具回归](../../scripts/dev/source-lock.test.mjs) 15 项，含未来版本候选、混合字节快照、无效 manifest、路径越界与 CLI 不写锁）；Python 环境／观察／命令 **12/12**；`scripts/` 与 `packages/` 范围内 **76 个 MJS** 通过 `node --check`、**45 个 Python** 通过源码 `compile`；两份历史 `SHA256SUMS` 共 **42/42**；`git diff --check` 通过。来源审计实跑 **98/98 资产、6/6 包版本、stock patch 匹配**。另一路独立只读复核确认“版本与摘要混合快照”“非版本根 manifest 未校验”两项 P2 已闭合、无其他阻断，未改文件、未运行 UI／合并测试或任何服务；跨文件字节不属于原子系统快照的边界已在工具中显式声明。以上是离线兼容与来源核对，不是真实部署、D07／D08 恢复或 M1 验收。

历史 M1 实验脚本（`scripts/m1/install_candidate.py` 的 rc.4 peer 断言、`t107_matrix.py` 的 rc.4 组合描述）仍绑定 T-103／T-107 当时的运行事实，**不是当前 launcher 来源门禁，也不应直接重跑并当作 rc.5 兼容证明**；若要复跑实验，须另按新基线显式调整并重新取证，不能改写原实验记录。

### rc.5 运行时原 UI 回归（2026-11-02，未验收）

在 WIP 快照本地 commit `afa9e13`（未推送）后推进运行态验证。先在随机 `/tmp/agent-studio-test-*` 根执行 launcher `prepare`：rc.5 投影成功（`sdk 0.2.1-rc.5`、原生 Terminal 23 资产、sidebar 13、helper 12、studio 文件复制、stock patch 禁用一次＋native 插入一次）；二次 prepare 幂等；临时根已删除，仓库与上游安装未变。

随后把现有开发预览重启到 rc.5（旧 PID `1914320` 停止）。初次重启由受限文件沙箱内的 shell 启动，导致 `/dev/ptmx` 被拒、`forkpty(3) failed` 与 `local-provider-error`；独立 Python `pty.fork` 同样失败，确认这是**启动环境限制而非 rc.5 或产品缺陷**。以完整权限重启后 PTY 正常（真实 bash、PID／startTick、输出可读）。**运行预览须在不限制设备访问的环境中启动**，不能让预览继承文件沙箱。

原 UI 回归结果（成功与失败目录均保留）：

- **D01**：通过（证据 `artifacts/d01/ui-rc5-regression-4/browser.json`）。适配：rc.5 外壳新增 `schedule/catalog` 探测保持 Studio 明确禁用；harness 显式选择 D01 工作区；禁用 Files 断言改为当前 `provider-unavailable` 状态，并继续要求 `/sidebar/api/fs.trees` 409。
- **D04 local**：通过 11 项（证据 `artifacts/d04/ui-rc5-regression-9/browser.json`）。适配：同一 m1-a 绑定可有多个 ready 会话，远端身份断言改为精确 `kind=remote`＋绑定，不写死演示会话 ID；切换工作区后只点击可见 right-pane tab；rc.5 侧边栏导轨会覆盖原生加号按钮，终端步骤直接派发真实按钮 click；失败报告保留类型与 traceback。中间失败目录 `ui-rc5-regression-2..8` 未删除。
- **D05**：通过 7 项（证据 `artifacts/d05/ui-rc5-regression-2/browser.json`）。离线 fixture 重启后端口与合成凭据轮换，用产品 `credentials/set` 与 `model.describe/configure` 把持久路由更新到新 `baseURL`（模型配置 revision 11），harness 等待 provider 列表加载；仍是显式离线协议 fixture，不是真实 LLM。
- **D06**：通过 7 项（证据 `artifacts/d06/ui-rc5-run2/browser.json`）。本地 ACP peer 全流程通过；远端需重启后显式 `acp-remote-demo` 重连，首次失败 `ui-rc5-run1` 保留。
- **D02／D03 remote**：未通过，当前远端 helper 报 `helper-call-disconnect`（证据 `artifacts/d03/ui-rc5-regression-2/browser.json`），与 D07 历史 SSH255／helper EOF 同属外部不稳定边界；不以本地通过回写远端结论，未重放或伪造。
- **D08 真实恢复**：未执行。远端通道当前不可用，无法安全获得原 helper／process 身份；不重发命令／输入／审批，不以新任务冒充恢复，13 条 unknown 不变。
- 本轮源码适配：`browser.py`（D01）、`core.browser.py`（D04／D03）、`model.browser.py`（D05）为测试 harness；`adapters/local-provider.mjs` 新增有界失败审计消息；未改 Gateway／sidebar／native 投影语义。DB 新增 D05 远端会话与模型配置 revision 11，均为测试数据；历史 evidence 未改。
- 以上是开发预览回归，不是 M1、D07、D08 或发布验收。

### M1-10 归一化旁路独立复验（2026-11-02）

repair2 已把 `scripts/m1/t107_repair_guard.mjs` 的动作分类改为与安装 sidebar 完全同源的 `new URL(req.url ?? "/", "http://dsh.internal").pathname`；剩余工作是独立验证，而不是再改代码。本轮由独立代理在全新私有夹具中复跑：28/28 聚焦单测通过；实际安装 sidebar／host 注册入口的受限 Node 探针 exit 0，**51 个负例零副作用、10 个本地正例各一次真实效果、8 个 recorder 全部回收、routes/listeners 残留 0、networkAttempts 0、sourceUnchanged true**。独立自写探针覆盖 27 个 target（canonical、`./`、`%2e`、`%2E`、`foo/../`、query/fragment、绝对／协议相对／无前导斜杠、编码斜杠、反斜杠等）：凡安装语义会派发 `open.external` 的拼写，remote／absent／forged 均为 **403 且 delegate 0**，local 为 200 且 delegate 1；其余拼写按安装语义 delegate，无旁路。parse failure 与 forged binding／claim mismatch 均 403、delegate 0。源码与安装哈希全部匹配（guard `49796a…`、入口 `612fcb…`、测试 `4d534c…`、sidebar `871e8d…`、host-open-in-app `b1d17a…`）。

独立记录见[复验证据](evidence/t107-repair2-independent-validation.json)。非阻断观察：guard 与安装实现的 body/错误码差异均为更严格拒绝；fixture 的 socket／准入仍是 stub；按声明范围未跑真实 controller／远端／DOM。历史 review2 归档保持不完整且未改写。

### 仍未验证与下一步授权边界

本地边界修复不是 D07 SSH255／helper EOF／timeout 的已证实根因；不撤销最终两次综合失败，也不宣称 13 条 unknown 已停止或已取消。D08 历史 UI 输入失败仍是有效失败记录；源码中的单行输入／原生 Terminal 接线即使离线通过，也不构成真实同 Host 恢复验收。真实实验仍需另行确认，然后只运行一个有截止时间的原任务，核对原 helper／session／process／PID／startTick、输出接续及缺口、单次副作用、取消与 release；不得重发命令／输入／审批或以新任务冒充恢复。

正式 M1 仍未有最终放行决定：[review2](evidence/t107-independent-review2.json) 记录 `repair-required`、`m1Passed=false`，归档仍缺最终 validation，不能称为完整独立验收归档；M1-05 只在声明技术范围通过。repair2 对 T107-R2-IA-04 的 URL 归一化修复已由[独立复验](evidence/t107-repair2-independent-validation.json)在本机声明技术范围关闭：28 项单测、实际入口 51 负例／10 本地正例、8 个 recorder 全回收、0 旁路、安装源码哈希匹配。正式 M1 放行与 T-201、真实外部模型／CLI、生命周期、多机／手机、完整 M2／M3 与发布门槛均未因本轮修复而通过。
