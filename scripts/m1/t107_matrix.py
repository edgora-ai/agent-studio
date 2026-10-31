"""Build an append-only, evidence-bound T-107 M1 investigation matrix (not acceptance)."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import tarfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
DSH = Path('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh')
SIDEBAR = Path('/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar')
CANDIDATE = ROOT / 'artifacts/m1/t103/fixture-9teakpr5/runtime/node_modules/dsh-ssh-remote'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads((ROOT / path).read_text())


def ref(path):
    path = Path(path)
    if not path.is_absolute():
        path = ROOT / path
    return {'path': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path), 'sha256': sha(path)}


def clauses():
    text = (ROOT / 'docs/05-delivery-and-acceptance.md').read_text().split('### M1：', 1)[1].split('### M2：', 1)[0]
    return [line[2:] for line in text.splitlines() if line.startswith('- ')]


def integrity():
    evidence = {}
    for line in (ROOT / 'docs/implementation/evidence/SHA256SUMS').read_text().splitlines():
        expected, path = line.split(maxsplit=1)
        assert sha(ROOT / path) == expected, path
        evidence[path] = expected
    inventory = read('docs/implementation/evidence/t101-installed-inventory.json')
    installed = []
    for package in inventory['packages']:
        label = package['label']
        base = DSH if label == 'dsh' else SIDEBAR if label == 'sidebar' else DSH / ('node_modules/@deepseek-ai/dsh-' + label)
        for f in package['files']:
            assert sha(base / f['path']) == f['sha256'], str(base / f['path'])
            installed.append({'package': label, **f})
    sources = {}
    for name, key in [('t103-isolation-correction.json', 'harnessSources'), ('t104-coder-lab.json', 'sources'),
                      ('t105-independent-acceptance-pass1.json', 'sourceSha256'), ('t106-independent-acceptance-review2.json', 'sourceSha256')]:
        values = read('docs/implementation/evidence/' + name)[key]
        if isinstance(values, list):
            values = {row['path']: row['sha256'] for row in values}
        for path, expected in values.items():
            assert sha(ROOT / path) == expected, path
            sources[path] = expected
    archive = ROOT / 'artifacts/m1/t103/downloads/asset-c__545n_/dsh-ssh-remote-0.13.3.tgz'
    assert sha(archive) == 'cab6fa53954dc1272dfde9ec8a8fd3928fd79232c78b658cb1b434fb0644b162'
    members = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            if member.isdir():
                continue
            path = PurePosixPath(member.name)
            assert member.isfile() and path.parts[0] == 'package' and '..' not in path.parts and not path.is_absolute()
            relative = str(PurePosixPath(*path.parts[1:]))
            data = tar.extractfile(member).read()
            assert len(data) <= 4 * 1024**2
            assert (CANDIDATE / relative).read_bytes() == data, relative
            members[relative] = hashlib.sha256(data).hexdigest()
    assert len(members) == 298
    assert set(members) == {str(p.relative_to(CANDIDATE)) for p in CANDIDATE.rglob('*') if p.is_file()}
    prior = read('docs/implementation/evidence/t106-independent-acceptance-review2.json')
    assert prior['gate'] == 'pass' and prior['t107Ready'] and not prior['stageM1Passed']
    references = [prior['fullDefaultRun'][key] for key in ('result', 'candidate')]
    references += [prior['trust']['baseline'], prior['finalResources']['evidence']]
    t104 = read('docs/implementation/evidence/t104-coder-lab.json')
    references += [{k: row[k] for k in ('path', 'sha256')} for row in t104['reports'].values()]
    for row in references:
        assert sha(ROOT / row['path']) == row['sha256'], row['path']
    spec = importlib.util.spec_from_file_location('t107_verified_tool', SCRIPTS / 't106_tools.py')
    tools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tools)
    tool = tools.verify_cached(ROOT / 'artifacts/m1/t106/tools-rg14-3211d20ec95e/manifest.json')
    return {'permanentEvidence': evidence, 'installedFiles': installed, 'unchangedSources': sources,
            'candidateArchive': ref(archive), 'candidateFiles': members, 'reusedRuntimeReferences': references,
            'privateTool': tool, 'historicalRuntimeRerun': False}


def versions():
    result = {}
    for name, path, scope in [('dsh', DSH, 'rc.4 isolated service/profile and helper combination; no product session'),
                             ('sidebar', SIDEBAR, 'static inventory + T-107 selected actual routes/client callbacks; not full UI'),
                             ('candidate', CANDIDATE, '0.13.3 explicit entry + raw helper client; native entry disabled')]:
        package = json.loads((path / 'package.json').read_text())
        result[name] = {k: package.get(k) for k in ('name', 'version', 'repository', 'engines', 'peerDependencies')}
        result[name].update(packageFile=ref(path / 'package.json'), runtimeScope=scope)
    metadata = read('docs/implementation/evidence/t101-candidate-metadata.json')['sshRemote']
    result['candidate'].update(manifestDshVersions=metadata['manifestDshVersions'], manifestDoesNotEnumerateRc4=True,
                               peerRange=metadata['dshPeerRange'], source=metadata['versions'][1],
                               interpretation='Manifest omission is not incompatibility; installed rc.4 combination tested with explicit entry only.')
    deployed = read('docs/implementation/evidence/t104-coder-lab.json')['deployment']
    result['helper'] = {'version': '0.13.1', 'bytes': 217238, 'sha256': 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f', 'source': 'candidate loadHelperAsset bundle; three Python source modules, not bare helper.py'}
    result['coderCLI'] = {'version': '2.37.8', 'source': 'official CLI in pinned Coder container, accepted T-105 official connection evidence'}
    result['coderServer'] = {'version': 'v2.37.8+7ac93cf', 'source': deployed['coderImage']}
    result['templateImage'] = {**deployed, 'templateName': 'lab-v3', 'policyVersion': 'lab-v1', 'builtWorkspaceImageNotDockerfileBase': True,
                               'sourceFiles': [ref('infra/coder-lab/template/main.tf'), ref('infra/coder-lab/Dockerfile.workspace')]}
    result['privateRg'] = {'version': 'ripgrep 14.1.0', 'packageVersion': '14.1.0-1', 'architecture': 'arm64',
                           'source': 'https://ports.ubuntu.com/ubuntu-ports/pool/universe/r/rust-ripgrep/ripgrep_14.1.0-1_arm64.deb',
                           'packageSha256': '71fe8a5667bc87d2bca175a3426c6ec518e0679cc821d23ae7056de7096f04de',
                           'binarySha256': '51407f46525cf368f99011044fae7aa00912dce6467731f97bb7cf423e2bd702', 'binaryBytes': 4917680,
                           'scope': 'per-run T-105 helper HOME only; accepted T-106 runtime reused; not installed by T-107; frozen image still lacks rg'}
    return result


def build(runtime, entrypoints):
    runtime = Path(runtime).resolve()
    entrypoints = Path(entrypoints).resolve()
    assert runtime.is_relative_to(ROOT / 'artifacts/m1/t107') and entrypoints.is_relative_to(ROOT / 'artifacts/m1/t107')
    rr = json.loads((runtime / 'result.json').read_text())
    ep = json.loads((entrypoints / 'entrypoints.json').read_text())
    assert not rr['failures'] and rr['probe']['probePassed'] and ep['probePassed']
    trusted = integrity()
    v = versions()
    predecessor = read('docs/implementation/evidence/t106-independent-acceptance-review2.json')
    t106 = read(predecessor['fullDefaultRun']['candidate']['path'])
    evidence = {name: ref('docs/implementation/evidence/' + name + '.json') for name in [
        't101-installed-inventory', 't101-candidate-metadata', 't103-isolation-correction', 't104-coder-lab',
        't105-independent-acceptance-pass1', 't106-independent-acceptance-review2']}
    evidence.update(capacity=ref(runtime / 'result.json'), entrypoints=ref(entrypoints / 'entrypoints.json'))
    definitions = [
        ('pass', ['t101-installed-inventory', 't101-candidate-metadata', 't103-isolation-correction'],
         'Manifest, peers and installed versions distinguished; rc.4 profile/service combination genuinely loaded in isolated T-103; no automatic upgrade.',
         ['Full sidebar/main-session end-to-end combination not claimed; selected installed sidebar/Host code now exercised.'], [], []),
        ('pass', list(evidence)[:6], 'All requested components pinned with provenance, versions and hashes; runtime versus static scope explicit.',
         ['Sidebar full UI static-only apart from selected T-107 entrypoints; production compatibility not inferred.'], [], []),
        ('pass', ['t101-candidate-metadata', 't103-isolation-correction'], 'GitHub CrazyShout release, manifest/assets and 298 installed bytes checked; not npm homonym.', [], [], []),
        ('pass', ['t104-coder-lab', 't105-independent-acceptance-pass1'], 'Frozen lab-v3 contract and SC-17 laboratory delivery probes passed: two independent records, version/root admission negatives, missing/forged-record rejection.',
         ['Only declared lab policy, not full FR-08/NF-02 isolation acceptance.', 'UID1000-owned marker can be changed by same UID; trust also requires current API/DB and same authenticated channel.',
          'No workspace PID/hard-disk quota; writable rootfs; internal bridge is not complete isolation; approved-old-version check is offline, not deployed rollback.'], [], ['U-03']),
        ('fail', ['capacity', 't106-independent-acceptance-review2'], 'Small capacity/timeout probes and replay refusal pass; NF-07 cannot be closed: no usable provider recovery window or task/approval policy default.',
         ['600-second helper retention/journal mechanism is not proven provider recovery.', 'Full SC-06, SC-14 reconnect/cursor recovery and M3 capacity/network validation not executed.',
          'Do not infer product task cancellation from request timeout.'], ['B-01'], ['U-01']),
        ('pass', ['t103-isolation-correction', 'capacity', 'entrypoints'], 'All probes use fresh ignored fixtures and existing lab instances; no production profile, dependency, template/image or persistent-data changes.',
         ['Node child-process permission/network hooks are not an OS security sandbox.'], [], []),
        ('pass', ['t105-independent-acceptance-pass1', 't106-independent-acceptance-review2', 'capacity'], 'Official Coder alias -> strict OpenSSH -> explicit candidate -> real helper; current same-channel gates reused and observed.', [], [], []),
        ('pass', ['t104-coder-lab', 't105-independent-acceptance-pass1', 'capacity'], 'Build records predate project access; independent API/DB relationship, marker/UID/root and current-channel ACK verified; wrong workspace/account/root/stale generation rejected.',
         ['A writable marker alone is not authentication; no same-connection random-write self-proof.'], [], []),
        ('pass', ['t106-independent-acceptance-review2', 'capacity'], 'Independent random bytes, argv/cwd/env command, real PTY input/resize/signals, group cancellation and no-central-fallback accepted for enabled raw helper channel.',
         ['Native spawn manages local SSH lifecycle and remains adapter-rejected; not a second accepted execution channel.', 'No product session or reconnect/PTY replay claim.', 'Git filename, private-rg non-Git filename and explicit-command content evidence remain separate.'], [], []),
        ('fail', ['entrypoints'], 'M1 technical probes executed; actual local opener/scheme/shortcut actions observed, but SC-16 remote rejection condition is not met by installed entrypoints.',
         ['Synthetic remote session/empty anchor; actual registered callbacks, no real DOM key event or product binding storage.', 'OS actions captured by harmless executable/action seams; no native desktop opened.',
          'Sidebar full DOM and actual production remote-bound session are not-run, not replaced with an always-deny wrapper.'], ['B-02'], ['U-02']),
        ('pass', ['capacity', 'entrypoints', 't106-independent-acceptance-review2'], 'Interface coverage, channel boundaries, deficiencies and bounded unblock tasks delivered for independent gate review.',
         ['Recommendation only: adapt explicit helper/Host routes; do not replace/upgrade core without a specific demonstrated incompatibility.', 'T-201 remains blocked; no M1 self-signoff.'], [], []),
    ]
    gates = []
    for index, (status, refs, outcome, limits, blockers, unblock) in enumerate(definitions):
        gates.append({'id': f'M1-{index+1:02}', 'clause': clauses()[index], 'spec': f'docs/05-delivery-and-acceptance.md:{26+index}',
                      'status': status, 'outcome': outcome, 'evidence': [evidence[k] for k in refs],
                      'versionRefs': list(v), 'sourceHashRef': 'integrity.unchangedSources / integrity.installedFiles / sourceSha256',
                      'enabledChannelsRef': 'channels', 'limitations': limits, 'blockerIds': blockers, 'smallestUnblockActionIds': unblock})
    helper = CANDIDATE / 'helper/dsh_remote_helper.py'
    capabilities = [
        {'id': 'CH-FS', 'status': 'pass', 'enabled': True, 'scope': 'experiment only', 'channel': 'BoundProvider raw helper FS', 'evidence': [evidence['capacity'], evidence['t106-independent-acceptance-review2']]},
        {'id': 'CH-EXEC-PTY', 'status': 'pass', 'enabled': True, 'scope': 'experiment only', 'channel': 'raw helper process/start+read/write/resize/signal/terminate/release', 'evidence': [evidence['t106-independent-acceptance-review2']]},
        {'id': 'CH-GIT-NAMES', 'status': 'pass', 'enabled': True, 'scope': 'Git discovery only', 'channel': 'raw helper fs/discover*', 'evidence': [evidence['capacity']]},
        {'id': 'CH-RG-NAMES', 'status': 'pass', 'enabled': 'conditional-private-tool', 'scope': 'per-run private verified rg, not frozen image', 'evidence': [evidence['t106-independent-acceptance-review2']]},
        {'id': 'CH-RG-CONTENT', 'status': 'pass', 'enabled': 'conditional-explicit-command', 'scope': 'rg --json through bound command, not product search', 'evidence': [evidence['t106-independent-acceptance-review2']]},
        {'id': 'CH-NATIVE-SPAWN', 'status': 'pass', 'enabled': False, 'meaning': 'Executable rejection through BoundProvider.compatibility only; native implementation still only controls local SSH.', 'evidence': [evidence['capacity']]},
        {'id': 'CH-MUTATION-REPLAY', 'status': 'pass', 'enabled': False, 'meaning': 'Executable same-operation duplicate and post-unknown mutation guards; raw session never reacquired. No product-wide bypass guarantee.', 'evidence': [evidence['t106-independent-acceptance-review2'], evidence['capacity']]},
        {'id': 'CH-RECOVERY', 'status': 'fail', 'enabled': False, 'meaning': 'Adapter refuses; original-task requery/cancel after reconnect not implemented. Refusal is fail-safe, not P0 recovery pass.', 'evidence': [evidence['capacity']]},
        {'id': 'CH-PRODUCT-SEARCH', 'status': 'not-run', 'enabled': False, 'meaning': 'Adapter refuses product-content-search; main session/sidebar integration belongs to M2.'},
        {'id': 'CH-HOST-BYPASS', 'status': 'fail', 'enabled': 'installed code exists; not enabled as supported remote capability', 'meaning': 'EP-01..EP-05 dispatch local/scheme actions. Compatibility guard cannot cover independent Host routes.', 'evidence': [evidence['entrypoints']]},
    ]
    timeouts = [
        {'id': 'TIME-IDENTITY', 'defaultMs': 25000, 'maximumMs': 25000, 'owner': 't105_connection.py read_frame', 'afterTimeout': 'identity gate rejected before project dispatch', 'validation': 'accepted T-105 runtime reused'},
        {'id': 'TIME-ACK', 'defaultMs': 30000, 'maximumMs': 30000, 'owner': 't105_remote_gate.py', 'afterTimeout': 'gate exits without helper exec', 'validation': 'accepted real missing-ACK timeout'},
        {'id': 'TIME-SSH', 'defaultMs': 15000, 'maximumMs': 15000, 'owner': 't105 dedicated SSH ConnectTimeout', 'afterTimeout': 'connection unavailable; no fallback'},
        {'id': 'TIME-CLI', 'defaultMs': 90000, 'maximumMs': 95000, 'owner': 't105 official CLI process + 5000ms termination grace', 'afterTimeout': 'reject/owned transport termination; not proof remote task cancelled'},
        {'id': 'TIME-RPC', 'defaultMs': 5000, 'maximumMs': 10000, 'owner': 'BoundProvider.call', 'afterTimeout': 'RemoteHelperCallInterruptedError; mutationMayHaveStarted fences later mutations if true', 'sample': '40ms read timeout; underlying task still running; CAP-TIMEOUT'},
        {'id': 'TIME-START', 'defaultMs': 8000, 'maximumMs': 8000, 'owner': 'BoundWorkspace.start', 'afterTimeout': 'may have started -> unknown, no redispatch'},
        {'id': 'TIME-TASK-WAIT', 'defaultMs': 8000, 'maximumMs': None, 'owner': 'RemoteProcess.until caller; not a validated product task deadline', 'afterTimeout': 'T106_PROCESS_DEADLINE; task not auto-terminated', 'sample': '40ms caller wait overshoots to next 100ms process-read completion; explicit terminate required'},
        {'id': 'TIME-DISCOVERY', 'defaultMs': 18000, 'maximumMs': 18000, 'owner': 'BoundWorkspace.discover; helper scan deadline 15000ms', 'afterTimeout': 'discovery close in finally; scan errors/complete flags remain meaningful'},
        {'id': 'TIME-CANCEL', 'defaultMs': None, 'maximumMs': None, 'owner': 'RemoteProcess.terminate', 'phasesMs': {'termGrace': 1500, 'statusPollBudget': 3000, 'exitOutputWait': 5000, 'perRpcDefault': 5000}, 'afterTimeout': 'cancellation unconfirmed; sum is not a measured atomic hard deadline'},
        {'id': 'TIME-RELEASE', 'defaultMs': 8000, 'maximumMs': 8000, 'owner': 'RemoteProcess.release', 'afterTimeout': 'cleanup unconfirmed'},
        {'id': 'TIME-PRODUCT-TASK', 'defaultMs': None, 'status': 'not-run', 'owner': 'not implemented; bounded U-01 contract needed', 'afterTimeout': 'not specified'},
        {'id': 'TIME-APPROVAL', 'defaultMs': None, 'status': 'not-run', 'owner': 'T-206/T-303 product policy not implemented; M1 initial policy unresolved', 'afterTimeout': 'not specified; do not invent auto-approval'},
    ]
    recovery = {'providerWindowMs': None, 'providerStatus': 'fail', 'reason': 'No reconnect/requery implementation in enabled BoundProvider; compatibility(recovery) rejects.',
                'helperMechanism': {'defaultRetentionMs': 600000, 'configClampMs': [30000, 3600000], 'configOwner': 'daemon initialize retentionMs',
                                    'source': ref(helper), 'sourceLines': [457, 1996, 1997, 2021], 'validation': 'static mechanism, not accepted window'},
                'dedupJournal': {'minimumRetentionMs': 600000, 'formula': 'max(session retentionMs,600000)', 'maxOperations': 4096,
                                 'storage': 'in-memory per-session operations and locks; not a durable database', 'sourceLines': [521, 545],
                                 'restartLossOrExpirySafetyTested': False, 'notProviderRecoveryWindow': True},
                'mutationReplayEnabled': False, 'protocolFaultMatrix': {'status': 'not-run', 'reason': 'No replay operation proposed for enablement; ACK/dedup-log-expiry/restart/generation suite mandatory before enabling.'},
                'acceptedFailSafeEvidence': predecessor['fullDefaultRun']['candidate'],
                'acceptedFaultFacts': next(c['facts'] for c in t106['cases'] if c['case'].startswith('E-'))}
    capacities = {'directory': {'adapterLimit': 1000, 'helperEntryLimit': 1000, 'helperScanLimit': 100000, 'pagination': False,
                               'sample': '3 entries with request limits 2/3/4, explicit truncation and E_TOO_LARGE; maximum 1000 is not load-tested', 'cancellation': 'no list cancel API; bounded RPC timeout only'},
                  'file': {'adapterInlineWrite': 65536, 'adapterInlineRead': 196608, 'adapterLargeFile': 6291456, 'helperInlineRead': 524288, 'helperFile': 67108864, 'helperChunk': 262144,
                           'sample': '65535/65536 accepted,65537 rejected pre-dispatch; read max32 at31/32/33; readRange EOF/version across boundary'},
                  'search': {'adapterEntries': 1000, 'helperPageEntries': 500, 'helperEntries': 50000, 'helperPathBytes': 8388608, 'helperPageBytes': 131072, 'helperDeadlineMs': 15000,
                             'sample': '10 Git entries across pages of2; request501 rejected; close acknowledged. Immediate close is not guaranteed mid-scan cancellation.',
                             'content': 'private-rg exact match/no-match from T-106 only; product search disabled; no fabricated content-pagination pass'},
                  'output': {'adapterBytes': 131072, 'helperRingBytes': 2097152, 'readRequestBytes': 65536, 'stdinBytes': 65536,
                             'sample': '131071/131072 complete,131073 throws T106_OUTPUT_LIMIT; actual ring eviction not-run',
                             'semantics': 'adapter accumulates received page before checking cap, so transient storage can exceed cap by a bounded page; exception is not task cancellation'},
                  'maximumCapacityLoadTests': 'not-run; explicitly forbidden broad load/OOM/stress; small real request-limit samples only'}
    blockers = [
        {'id': 'B-01', 'gate': 'M1-05', 'severity': 'full-M1/P0-foundation', 'reason': 'NF-07 recovery window has no provider implementation; product task/approval initial policy missing. 0/disabled is not a passed window.', 'unblock': 'U-01'},
        {'id': 'B-02', 'gate': 'M1-10', 'severity': 'SC-16 routing safety', 'reason': 'Actual installed opener/Host scheme/shortcut entrypoints dispatch on central anchor or browser instead of remote-bound rejection.', 'unblock': 'U-02'},
    ]
    unblock = [
        {'id': 'U-01', 'scope': 'M1 technical recovery/deadline contract, not full T-201/T-206 implementation or mutation replay',
         'inputs': ['frozen helper session retention and task identities', 'accepted T-106 unknown-outcome evidence', 'NF-07 and SC-06'],
         'codeSurface': ['new experimental recovery adapter/probe beside frozen T-106, only after coordinator approval', 'explicit task/approval timeout ownership and state contract'],
         'acceptanceCommands': ['node --test scripts/m1/t107_recovery.test.mjs', 'python3 -I scripts/m1/t107_recovery.py --case within-window --window-from-helper'],
         'acceptanceCriteria': ['same healthy instance, saved original task identity, disconnect/reconnect inside declared window -> requery then cancel original task; independent PID/startTick and side-effect count',
                                'outside window -> unknown; no new mutation, no automatic replay', 'bounded task wait and approval timeout policy has actual tested owner/transition; no invented latency SLA'],
         'resourceImpact': 'one owned bounded process and current per-run helper on m1-a; no restart of workspace/control-plane; if architecture requires daemon restart or frozen-source change, report before proceeding', 'executed': False},
        {'id': 'U-02', 'scope': 'M1 minimal executable remote-mode deny seam; full binding persistence/sidebar adaptation remains T-201/T-205',
         'inputs': ['EP-01..EP-06 actual route/callback evidence', 'server-authoritative remote-context lookup contract'],
         'codeSurface': ['isolated host registration wrapper for sidebar open.external and host open-in-app routes', 'Host API desktop mapping boundary', 'client URL branch and registered workspace.openLocal command'],
         'acceptanceCommands': ['python3 -I scripts/m1/t107_run.py entrypoints', 'node --test scripts/m1/t107_remote_opener_guard.test.mjs'],
         'acceptanceCriteria': ['actual installed entrypoints with verified remote-context seam reject valid paths/schemes and central empty anchors, with zero recorder actions', 'local positive control still dispatches; bypass direct route/API rejected; no always-deny fixture'],
         'resourceImpact': 'local synthetic fixture only; no production profile/global package edits; coordinator must authorize any new wrapper implementation', 'executed': False},
        {'id': 'U-03', 'scope': 'known P0 deployment-policy gap; lab SC-17 delivery pass does not satisfy future FR-08/NF-02',
         'inputs': ['lab-v3 contract', 'workspace PID/disk policy requirements and preservation plan', 'private rg provenance'],
         'codeSurface': ['new explicitly approved template/image version, not frozen lab-v3', 'PID/storage resource policy and verified rg deployment'],
         'acceptanceCommands': ['python3 -I scripts/m1/test_coder_contract.py', 'python3 -I scripts/m1/coder_template.py verify', 'python3 -I scripts/m1/t107_policy_probe.py --small-fixture'],
         'acceptanceCriteria': ['agree explicit policy, pin new image/template, verify quotas with bounded samples and rg health; independently read identities before access', 'retain all existing volumes, old template and existing workspaces; do not silently rebuild'],
         'resourceImpact': 'requires infrastructure scope approval; may require replacement workspace/image and quota-capable storage; no such changes made', 'executed': False},
    ]
    value = {'schemaVersion': 1, 'task': 'T-107', 'role': 'implementation-and-gate-investigation', 'recordedOn': '2026-10-30',
             'gate': 'blocked-awaiting-independent-review', 'm1Passed': False, 't201Ready': False, 'independentAcceptance': False,
             'gates': gates, 'versions': v, 'channels': capabilities, 'timeouts': timeouts, 'recovery': recovery, 'capacity': capacities,
             'blockers': blockers, 'unblockTasks': unblock,
             'unblockCommandStatus': 'Future acceptance commands, not executed: recovery/guard/policy probe filenames are proposed task deliverables and do not yet exist. Existing entrypoint probe only diagnoses the current failure.',
             'futureStageLimits': ['M2 full main-session/provider/sidebar/CLI-interaction integration not implemented.', 'M3 cross-host/isolation/restart/mobile/recovery scenario matrices not executed.', 'M4 upgrade/rollback and release not executed.'],
             'knownGapClassification': {'missingRg': 'Not a failure of M1-07 connectivity or conditional M1-09 helper probes. Frozen image/product search remains unsupported; private tool is experimental only.',
                                        'nativeSpawn': 'Not required as a second enabled channel; rejection tested at adapter boundary. Independent product bypasses are not covered by that rejection.',
                                        'templateIsolation': 'M1-04 lab contract and SC-17 delivery passed, not full production isolation. Missing PID/disk limits remain explicitly unmet P0 deployment-policy capability; U-03 needs scope approval before a production-capable matrix.',
                                        'recovery': 'Positive provider window required by M1-05; not postponed wholesale to M3 or passed by disabling.',
                                        'opener': 'Technical inspection ran; safety fail on actual code. Full UI integration is M2, but no remote-supported combination released while bypass observed.'},
             'newRuntime': {'capacity': rr, 'entrypoints': ep}, 'integrity': trusted,
             'sourceSha256': {str(p.relative_to(ROOT)): sha(p) for p in sorted(SCRIPTS.glob('t107_*')) if p.is_file()},
             'evidence': evidence,
             'history': {'allPriorEvidencePreserved': True, 't107Attempts': [ref(p) for p in sorted((ROOT / 'artifacts/m1/t107').glob('entrypoints-*/command.json'))],
                         'initialCapacityRun': ref('artifacts/m1/t107/run-dd205de79ced5eee393847de/result.json'),
                         'initialCapacityErrata': 'First run correctly advertised helper output limit2097152 but prose mistakenly said8MiB; final source and matrix use2MiB. FirstToCompleteMs included later search/close work; final probe records firstResultMs/scanCompleteMs separately. Old JSON unchanged.'}}
    validate(value)
    return value


def validate(value):
    assert value['task'] == 'T-107' and value['schemaVersion'] == 1
    assert [g['id'] for g in value['gates']] == [f'M1-{i:02}' for i in range(1, 12)]
    assert [g['clause'] for g in value['gates']] == clauses()
    statuses = {'pass', 'fail', 'not-run'}
    for gate in value['gates']:
        assert gate['status'] in statuses
        assert gate['evidence'] and gate['versionRefs'] and gate['sourceHashRef']
        if gate['status'] != 'pass':
            assert gate['blockerIds'] and gate['smallestUnblockActionIds']
        for item in gate['evidence']:
            assert sha(ROOT / item['path']) == item['sha256']
    assert not value['independentAcceptance'] and not value['m1Passed'] and not value['t201Ready']
    assert value['recovery']['providerWindowMs'] is None and value['recovery']['providerStatus'] == 'fail'
    assert not value['recovery']['mutationReplayEnabled']
    assert value['capacity']['output']['helperRingBytes'] == 2097152
    assert value['newRuntime']['capacity']['probe']['helper']['limits']['maxProcessOutputBytes'] == 2097152
    assert {g['id'] for g in value['gates'] if g['status'] == 'fail'} == {'M1-05', 'M1-10'}
    assert {b['id'] for b in value['blockers']} == {'B-01', 'B-02'}
    assert all(not row['executed'] for row in value['unblockTasks'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--entrypoints', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    value = build(args.runtime, args.entrypoints)
    output = args.output.resolve()
    assert output.parent == ROOT / 'docs/implementation' and output.name.startswith('t107-') and output.suffix == '.json'
    with output.open('x') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    actual = json.loads(output.read_text())
    assert actual == value
    validate(actual)
    index = {gate['id']: gate for gate in actual['gates']}
    assert len(index) == 11 and index['M1-05']['status'] == 'fail' and index['M1-10']['status'] == 'fail'
    print(json.dumps({'path': str(output), 'sha256': sha(output), 'gateCount': len(index), 'failures': [k for k, v in index.items() if v['status'] == 'fail'], 't201Ready': actual['t201Ready']}))
