# T-104 Coder 控制面与实例实验

日期：2026-10-30。用户明确授权由助手自行搭建 Coder；不再要求用户提供现成控制面、测试账号或模板。**本机专用控制面、模板及两个实例的实验范围已验证；不是产品 API、SSH／helper 或 M1 总体验收。** [执行清单](m1-closeout-tasks.md)记录后续任务；[永久机器证据](evidence/t104-coder-lab.json)包含实际报告、源码指纹与已知限制。

## 1. 实际部署与资源边界

| 对象 | 实际配置／结果 |
|---|---|
| Compose 项目 | `agent-studio-coder-lab`；[部署配置](../../infra/coder-lab/compose.yaml)，不接管其他服务 |
| 控制面 | Coder `v2.37.8+7ac93cf`；镜像固定 digest，独立数据库；TLS，禁用遥测与更新检查 |
| 数据库 | PostgreSQL 15 固定 digest；独立 volume，无宿主端口；网络范围的 host 认证为 SCRAM |
| 宿主入口 | 显式配置 IPv4 回环地址，Docker 自动分配宿主端口；本次为 `https://127.0.0.1:32768`，不是脚本硬编码默认值 |
| 内部访问 | `https://coder:8443`；端口来自私有配置；工作区通过专用 internal bridge 连接控制面 |
| 控制面权限 | 官方 Docker 路径挂载宿主 Docker socket；这赋予管理能力，不能视为强沙箱 |
| 控制面限额 | 2 CPU、2 GiB、256 PID；数据库 0.5 CPU、512 MiB、128 PID |
| 工作区 | `m1-a`、`m1-b`；同机 ARM64 Linux，UID/GID 1000，每个 0.5 CPU、256 MiB、独立 `/workspace` 卷 |
| 工作区挂载 | 只有项目 volume；不挂宿主 HOME、Docker socket、owner 凭据或 TLS 私钥；无宿主端口 |
| 镜像 | [Dockerfile](../../infra/coder-lab/Dockerfile.workspace) 固定 Python base digest，无缓存构建成功；模板使用实际不可变 image ID |
| 凭据 | 生成专用实验账号；`secrets/coder-lab/` 为 0700，顶层文件无组／其他访问权限；server key 为受限组 0640 |
| 留存 | 4 个实验容器仍运行；数据库、Coder home、两个项目卷保留。原有运行容器均仍在，没有删除持久数据 |

Coder、PostgreSQL、workspace image 的完整摘要见机器证据。模板固定 provider：`coder/coder 2.19.0`、`kreuzwerker/docker 4.6.0`、`hashicorp/random 3.9.1`。没有逐工作区 IDE、模型 API 调用、生产 dsh 修改或公网入口。

这是短期实验部署：TLS 证书有效期 30 天，审计时剩余超过一天；Compose 使用 `restart: "no"`，未验证宿主重启恢复、备份或长期运维。不能作为生产部署交付。

## 2. 冻结模板与独立身份记录

[模板源码](../../infra/coder-lab/template/main.tf)的当前版本为 **lab-v3**，SHA-256：

```text
82407d4d87947d437e7b9e8ecc78b144e1229d098b25394c92b87fd3a68aefdb
```

- Template ID：`3f2fe2b4-54ac-4054-a32e-8159c46b52df`。
- 当前版本 ID：`7621affa-b880-476f-91eb-74855d529702`。
- v1／v2 历史保留，本地实验 allowlist 标记 revoked；v3 allowed。相同 frozen source 再次 push 为 no-op；修改源码必须显式增加版本。
- 创建脚本固定 `--template-version lab-v3`。已有两个工作区的真实创建／更新和 v3 运行已验证；最后新增的创建参数由离线 mock 检查，没有为重测参数创建第三实例。

实例 marker 包含 `schemaVersion`、`workspaceId`、`agentResourceId`、`generation`、`templateVersion`、`imageId`、`root`、`uid`、`policyVersion`。预期值来自构建资源 metadata，实际值通过独立 Docker 读取，不通过待测 SSH 连接写读自证。

**Terraform 的 `coder_agent.main.id` 不等于 REST Agent ID。** 前者单独记作 `agentResourceId`；后者作为 `platformAgentId` 放在记录 envelope 中，与 build ID、模板版本 ID 一起保存，并直接查询 PostgreSQL 的 `workspace_agents`／`workspace_resources`，确认属于当前 build job。`workspace_builds` 的 workspace／templateVersion 也与 API 逐字段比对。

| 样本 | 实例世代 | 核验 |
|---|---|---|
| m1-a | `608b0e32-1322-4b86-dd99-49b50172d8e8` | API、数据库、容器、marker 对照通过；Agent connected |
| m1-b | `ada53b10-cf14-f6e3-c15a-2ab5eef36c25` | 同上；世代与 m1-a 不同 |

build 与 generation 分开：`random_uuid` 随运行资源 count 创建／销毁，template version 或 image 改变时也更换；普通网络重连不会触发模板构建。实际更新 v1 → v2 → v3 经 Coder stop/start 完成。任意平台外部替换、核验到派发间通道切换、旧会话／审批失效仍留给 T-105／T-302，不由此实验宣称通过。

## 3. 准入与负向测试的真实覆盖

[模板 runner](../../scripts/m1/coder_template.py)提供可运行的实验 validator；[离线测试](../../scripts/m1/test_coder_contract.py)共 **13 项**，包含类型、字段、UUID、不可变镜像、规范根目录、版本准入以及固定创建参数。

结合两个真实实例执行了 7 个拒绝探针：未知版本、错误模板、越界根目录、撤销版本、缺失记录、错误实例和伪造世代。负向探针前后的平台 workspace ID 集合相同；另一个 synthetic、较旧但获准的版本通过离线政策校验。

**这些是独立实验探针，不是已实现的产品服务端创建 API。** Coder 原生 API 没有被这段 allowlist 逻辑改造；获准旧版本样本不等于真实部署回滚。产品准入及完整 SC-02 仍由 T-202／T-208 实现验收，避免要求 M1 先依赖 M2。

## 4. 实际验证命令与结果

以下从仓库根执行，复用已部署资源，不重新 prepare 或清空数据库：

```sh
python3 -I scripts/m1/test_coder_contract.py
# Ran 13 tests / OK
python3 -I scripts/m1/coder_lab.py verify
# publicHealth=200, anonymousProtected=401, invalidProtected=401
# authenticatedProtected=200; ownerDatabaseReadback/ownerApiReadback/ownerSearch=true
python3 -I scripts/m1/coder_template.py push
# PASS: exact frozen template version already active; no upload needed
python3 -I scripts/m1/coder_template.py verify
# PASS: two different independent instance records, database/API/container readback, 7 rejected probes
artifacts/m1/t104/browser-venv/bin/python -I scripts/m1/test_coder_browser.py --browser /snap/bin/chromium
# 错误密码 401，正确密码登录 201，已认证 workspace API 200
# 两个工作区可见；JS errors=0，blocked external hosts=[]
python3 -I scripts/m1/coder_lab.py cleanup-sessions
# DELETE 1; disposable lab sessions revoked; protected runner session retained
python3 -I scripts/m1/audit_coder_lab.py
# PASS: 4 running lab containers; private config, limits, TLS, database auth and retained session checked
# Historical startup diagnostics retained; recent 120-second warning/error count: 0
```

`cleanup-sessions` 只处理本实验 owner 的临时登录，不删除工作区或数据；SQL 直接核对临时 session 为零，并保留、实测 runner session。浏览器每次写入新的独立输出目录，不覆盖旧证据。最后一次浏览器截图已查看，两个工作区真实显示 Running。

浏览器用专用证书 SPKI pin，并仅在测试浏览器内将 canonical `coder` 映射到配置中的回环入口；未修改宿主 hosts、系统 CA 或关闭全局 TLS 校验。**普通浏览器仅打开回环 URL 不等于已具备同样的 canonical hostname 可达性。** 对外访问、日常用户访问配置及 T-105 中央 CLI 的地址／信任链仍须按其部署方式落实，不能靠 `--insecure` 绕过。

### 日志事实，不改写为“启动从无错误”

- 控制面有关闭 telemetry 的提示，及 `coder_agent.dir` 弃用／不支持非 HOME 的 Desktop file sync 警告；本实验未启用 Desktop 同步。
- 数据库初始化记录 local trust 提示；直接检查 HBA，网络范围规则为 `scram-sha-256`，未暴露数据库端口。
- 一个 Agent 在 provision job 尚未结束时出现认证重试；另有非 prebuilt 工作区探测拒绝和 userspace `fakeRouter` 警告。最终两个 Agent connected，容器 restart count 为 0，未 OOM。
- 最后审计的 120 秒没有匹配的 warning/error 日志；**不声称完整启动历史为零错误或网络隔离已验证。**

一次早期 Playwright request 失败曾在默认错误正文中打印专用测试 session Cookie；该临时 session 及之后所有浏览器临时 session 均已撤销，直接查库最终仅剩受保护 runner session。现改用页面内 fetch，错误处理不输出请求细节。公开证据不含 Cookie 值、账号密码或私钥。

## 5. 首次部署步骤与运行限制

以下仅供**全新且已授权**的实验目录执行；当前机器已经完成，不应重复 prepare 或为重跑删除原目录：

```sh
# 先显式设置 LAB_BIND_ADDRESS 为 IPv4 回环地址、CODER_TLS_PORT 为容器 TLS 端口。
python3 -I scripts/m1/coder_lab.py prepare \
  --bind-address "${LAB_BIND_ADDRESS:?Set an IPv4 loopback address}" \
  --tls-port "${CODER_TLS_PORT:?Set a container TLS port}"
python3 -I scripts/m1/coder_lab.py up
python3 -I scripts/m1/coder_lab.py build-workspace
python3 -I scripts/m1/coder_template.py push
python3 -I scripts/m1/coder_template.py create
python3 -I scripts/m1/coder_template.py verify
```

[部署 runner](../../scripts/m1/coder_lab.py)生成凭据／短期 CA，验证 Compose，健康等待最多 180 秒；外部命令默认 540 秒，失败诊断只写受限目录。`build-workspace` 实际使用 `--no-cache`。已有版本更新使用 `coder_template.py update`，会停止／启动两个专用工作区；不要在活跃任务未处理时随意重跑。构建镜像时存在包管理器联网，工作区运行时只连 internal bridge；不把前者描述成离线构建。

浏览器脚本依赖实验 venv 的 `playwright==1.56.0` 和显式指定的 Chromium；本次使用已有 `/snap/bin/chromium`，没有安装全局 Python 包。复现永久证据用[归档脚本](../../scripts/m1/record_coder_lab.py)，传入各 runner 输出的 JSON 路径和新输出文件；历史文件不覆盖。

## 6. 未通过项与下一步

- 同机两个普通容器，不是跨主机／VM 强隔离；控制面 Docker socket 有管理权限。
- marker owner 是 UID 1000，可 chmod；0444 不能防同 UID 工具篡改，marker 本身不是信任边界。v3 明确这一点，没有假装 root ownership 已修复。
- 工作区尚无 PID cgroup 限额、硬磁盘配额或只读 rootfs；internal bridge 也不是完整出站／跨环境安全证明。正式 NF-02／SC-08 验收不能放行。
- 尚未验证当前 SSH 通道身份、远端 helper、FS／命令／PTY／取消、无中央回退、真实 dsh 会话或多主机。对应 T-105 → T-106 → T-107。
- M1 仍未通过；T-201 等产品实现不提前放行。没有新增 Git commit／push。
