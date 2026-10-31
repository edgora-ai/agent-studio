# M1 只读核查与接入契约

日期：2026-10-30；起始代码基线：`8e684fa70f14a0034d80b69e83914930fac778a5`。对应[执行任务](../08-execution-plan.md)中的 T-101／T-102。这里只记录实际静态核查和后续实验契约，不是安装、连接或产品运行通过报告。

## 1. 执行状态

| 任务／阶段 | 状态 | 交接结果 |
|---|---|---|
| T-101 | 已验证，仅只读范围 | 六个本机包的版本／来源／接口定位、26 个文件指纹，以及三个候选固定版本的上游元数据已核对 |
| T-102 | 已验证，仅契约与验证清单 | 明确身份、文件、进程、PTY、侧边栏和交互的接入边界；形成逐接口实验清单和资源授权申请 |
| T-103 | 已验证，仅指定隔离 profile | 显式入口经真实 boot／Loader／Include 启动、禁用／启用与整树卸载通过；原生注册仍禁用，远端和生产组合未验，见[隔离实验记录](t103-isolated-load.md) |
| T-104 | 已验证，仅本机模板／实例实验 | 用户后续授权自行搭建 Coder；独立 TLS 控制面、数据库、lab-v3 与两个实例的 API／DB／容器对照及 UI 登录通过；见[Coder 记录](t104-coder-lab.md) |
| M1 | 未通过 | T-105／T-106／T-107 尚未执行，真实连接、helper 引导、FS／命令／PTY 和故障证据缺失 |

T-103／T-104 已有独立实验记录，其余实施任务未开始。T-101／T-102 的“已验证”不代表 CK-01 整体或 NF-03 已通过；版本清单、静态接口、包加载、模板实例、远端执行和真实会话是不同层次的证据。

下文的“本次”限于 T-101／T-102 只读核查时点；其后获准的下载、安装与加载另记于 T-103，不回写两份静态证据的历史字段。只读核查没有安装／升级软件、启动 profile 或服务、读取账号配置或私钥、修改 SSH／运行配置、创建资源、调用模型 API、提交或推送，网络访问限于所选 GitHub 仓库元数据与文本资产。原始工作树追踪工具未解析到 topology／work 节点；未推测工作节点，以仓库任务表和起始提交为依据。

## 2. T-101：本机安装产物

完整字段与文件 SHA-256 见[安装清单](evidence/t101-installed-inventory.json)。清单使用包内相对路径，不归档用户绝对目录、源码全文、配置或凭据。

| 观察对象 | 实际版本 | 来源／许可核对范围 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.2.1-rc.4` | package.json 指向 deepseek-ai/deepseek-harness 的 apps/cli，声明 MIT；未据此反推安装包源码 commit |
| `@deepseek-ai/dsh-fs` | `0.2.1-rc.4` | 同仓库 packages/fs/fs；package.json 声明 MIT |
| `@deepseek-ai/dsh-subprocess` | `0.2.1-rc.4` | 同仓库 packages/subprocess/subprocess；package.json 声明 MIT |
| `@deepseek-ai/dsh-workspace` | `0.2.1-rc.4` | 同仓库 packages/workspace/workspace；package.json 声明 MIT |
| `@deepseek-ai/dsh-working-directory` | `0.2.1-rc.4` | 同仓库 packages/session/working-directory；package.json 声明 MIT |
| `dsh-better-sidebar` | `0.28.2` | package.json 指向 omdsh-dev/DSH-better-sidebar；声明 MIT，实际 LICENSE 正文已读；Node engine 为 >=20 |

SHA-256 是本次实际文件指纹，不是与供应方归档核对后的来源认证。本次未评估所有传递依赖许可证，也未核对当前 Node／Python 运行版本；安装与运行前仍须检查候选 engine 和 helper 依赖。

### 已定位的接口事实

下表的路径相对上述对应包根目录；安装清单同时保存声明文件与部分已安装 JS 的指纹。声明存在不等于远程 provider 已实现或已通过测试。

| 定位 | 本次观察 | 对接后果 |
|---|---|---|
| dsh-fs `lib/types/index.d.ts:71`、`:94`、`:183`、`:197`、`:208`、`:221` | 有 watch、异步 resolve、受限字节读／范围读、listDir、可带 expected 的写入／编辑；listDir 返回数组，没有分页参数 | 按实际安装接口接入，验证 watch 支持、字节上限和取消；保存显式携带版本条件，不能把未带条件的写入当成冲突保护 |
| dsh-subprocess `lib/types/index.d.ts:102`、`lib/types/types.d.ts:156` | spawn 同步返回 SubprocessHandle；普通句柄有 control、collected、done、terminate、waitForExit，没有公开 pid | 不能把“同步返回本机 PID”作为 rc.4 普通句柄契约；候选的桥接实现须在隔离 profile 核对 |
| dsh-subprocess `lib/types/index.d.ts:94`、`:110`，`lib/types/types.d.ts:238` | terminalEnvironment 与 spawnTerminal 独立；PTY 句柄有 pid、resize、前台组观察／信号及异步 terminate | 不能用普通 exec 代替 PTY，也不能把传输进程 PID 当远端持久任务身份 |
| dsh-workspace `lib/types/index.d.ts:135`、`:146` | WorkspaceRegistry.create 要求已有本机可规范化目录；通过 fs.realpath 处理路径 | 不能直接把远程目录字符串当中央 workspace 注册路径；内部 anchor 或最小核心扩展仍须验证 |
| dsh-working-directory `lib/types/index.d.ts:64`、`:73`、`:83` | get／ensure／set 管理有效 cwd；ensure 可在目录消失后恢复原项目 | 要验证该消费方获得正确 realm/provider；不能让其将远程错误恢复成中央目录执行 |
| sidebar `src/fs-tree.ts:19`、`src/fs-watch.ts:20`、`src/git.ts:429` | 直接调用 Node FS、fs.watch 和本机 spawn('git') | 替换 ctx.fs／ctx.subprocess 不自动迁移这些入口；T-205 必须服务端适配或明确拒绝 |
| sidebar `src/open-external.ts:2`、`:12` | 本机打开器经 host route 调用 child_process，另有客户端 SSH editor URL 分支 | 远程绑定的服务端动作和客户端 scheme 都需要审计；隐藏按钮不足以封堵旁路 |
| sidebar `lib/types/client/api.d.ts:212` | SessionScope 只有 sessionId、可选 cwd／repoRoot | 没有可直接信任的绑定版本／实例身份；由服务端按会话解析，不能相信客户端 cwd 选择目标 |
| sidebar `lib/types/client/service.d.ts:607`、`:692`、`:754`、`:765` | 有 registerTab、registerFileViewer、openTab、openFile、hostRouteUrl 等 UI 扩展面 | 可复用目标标识与打开入口；这些注册能力不等于可替换既有服务端 FS／Git 实现 |

## 3. T-101：固定候选来源与元数据

完整 commit、许可位置、准确相关依赖、manifest 与发布资产信息见[候选清单](evidence/t101-candidate-metadata.json)。本次使用 gh api 读取固定 ref／commit，不把主分支内容当固定版本。

| 候选 | 固定 tag → commit | 核对结论 |
|---|---|---|
| SSH 主候选对照版 | v0.13.2 → `61ebead8dbfa4640b10a0da9b4c8c59d82347a93` | [固定 package.json](https://github.com/CrazyShout/dsh-ssh-remote/blob/61ebead8dbfa4640b10a0da9b4c8c59d82347a93/package.json)；MIT 正文已读，Node engine >=22 |
| SSH 首轮实验候选 | v0.13.3 → `312524ec3627785fdf8ea537408fc6871a58271b` | [固定 package.json](https://github.com/CrazyShout/dsh-ssh-remote/blob/312524ec3627785fdf8ea537408fc6871a58271b/package.json)；MIT 正文已读，Node engine >=22；不是已通过的底座或生产锁定 |
| Remote VS 参考版 | v0.11.1 → `b73cb97fec7f74c17801012016d8054ba2e8621e` | [固定 package.json](https://github.com/xiray-xia/dsh-remote-vs/blob/b73cb97fec7f74c17801012016d8054ba2e8621e/package.json)；MIT 正文已读，dsh engine >=0.2.2-alpha.2 <0.3.0；不加入首轮并行实现 |

SSH 两版本的相关 dsh peer 原样范围均为 `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-rc.2 <0.3.0`；manifest 均只枚举 rc.2／rc.3 对应的三个版本，没有本机 rc.4。两者都不能证明实际运行兼容或失败。manifest 的 helperVersion 是 **0.13.1**，不能从插件 0.13.3 猜成 helper 0.13.3。

SSH 两份 manifest 的归档大小／摘要，与 release API digest 和 SHA256SUMS 文本一致；但本次未下载 tgz，未独立计算包或 helper 摘要。v0.13.3 的归档元数据为 1,518,475 字节，公开 SHA-256 为 `cab6fa53954dc1272dfde9ec8a8fd3928fd79232c78b658cb1b434fb0644b162`；实际下载、归档安全检查与独立验摘要留给获准后的 T-103。

Remote VS 的实际 tag 有 v 前缀；无前缀 0.11.1 的 ref／release 查询实际返回 404，改用存在的 v0.11.1。其 release 附加资产为空，固定源码树和 release 未找到 manifest，不能借用 SSH 的版本矩阵。ssh2 ^1.17.0 位于 devDependencies；运行依赖实际包含 dsh-fs-ssh／dsh-ssh 0.2.1-rc.2，不能仅凭开发依赖推断发布包的完整连接行为。

候选暂按“现有 dsh rc.4 + sidebar 0.28.2 + SSH v0.13.3（声明 helper 0.13.1）”申请隔离验证，保留 v0.13.2 做必要对照。没有选择升级 dsh、切 alpha、fork 或修改生产。也没有以 npm 同名包替代这个固定仓库来源。

## 4. T-102：最小接入契约与数据归属

下表是待实现／验证的内部契约，不是发明已有 dsh 或 Coder 同名 API，也不是本次新增了可调用的产品接口。

| 接入面 | 输入／归属与必须返回的事实 | 最小实现边界／阻断条件 |
|---|---|---|
| 主体与派发上下文 | 已认证 Principal、服务端 SessionBinding、bindingId／version、project／environment、根目录、策略和世代；当前通道身份从认证连接取得 | 不从 UI cwd 构造身份；不只比较两个旧缓存字段；身份失效须同步关闭新派发资格 |
| 平台与实例记录 | Coder 真实 workspace／agent／build，加模板版本、镜像／策略摘要、独立预置标记与读取来源 | 平台是环境事实来源，中央保存绑定快照；先核验当前连接，再引导 helper；不通过待测通道写读标记自证 |
| workspace／cwd | 中央内部 workspace 兼容上下文与远程公开执行 cwd 分开；映射由受信任登记提供 | 先试公开工作区扩展面或版本化 anchor；无法区分上下文就拒绝，不 patch 全局 Node FS，不把 ensure 的恢复当本地后备 |
| 文件与受管保存 | 按绑定解析 FsTarget／targetKey，使用 processPath／fileUrl／contains；传基础版本与取消信号，返回新版本或明确冲突 | 不省略 expected；watch、字节范围、缺失／二进制／过大错误按实际 provider 检查；直接写盘者的最终竞争单独披露 |
| 搜索与容量 | 搜索结果带绑定、执行环境路径、行号；目录／文件／输出分别有容量边界与截断事实 | listDir 现有 seam 无分页参数，先实测上限及诚实失败／截断，不能给不存在的原生分页承诺 |
| 执行与恢复 | Execution 记录操作、绑定快照、所选通道及完整远端运行身份；区分输出、退出、取消／超时原因和清理事实 | spawn 的同步句柄不等于公开 PID；SSH 子进程退出不等于远端进程范围为空；缺少原任务重查能力是 P0 缺口 |
| PTY | 使用独立终端 API，声明尺寸、前台进程组、信号、输出游标、终止语义及观察边界 | 不把普通管道或本机传输 PID 冒充远端 PTY；终止需远端事实，resize／信号须分别验证 |
| mutation 重传 | 作用域含主体、绑定版本、世代、server session、operationId 与参数摘要；登记、日志保留、已有结果查询和不确定状态归属明确 | 首轮默认禁用未证明安全的自动重传；operationId 或“一次重放”不是证明；副作用到持久结果间崩溃须保持未知 |
| 侧边栏与 Host API | 保留 UI 注册和 hostRouteUrl；服务端从 sessionId 查绑定；同一路由承接文件、watch、搜索和 Git status／Diff | 直接 Node I/O 须逐入口适配或拒绝；UI 扩展不等于服务端路由已替换；客户端 scheme 同样受能力限制 |
| CLI 会话交互 | InteractionRequest 保存主体、任务、绑定版本、请求类型、有效期、决定和消费状态；原 CLI 确认消费 | 运行中审批／澄清，不只批准启动；同主体跨设备可答，但重复／过期／跨绑定拒绝；实现与持久化实测留给 T-206／T-306 |
| 中央存储与秘密 | 项目／版本化绑定／会话关联、任务与交互审计由中央持久保存；项目文件在目标环境；秘密只存受保护引用 | 存储引擎和新增 schema 未选定，先用真实现有机制验证；任何新增存储都须直查→完整读回→检索，不把回执当证据 |
| 入口认证与传输 | 复用现有认证上下文，按真实公开／受保护路由分类，校验主体与工作区归属 | 本次未读取部署账号配置或验证现有认证／TLS，不能宣布可直接复用成功；不默认新增 SSO 或公网入口 |

### 逐接口实验清单

下表是只读核查时拟定的后续实验，不计入 T-101／T-102 静态结果。当前 T-103／T-104 的执行状态以第 1 节和各自记录为准；T-105～T-107 仍未执行。

| 实验 | 负责任务 | 最小正向／负向验证 |
|---|---|---|
| 包安装与服务解析 | T-103 | 固定资产独立验摘要，核对 engine／依赖；隔离加载及实际 context／realm，保留具体符号／调用错误 |
| helper 包内资源 | T-103 | 查实际内嵌 helper 版本、来源和摘要；这一步只查包内资源，不要求未建工作区就引导远端 |
| 模板与期望身份 | T-104 | 两实例独立记录、允许版本、根目录和账号；伪造／撤销／越界分支拒绝 |
| 连接与 helper 引导 | T-105 | 官方连接、OpenSSH 别名、插件接入；错误身份拒绝；正确身份后引导 helper 并读回版本与能力 |
| 文件与目标一致性 | T-106 | 文件独立写读、符号链接／越界、字节范围与容量边界；远端不可用无中央写入 |
| 进程与取消 | T-106 | 结构化 argv／cwd／env、实际输出／退出、远端进程范围及取消；传输退出不算远端停止 |
| PTY 最小能力 | T-106 | 实际终端输入、初始尺寸／resize、信号与取消，记录当前 provider 的前台组／清理限制 |
| 通道、重传与时限 | T-107 | 每条启用路径分别声明；未启用拒绝，ACK 丢失／重复／日志失效与副作用计数；形成实测初值而非无限等待 |
| 本机旁路技术探针 | T-107 | 用独立测试目录和无敏感标记观察 Host API／打开器／scheme，不触碰真实项目；记录缺口，正式修复验收由 T-205／T-304 承担 |

发现一处任务边界需要细化：T-103 的 helper 检查限于包内资源；**实际远端引导移到 T-105 的身份核验之后**。因此 T-103／T-104 仍可并行，不会要求 T-103 提前依赖尚未创建的工作区；M1 的真实 helper 链路门槛没有减少。

## 5. 下一步授权申请与阻断解除

### A：T-103 的本机隔离实验

以下范围已由用户明确批准；实际执行结果以 T-103 记录为准，授权不延伸至 B 项。

- 申请在本项目被忽略的独立测试输出目录建立新 profile／依赖目录；只加载现有 dsh rc.4 的隔离组合和固定 SSH v0.13.3，不改现有 web profile 或全局依赖，不复用其完整账号配置。
- 允许动作需包括固定资产下载、独立验摘要、归档静态检查、隔离依赖安装和最小加载测试；首轮不执行未审查的依赖安装脚本，若必要则先说明并再次确认。
- 单步最长 10 分钟、测试目录磁盘预算 2 GiB；超出停止并报告。它们是操作预算，不冒充已落地的 OS 硬隔离。不得运行真实用户项目或把控制凭据／模型密钥复制进去。
- 新下载各放新的空目录，采集脚本与下载目录分开；不连接真实 Coder 工作区，不自动信任 Host key，不启动公网服务、不调用模型 API。
- 若 engine、依赖或 rc.4 接口不能满足，保留实际错误，不自动升级 dsh／Node、不切 alpha。确认本范围后才能解除 T-103 的授权阻断。

### B：T-104 的 Coder 专用测试夹具（授权已更新）

初次只读核查时尚无 Coder 范围；用户后续明确要求“coder 需要你自己搭建”，并授权执行。该授权已解除原阻断，不再要求用户提供现成控制面、账号或模板。

- 实际新建独立 Coder 2.37.8／PostgreSQL、回环 TLS 入口、专用账号和网络、lab-v3 模板与两个小工作区；凭据仅留受限目录，不复制真实账号材料。
- 独立实验探针验证模板准入与实例记录；真实创建／更新以及两实例的 API／数据库／容器读回已执行。产品创建／拒绝 API 留给 T-202，不混同实验层次。
- 不接管其他服务，不开放公网、不修改生产 dsh、不删除持久数据；后续生命周期破坏实验仍限定 T-302 的专用夹具与范围。
- 实际结果、配置限制、资源留存和复核命令见 [T-104 记录](t104-coder-lab.md)与[可执行清单](m1-closeout-tasks.md)。

T-103 与 T-104 的指定实验范围均已验证，T-105 可开始；当前 SSH 身份、helper、远程执行与完整 M1 仍未通过。

## 6. 实际验证记录

本机清单使用只读采集脚本生成：读取指定安装根目录内的 package.json、声明文件和所选 JS／侧边栏源文件，不 import 或执行这些模块。报告写入后直接读回完整字段，重新计算所有来源 SHA-256；第二次采集与第一次输出逐字节一致。

```text
PASS: 6 package records and 26 file hashes written and read back
@deepseek-ai/dsh 0.2.1-rc.4
@deepseek-ai/dsh-fs 0.2.1-rc.4
@deepseek-ai/dsh-subprocess 0.2.1-rc.4
@deepseek-ai/dsh-workspace 0.2.1-rc.4
@deepseek-ai/dsh-working-directory 0.2.1-rc.4
dsh-better-sidebar 0.28.2
```

候选核查使用 gh api 的 git/ref/tags、固定 commit contents、releases/tags 和 release asset 文本读取；未执行上游脚本。发布元数据清单可按仓库／tag／commit／资产 ID 检索，字段读回与来源定位在本机再次核对；摘要一致性不是归档字节验证，也不抵抗同一发布方同时篡改多份元数据。

本次文档与依赖图检查通过：15 份文档、31 项任务、75 对 FR／SC 关联；35 个回归测试通过，8 份历史快照不变。新证据已直接读回并按包名／tag 检索：dsh 返回 0.2.1-rc.4，v0.13.3 返回固定 commit 312524ec3627785fdf8ea537408fc6871a58271b。两份新 JSON 的独立校验和保存在 docs/implementation/evidence/SHA256SUMS，报告哈希仍不等于上游归档验摘要。

```text
python3 -I scripts/check_docs.py
python3 -I scripts/test_check_docs.py
sha256sum --check docs/research/evidence/SHA256SUMS
sha256sum --check docs/implementation/evidence/SHA256SUMS
```

没有数据库、API 认证、容器或浏览器运行验收可报告。完整产品完成条件仍见[交付与验收](../05-delivery-and-acceptance.md)。
