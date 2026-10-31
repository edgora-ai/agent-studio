"""Archive reviewed, non-secret T-105 evidence without overwriting historical files.

All input reports must be inside this checkout's ignored artifacts directory.
This records implementation status only; an independent verifier owns acceptance.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
spec = importlib.util.spec_from_file_location('t105_record_lab', SCRIPTS / 'coder_lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_evidence(path):
    path = Path(path).resolve(strict=True)
    if not path.is_relative_to(ROOT / 'artifacts/m1'):
        raise ValueError('Evidence input must be inside the dedicated artifacts tree')
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'result': json.loads(path.read_text())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--checks', required=True)
    parser.add_argument('--audit', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    runtime = read_evidence(args.runtime)
    checks = read_evidence(args.checks)
    audit = read_evidence(args.audit)
    result = runtime['result']
    if result['status'] != 'awaiting-independent-verification' or not all(c['accepted'] for c in result['cases']):
        raise ValueError('Runtime evidence is not ready for independent verification')
    if not audit['result']['passed'] or any(c['exitCode'] != 0 for c in checks['result']['commands']):
        raise ValueError('Regression or resource-audit checks did not pass')
    for name, expected in result['sources'].items():
        if sha(ROOT / name) != expected:
            raise ValueError('Runtime source fingerprint is stale: ' + name)
    for name, expected in checks['result'].get('sourceSha256', {}).items():
        if sha(ROOT / name) != expected:
            raise ValueError('Regression source fingerprint is stale: ' + name)
    selected_sources = ['t105_connection.py', 't105_remote_gate.py', 't105_candidate.mjs', 't105_cleanup.py',
                        'test_t105_connection.py', 'record_t105.py', 'ssh_remote_entry.mjs', 'network_guard.mjs',
                        'coder_lab.py', 'coder_template.py', 'audit_coder_lab.py']
    official = ROOT / 'artifacts/m1/t105/official-source-4bh0arur'
    official_sources = ['cli/configssh.go', 'cli/ssh.go', 'agent/agentssh/agentssh.go', 'agent/agent.go']
    record = {
        'task': 'T-105', 'status': 'in-progress-awaiting-independent-verification', 'stageM1Passed': False,
        't106Accepted': False, 'productScenariosPassed': [],
        'runtime': runtime, 'verification': checks, 'resourceAudit': audit,
        'sourceSha256': {str((SCRIPTS / n).relative_to(ROOT)): sha(SCRIPTS / n) for n in selected_sources},
        'officialSource': {'commit': '7ac93cffea828ca2d9514cfc6c0ad6337834aebe',
                           'sha256': {n: sha(official / n) for n in official_sources}},
        'connectionDesign': [
            '中央 OpenSSH 使用专用 -F 配置；ProxyCommand 由中央受限入口读取 runner 引用，以环境传入既有控制面容器内 /opt/coder。未给工作区 owner token。',
            'Coder CLI 与 Server 固定 v2.37.8+7ac93cf；canonical coder DNS 与专用 CA 在既有控制面内使用，宿主 DNS/hosts/全局 CA/SSH 配置未变。',
            '官方 config-ssh 默认 StrictHostKeyChecking=no；官方信任基础是 TLS 认证控制面、Agent 认证及按 platformAgentId 建立的 tailnet。该默认配置仅作已保存的对照，不直接启用。',
            '首次仅在官方认证通道上显式 accept-new 登记专用 known_hosts，读当前预置身份并前后重查 build；后续 strict=yes。真实目标切换触发 host-key 拒绝。主机密钥是附加连续性检查，不声称独立硬件证明。',
            '预期记录来自当前 API/build metadata，SQL 将 workspace_agents.resource_id 经 workspace_resources.job_id 关联当前 workspace_builds；Terraform agentResourceId 与 platformAgentId 分开。',
            '每次安装、连接及重连均在实际 SSH 命令进程内先只读观察 marker、UID、账号、canonical root 与 Coder channel workspace/name/owner/agent-name；中央再重查当前 build/agent，比较后发绑定观察摘要的 ACK。',
            '同一 SSH 远端进程第二次检查观察不变才 exec helper；此处不能重新解析别名或建立新通道。每次新调用都重新核验，不沿用上次通过缓存。未实现长期产品绑定或重建竞态全量验收。',
            '复用原字节 ssh_remote_entry.mjs 箭头入口；registerHooks 仅将该入口包名解析到固定候选，不修改 SDK、候选或 writable peer symlink。真实 fs/subprocess providers，没有伪造 provider。',
            'helper 安装真实写入专用 /tmp/t105-*/home；独立 Docker 全文件 SHA-256/字节数读回、release 按名检索以及真实 RPC version/capabilities/health 交叉验证。未执行 T-106 项目 FS/命令/PTY。',
            '真实 session/close ACK 与 Cordis disposer 各完成一次；另用原 helper 的认证 admin/shutdown 关闭该实验独有、默认会保留 600 秒的 daemon，独立查 /proc 确认无运行及未回收进程。保留部署文件与数据。',
        ],
        'negativeCoverage': ['wrong-workspace (actual m1-b transport)', 'wrong-account-and-UID (expected root/0 vs actual coder/1000)',
                             'wrong-root (actual /tmp canonical probe)', 'stale-generation', 'stale-current-build-record',
                             'actual alias transport switch after installer dispatch, before connector'],
        'limits': [
            '本项实现待独立复核；M1 未通过，T-106/T-107 与产品场景未验收。',
            'helper 返回 degraded：镜像缺 ripgrep；不修改 lab-v3 或安装依赖掩盖，不把返回 capabilities 当作 FS/命令/PTY/恢复验收。',
            '同 UID 可修改 marker、控制状态及项目；不是同 UID 防篡改、OS 沙箱、完整网络隔离或跨主机实验。工作区 PID/硬磁盘配额仍缺。',
            'Node --allow-child-process 产生 PERM0002；Node 写授权只覆盖 run root，23 项候选/peer直接与别名拒写及 JS 网络 guard 均实际检查，但子进程与管理 broker 仍有宿主管理权限。',
            '有界期限：身份读回25秒、远端ACK30秒、OpenSSH连接15秒、官方CLI90秒加5秒终止宽限、Node80秒；不是产品 NF-07 的最终窗口。',
            '继承的历史启动警告保留；本轮真实 host-key 负向测试造成 Agent SSH EOF warning，严格近期日志审计曾失败，已分类并在后续静默窗口重验，绝不声称整个运行历史零错误。',
            '首次代理使用 GNU timeout 选项被 BusyBox 拒绝；失败证据保留，改为已核对的 -s TERM -k 5 90 后重跑。',
            '未重建镜像/数据库/工作区，未创建第三工作区，未删除卷或持久数据，未调用模型API，未改生产profile/全局包，未提交/推送/发布。',
        ],
    }
    text = json.dumps(record, ensure_ascii=False, indent=2) + '\n'
    account = json.loads((lab.PRIVATE / 'account.json').read_text())
    secrets = [lab.token(), account['password']]
    if any(value and value in text for value in secrets) or re.search(r'-----BEGIN .*PRIVATE KEY-----', text):
        raise ValueError('Refusing secret-bearing evidence')
    output = Path(args.output).resolve()
    if output.parent != ROOT / 'docs/implementation/evidence' or output.suffix != '.json':
        raise ValueError('Choose a new JSON in docs/implementation/evidence')
    with output.open('x') as handle:
        handle.write(text)
    if json.loads(output.read_text()) != record:
        raise ValueError('Full evidence readback mismatch')
    # Direct readback plus task/case-name lookup, not merely writer return values.
    loaded = json.loads(output.read_text())
    if loaded['task'] != 'T-105' or {c['case'] for c in loaded['runtime']['result']['cases']} != {
            'wrong-workspace', 'wrong-account-uid', 'wrong-root', 'stale-generation', 'stale-build-record', 'channel-switch', 'positive'}:
        raise ValueError('Evidence retrieval is incomplete')
    print('PASS: T-105 evidence written, fully read back and retrieved by task/case; secrets scan passed')
    print('SHA256', sha(output))
    print('Evidence:', output)


if __name__ == '__main__':
    main()
