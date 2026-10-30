# 本机容器实验记录

归档日期：2026-10-29。原型位置：`~/.dsh/sandboxes/local-opencode/`。以下结果来自已保存的历史报告，本轮只核对与复制报告，没有再次启动容器、执行模型请求或检查当前服务状态。

## 实验回答了什么

中央 dsh 可以通过独立的 `subagent_opencode_sandbox` 工具，按任务创建本机 Docker 容器，运行真实 OpenCode ACP，并在挂载项目中完成实际读写。原有子代理和主代理没有全部迁入容器。

这是单机、单账号的执行环境原型，不是 Agent Studio 产品实现；它没有证明 Coder、跨主机路由、完整侧边栏、真实手机交互或 v0.3 的 CLI 审批契约通过。

## 历史配置快照

| 项目 | 实验配置 |
|---|---|
| 工具 | OpenCode 1.18.35、Python 3.13；没有另行安装 Claude Code、Node 或 Git |
| 架构／用户 | ARM64；UID/GID 1001:1001 |
| 镜像标签 | `dsh-local-opencode:1.18.35-lab` |
| 实际镜像 | `sha256:540cf94513abec6949161a8b0352942a4f8aa4b98a95546f8d4349cd25f05bfb` |
| 模型／配置 | `hroze-sp/gpt-6-sol`，只选择一个 provider，MCP 配置为空；未归档账号配置值 |
| 文件系统 | 只读系统盘；临时 HOME 和 `/tmp`；只挂载选定项目及只读专用配置 |
| 资源 | 2 CPU、2 GiB 内存、128 PID、默认 300 秒超时 |
| 权限 | drop ALL capabilities、no-new-privileges，不挂载 Docker socket 或整个宿主 HOME |
| 网络 | Docker bridge；使用已有代理配置名称 `us-la`，未实施出站目标白名单 |

挂载项目使用容器内同名绝对路径以兼容 ACP cwd，这不代表任意宿主路径都可访问。临时 HOME 每次重新生成，项目文件持久保留。

## 已保存的测试结果

| 层级 | 报告中的结果 | 快照 |
|---|---|---|
| 准备 | 单 provider、无 MCP、配置文件 0600、凭据读回通过且未记录秘密值 | [preparation.json](evidence/preparation.json) |
| 隔离 | 15 项检查通过，包括用户、HOME、显式环境、只读根、宿主标记／配置不可见、无 socket、权限与资源 | [isolation.json](evidence/isolation.json) |
| 生命周期 | 项目读写、HOME 重置、越界拒绝、取消和超时回收通过 | [isolation.json](evidence/isolation.json) |
| 管理 | 列表、按 run ID 停止、取消状态持久化、真实 Docker 状态及重复停止通过 | [management.json](evidence/management.json) |
| ACP 探针 | `DSH_CONTAINER_ACP_OK`，完成，9456 ms | [acp-probe.json](evidence/acp-probe.json) |
| 配置组合 | provider 实际插入 Host 层，工具加入标准 preset，其他配置未改变 | [composition.json](evidence/composition.json) |
| 真实 dsh | 10 项端到端检查通过，耗时 75.04 秒；唯一沙箱委派，无父代理文件工具或其他 provider 代跑 | [e2e-verification.json](evidence/e2e-verification.json) |

真实子进程输出：

```json
{
  "nonce": "890f3c64daaa87fba86d5d82",
  "total": 2028,
  "sandbox": "local-opencode",
  "home": "/home/sandbox",
  "uid": 1001,
  "hostFileVisible": false,
  "template": "local-opencode-container"
}
```

对应会话 `session-8e766c2b-8756-4dee-9635-13990bed0618`，运行 ID `299e136cb2db4e90adb15eae6fc78fd5`。报告记录退出码 0、容器已删除；会话持久日志有 42 条记录，提示、工具和随机 nonce 已落盘，列表与新 API 读回通过。全文会话搜索由原配置禁用，不计作搜索验收通过。

## 已知错误与修正的背景

- 早期隔离脚本把 tmpfs 与 bind mount 数量混为一谈；Docker 将它们放在不同字段，后来分别验证。
- 早期回收检测依赖 Docker 错误文案大小写，导致实际容器已删除而记录为未删除；改为查询容器清单确认。旧运行记录保留，不能把其早期字段当成当前 Docker 状态。
- 独立 provider 连通不等于真实主会话暴露了工具；最终另行核对组合和真实 dsh 委派流程。

这些修正来自此前实验记录。归档报告是结论和关键事实快照，未包含全量进程日志、全部历史失败记录或所有原型源码。

## 明确不能推出的保证

- Docker 与宿主共享内核，不是 VM；没有完成容器逃逸防御验证。
- 网络可以访问宿主可达网络，没有实现目的地隔离。
- 工具进程能读取分配给自己的凭据；没有凭据不可见代理。
- 主 dsh 和原有工具仍按原方式运行，不是全工具路由平台。
- 没有多主机选择、多租户、账号轮换、环境池或完整终端 UI。
- SIGKILL、宿主／Docker daemon 故障可能绕过清理；没有租约回收服务，断线不证明进程停止。
- 历史报告中的 `allContainersRemoved` 是当时结果，不能用来声称归档时或未来没有残留容器。

## 复现与保留边界

[原型 README 快照](evidence/prototype-readme.txt)保留原使用、管理和撤销方式。实际脚本、Dockerfile、镜像与测试工作区仍在原实验目录；本项目没有复制它们或秘密配置。若未来复跑，需要先核对当前配置、版本、权限和资源授权，不能直接把历史命令当作继续执行的授权。

返回[调研索引](README.md)。
