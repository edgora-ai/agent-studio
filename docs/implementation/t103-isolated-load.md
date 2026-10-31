# T-103 隔离安装与加载实验

日期：2026-10-30；起始代码基线：`8e684fa70f14a0034d80b69e83914930fac778a5`。前置为 [T-101／T-102 只读核查与契约](m1-readonly-audit.md)，任务定义见[执行计划](../08-execution-plan.md)。这是隔离实验记录，不是生产配置或远程能力验收。[初轮机器证据](evidence/t103-isolated-experiment.json)和[原 profile 续跑证据](evidence/t103-profile-experiment.json)均保留为历史；当前隔离防护和最新两次生命周期结果以[修正证据](evidence/t103-isolation-correction.json)及第 9 节为准。第 2–8 节记录原实验过程，不能将其旧 fixture 写权限方案继续当作有效隔离边界。

## 1. 状态与授权

**T-103 已验证，仅限指定最小隔离 profile。独立复核发现原 fixture 写权限可经 peer 符号链接到达现有 SDK，且 DNS guard 有遗漏；现已收紧为全新运行根的精确写权限，补齐标准 DNS 入口，并通过离线负向回归和两次真实 profile 启动／禁用／重新启用／整棵卸载。采用显式非构造器入口保留清理函数；原生未经包装注册仍不支持，不启用其原始 bundle patch。这不是 OS 沙箱，也不构成生产或远端能力验收。**

初轮授权允许在本项目独立目录下载并验摘要、检查归档、隔离安装和加载；不改现有 profile／全局依赖，不连接 Coder、不复制凭据、不调用模型 API，不执行未审查安装脚本。单步限 10 分钟，目录预算 2 GiB。修正轮仅使用现有固定安装，不重新下载或安装依赖；运行器每次设置 120 秒期限，允许值不超过 600 秒。

本 T-103 修正轮不执行 Coder／SSH／模型或生产操作。用户后续已另行授权自行搭建 Coder；T-104 的当前结果见[独立部署记录](t104-coder-lab.md)和[收尾任务清单](m1-closeout-tasks.md)，不能从本页的本地 profile 结果推断。第 7 节缺授权的描述仅是初轮历史，不再是当前阻断。

## 2. 已验证的输入与完整性

| 对象 | 实际观察 |
|---|---|
| 固定来源 | CrazyShout/dsh-ssh-remote 的 v0.13.3；源码 tag 对应 `312524ec3627785fdf8ea537408fc6871a58271b` |
| 发布资产 | `dsh-ssh-remote-0.13.3.tgz`，asset ID `689590055`，1,518,475 字节 |
| 归档 SHA-256 | `cab6fa53954dc1272dfde9ec8a8fd3928fd79232c78b658cb1b434fb0644b162`，实际下载字节独立计算，与 T-101 固定元数据一致 |
| 归档检查 | 298 个条目、展开 3,427,154 字节；无链接／特殊文件／越界路径，展开到新建空目录 |
| 包身份 | `dsh-ssh-remote` 0.13.3；MIT；没有 preinstall／install／postinstall／prepare hooks |
| Node | 实际 24.22.1，满足候选 `>=22`；未升级 Node |
| helper | 主文件声明 VERSION 0.13.1；只读资源检查，没有运行 Python helper |

最初通过 gh asset API 下载返回 `401 Bad credentials`。未修改 gh 登录或申请新 token，改用公开 release 的匿名下载地址；匿名下载成功后仍独立核对固定 SHA-256。未以认证错误推断候选不可安装。

### helper 摘要的真实定义

`lib/helper/installer.js:34–54` 的 `loadHelperAsset()` 读取主 Python 文件，并将 `dsh_transfer.py` 与 `dsh_terminal_state.py` 的源码按固定顺序嵌入 `# DSH_BUNDLED_EXTENSIONS`，然后对最终 UTF-8 部署内容计算 SHA-256。因此 manifest 的 `helperSha256` **不是主 Python 文件的单文件摘要**。

本次先用仅导入 Node 内建模块的脚本按相同规则独立计算，再在文件权限限制下调用已审查的真实 `loadHelperAsset()`；两者都得到：

```text
bundle bytes: 217238
sha256: c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f
VERSION: 0.13.1
```

早先直接拿主文件摘要对比 manifest 的检查选错了对象，已纠正；没有修改或豁免预期摘要，也没有据此认定包损坏或 rc.4 不兼容。完整归档摘要匹配也不等于独立认证上游发布者。

## 3. 隔离安装

在被 Git 忽略的 `artifacts/m1/t103/` 下新建 fixture，下载、解包、脚本、运行目录和 npm 缓存分开。npm 使用专用 HOME、用户／全局 npmrc 和缓存，不继承账号、代理认证、SSH Agent 或模型密钥环境变量；不读取现有 web profile 配置。

固定 release 归档通过 `file:` 安装，不从 npm 同名包选择候选。启用 engine-strict、禁用 lifecycle scripts、peer 自动安装、bin links、audit 和 fund。声明范围内的 schemastery／yaml 固定到已有宿主对应版本；未安装另一套 dsh 或 alpha peer。

| 安装对象 | 实际版本 |
|---|---|
| dsh-ssh-remote | 0.13.3 |
| @deepseek-ai/schemastery | 3.18.5 |
| @deepseek-ai/cosmokit | 1.8.6 |
| @noble/hashes | 2.4.0 |
| @standard-schema/spec | 1.1.0 |
| yaml | 2.9.1 |
| zod | 4.6.6 |

11 个声明 peer 显式链接现有安装：Cordis 4.0.5，以及 10 个 dsh 0.2.1-rc.4 包。链接不是另一次安装。原实验仅检查源目录的直接路径不具写权限，遗漏了可写 fixture 内的符号链接别名；因此“链接只读”的原始判断不成立。第 9 节修正运行器后才对直接路径和别名实际执行拒写验证；安装脚本的新报告也改用 `source-symlink-not-read-only`，不再将链接本身标为只读。

```text
added 7 packages in 2s
PASS: installed fixed candidate with scripts disabled; 11 existing peers linked; report read back
PASS: 298 installed candidate files match the inspected archive byte-for-byte
```

安装后的 fixture 文件内容合计 20,522,951 字节；这是当步采样，不是 OS 磁盘配额。安装报告与 lockfile 已直接读取，按包名检索实际版本；7 个 lockfile 包记录均没有 install hook 标记。

## 4. 模块导入与运行限制

测试脚本放在下载／解包目录之外，从项目根目录启动。Node permission 仅允许读取现有安装代码、fixture 与测试脚本，写入仅限 fixture；未授予子进程权限。HOME／DSH_HOME 指向 fixture，不启动真实 web profile。

另外安装显式拒绝网络的测试 guard，覆盖 fetch、TCP／TLS／HTTP、监听、UDP 和 DNS 入口。guard 自测实际拒绝 fetch 与 socket；Node 实际拒绝子进程启动和 allowlist 外的普通仓库文件读取。**这是测试防护，不宣称 OS 网络隔离或抵抗任意恶意原生代码。**

真实导入安装后的 `lib/index.js` 成功，验证实际导出为 `Config`、`apply`、`inject`、`name`，且 `inject` 为 `fs`／`subprocess`；未补符号 shim，网络尝试记录为空。

```json
{"stage":"module-import","passed":true,"nodeVersion":"24.22.1","exports":["Config","apply","inject","name"],"networkAttempts":[]}
```

导入成功不等于 `apply()` 激活、provider 路由或卸载成功。插件会修改传入的 FS／subprocess 路由，因此以下实验使用独立真实 Cordis context 和真实本地 provider，不对现有 web context 调用 `apply()`，也不用伪造 provider 冒充兼容。

## 5. 实际 Context 激活与卸载：C-103-01

构造真实 Cordis 4.0.5 `Context`，通过 `ctx.plugin()` 加载现有 `LocalFileSystem` 和 `LocalSubprocessRuntime` 0.2.1-rc.4。提供空 hosts，不提供模型、HTTP、会话、Shell、PTY、技能、更新或侧边栏服务，也不调用 SSH 配置发现方法。两个 provider 和候选 fiber 均实际达到 active 状态。

使用随机非敏感 UTF-8 标记：直接写入／直接查文件，再经真实 FS provider 完整读回，并通过目录列表按文件名检索；激活前、激活中、卸载后分别通过。subprocess 这里只验证服务解析和方法存在，未启动任何子进程，不能算命令执行通过。

| 观察 | 未经包装的 Cordis 注册 | 显式箭头适配器 |
|---|---|---|
| 激活、sshRemote 注册、本地文件读回／检索 | 通过 | 通过 |
| dispose 后 fiber／服务／registry 状态 | fiber state 4、uid null；服务已移除，registry 回到 provider 基线 2 | 相同 |
| helper manager disposed | **false，失败** | true |
| 5 秒 transfer interval 清除 | **未清除，失败** | 已清除 |
| 显式适配器清理计数 | 不适用；没有包装或插入清理 hook | 进入 1 次、完成 1 次 |
| Cordis 错误日志／网络尝试 | 均为 0；不能据此判清理成功 | 均为 0 |
| 额外清理 | 记录失败后，测试显式释放 helper 并清除残留 interval | 无需强制补救 |

原生负向结果与适配器正向结果又使用保存到仓库的同字节探针各重复一次，结果一致。provider 最终卸载后，两组 registry 均为 0，exit listener 从 provider 构造后的增量恢复到导入后的基线 1；该基线 listener 属模块导入生命周期，不将其误记成 provider 泄漏。两个隔离 HOME／DSH_HOME 没有新增文件，工作目录只有测试标记。

### 原因与最小适配范围

候选 `lib/index.js:22,75–106` 导出普通 `function apply()` 并返回 async disposer；当前 Cordis `lib/index.js:1067–1071` 将其判为构造器，以 `new callback()` 执行，随后只检查实例初始化符号，没有收集这个返回的清理函数。因此 **fiber 已 disposed 和错误日志为空都不能证明候选清理已运行**。

实际调用已安装 Loader 的 `unwrapExports()`，确认它保留同一候选 namespace；实际 Cordis `isConstructor()` 确认 apply 被判为构造器。Loader `lib/index.js:460–463` 再将该对象交给 registry；这些定位支持上述原因，但不替代完整 dsh profile boot。

对照使用以下语义的显式入口，保留元数据，不修改候选源文件或现有 profile：

```js
const compatibilityEntry = {
  name: candidate.name,
  inject: candidate.inject,
  Config: candidate.Config,
  apply: (ctx, config) => candidate.apply(ctx, config),
};
```

实际探针还给返回的 disposer 加了调用计数和错误采集；没有补假 provider、吞掉异常或手工替适配器清理。箭头入口不会被当作构造器，实际返回值被 Cordis 收集，helper／interval／registry 清理均通过。

**初轮阻断已由第 6 节的真实 profile 续跑解除：**保留 disposer 的显式入口已纳入隔离文件配置，经实际 dsh boot／Loader／Include 验证。这里的最小 Context 对照与第 6 节的 profile 试验是不同证据层次；原生失败没有消失，不因此宣布生产可用，也不升级 dsh、切 alpha 或修改上游插件。

### 可复用探针与本地执行记录

初轮七份探针源码已按原 SHA-256 保存在被忽略的 `artifacts/m1/t103/historical-harness-wp7dgpjr/` 下；相对路径与旧证据保持一致。当前[安装脚本](../../scripts/m1/install_candidate.py)、[加载探针](../../scripts/m1/activate_candidate.mjs)、模块导入／profile 探针和网络 guard 已有修正，**不能再声称所有旧源码摘要都匹配当前文件**；新摘要见修正证据。

- Python 命令始终使用 `-I`。现有固定安装的复现使用[保存的运行器](../../scripts/m1/run_candidate.py)，不需要重新下载或安装。
- 运行器支持 `profile|import|native|adapter`，清空继承环境，并生成 runtime 下全新 UUID 运行根；HOME／DSH_HOME／TMPDIR 与所有输出都位于该根内。
- Node 写权限只包含该新根本身及 `新根/*`，**不包含 fixture／runtime／node_modules 或 peer 链接**；禁用 child process。所有候选探针先执行[共享前置校验](../../scripts/m1/isolation.mjs)，拒绝旧广域授权、额外 Node 参数、已有根和非白名单环境。
- `native` 的历史预期为只在 helpersDisposed／intervalsCleared 两项失败；`adapter` 预期保留 disposer。修正轮只重新执行了真实 profile 两次，并未把历史最小 Context 对照冒充本轮重跑。
- 输出使用新路径、拒绝覆盖；旧失败证据和旧校验和保持不变。当前完整命令与验证边界见第 9 节。

## 6. 真实文件配置的 profile 续跑

### 选定入口与加载路径

使用[显式 profile 入口](../../scripts/m1/ssh_remote_entry.mjs)，原样导出候选的 name／inject／Config，并以箭头 apply 返回候选的真实 disposer。通过[文件配置探针](../../scripts/m1/profile_candidate.mjs)调用已安装 dsh rc.4 的公开 `loadProfileDirectory()`／`boot()`，不是自行手动注册候选来冒充 profile 已启动。

实际路径是：`dsh-app-boot.boot → Loader → Include → 磁盘 cordis.json → 相对入口模块 → 固定候选`。JSON 配置包含真实 FS、本地 subprocess 和适配入口三项，均由 Loader 激活。profile manifest 使用空 bundles，**不应用候选原始 cordis.patch.yml**，避免再次注入未经包装的失败入口。

profile 放在已有隔离依赖项目的 runtime 下，使用正常的父目录 node_modules 查找；通过 realpath 核对实际解析包正是已验摘要的 0.13.3 候选。没有新依赖安装、上游修改、默认版本替换或生产配置复用。

### 实际交互与清理

最终探针在两个全新目录独立通过以下全过程：

1. 从文件启动，三个配置项均到达 active；入口 apply 实际判定为非构造器。
2. 通过真实 FS provider 读回随机 UTF-8 标记，并通过目录列表按名称检索。
3. 经 Loader 禁用候选；直接读取配置文件并逐字段对比完整三项数据，再核对 Loader 状态与服务移除；helper 只释放一次，interval 已清除，本地 provider 仍可读取标记。
4. 经 Loader 重新启用；再次完整读回配置、按 ID 检索并核对状态，确认产生新的 helper，而非复用旧 disposed 实例。
5. 关闭整个 profile；第二个 helper 同样只释放一次，两轮 interval 均清除，registry 为 0，provider 的 exit listener 恢复至导入后的基线 1；磁盘配置仍保持 enabled。

| 最终两个独立样本 | 实际结果 |
|---|---|
| 配置项 active | 每次均为 3 项 |
| Loader 禁用／启用后的完整配置读回 | 通过，原有字段无丢失 |
| 每个 helper 的 dispose 次数 | 两轮均为 1 |
| 未清理 interval／最终 registry | 均为 0 |
| 错误／警告／网络尝试／强制补救 | 均为 0 |
| 隔离 HOME／DSH_HOME 与工作目录 | HOME 均无新增文件，工作目录只有测试标记 |

初次准备曾在 `fs.symlink` 被 Node permission 以 `ERR_ACCESS_DENIED` 拒绝，尚未进入插件加载；没有放宽权限，改用上述正常依赖查找路径。该失败和后续成功均保留在续跑证据中，不将权限模型错误误判为候选不兼容。

### 复现约束与通过边界

- 当前探针要求通过第 9 节运行器启用 `--permission`、禁止 child process；写权限只给全新测试根及其子路径，旧的 fixture 广域写权限会在候选加载前被拒绝。HOME／DSH_HOME／TMPDIR 均指向新测试根。
- 参数依次为已安装候选根、现有 dsh 根、尚不存在的测试根；**新测试根必须位于已有隔离依赖项目 runtime 下**，使复制后的入口能正常解析该项目的 node_modules。探针会拒绝解析到其他同名包。
- 入口与探针源码 SHA-256、实际 SDK 版本、两个完整样本和初次失败原因均在续跑 JSON 中；原始初轮 JSON 及其校验和不变。
- 这是通过公开 app-boot API 启动的实际最小文件 profile，不是运行完整生产 CLI／web profile；better-sidebar 0.28.2 仍只有既有静态核查与指纹证据，未在这里启动 UI。

## 7. 初轮未验证与当时交接（历史）

- T-103 的指定隔离 profile 范围已验证；C-103-01 的原生失败仍保留，后续只能沿已验证显式入口接入，不能恢复原始 bundle 自动注入。
- 未启动生产 CLI／web、better-sidebar UI、HTTP 入口、模型或远端 CLI；不能宣布完整三包组合或侧边栏集成通过。
- 未连接 Coder／SSH，未引导或运行远端 helper，未测试远程 FS／命令／PTY、取消、身份核验、去重、恢复或本地回退。
- T-104 仍缺专用测试范围与授权，T-105 继续等待 T-104。CK-01 整体与 M1 未通过，不提前推进依赖 M1 的产品任务。
- 没有新增 Git 提交、推送或对外发布。

安装、最小 Context 加载和文件 profile 续跑之后分别重新采集原有六个包的 26 个来源文件指纹，与 T-101 清单逐字节一致；两份 T-101 JSON 的独立 SHA-256 检查仍通过。此结论只覆盖列出的来源，不扩大成对整台主机或完整 profile 的全量审计。

## 8. 初轮验证记录（历史）

```text
PASS: 16 documents, 31 execution tasks, 89 local links
Mappings: 75 declared, 75 in matrix
Ran 36 tests
OK
PASS: 8 historical evidence files and 4 implementation JSON checksums
PASS: 7 preserved harness source hashes and 298 post-profile candidate byte comparisons
```

文档回归曾有两项失败：测试临时根只复制 README／docs，没有复制新文档链接的脚本。现已将 scripts 纳入测试夹具，并增加“删除已链接脚本必须报断链”的负向测试；没有关闭或放宽链接校验。修正后 36 项全部通过。

五份 MJS 入口／探针通过 Node 语法检查，两份 Python 采集／安装脚本通过语法编译；原生与显式适配器的最小 Context 对照各执行两次，失败与通过原因一致；最终文件 profile 探针又在两个新目录验证完整启动／禁用／启用／卸载。机器证据均直接完整读回，并按任务、缺陷 ID 和包名检索；profile 续跑后的实验目录采样为 26,806,393 字节，未超过 2 GiB 操作预算。

本轮没有新增产品数据库、认证 API 或应用容器；未做其端到端验收，不以文档／探针通过代替构建部署、远端执行或产品完成。

## 9. 隔离防护修正与重新验证

### 写入边界

复核在 Node 24.22.1 上确认：直接访问现有 SDK 元数据的写操作被拒绝，但经 fixture 内 peer 符号链接访问同一文件时会通过旧权限检查。修正后，运行器只发出两个写授权：尚不存在的运行根本身，以及该根后带 `/` 的子路径通配符。依赖树、旧运行根和 peer 别名均不在写权限内。

`isolation.mjs` 在导入任何候选／provider 代码前验证参数、精确启动 flags、清空后的环境和新根；对候选元数据及全部 11 个 peer 的直接／别名元数据分别进行实际 `O_WRONLY` open 拒绝测试。该 open 不创建、不截断、不写内容；若错误授权使 open 成功，会立即关闭并中止，而不是修改文件。两次真实运行合计验证 22 次直接路径和 22 次别名拒写。之后才创建运行目录和加载候选。

新目录在 Node 启动时尚不存在，单独授权目录名只允许创建根、不允许子项；因此需要“精确根＋`根/*`”这对窄授权。最初离线回归捕获了这一差异；失败报告保留在修正证据引用的 artifact 路径中，没有恢复 fixture 广域授权。

### 网络 guard 与离线负向回归

[网络 guard](../../scripts/m1/network_guard.mjs) 覆盖 `dns`、`dns.promises` 和两种 `Resolver` 原型上的标准 lookup／resolve／reverse 操作，并同步 Node 命名导出；同时补充 UDP 实例 bind／connect／send 入口。仍然只是标准 JavaScript 测试防护，**不是 OS 网络隔离，也不承诺抵抗恶意原生代码或任意绕过**。

[离线回归](../../scripts/m1/test_isolation.py) 包含：新根窄授权通过、直接与别名拒写、旧 fixture 广域授权在 profile 加载前失败、额外别名授权失败、已有符号链接根失败、继承环境失败、清空环境和期限终止验证，以及[网络 API 负向测试](../../scripts/m1/test_network_guard.mjs)。网络测试先把所测原生函数替换为本地 sentinel，再安装 guard；遗漏 patch 只会触发本地失败，绝不会为测试发送 DNS／socket 请求。

```sh
python3 -I scripts/m1/test_isolation.py
# Ran 8 tests / OK
# PASS: 8 offline regressions; 83 guarded API calls; no real network

python3 -I scripts/m1/run_candidate.py profile \
  --candidate-root artifacts/m1/t103/fixture-9teakpr5/runtime/node_modules/dsh-ssh-remote \
  --installed-dsh /home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh \
  --timeout-seconds 120
# 同一命令执行两次；运行器分别生成全新 UUID 根。
```

以上相对路径命令从项目根运行；复用已有固定安装，不自动获取不存在的依赖。每次运行的完整 Node 命令、环境变量名白名单、退出码、时长、完整结果和摘要均保存在新证据中。超时会终止该探针进程组并保存失败诊断；期限参数只允许 1–600 秒，不把卡住的生命周期当通过。

### 两次修正后真实 profile 结果

| 新运行根后缀 | Node 退出码 | 时长 | 前置拒写／完整生命周期 |
|---|---|---|---|
| `89b22cd61f3a480aac64c289c7f71810` | 0 | 0.649 秒 | 全部通过 |
| `fcfcfae4a7794b9b980e235b99c1e185` | 0 | 0.371 秒 | 全部通过 |

两次均验证三个配置项 active、真实本地 FS 标记读回／按名查找、禁用／重新启用后的完整配置读回、两个独立 helper 各清理一次、全部已观察 interval 清除、registry 为 0 和 exit listener 恢复基线。错误／警告／被 guard 拦截的网络尝试／强制补救均为 0；HOME／DSH_HOME 保持空，workspace 只有标记。收集证据时再次逐字段读取最终磁盘配置。

执行前后各有 298 个已安装候选文件与固定归档逐字节一致。七份原始源码备份和两份旧 T-103 JSON 摘要均验证不变；修正证据记录 11 份当前 harness／runner／回归源码的新摘要。没有改写旧 `SHA256SUMS`。目录采样为 27,685,547 字节，低于 2 GiB；这不是 OS 磁盘配额。

新证据：[t103-isolation-correction.json](evidence/t103-isolation-correction.json)，SHA-256：`b486194975f91437d0ec7849cc0dd3dfe13cf0bee78c4724c5ed76dbae652019`。

**边界不扩大：**本轮只重新执行了修正后的真实最小 profile 两次；native／adapter／import 入口共享已测前置校验并通过语法检查，但没有单独重跑。hosts 为空，subprocess 只验证服务存在，不执行命令；没有下载／重装、生产 CLI／web／侧边栏、Coder／SSH、远端 helper 或模型操作。不据此宣布产品或远端验收通过。
