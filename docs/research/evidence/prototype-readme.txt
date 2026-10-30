# 本机 OpenCode 容器实验

这是一个本机、单账号的执行环境原型，不是多机调度平台或虚拟机。dsh 留在宿主机，通过新增的 `subagent_opencode_sandbox` 工具，按任务创建 Docker 容器并运行 OpenCode ACP。原有子代理未替换。

## 在 dsh 使用

在标准 preset 的会话里发送：

```text
请调用 subagent_opencode_sandbox，cwd 设置为
/home/ubuntu/.dsh/sandboxes/local-opencode/workspaces/demo，
在其中创建 hello.py 并运行，返回实际输出。不要使用宿主 bash 代替执行。
```

也可以使用 `workspaces` 下的其他项目目录。启动器只接受该目录下的真实项目子目录；解析后的路径不在白名单内会拒绝启动。项目挂载到容器内的同名绝对路径，以兼容 ACP 的 cwd；这不意味着其他宿主目录也被挂载。

## 执行环境

- 镜像标签：`dsh-local-opencode:1.18.35-lab`；实际运行由 `settings.json` 固定到镜像 ID。
- 基础镜像：固定摘要的 `python:3.13-slim`，ARM64。
- 工具：OpenCode 1.18.35、Python 3.13；本实验没有另行安装 Claude Code、Node 或 git。
- 模型：`hroze-sp/gpt-6-sol`，只复制这一模型对应的 provider 配置，没有复制宿主 MCP 配置。
- 网络：Docker bridge，沿用现有 `us-la` HTTP(S) 代理选择；没有实现出站目标白名单，也没有隔绝宿主可达的网络。
- 用户：`1001:1001`，非 root；drop ALL capabilities，no-new-privileges。
- 系统盘：只读。`/tmp` 与 `/home/sandbox` 使用临时内存文件系统。
- HOME：每次任务全新生成；HOME 中的改动在任务结束后丢弃。项目目录中的文件保留。
- 挂载：只有当前项目目录可写，以及 `/run/opencode/config.json` 的只读专用配置。不挂载整个宿主 HOME 或 Docker socket。
- 配额：2 CPU、2 GiB 内存、128 个进程；默认超时 300 秒。

账号凭据仅存放在 `secrets/opencode.json`，代理环境在 `secrets/container.env`，文件权限均为 0600。它们没有进入镜像，但容器内同账号的工具仍能够读取注入给自己的凭据；本原型没有实现凭据对模型进程不可见的代理机制。

## 查看和停止任务

```bash
LAB="$HOME/.dsh/sandboxes/local-opencode"
python3 -I "$LAB/scripts/sandboxctl.py" list
python3 -I "$LAB/scripts/sandboxctl.py" stop RUN_ID
```

`list` 读取本地 `state/*.json`，并查询 Docker，附加 `containerExistsNow`。开发阶段旧记录中的回收检测字段可能来自早期判定逻辑，当前是否存在容器以 `containerExistsNow` 为准；保留这些记录用于审计。

手动运行容器内命令：

```bash
LAB="$HOME/.dsh/sandboxes/local-opencode"
cd "$LAB/workspaces/demo"
python3 -I "$LAB/scripts/sandboxctl.py" run -- python --version
```

给单次运行设置更短的超时：

```bash
python3 -I "$LAB/scripts/sandboxctl.py" run --timeout-seconds 30 -- python hello.py
```

正常结束、SIGTERM/SIGINT/SIGHUP、显式 stop、超时都会进入停止和删除流程。任务记录、项目文件与镜像会保留，因此空闲时没有常驻的实验容器。

## 修改环境

- `settings.json`：镜像、配额、超时、网络及专用配置路径。修改后在下一次启动生效，无需重启 dsh。
- `secrets/opencode.json`：这个沙箱账号的 provider 和模型。不要把内容粘贴到聊天或日志。
- `secrets/container.env`：显式传入的代理等环境变量。容器不会直接继承启动器的全部环境变量。
- `image/Dockerfile`：基础系统、软件、系统文件及非敏感默认环境。修改镜像后需重新构建，并将新的镜像 ID 写入 settings.json。
- `~/.dsh/profiles/web/cordis.patch.yml`：独立的 `opencode-sandbox` provider 和 `subagent_opencode_sandbox` 工具。

系统盘只读是本实验选定的策略，不是容器只能使用固定系统：需要的软件和系统文件可以预先放入镜像，指定目录也可以另行设计为可写卷。内核级设置仍属于宿主；独立内核需要 VM/microVM。

## 验证证据

- `evidence/preparation.json`：最小配置及凭据读回验证，不含凭据值。
- `evidence/isolation.json`：文件、环境、系统盘、权限、资源限制、取消与超时回收。
- `evidence/management.json`：按 run ID 列表和停止、重复停止、状态读回。
- `evidence/acp-probe.json`：真实 ACP provider 到容器 OpenCode 的调用。
- `evidence/composition.json`：provider 在 host 层实际插入，其他配置结构未变。
- `evidence/e2e-verification.json`：真实 dsh 会话、唯一委派、容器写文件、随机数据校验、容器清理和会话持久化。
- `verification.json`：dsh 认证、浏览器、原有会话与配置验证。

全文会话搜索由原有部署的 `openAt: never` 禁用；没有为本实验启用。会话列表、历史 API 读回和压缩会话日志的直接读取已用于验证。

## 当前边界

- 仅新沙箱子代理在容器内运行；dsh 主代理及原有工具仍按原来的方式执行。
- Docker 与宿主共享内核，不是 VM，也没有验证容器逃逸防御。
- 尚无多机选择、多租户认证、自动账号轮换、常驻环境池或交互终端页面。
- 宿主宕机、启动器遭 SIGKILL、Docker daemon 故障不保证执行 finally；没有后台租约回收服务。此时应通过 Docker 和运行记录核对并清理，不能据断线就推断任务停止。
- 配置或工具发生变化后应重新跑相应测试。测试脚本保留失败和成功记录，不会清除原始证据。

## 撤销接入

仅移除 `cordis.patch.yml` 中 `subagent-opencode-sandbox` 的 insert 块与 `tool-subagent-opencode-sandbox` 工具行，然后重启 `dsh-web.service`。`backup/cordis.patch.yml` 是本次变更前的完整备份；如果之后又有其他配置改动，不要直接用它覆盖新配置。

删除实验目录、镜像、凭据或项目文件是另外的操作；本次没有自动删除这些持久内容。
