# 前期调研档案

归档日期：2026-10-29。研究时间范围：本次 Agent Studio 立项前后的调研与本机容器实验。本文保存历史依据，不表示重新核对了上游现状或重新执行了实验。

## 如何使用

- 当前产品范围、路由规则与验收要求，以上一级的需求、架构、集成及验收文档为准。本档案不是另一份实施规范。
- 原始研究曾比较并推荐过“远端完整 dsh worker”的方案 B。该建议已被用户否决；本项目只采用中央 dsh 的方案 A。保留旧材料是为了记录推理过程，不是重新开放方案 B。
- 社区项目的版本、许可证、主分支内容和商业版边界均是当时的观察。实施前必须重新锁定来源、提交、版本和许可；历史的声明范围不等于安装兼容。
- 证据分为：外部文档／发布元数据核对、源码／安装产物静态核对、真实执行实验。三者不可互相冒充。

## 主题材料

| 材料 | 保留内容 |
|---|---|
| [平台选型](01-platform-survey.md) | Coder、OpenSandbox、Daytona／Nightona，Linux 多主机与 K8s 边界、开源和付费限制 |
| [社区插件与 dsh 契约](02-plugin-and-runtime-survey.md) | 两款远程插件、同名 npm 来源问题、Cordis 服务解析、侧边栏及 ACP／SDK 接口边界 |
| [远程 IDE 与方案演进](03-ide-and-decisions.md) | VS Code 远程扩展原理、code-server 限制、方案 A/B 的取舍、移动端目标 |
| [本机容器实验](04-container-experiment.md) | 已运行原型的实际能力、隔离边界、已知问题及可读回证据 |

## 原始材料与快照

下列文件已经实际复制到本项目，不只保留了外部路径：

| 文件 | 原始来源与含义 |
|---|---|
| [历史研究摘录](evidence/historical-research-excerpts.txt) | 从本次会话的结构化记录提取六段研究报告／回答；包含已否决的方案 B 建议，文件首部有历史材料警告 |
| [原型说明快照](evidence/prototype-readme.txt) | `~/.dsh/sandboxes/local-opencode/README.md` 的归档时快照；操作命令是历史说明，本轮没有执行 |
| [准备与配置读回](evidence/preparation.json) | 原型 `evidence/preparation.json`；只含验证结果、版本／哈希和代理配置名称，无密钥值 |
| [隔离测试报告](evidence/isolation.json) | 原型 `evidence/isolation.json`；15 项隔离检查及挂载、用户、资源事实 |
| [管理与回收报告](evidence/management.json) | 原型 `evidence/management.json`；列表、按 ID 停止、状态读回与清理 |
| [ACP 调用报告](evidence/acp-probe.json) | 原型 `evidence/acp-probe.json`；真实子代理调用的结果与耗时 |
| [配置组合报告](evidence/composition.json) | 原型 `evidence/composition.json`；provider 和工具实际插入组合的检查 |
| [真实 dsh 端到端报告](evidence/e2e-verification.json) | 原型 `evidence/e2e-verification.json`；工具事件、随机输出、容器状态及持久化检查 |
| [快照校验和](evidence/SHA256SUMS) | 上述八份快照的 SHA-256；路径相对项目根目录 |

在项目根目录验证归档文件完整性：

```bash
sha256sum --check docs/research/evidence/SHA256SUMS
python3 -I scripts/check_docs.py
python3 -I scripts/test_check_docs.py
```

哈希验证只证明归档文件与归档时内容一致，不等于重新证明报告中的运行结果。JSON 中的会话／任务 ID、随机 nonce 和测试路径是可追溯实验标识，不是访问凭据。

## 历史摘录的出处

原始会话记录位于 `~/.claude/projects/-home-ubuntu--dsh/77754e17-43e6-4071-ac54-50cda474566c.jsonl`。摘录选择的是归档时以下行中的文本字段，不是整份会话记录：

- 第 1744 行：dsh 源码／安装版兼容性研究报告。
- 第 1765 行：上述研究的收束说明。
- 第 1774 行：Coder／OpenSandbox 等平台对比及早期架构建议。
- 第 1932 行：社区远程工作区插件调查及复用方向修正。
- 第 1940 行：会话优先与移动端交互目标分析。
- 第 1951 行：中央维护、项目环境统一和隔离责任分析。

其中任务通知只提取结果正文；提取时对 URL 用户密码与常见密钥查询参数做过滤，未修改历史建议以伪装成今天的决定。行号仅用于定位这份历史记录，不能代替正文快照。外部来源链接保留在各主题材料中，本轮未下载网页镜像或第三方源代码包。

## 刻意没有归档的内容

不复制 `secrets/`、`.env`、OpenCode 完整账号配置、SSH 私钥、带登录 token 的 URL、真实用户项目代码、全部会话日志及全量基线会话清单。原型的镜像、二进制和程序脚本仍在原实验目录；此处是研究资料与报告快照，不是可独立部署的原型发行包。

当前项目入口见[项目 README](../../README.md)，正式集成方案见[集成方案](../04-integration-plan.md)。
