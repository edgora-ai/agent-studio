# 独立部署交接说明（新会话接手用）

状态：**未完成，未交付可用实例。** 本文件只记录已核实事实与下一步，不将任何准备物当作可用交付。
生成时间：会话阻塞停轮后由 Lead 整理；仓库分支 `work/m1-source-audit`，已推送提交 `1aee642`。

## 1. 项目目标（用户原话要点）

1. 在本机新建**完全独立**的 Agent Studio DSH 与 Coder 实例，保留既有实例、数据与身份历史。
2. 中央 DSH + Coder 工作区 + 受控 SSH/helper + **真实原生模型**（禁止 OpenCode 或任何非 DSH subagent）。
3. **真实浏览器**验证：认证、项目/环境选择、远程文件读写、终端命令、真实编程任务。
4. 使用独立根、端口、Compose 项目、数据卷、凭据；不触碰 GUI `http://10.147.18.50:3080`、其他既有服务、保护 fixture job `bash-0c433b0240bd4b7c`；不输出凭据、不扩大公网暴露、不重放旧任务、不删改旧持久数据。
5. 保留 SDK `0.2.1-rc.5` 的可升级兼容快照（不永久锁版本）。
6. 禁止使用权限/提权/审批字段；策略拒绝立即停止，不换工具/代理绕过。
7. 用户要求可用的交付，不要过程性解释。

## 2. 已完成（可核实）

- 仓库基线提交 `1aee642`（fix(sidebar): harden ACP history, tree refresh and Git reads），分支 `work/m1-source-audit`。
- 既有服务仍在运行（本次只读核对，未改动）：
  - `agent-studio-coder-lab-coder-1`、`agent-studio-coder-lab-database-1`
  - 历史工作区容器 `agent-studio-lab-ff136352-…`、`agent-studio-lab-d352009d-…`
- 浏览器验收草稿（源码级，**未执行**）：
  - `scripts/dev/fresh-browser.py`
  - `scripts/dev/test_fresh_browser.py`
  - 两者仅做过 `ast.parse` 语法检查；已知待改：用 Request 对象做 ledger（不用 `id(request)`）、预期越界错误码应为 `path-outside-binding`、源/线上 schema 与 auth DOM 断言。
- 只读源码诊断结论（已核实，非修复）：
  - `@deepseek-ai/dsh-tools/lib/types/schema.js` 75–82、238–244：author 侧 optional 字段被正确保留，编译层不是缺陷源。
  - `dsh-tool-bash/lib/index.js` 518–527、`dsh-tool-fs/lib/index.js` 1108–1119：两个权限字段在 schema 中是 optional；fs 1134–1138 在任何 I/O 前校验配对。
  - `dsh-llm-pi-ai` `piTool` 1262–1267：原样转发 `tool.parameters`。
  - `@earendil-works/pi-ai` 1.4.0：`openai-codex-responses.js` 392 与 415–419 两处 `strict: null`；`openai-responses-shared.js` 337–368 会把这些值原样发出；`constrained-sampling.js` 91–104 的 strict 转换会补 nullable 并 required=全部属性。
  - **以上只是候选线索，活跃 provider/真实出站 wire 从未捕获，根因未证实。**

## 3. 未完成（全部核心交付）

- `.preview/agent-studio-fresh/dsh`：**不存在**（未 prepare）。
- `.preview/agent-studio-fresh/coder/manifest.json`：**不存在**（未启动 Coder）。
- `infra/coder-fresh/`、`artifacts/deployment-fresh/`：**不存在**。
- **以下源文件未落盘**，内容仅存在于上一会话对话中，新会话必须重写：
  - `scripts/dev/fresh-coder.py`（原会话中约 650 行，含 Docker/Compose/TLS/template/SSH 编排）
  - `scripts/dev/fresh-model.mjs`
  - `scripts/dev/fresh-server.mjs`（仅有设计，从未写过）
- 真实模型从未调用；无任何 inference 证据。
- 浏览器从未访问新实例；无截图/报告。

## 4. 关键契约（必须沿用，避免与旧实例混淆）

- 新 DSH 根：`/home/ubuntu/workspace/agent-studio/.preview/agent-studio-fresh/dsh`
- 新 Coder 根：`.preview/agent-studio-fresh/coder`，manifest 文件 `manifest.json`
- 认证：DSH 根下 `ready.json`，登录 URL 在 `login.url`（**不是** login-url.txt）
- 模型凭据：新 DSH 根下 `model-credentials.json`（0600 非符号链接，`{version:1,references:{},records:{}}`），模型引用名 `/^STUDIO_MODEL_[A-Z0-9_]{1,100}$/`
- transport 显式 opt-in：`<新 DSH 根>/coder-transport.json`：
  `{"version":1,"manifest":"<绝对路径的兄弟 Coder manifest>"}`
- 新目录键：`coder-fresh-workspace`、`coder-fresh-workspace-d05-v1`；策略 `d02-bound-helper-v1`、`d05-model-helper-v1`
- 计划 Coder 端点：`https://10.147.18.50:19443`（仅私网绑定，禁止 0.0.0.0/公网；TLS SAN 含 coder/10.147.18.50/127.0.0.1；容器内 `https://coder:8443`）
- manifest 字段（非秘密）：`schema_version, origin, compose_project, private_dir, state_file, ca_file, session_file, ssh_config, known_hosts, expected_record, known_hosts_sha256, alias, credential_ref, template_version, allowed_catalog_policies`
- `expected_record` 需含完整身份：`name, owner, ownerId, workspaceId, platformAgentId, agentName, resourceId, jobId, buildId, templateId, templateVersionId, templateSha256, marker, expectedUser, expectedUid, root`
- 固定 pinned 镜像（沿用已审核）：
  - `ghcr.io/coder/coder@sha256:8514c20c3c7811a9835eb903c5123b0090ba6538dc8bcc8281624d0bdedd9063`
  - `postgres@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e`
  - base `sha256:35749aeb9ddb29fa2e5213a531d81f8827d8d29ea4348488d2155a27a95a40b5`
- 新模型候选（**未验证**）：provider `hroze-chat`，`https://cli.hroze.org/v1`，`openai-completions`，默认模型 `deepseek-flash`；凭据引用只能从 DSH 配置中以进程内方式复制，**不得打印**。Studio 侧模型 `studio-model-fresh`，`contextWindow=196608, maxTokens=16384, input=['text'], reasoningEfforts=false`。

## 5. 工具接口问题（如实记录，勿重复踩坑）

- 上一会话的 write/edit 调用被模型侧强制带上 `sandbox_permissions` 与 `justification` 两个字段；即使使用开放参数的并行包装也一样。
- 因此写入在执行前报 `invalid justification: expected a non-empty sentence`。**这不是沙箱拒绝**（不是 `FS_SANDBOX_DENIED`），也不是权限不足。
- 运行约束明确禁止设置这两个字段，所以不能靠填值绕过，也不能用其他工具/代理绕。
- 该问题导致本会话在 `gpt-6.1-sol` 路由下无法落地任何代码改动，进而阻塞全部部署任务。
- **后续证据**：同一会话切到 `deepseek-flash` 路由后，一次完全省略这两个字段的 `write` 调用成功（即本文件的创建）。因此先前失败很可能是**特定模型路由下的工具参数序列化问题**，而非 DSH 运行时缺陷。这一点仍需在新会话中确认，不要直接下结论。
- 新会话正确做法：**首次写入必须完全省略这两个字段**。若再次被强制出现，优先对比模型路由/profile 配置，不要填假值，也不要把责任推给用户。

## 6. 团队任务板现状

- task-22 新 Coder：in_progress（owner fresh-coder），**HOLD**，无产出文件。
- task-23 浏览器验收：in_progress（owner fresh-browser），仅有上述两个草稿。
- task-24 受绑定执行桥接：in_progress（owner fresh-bridge），仅改了 `coder_broker.py` 的 docstring 与 import（无功能实现）。
- task-25 真实模型：in_progress（owner fresh-model），**HOLD**，无产出。
- task-26：Lead 记录的工具接口阻塞诊断，**不是修复**。
- 新会话中这些 teammate 是否仍可用取决于新会话；**不要假设**它们保留上下文，任务板描述是唯一持久依据。

## 7. 建议的新会话执行顺序

1. 先做一次**最小原生写入自测**（省略权限字段，写一个临时文件），确认工具链正常；不正常就先修工具配置，不要再开始部署。
2. 重写 `scripts/dev/fresh-coder.py`：先 `inspect`/`plan` 纯只读子命令，确认端口 19443 空闲、Compose 项目名/卷名无冲突，再 `all` 执行；执行前核对 Docker 状态与镜像已存在（离线或已缓存）。
3. 生成 Coder manifest 后，先跑 `scripts/dev/preview.mjs` 的 `prepare` 逻辑公证新 DSH 根（**不要**用默认 `.preview/agent-studio`，那是受保护历史预览）。
4. 接 transport（task-24）→ 真实模型（task-25）→ 浏览器验收（task-23）。
5. 每一步用真实退出码/HTTP 状态/截图取证；不把离线测试当验收。

## 8. 必须继续遵守的红线

- 不碰 `http://10.147.18.50:3080` 及其进程/配置。
- 不碰保护 fixture job `bash-0c433b0240bd4b7c`（不查询、不 collect、不 kill）。
- 不影响既有 coder-lab 容器、历史工作区容器、其他应用。
- 不输出任何 token、cookie、登录 URL、密钥、整份凭据文件。
- 不创建非 DSH subagent、不调用 OpenCode 等外部代理。
- 不使用 `sandbox_permissions`/`justification`/审批相关字段；真实策略拒绝立即停。
