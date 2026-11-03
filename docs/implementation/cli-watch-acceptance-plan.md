# CLI／watch 最小真实验收准备（未执行）

状态：Lead task12 的**输入计划**，非测试记录、部署授权或验收结论。依据公开契约：[ACP 后端目录](../../packages/dsh-agent-studio/acp-backends.mjs)、[会话控制](../../packages/dsh-agent-studio/acp-session.mjs)、[协议投影](../../packages/dsh-agent-studio/acp-protocol.mjs)、[持久状态](../../packages/dsh-agent-studio/acp-state.mjs)、[凭据引用](../../packages/dsh-agent-studio/credentials.mjs)、[执行计划](../08-execution-plan.md)及[交付与验收](../05-delivery-and-acceptance.md)。

## 边界与结论口径

- 本计划仅准备输入；源码／离线切片不等于部署，不等于 T-206／T-207／T-208、远端 Git／watch 或真实 CLI 验收。现有 ACP 原生审批、提问、取消路径已实现；本轮**没有**真实 CLI 验收。不得据此声称源码中的 UI 修复已经现场验收。
- dsh／Gateway `0.2.1-rc.5` 是可重复兼容性快照，不是永久冻结、生产升级决定或回滚证明；后续版本须重新核对兼容性与来源。
- 每项只标“通过／失败／未执行／环境不支持”，分别记录实际后端、目标与可观察事实；离线 mock、模型口头承诺、浏览器视口和独立 provider 探针都不充当真实产品闭环。

产品收口顺序：先获得真实 CLI／目标／授权，核对 ACP 协议门，再做单次真实对话与有界控制；远端 Git／watch 使用另一个获准专用目标。任一步失败不以提高测试数量替代修复。

## REQUIRED INPUTS：等待提供／明确批准，均未选定

| 输入 | 必须明确的内容与边界 |
|---|---|
| 真实 CLI | 经批准、实际支持 ACP 的 CLI 名称与版本、规范绝对可执行文件路径及 SHA-256、ACP 启动 `argv`（至多 48 项）；实际能力与许可／来源核对。不可用离线 fixture 冒充。 |
| 目标身份 | `local` 或 `coder`；准确的 principal、session、binding ID／version、目标根、当前目标实例及认证通道身份；远端另核验原生 anchor UUID 与 Coder workspace UUID 是不同身份，不能互换。 |
| 引导材料 | bootstrap Python 的规范绝对路径及 SHA-256；可选至多 4 个固定 asset 名称及 SHA-256；资产来源、目标根写入及私有 ACP HOME 创建／写入的批准范围。 |
| 安全夹具 | 一条专用、非秘密的 scratch fixture 路径及允许的文件／进程副作用和独立读回方式；禁止随意写仓库或访问远端生产资源。 |
| 交互预算 | 真实模型／账户的批准使用方式、预算、任务总期限 180 秒、每个控制期限不超过 60 秒；不得要求用户粘贴任何凭据值。 |
| 操作权限 | 分别确认取消／断线注入的准确目标与权限；若需目录／策略／预览投影／重启，逐项取得显式授权，不能从本文推定。 |

这些字段是申请表，不是默认值：缺少任一影响启动、归属或副作用的字段，保持“未执行”。操作者只提交非秘密的身份标识、摘要与批准范围；秘密材料由获准的私有渠道设置，不向文档或聊天粘贴值。

### 目录与安全输入约束

- 规范目录形状为 `{version:1,backends:[row]}`，row **恰含** `id,name,version,protocol,kinds,policies,executable,executable_sha256,argv,credential_refs,environment,offline_fixture,bootstrap,assets`；`bootstrap` 恰含 `executable,sha256`，每个 asset 恰含 `name,sha256`。这是字段清单，**不是**可运行配置。
- 真实行 `protocol="acp"`、`offline_fixture=false`；`kinds` 须匹配目标，`policies` 包含相应 `d06-acp-local-v1` 或 `d06-acp-helper-v1`，且 catalog 所属 spec 的 `acp_execution:true` 需单独批准配置，**不自动启用**。目录至多 16 行，ID 唯一；绝对路径无 `.`／`..` 段，SHA 为 64 位小写十六进制。
- `credential_refs` 仅映射 CLI 环境变量名到专用 `STUDIO_ACP_*` 引用名；不得复用中央 `STUDIO_MODEL_*`、Coder／SSH／OAuth 凭据，不能通过 project `.env` 或凭据探测获取。`credential_refs` 与 `environment` 各至多 8 项且键不重叠；环境名满足大写字母起始、后接大写字母／数字／下划线、长度 2–80，拒绝 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TMPDIR`、`XDG_`／`LD_`／`DYLD_`／`PYTHON`／`NODE_`／`CODER_`／`SSH_`／`DSH_` 前缀及 `BASH_ENV`、`ENV`。普通环境名还不得含 `TOKEN`／`SECRET`／`PASSWORD`／`CREDENTIAL`／`API_KEY`；不存放秘密值。
- 目录是 launcher 自有私有常规文件（权限 `0600`、无符号链接），不能把用户提供的明文目录放入仓库。真实启动的 bootstrap 会将有界 helper／assets 安装到**目标根**，并在批准的私有 ACP HOME 内写入；不得宣称真实 ACP 启动只读。任何材料来源、权限或副作用未获批准即停。

输入检查按实际路径与摘要分别完成：CLI 可执行文件、bootstrap、固定 asset 都必须与获准目标上的字节一致；不能只核对声明的版本字符串。目录内容仅登记引用名和非秘密环境变量，不复制 vault 值。

目录和 `acp_execution` 分属不同许可面：目录有该 row 仍需目标 kind、绑定 policy 与 spec 同时允许；描述接口的“configured”也不能替代实际协议运行与身份核验。

## 最小兼容门

- 只要求真实 CLI 支持 `initialize` → `session/new` → 单次 `session/prompt`，接收 `session/update`，以及 `session/cancel`；核对协议版本、进程身份、cwd／绑定与停止原因。客户端 `fs.readTextFile=false`、`fs.writeTextFile=false`、`terminal=false`，这些回调不支持。
- 不验收 `session/load`／resume／auth callback：当前未实现；登录和凭据材料应先由经批准的安全路径准备。实际 CLI 尚未选定前不得为“兼容”任意添加 adapter。
- 权限事件必须给出 `allow_once` 与 `reject_once`；提问限 `form` 的扁平、带类型 1–8 字段，实际 schema 仍须通过投影约束。CLI 若只有永久批准、复杂表单、文件／终端回调等不兼容能力，**阻断该项**，不可重命名伪 provider、用全局自动批准或终端文字回避。

协议门的结果记录 CLI 自报能力和实收请求；若真实 CLI 不请求受支持控制，成功文本交互仍可单独记录，但不得自动给审批或澄清情景判通过。

## 真实 CLI 情景矩阵（仅在输入齐全并获授权后执行）

| 场景 | 必须取得的真实观察；缺能力则标未执行／不支持 |
|---|---|
| 成功 | 原 CLI 单 prompt 的文本更新与带类型的工具更新、实际 task／CLI session／instance／operation ID、原进程退出与 release；独立检查专用 scratch 的预期文件或副作用及一次计数。 |
| 批准一次 | 原 CLI 发出真实 permission RPC，原用户会话答 `allow_once`；核对被批准的是同一任务／主体／会话／绑定版本／CLI 实例，CLI／peer **实际收到**选项，再核对一次副作用。 |
| 拒绝一次 | 真实 `reject_once` 回到原 CLI／peer；独立确认目标未产生被拒绝的副作用，而非仅 UI 标记拒绝。 |
| 澄清 | 原 CLI 发出受支持扁平 typed form，用户结构化回答由原 CLI／peer 收到；核对返回类型及最终行为，不用终端输入模拟。 |
| 错误归属 | 重复消费、到期答复、跨主体／会话／任务／binding/version／CLI instance 回答均被拒绝；独立检查无越权副作用或第二次消费。 |
| 取消／断线 | 授权范围内对原任务取消、仅对指定目标断线；查原进程 status、cancel 与 release、受管范围的存活事实。结果未知／取消未确认要诚实保留，不能改 ID 重跑掩盖。 |
| 重载／离线历史 | 核对持久任务／控制归属、更新与历史读回；重载／离线不得复活旧控制或重放 prompt／文件副作用；`model_requests` 原生记录不能误认作 ACP 历史。 |

- 对每次控制分别记录：UI 接收、决策、`stdio-written-unconfirmed`（仅写到 stdio）、CLI／peer 已收到响应的**独立回执**；前者不证明后者。保存真实退出码、释放事实及未知原因，不能从任务完成标签倒推 CLI 已消费应答。
- 权限／提问是否出现取决于该 CLI 实际能力与运行轨迹；模型不能被当作确定性触发器。未出现的情景保持未执行，不能用合成事件补成真实验收。

### 单次真实运行的证据对照

1. 启动前记下获准 principal、session、binding/version、目标根、CLI 可执行文件摘要、后端 ID 与 request ID；与过程 identity 逐项比对。
2. 只用一条无敏感内容的任务提示指向专用 scratch；在真实 CLI session 中比对 `session/update` 和停止原因，不把中间文本当作已写盘。
3. 每个获准副作用分别从目标文件／进程独立读取；记录实际字节或非秘密摘要、发生次数、运行前后的差异和读回目标身份。
4. 每条审批／提问保留发起请求的 RPC ID、CLI instance、原控制 ID、绑定世代和截止时间；回答前核对同一活跃任务与有权用户。
5. 将 UI 送达、stdio 写入、CLI／peer 接收、实际执行结果分别列出。缺少后者时只记“响应送达未确认”，不能反推批准生效。
6. 完成后独立确认 process status、退出码与 release；如果原任务还在运行或清理不确定，保留 unknown 与原 operation ID，先停后续情景。

审批、拒绝、提问需各自有原 CLI 发起并消费的可区分证据；仅 UI 自己生成的待答卡片或模型输出中的文字不是运行中控制。重复／到期／foreign scope 的拒绝也要核对原任务的副作用计数未变化。

## 远端 Git／watch 专用目标情景（待批准）

- 在**已有且另行批准的目标**观察新鲜 connected agent／身份与单一通道；这不是创建／续期 agent、重启 workspace 或重配认证的授权，若需 provisioning 必须另行批准。核对 native-anchor UUID 与 Coder workspace UUID 分属不同命名域。当前公开后端只允许只读 Git `status`／`diff`／`worktrees`／`diff-head`；`git.branch` 有意禁用并返回 `agent-studio/provider-unavailable`，记录为禁用，不能记为成功空分支。分支成功空态仅由合成测试覆盖，在另行完成契约／能力／安全审查及授权启用前，不作为现场验收情景；本计划不授权增加路由。源码／合成 UI 错误呈现修复已做，未部署，也没有现场 Git／provider／浏览器验收。
- watch 先对 root 与 expanded 目录取得 baseline；仅对获准 scratch 在 watcher 离线时修改，再恢复连接取得 **ACK-only**，不依赖之后任何 watch 事件，等待并核对实际 `fsTrees/list` 字节已变化；还需覆盖已展开子目录先有 cache→折叠并取消 watch 但不驱逐 cache→子目录未被 watch 时修改 scratch→带 cache 重新展开、仅新子目录订阅返回 ACK 且无 change 事件，仍须实际重新列出该子目录并读到新字节的情况。ACK 不是异步列表完成或新鲜度证明。列表失败应保留旧缓存，同时区分 native `loadError`／warning 与 watch sticky cause（如有）；不可把旧树展示为新鲜事实。上述均为未来待测项，未记真实通过。
- 覆盖 collapse、search-hidden、hide、unmount、session-switch 的订阅／可见性，及 dirty editor 冲突保留；针对每个操作读回原目标内容和 UI 状态，不以 watch 更新覆盖未保存编辑。
- 轮询 `2500ms`，上限 `32` dirs／`16` clients／`1000` entries；这是 bounded polling，**非** native watch、递归 watch 或新鲜度证明。断连注入仅触及被批准 watcher／target，不能操作其他 binding 的 unknown 状态；未授权不得执行远端生命周期动作。

### Git／watch 的最小观察链

1. 在获准的既有目标观察新鲜 connected agent 和单个已核验通道，先核对目标 root、绑定版本、native anchor 与 workspace ID；不从公开 cwd 猜测远端环境。观察不授予新建／续期 agent、生命周期或认证操作权限。
2. Git 只观察当前允许的只读 `status`／`diff`／`worktrees`／`diff-head` 返回与目标标识；分别记录访问被拒、已确认无改动与读取失败，不从空输出推定成功。status 失败时核对保留的旧行、新鲜度未确认提示，并分别记下上次保留的 status 与本次为 null 的 current status 槽位；即使 error 为 false，也不能把该回退态误记为已确认 clean／notRepo。pending／失败 Retry 仍按陈旧结果记录，直到同目标的权威成功读取（含 sameStatus）。核对 session／binding 世代、repo／worktree 目标与最新请求归属，避免迟到成功或失败跨目标覆盖。`git.branch` 的 `agent-studio/provider-unavailable` 只记为禁用，分支成功空态仍仅属合成情景；合成 payload 不证明后端允许读取 linked-worktree 目标或具备相应授权。worktree inventory 的原生错误与 GitGraph 不在 status／branch 错误保持保证内。本条全属未来观察要求，未现场执行。
3. watch 记录 root 与 expanded baseline 的列表字节；离线修改获准 scratch 后，在恢复时截取 ACK-only 时点，随后独立等候并读取实际原生列表字节，明确没有后续 watch 事件参与；另测已展开子目录先有 cache、折叠并取消 watch 但不驱逐 cache、未 watch 时修改 scratch、带 cache 重新展开仅新子目录订阅 ACK 且无 change 事件时，实际重新列出该子目录并读到新字节的路径归属。不把 ACK 时点自身算作列表已更新。
4. 当列表读取失败，分别观察 native `loadError`／warning、可能存在的 sticky watch cause 与保留的旧 cache；直到有实际新列表读回，不把显示出的旧节点写成变更已被观察。
5. 对 collapse／隐藏／unmount／切换 session 逐项核对监听归属消失或变化；dirty editor 保存前的冲突仍留给用户处理，不自动覆盖。

以上检查只验证被授权目标的行为；不把 Git 命令走对路由推论为所有 Shell、文件编辑或远程主机已经验收。

## 停止、清理与证据

- 任何实际文件策略拒绝立即停止，不绕路；CLI／版本／SHA／身份、权限、能力、凭据安全路径或目标副作用范围不确定，也先停并列出缺失输入。超时、断线、退出／释放未确认保留 unknown，等待针对原任务的授权处置。
- 只清理获准 scratch 与已确认归属的受管进程／临时资产，先独立读回并记数量／状态；取消未确认不运行宽泛清理。不得为测试方便改写旧 unknown／历史证据或真实策略。
- 后续证据仅留去敏的输入摘要／哈希、准确目标身份、版本与时间、原 CLI／peer 回执、独立文件／进程读回、失败和未执行项；不收录凭据值、认证 cookie、私有配置或真实项目内容。等待明确授权后另行执行与复核，本轮不产生运行验收结论。

交接只需要确认缺口清单与执行范围；授权到达之前不修改目录、策略、预览或运行目标，也不把这份计划计为正式验收证据。
