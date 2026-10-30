# 平台选型调研

调研基线：2026-10-29。性质：当时的官方文档、公开仓库与发布状态核对；没有部署 Coder、OpenSandbox 或跨主机实验。当前首期平台已经确定为 Coder，其他候选仅保留选型背景。

## 要解决的不是一个 SSH 连接

目标包括中央环境目录、模板与生命周期、对不同机器／K8s 环境的访问接口，以及统一的项目体验。平台可提供部分控制和连接能力，但 dsh 的会话绑定、文件／执行路由、插件适配仍是独立工程。

“支持 Docker／K8s”不等于“能将任意 Linux 主机自动注册成负载均衡资源池”；“创建工作区”也不等于工作区已经满足文件、凭据、资源及网络隔离要求。

## 候选对比

| 候选 | 当时核对的能力／状态 | 对本项目的价值 | 不可据此承诺的能力 |
|---|---|---|---|
| Coder | 中央控制台、模板、工作区生命周期、REST、Agent、SSH 和应用访问；开源核心与 Premium 功能并存 | 以开发工作区为对象，贴近长期项目及本地／远程切换；确定为首期平台 | 裸机自动入池、所有高级功能免费、工作区天然强隔离、现有 dsh 插件自动远程化 |
| OpenSandbox | Apache-2.0；沙箱生命周期／执行接口与 SDK、文件和命令、Docker／K8s；当时主分支已有基础 Console | 面向沙箱 API 的未来平台适配候选 | Docker 单主机后端自动成为多宿主调度器；基础 Console 等同成熟开发工作台 |
| Daytona | 当时公开仓库说明核心开发已转入私有代码库，公开仓库不再按此前开源路线维护 | 保留历史候选，不作为当前活跃开源底座推荐 | 把过往开源宣传或旧版本文档当成当前维护承诺 |
| Nightona | 当时作为 Daytona 开源分支的社区延续方向被调查，仍处启动阶段 | 观察项，未纳入实施路线 | 成熟发布、稳定供应链或已验证部署；本归档不补造未保留的仓库／发布链接 |

Coder 的开源核心许可证当时按 AGPLv3 核对，但具体企业代码与功能许可不能由这一标签推导。实施时仍须核对选定版本与所用功能。OpenSandbox 的许可也只对应当时调查的仓库状态。

## Coder 的多 Linux 主机与 K8s 路线

当时查到 Terraform Docker provider 可通过 SSH／TCP 连接远程 Docker 主机。因此可以用受控模板明确选择宿主；这不是自动负载均衡能力的证明。K8s 路线则将放置交给集群调度，验收仍需记录真实节点。

外部 provisioner 文档标注 Premium，不能默认其是免费且必需的部署部件。应先验证现有控制面与模板／provider 的可行路径；涉及付费依赖时明确许可，而不是在实施中静默变更平台或范围。

Coder 的工作区应用代理可以暴露 Web 应用，但不说明必须在每个工作区运行完整 dsh 或 code-server。早期用这一能力推导方案 B 的建议已经失效；当前方案只保留中央 dsh。

## OpenSandbox 的适用范围

其 API 更接近“创建 → 文件／命令 → 保活／停止／删除”的沙箱调用链。对于多个独立 Docker 主机，不能仅因存在 Docker 后端就认定已有主机池管理；K8s 或另行实现的后端路由才是可评估路径。

当时主分支 Console 偏生命周期操作，历史／审计等能力不能从界面存在直接推断。首期不并行做 Coder 和 OpenSandbox 两套适配，避免放大兼容和验收范围。

## 选型结论的有效范围

- 采用 Coder 是当前产品决定；不等于 Coder + 社区插件 + 当前 dsh 版本组合已经实跑。
- 对接标准优先采用所选平台的正式 API／连接方式；没有发现一组可不加适配就覆盖所有平台的通用工作区标准。
- 无论平台选型如何，项目身份、任务绑定、故障关闭和隔离策略仍由集成层与基础设施共同落实。
- 本轮归档没有重新查询上游版本或维护状态；Daytona／Nightona 等时间敏感结论再次选型时必须复查。

## 来源与历史记录

- [Coder 仓库](https://github.com/coder/coder)
- [Coder 架构](https://coder.com/docs/install/plan/architecture)
- [远程 Docker provider 认证](https://coder.com/docs/admin/templates/extending-templates/provider-authentication)
- [Provisioner 与功能许可边界](https://coder.com/docs/install/operate/provisioners)
- [工作区 Web 应用](https://coder.com/docs/admin/templates/extending-templates/web-ides)
- [OpenSandbox 仓库](https://github.com/opensandbox-group/OpenSandbox)
- [OpenSandbox Console](https://github.com/opensandbox-group/OpenSandbox/tree/main/console)
- [Docker 单主机网络架构](https://open-sandbox.ai/architecture/network/single-host-network)
- [Daytona README](https://github.com/daytonaio/daytona/blob/main/README.md)
- [原始研究摘录](evidence/historical-research-excerpts.txt)：第 1774 行对应的历史回答；其中方案 B 推荐已被后续决定否决。

返回[调研索引](README.md)。
