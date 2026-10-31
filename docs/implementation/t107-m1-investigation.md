# T-107：M1 逐门槛调查

日期：2026-10-30。角色：唯一实现／证据写入者，**不是独立验收者**。结论建议：**完整 M1 未通过，T-201 不放行**。本轮已交付逐项矩阵、真实入口探针、安全规模容量／超时样本和限定解除任务，等待另一名审核者独立判断。

- [机器可读矩阵](t107-m1-matrix.json)：11 个固定 gate ID，逐字对应 05 的 M1 条款，含版本、摘要、证据、通道、时限、容量、阻断及解除任务。
- [本轮验证与最终资源证据](evidence/t107-investigation1.json)。历史 JSON／SHA 行不改写。
- 前置：[T-106 独立复验](evidence/t106-independent-acceptance-review2.json)，`gate=pass`、`t107Ready=true`；只复用其限定实验结论，不转成 M1 或产品验收。

## 1. 全部 M1 条款

以下是实现调查的拟判定，不是独立签署。`pass` 只指该条款的注明范围。

| ID | 05 条款 | 状态 | 实际范围／缺口 |
|---|---|---|---|
| M1-01 | manifest／peer／安装产物版本门 | pass | rc.4 + 候选显式入口的隔离 profile 已实跑；sidebar 全 UI 不是该组合的通过范围，本轮只调用选定实际入口 |
| M1-02 | 锁定全部组件及来源 | pass | dsh、sidebar、候选、helper、Coder CLI／Server、模板／构建镜像和私有 rg 都记录实际版本及摘要 |
| M1-03 | 非 npm 同名项目／发布完整性 | pass | 固定 CrazyShout GitHub 0.13.3 归档及安装的 298 文件逐字节核对 |
| M1-04 | 冻结模板契约／SC-17 交付 | pass | 仅 lab-v3 声明策略及两实例／准入／身份交付；**不是完整隔离通过**，PID／硬磁盘配额缺口保留 |
| M1-05 | NF-07 时限、恢复、日志保留、容量、重传 | **fail** | 小样本、上限记录和禁止重传成立；没有可用的 provider 恢复窗口，产品任务／审批时限初值未落实 |
| M1-06 | 隔离测试、不影响生产 | pass | 新忽略目录、现有两个实验工作区；未改生产 profile、全局依赖或基础设施 |
| M1-07 | Coder／OpenSSH／插件／helper 三层连通 | pass | 复用 T-105／T-106 独立证据；本轮真实容量连接又经过两次同通道身份门禁 |
| M1-08 | 先核预置身份及错误目标负向 | pass | 构建记录、API／DB、当前认证通道、ACK；错误工作区／账号／root／旧世代负向复用已验来源 |
| M1-09 | 独立读回、命令、PTY、取消、不可用无回退 | pass | 仅单 raw helper 实验通道；原生 SSH spawn 不作为第二条已启用通道 |
| M1-10 | 本机打开器／scheme／快捷键拦截检查 | **fail** | 技术探针已执行并发现实际派发；SC-16 要求的远程拒绝条件未满足 |
| M1-11 | 接口覆盖和缺口清单 | pass | 矩阵与本记录明确复用、适配面、未执行项和最小解除任务 |

M1-10 没有因“已记录行为”就标绿：本轮完成了调查，但实际入口未满足 SC-16 的预期拒绝。正式绑定持久化和完整侧边栏仍属 M2；这里不提前实现它们，也不以“以后适配”宣布当前组合安全。

## 2. 固定组合与证据复用

| 组件 | 实际版本／身份 | 测试层级 |
|---|---|---|
| dsh | `0.2.1-rc.4` | T-103 隔离服务／profile；T-105／106 连接和 helper 实验 |
| sidebar | `0.28.2` | 既有静态清单；本轮实际 host apply／注册路由、客户端 API 和选定 Host API 方法；未启动完整 UI |
| SSH 候选 | `0.13.3`，commit `312524ec3627785fdf8ea537408fc6871a58271b` | 显式入口；原生未包装入口禁用 |
| helper | `0.13.1`，217238 字节 | 实际 bundle SHA `c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f` |
| Coder CLI／Server | `2.37.8`／`v2.37.8+7ac93cf` | 官方连接／已验控制面 |
| 模板／策略 | `lab-v3`／`lab-v1` | 模板版本 `7621affa-b880-476f-91eb-74855d529702`；SC-17 实验交付 |
| 构建工作区镜像 | `sha256:35749aeb9ddb29fa2e5213a531d81f8827d8d29ea4348488d2155a27a95a40b5` | 这是构建镜像，不是 Dockerfile 的 base digest |
| 私有 rg | Ubuntu arm64 `14.1.0-1`，命令 `ripgrep 14.1.0` | T-106 每 run 私有 HOME，已验证签名链、包及二进制；本轮不下载／上传／安装 |

候选 manifest 列 rc.2／rc.3，没有列 rc.4；peer 范围与 manifest 枚举分别记录，不把遗漏当不兼容，也未升级到 rc.5。矩阵核对 26 个安装文件、36 个历史源文件、298 个候选文件以及永久 JSON、独立 runtime 和 T-104 原始报告摘要。没有重跑历史浏览器、部署或整套 SDK 审计。

冻结镜像仍缺 rg，helper 初始 `degraded`。Git 文件名发现不等于非 Git／内容搜索；非 Git 和 `rg --json` 内容匹配只复用 T-106 私有工具条件证据。它不阻断“已通三层连接”的事实，但不算 frozen image 或产品搜索能力已交付。

## 3. 实际入口探针

实现：[入口脚本](../../scripts/m1/t107_entrypoints.mjs)、[控制器](../../scripts/m1/t107_run.py)。最终本地夹具：`artifacts/m1/t107/entrypoints-tf2gb_o5`，命令 exit 0，7 个观测用例。

- 调用安装包完整 `lib/index.js` 的 `apply`，取得其**实际注册的 `/sidebar/api` callback**，用流式请求／响应载体调用，不重写路由判断。
- `open.external` 的 reveal 和本地 editor scheme 均返回启动成功；实际 child_process 启动受限 PATH 中无害的 `xdg-open` 记录程序。记录器的 argv 直接读回，目标为中央随机空 anchor。
- 安装包客户端 `api.ts` 仅做类型擦除；实际 `openExternal` 对 SSH editor scheme 调用 `window.location.assign`。这是实际导航调用，不是浏览器／OS 已打开编辑器的证明。
- 加载 dsh 完整安装客户端模块并调用 `apply`，取得真实 `workspace.openLocal` 注册项。其 `resolve()` 返回 `handled`，`run()` 经实际 `/open-in-app/open` 路由启动无害 `code` 记录器，参数仍是中央 anchor。
- 实际 `SessionController.openWorkspacePath/verifyDesktopPath` 配合真实 LocalFileSystem，将中央 anchor 映射后调用最终原生动作 seam；没有因请求中的远程上下文拒绝。只替换最终打开动作，不把替换函数充当安全守卫。
- 正向派发对照之外，真实路由拒绝模拟 admission 失败（403）、空／相对路径和 HTTP URL（400）。**这不是产品认证测试**，也不是远程绑定拒绝。

边界：远程会话字段及 anchor 是合成的；产品 binding 存储／服务尚不存在。React 视图不渲染，注册回调被直接调用，未发送真实 DOM 键盘事件。客户端仅拦截导航，系统应用没有启动。实际安装代码不认识这些绑定字段，正是需要服务端权威守卫的缺口；不能说“实验适配器兼容入口拒绝”就已封住这些独立 Host 入口。

保留早期夹具失败：安装依赖祖先解析被隔离读权限拒绝、初版 resolver 递归、Node 不支持 node_modules 内原生 TS 擦除、未渲染客户端的 React 依赖解析。分别改为显式 SDK 解析、非递归 resolver、显式类型转换和未执行 UI 依赖载体，未扩大到账号／profile 配置读取，未修改安装包。旧结果都在矩阵 history 的 command 引用中。

## 4. 容量、时限和恢复

实现：[容量脚本](../../scripts/m1/t107_capacity.mjs)。最终真实 run：`artifacts/m1/t107/run-fad308ff9b16af3393d1e781`，controller／Node exit 0，5 类用例，独立磁盘快照与 helper 完整读回／名称检索一致。

| 类别 | 实际小样本 | 结论与未执行边界 |
|---|---|---|
| 目录 | 3 项；请求 limit 2／3／4；禁止截断时 limit 2 | 截断标志 true／false／false，完整性要求返回 `E_TOO_LARGE`；接口不分页。实际最大 1000 项／扫描 100000 项为源码及 hello 值，未制造千项目录 |
| 文件 | maxBytes 32，输入 31／32／33；write 65535／65536／65537；范围读 2+1 字节 | 超限明确拒绝；65537 在 dispatch 前拒绝且文件不存在；EOF／statVersion 有实测。不压测 6 MiB／64 MiB 最大文件 |
| 文件名搜索 | Git 10 项，分页请求 2；非法 limit 501；立即 close | 游标连续、最终 complete/eof；按名检索读回文件。close 确认不证明一定打断活跃扫描；非 Git／内容搜索复用 T-106 |
| 输出 | 131071／131072／131073 字节 | 前两项完整，后一项 `T106_OUTPUT_LIMIT`；异常不是取消。实际 helper ring 为 **2 MiB**，未触发 ring eviction／游标丢失 |
| 超时／取消 | 真实 process/read 等待 1000 ms、RPC 时限 40 ms；任务 wait 40 ms；随后显式 terminate | 41 ms 返回 timeout，任务仍运行；任务等待约 102 ms 才因读轮次结束报 deadline；取消约 61 ms 后 `running=false`、SIGTERM |

默认／归属在矩阵 `timeouts` 中：身份读取 25 s、ACK 30 s、SSH ConnectTimeout 15 s、官方 CLI 90 s+5 s 回收；适配 RPC 默认 5 s／允许最大 10 s，start 8 s、任务等待 8 s、discovery 18 s、release 8 s；取消分为 TERM grace 1.5 s、状态轮询 3 s、退出输出等待 5 s，各 RPC 仍独立有界。任务等待参数没有产品级上限校验，不能称其为完整任务超时政策。

本次同宿主样本：helper 连接 4182 ms；Git 首结果 1343 ms、扫描完成 1467 ms；命令首输出 759／672／677 ms。它们是测量值，不是 SLA；跨主机冷／热 UI 状态和网络下阈值归 M3，未执行。

**恢复与去重分开：** helper daemon 默认保留 600000 ms，可配置范围 30000–3600000 ms；内存 operation journal 最少 600000 ms，实际为 `max(session retentionMs,600000)`，最多 4096 项，清理有源码机制。这不是持久日志，也不是已验 provider 恢复窗口。BoundProvider 无恢复实现，`recovery` 入口拒绝，因此窗口为“未实现”，不是 0 秒通过。产品任务／审批默认时限尚缺，不编造数值。

mutation 自动重传继续禁用：当前源码 hash 不变，复用独立 T-106 的实际断连、一次副作用、唯一原 ID、后续 mutation 拒绝证据，本轮又实际调用 disabled-channel 守卫。日志过期／丢失／daemon 重启／世代切换的重传协议矩阵 **not-run**，因为没有提出启用重传；将来启用前必须另验。

首次容量 run `dd205de79ced5eee393847de` 的 hello 已正确显示 2097152，但文字误写 8 MiB；最终源码和矩阵明确为 2 MiB。其 `firstToCompleteMs` 也包含后续搜索／close，最终改为独立首结果和扫描时间。旧 JSON 不覆盖，最终新 run 重新实跑。

## 5. 最小解除任务与阶段边界

完整字段见矩阵 `unblockTasks`，均 **未执行**。下列新测试脚本名是未来交付约定，不表示文件已存在或命令已运行。

- **U-01 / B-01（M1-05）**：在另行批准的新实验适配层定义恢复／任务／审批时限归属，不改冻结 T-106、不引入 mutation 重传。输入为已存原任务身份和 helper 保留机制；同健康实例窗口内断连→重连→重查并取消原任务，独立查 PID/startTick／副作用。拟验 `node --test scripts/m1/t107_recovery.test.mjs`、`python3 -I scripts/m1/t107_recovery.py --case within-window --window-from-helper`。只允许一个短受管任务；需要改冻结源或重启 daemon 前返回协调器。
- **U-02 / B-02（M1-10）**：在隔离夹具中增加服务端权威远程模式拒绝 seam，覆盖实际 sidebar route、Host API、scheme 和注册快捷键。远程／空 anchor 零启动，本地正对照继续工作；不以 always-deny 代替。拟验本轮入口探针和 `node --test scripts/m1/t107_remote_opener_guard.test.mjs`。不改生产 profile／全局安装；完整绑定持久化及侧边栏改造仍属 T-201／T-205。
- **U-03（已知 P0 部署策略缺口）**：冻结 lab-v3 的 SC-17 实验交付成立，但 PID／硬磁盘限额、完整隔离和镜像 rg 不是已支持功能。先定实际策略及保留卷方案，再申请新模板／镜像和可能的 quota-capable 存储；保留旧模板、两个现有工作区及全部数据。验收含已有契约／实例验证和未来 `t107_policy_probe.py --small-fixture`。**当前授权禁止这些基础设施变更，本轮未做。**

普通容器共享内核，marker 同 UID 可改，rootfs 可写，internal bridge 不是完整网络隔离；两容器同机不算 SC-04。不能用文档披露把未满足 P0 能力写为通过，也不把 M3／M4／M5 全部功能提前变成本轮实现任务。

## 6. 复现、验证与资源

```sh
python3 -I scripts/m1/t107_run.py entrypoints
python3 -I scripts/m1/t107_run.py runtime
python3 -I scripts/m1/t107_gate_test.py
python3 -I scripts/check_docs.py
python3 -I scripts/test_check_docs.py
sha256sum --check docs/implementation/evidence/SHA256SUMS
sha256sum --check docs/research/evidence/SHA256SUMS
git diff --check
```

生成器 `t107_matrix.py` 仅以 `open('x')` 新建，不能覆盖既有 JSON。首次生成误选历史下载目录，摘要门禁在归档解析／矩阵写入前停止；换回已锁定的正确归档后成功，失败记录保留。机器记录完整读回、11 个 gate ID 检索、源摘要校验与 7 项 focused tests 均已运行。

独立最终观察：两个 T-107 远程 run 都无所属进程残留；最终 helper PID/startTick 消失；本轮历史／最终 10 个无害 recorder PID 均不存在；中央实验传输为空。原 T-106 独立验收的 **36 个容器 ID 精确集合不变：4 个 lab + 32 个基线服务**。没有删除合成文件、既有持久数据或容器。另行运行只读资源审计，最近 120 秒 warning/error 为 0，历史启动诊断保留。

没有委派、Workflow、模型 API、Git 提交／推送、生产配置或模板／镜像修改。下一步仅提交协调器安排独立门槛审核，不启动 T-201。
