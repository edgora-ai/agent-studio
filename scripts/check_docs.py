#!/usr/bin/env python3
"""Check documentation structure, traceability and execution-task dependencies."""

import argparse
import collections
import json
import pathlib
import re
import sys
import urllib.parse

REQUIRED = (
    'README.md',
    'docs/01-product-requirements.md',
    'docs/02-features-and-scenarios.md',
    'docs/03-system-architecture.md',
    'docs/04-integration-plan.md',
    'docs/05-delivery-and-acceptance.md',
    'docs/06-decisions-and-risks.md',
    'docs/07-design-review.md',
    'docs/08-execution-plan.md',
)
LINK = re.compile(r'(?<!!)\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)')
PLACEHOLDER = re.compile(r'\b(?:TODO|FIXME|TBD)\b|\[待补充\]|\[To be written\]')
PHASE_TWO = 'FR-12'


def expected_ids(prefix, last):
    return {f'{prefix}-{number:02}' for number in range(1, last + 1)}


def check(root):
    errors = []
    documents = {}
    local_links = 0
    external_links = 0
    names = set(REQUIRED)
    names.update(path.relative_to(root).as_posix() for path in (root / 'docs').rglob('*.md') if path.is_file())
    for name in sorted(names):
        path = root / name
        if not path.is_file():
            errors.append(name + ': missing required document')
            continue
        text = path.read_text(encoding='utf-8')
        documents[name] = text
        if not text.startswith('# '):
            errors.append(name + ': missing top-level title')
        for line_number, line in enumerate(text.splitlines(), 1):
            if PLACEHOLDER.search(line):
                errors.append(f'{name}:{line_number}: unresolved placeholder')
            for match in LINK.finditer(line):
                raw = match.group(1)
                parsed = urllib.parse.urlsplit(raw)
                if parsed.scheme in ('http', 'https', 'mailto'):
                    external_links += 1
                    continue
                if parsed.scheme:
                    errors.append(f'{name}:{line_number}: unsupported local-link scheme')
                    continue
                if not parsed.path:
                    errors.append(f'{name}:{line_number}: anchor-only links are not checked by this tool')
                    continue
                target = (path.parent / urllib.parse.unquote(parsed.path)).resolve()
                if not target.is_relative_to(root):
                    errors.append(f'{name}:{line_number}: link escapes project root: {raw}')
                elif not target.exists():
                    errors.append(f'{name}:{line_number}: broken local link: {raw}')
                else:
                    local_links += 1

    prd = documents.get('docs/01-product-requirements.md', '')
    scenario_text = documents.get('docs/02-features-and-scenarios.md', '')
    acceptance = documents.get('docs/05-delivery-and-acceptance.md', '')
    requirements = re.findall(r'^\|\s*(FR-\d{2})\s*\|', prd, re.MULTILINE)
    nonfunctional = re.findall(r'^\|\s*(NF-\d{2})\s*\|', prd, re.MULTILINE)
    scenarios = re.findall(r'^##\s+(SC-\d{2})(?:[:：\s])', scenario_text, re.MULTILINE)
    expected_requirements = expected_ids('FR', 14)
    expected_nonfunctional = expected_ids('NF', 8)
    expected_scenarios = expected_ids('SC', 17)
    for kind, actual, expected in (
        ('requirement', requirements, expected_requirements),
        ('non-functional requirement', nonfunctional, expected_nonfunctional),
        ('scenario', scenarios, expected_scenarios),
    ):
        duplicates = [name for name, count in collections.Counter(actual).items() if count > 1]
        if duplicates:
            errors.append(f'duplicate {kind} definitions: {duplicates}')
        if set(actual) != expected:
            errors.append(f'{kind} definitions differ: missing={sorted(expected - set(actual))}, extra={sorted(set(actual) - expected)}')

    # 优先级与显式阶段清单比较；不猜测正文中的自然语言范围。
    priorities = {}
    for identifier, priority in re.findall(r'^\|\s*(FR-\d{2})\s*\|\s*([^|]+)\|', prd, re.MULTILINE):
        priorities[identifier] = priority.strip()
        if priority.strip() not in ('P0', 'P1', 'P2'):
            errors.append(f'{identifier}: invalid priority {priority.strip()!r}')
    for label, priority in (('第一阶段必需', 'P0'), ('第二阶段独立', 'P2')):
        declarations = re.findall(r'^\*\*' + label + r'：\*\*[ \t]*(.*)$', acceptance, re.MULTILINE)
        if len(declarations) != 1:
            errors.append(f'{label}: expected one phase declaration')
            continue
        refs = re.findall(r'FR-\d{2}', declarations[0])
        if len(refs) != len(set(refs)):
            errors.append(f'{label}: duplicate phase requirements')
        expected = {identifier for identifier, value in priorities.items() if value == priority}
        if set(refs) != expected:
            errors.append(f'{label}: phase declaration differs from {priority} requirements')
    if priorities.get(PHASE_TWO) != 'P2':
        errors.append('FR-12 must remain P2')

    for name, text in documents.items():
        for reference in set(re.findall(r'\bFR-\d{2}\b', text)):
            if reference not in expected_requirements:
                errors.append(f'{name}: undefined requirement {reference}')
        for reference in set(re.findall(r'\bNF-\d{2}\b', text)):
            if reference not in expected_nonfunctional:
                errors.append(f'{name}: undefined non-functional requirement {reference}')
        for reference in set(re.findall(r'\bSC-\d{2}\b', text)):
            if reference not in expected_scenarios:
                errors.append(f'{name}: undefined scenario {reference}')

    declared_pairs = set()
    sections = re.finditer(
        r'^##\s+(SC-\d{2})[^\n]*\n(.*?)(?=^##\s+SC-\d{2}|\Z)',
        scenario_text, re.MULTILINE | re.DOTALL,
    )
    for section in sections:
        scenario, body = section.groups()
        declaration = re.search(r'^\*\*需求：\*\*[ \t]*(.*)$', body, re.MULTILINE)
        refs = set(re.findall(r'FR-\d{2}', declaration.group(1))) if declaration else set()
        if not refs:
            errors.append(scenario + ': missing primary requirement declarations')
        declared_pairs.update((requirement, scenario) for requirement in refs)

    matrix_rows = re.findall(r'^\|\s*(FR-\d{2})\s*\|\s*([^|\n]+)\|', acceptance, re.MULTILINE)
    duplicates = [name for name, count in collections.Counter(row[0] for row in matrix_rows).items() if count > 1]
    if duplicates:
        errors.append(f'duplicate acceptance rows: {duplicates}')
    covered = set()
    matrix_scenarios = set()
    matrix_pairs = set()
    for requirement, cells in matrix_rows:
        refs = set(re.findall(r'SC-\d{2}', cells))
        if not refs:
            errors.append('acceptance matrix has no scenario for ' + requirement)
        covered.add(requirement)
        matrix_scenarios.update(refs)
        matrix_pairs.update((requirement, scenario) for scenario in refs)
    if covered != expected_requirements:
        errors.append('acceptance matrix does not cover all requirements')
    if matrix_scenarios != expected_scenarios:
        errors.append('acceptance matrix does not cover all scenarios')
    for requirement, scenario in sorted(declared_pairs - matrix_pairs):
        errors.append(f'acceptance matrix missing declared mapping {requirement} -> {scenario}')
    for requirement, scenario in sorted(matrix_pairs - declared_pairs):
        errors.append(f'acceptance matrix has undeclared mapping {requirement} -> {scenario}')
    phase_two = [cells for requirement, cells in matrix_rows if requirement == PHASE_TWO]
    if len(phase_two) != 1 or set(re.findall(r'SC-\d{2}', phase_two[0])) != {'SC-11'}:
        errors.append('phase-two requirement FR-12 must map to SC-11')

    for requirement, scenario in matrix_pairs:
        if priorities.get(requirement) == 'P0' and scenario == 'SC-11':
            errors.append(f'{requirement}: P0 requirement maps to phase-two SC-11')

    # NF 为单向分配：唯一行，且至少引用一个已定义的场景或检查项。
    nf_sections = re.findall(
        r'^##\s+\d+\.\s*非功能验证映射\n(.*?)(?=^##\s|\Z)', acceptance, re.MULTILINE | re.DOTALL,
    )
    nf_covered = set()
    checkpoints = []
    if len(nf_sections) == 1:
        section = nf_sections[0]
        checkpoints = re.findall(r'^-\s+\*\*(CK-\d{2})\*\*：[^\n]+', section, re.MULTILINE)
        duplicates = [name for name, count in collections.Counter(checkpoints).items() if count > 1]
        if duplicates:
            errors.append(f'duplicate checkpoint definitions: {duplicates}')
        if set(checkpoints) != expected_ids('CK', 3):
            errors.append('checkpoint definitions differ from CK-01 through CK-03')
        nf_rows = re.findall(r'^\|\s*(NF-\d{2})\s*\|\s*([^|\n]*)\|', section, re.MULTILINE)
        duplicates = [name for name, count in collections.Counter(row[0] for row in nf_rows).items() if count > 1]
        if duplicates:
            errors.append(f'duplicate non-functional mappings: {duplicates}')
        for requirement, cells in nf_rows:
            nf_covered.add(requirement)
            targets = re.findall(r'\b(?:SC|CK)-\d{2}\b', cells)
            if not targets:
                errors.append(f'{requirement}: non-functional mapping needs a scenario or checkpoint')
            for target in targets:
                if target not in set(scenarios) | set(checkpoints):
                    errors.append(f'non-functional mapping {requirement} references undefined target {target}')
    else:
        errors.append('missing or duplicate non-functional verification mapping section')
    if nf_covered != expected_nonfunctional:
        errors.append('non-functional mapping does not cover all NF requirements')

    # 任务表验证依赖结构，不把已定义或无环等同于运行任务已完成。
    plan = documents.get('docs/08-execution-plan.md', '')
    task_rows = re.findall(r'^\|\s*(T-\d{3})\s*\|([^\n]*)$', plan, re.MULTILINE)
    duplicates = [name for name, count in collections.Counter(row[0] for row in task_rows).items() if count > 1]
    if duplicates:
        errors.append(f'duplicate execution tasks: {duplicates}')
    if not task_rows:
        errors.append('execution plan has no task definitions')
    tasks = {}
    for identifier, row in task_rows:
        cells = [cell.strip() for cell in row.split('|')]
        if len(cells) != 5 or cells[-1]:
            errors.append(f'{identifier}: execution task needs five table columns')
            continue
        path, prerequisites, output, acceptance_targets = cells[:-1]
        if path not in {f'P-{letter}' for letter in 'ABCDEF'}:
            errors.append(f'{identifier}: invalid execution path {path!r}')
        phase = int(identifier[2])
        if phase not in range(1, 6):
            errors.append(f'{identifier}: task phase must be M1 through M5')
        if (path == 'P-F') != (phase == 5):
            errors.append(f'{identifier}: P-F is reserved for phase-two M5 tasks')
        dependencies = re.findall(r'\bT-\d{3}\b', prerequisites)
        if not dependencies and prerequisites != '无':
            errors.append(f'{identifier}: prerequisites must name tasks or be 无')
        if len(dependencies) != len(set(dependencies)):
            errors.append(f'{identifier}: duplicate task prerequisites')
        tasks[identifier] = set(dependencies)
        if not output:
            errors.append(f'{identifier}: task output must not be empty')
        targets = re.findall(r'\b(?:SC|CK)-\d{2}\b', acceptance_targets)
        if not targets:
            errors.append(f'{identifier}: task needs a scenario or checkpoint')
        for target in targets:
            if target not in set(scenarios) | set(checkpoints):
                errors.append(f'{identifier}: task references undefined acceptance target {target}')
    for name, text in documents.items():
        for reference in sorted(set(re.findall(r'\bT-\d{3}\b', text)) - set(tasks)):
            errors.append(f'{name}: undefined execution task {reference}')
    for identifier, dependencies in tasks.items():
        for dependency in sorted(dependencies):
            if dependency in tasks and dependency[2] > identifier[2]:
                errors.append(f'{identifier}: task depends on later milestone {dependency}')
    remaining = {identifier: dependencies & tasks.keys() for identifier, dependencies in tasks.items()}
    while remaining:
        ready = {identifier for identifier, dependencies in remaining.items() if not dependencies}
        if not ready:
            errors.append(f'execution plan has cyclic dependencies: {sorted(remaining)}')
            break
        for identifier in ready:
            del remaining[identifier]
        for dependencies in remaining.values():
            dependencies.difference_update(ready)

    return {
        'ok': not errors,
        'documents': len(documents),
        'requirements': len(requirements),
        'nonFunctional': len(nonfunctional),
        'scenarios': len(scenarios),
        'acceptanceRows': len(matrix_rows),
        'declaredMappings': len(declared_pairs),
        'acceptanceMappings': len(matrix_pairs),
        'nonFunctionalMappings': len(nf_covered),
        'checkpoints': len(set(checkpoints)),
        'executionTasks': len(tasks),
        'localLinks': local_links,
        'externalLinksNotFetched': external_links,
        'errors': errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument('--json', action='store_true', help='Print a machine-readable result')
    args = parser.parse_args()
    result = check(args.root.resolve())
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result['ok']:
        print(f"PASS: {result['documents']} documents, {result['requirements']} requirements, "
              f"{result['nonFunctional']} non-functional requirements, {result['scenarios']} scenarios, "
              f"{result['acceptanceRows']} acceptance rows, {result['localLinks']} local links")
        print(f"Mappings: {result['declaredMappings']} declared, {result['acceptanceMappings']} in matrix; "
              f"{result['nonFunctionalMappings']} non-functional mappings, {result['checkpoints']} checkpoints")
        print(f"Execution plan: {result['executionTasks']} tasks; dependencies and phase boundaries checked")
        print(f"External links counted, not re-fetched: {result['externalLinksNotFetched']}")
    else:
        for error in result['errors']:
            print('FAIL: ' + error, file=sys.stderr)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
