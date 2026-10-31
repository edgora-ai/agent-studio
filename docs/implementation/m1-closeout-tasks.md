# M1 收尾执行清单

日期：2026-10-30。**T-106 限定实验已独立通过。T-107 review2 归档被两次上游 HTTP400 中断，只有 `gate=repair-required` 记录、没有最终 validation，不是完整审核交付。已定位路由问题的 repair2 本地自测通过，待独立验证；正式 M1 仍 blocked。** 本清单不替代[05 的完整阶段门槛](../05-delivery-and-acceptance.md)。

**2026-10-30 新用户开发例外**：按“连续完成剩余开发任务，遗留问题可以先记录并跳过，尽快可以跑起来”，审核中断及登记遗留项不再阻止 T-201 与后续隔离开发；T-201 **可开发／待实现，不是通过**。旧“T-201 不启动／本轮停止”记录保留其当时约束含义，不再作为当前开发禁令；正式完成与发布门槛不变，见[开发决策与账本](development-ledger.md)。

## 1. 当前状态与后继

| 任务 | 已有结果 | 当前状态／下一动作 |
|---|---|---|
| T-101／T-102 | [版本／来源与契约核查](m1-readonly-audit.md) | 已验证只读范围，不是运行能力 |
| T-103 | [隔离防护纠正与真实 profile](t103-isolated-load.md) | 冻结不改；原生未包装入口仍禁用 |
| T-104 | [Coder 2.37.8、lab-v3、两实例交付](t104-coder-lab.md) | 不重建；本轮未对现有服务做新测试 |
| T-105 | [当前通道身份独立验收](evidence/t105-independent-acceptance-pass1.json) | 冻结不改；沿用既有真实连接证据 |
| T-106 | [独立复验 review2](evidence/t106-independent-acceptance-review2.json) | `gate=pass`、`t107Ready=true`，仅实验 helper 通道；不重跑旧整套 |
| T-107 | [未完成归档的 review2](evidence/t107-independent-review2.json)、[repair2 本地自测](evidence/t107-repair2-selftest.json) | review2 记录 IA-01／IA-03 在限定范围关闭，但 M1-10 因 T107-R2-IA-04 失败；本轮修正仅自测通过，未签独立验收 |
| T-201 | 正式完成仍以完整 M1／T-107 通过为前置 | 按 2026-10-30 开发例外，**可隔离开发／待实现**；产品持久绑定等尚未实现，不能标为通过 |

repair2 的限定修正已结束；本次文档交接后由协调器推进开发切片，不恢复受阻审核、不换模型／代理／通道。后续独立验证另由协调器决定。旧[首轮审核](evidence/t107-independent-review1.json)、[repair1 自测](evidence/t107-repair1-selftest.json)、[repair1 增量矩阵（历史）](t107-repair1-matrix.json)、[原调查](t107-m1-investigation.md)与[原矩阵](t107-m1-matrix.json)均保留；源码变更前已单独快照，旧报告与 checksum 行不覆盖。

## 2. repair2 修正及能力边界

| 项 | 当前状态 | 不扩大的结论 |
|---|---|---|
| T107-R2-IA-04／M1-10 | 守卫按安装包相同的 `new URL(...).pathname` 语义分类；解析失败拒绝，不再按原始目标字符串漏掉已定位的 `./`、`%2e/` 拼写 | 仅隔离 wrapper，未改上游或生产安装；不是正式 binding／浏览器认证／DOM 验收 |
| 本地入口回归 | 原 42 个负向＋9 个指定拼写负向，共 51 个零动作；原 7 个正向＋3 个指定拼写本地正向，共 10 个；目录读取和应用目录 2 个非动作控制正常 | 只用无害 recorders／导航捕获；reveal 正确验证 `dirname(anchor)`，不改旧独立失败结果 |
| U-01／初始时限 | recovery／policy／runtime／controller 均未改，复用 repair1 真实恢复、原任务取消和一次副作用证据 | 本轮没有远端恢复或完整 controller 重跑；不是 daemon 重启、PTY／游标恢复或 mutation 重放 |
| IA-03 | 18,000 ms 仍只是 open 后循环预算；open/read/close 各默认 5,000 ms，close 单独等待；旧离线 28,800 ms 反例保持历史证据 | 没有硬端到端 deadline；本轮未重新执行该反例或远端时间探针 |
| U-03 | 仍待资源／策略范围审议；lab-v3 的 rg、PID／硬磁盘配额等缺口不变 | 本轮未扩权，也不是用户永久禁止；实验模板交付不等于完整产品隔离 |

## 3. 本轮检查

仅在新随机本地 fixture 中调用**未修改控制器的 `entrypoints()` 函数**，沿用已存在的受限 Node 参数；未调用控制器 `main()`。实际参数、输出与源码 hash 见 repair2 自测证据。

```sh
node --test scripts/m1/t107_repair.test.mjs
python3 -I scripts/m1/t107_gate_test.py
python3 -I scripts/check_docs.py
python3 -I scripts/test_check_docs.py
sha256sum --check docs/implementation/evidence/SHA256SUMS
sha256sum --check docs/research/evidence/SHA256SUMS
git diff --check
```

当前 focused 为 28 项（原 23 项＋5 项本地路由回归）；历史 `t107_gate_test.py` 的 7 项只验证原调查矩阵／原源码。写后验证保存为 `evidence/t107-repair2-validation.json`，不是独立 review2-validation。

## 4. 本轮资源与历史

- 本地 run `repair2-local-d8m9zpo3`：focused 与实际入口均 exit 0；61 个动作上下文用例、2 个非动作控制通过。8 个记录器 JSON 已直接读取、完整比较、按用例 ID 检索；8 个 PID 均不存在，注册路由／监听器清理为空。
- 本轮测试无失败、无重试。review2 两个旧补充夹具 exit 1 原样保留；其末次 `dirname(anchor)` 期望错误没有被重写成通过，未再运行旧夹具。
- 本轮无远端／Docker／服务检查，**不声称重新验证 36 个容器集合**；既有 4 lab＋32 基线及恢复清理事实仅引用旧证据。未删除记录器、合成数据或其他持久数据。
- 冻结源码、模板、镜像、上游安装、全局配置不改；无 Workflow／再委派／模型 API／commit／push。后续阶段顺序仍为 **T-107 → T-208 → T-309 → T-404**。
