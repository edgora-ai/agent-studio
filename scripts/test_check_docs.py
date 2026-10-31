import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHECKER = ROOT / 'scripts/check_docs.py'


class DocumentationChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='agent-studio-doc-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        shutil.copy2(ROOT / 'README.md', self.root / 'README.md')
        shutil.copytree(ROOT / 'docs', self.root / 'docs')
        shutil.copytree(ROOT / 'scripts', self.root / 'scripts')
        shutil.copytree(ROOT / 'infra', self.root / 'infra')
        shutil.copytree(ROOT / 'packages', self.root / 'packages')
        shutil.copytree(ROOT / 'profiles', self.root / 'profiles')

    def run_checker(self):
        result = subprocess.run(
            [sys.executable, '-I', str(CHECKER), '--root', str(self.root), '--json'],
            capture_output=True, text=True, timeout=20,
        )
        return result.returncode, json.loads(result.stdout)

    def update_task(self, identifier, **updates):
        path = self.root / 'docs/08-execution-plan.md'
        text = path.read_text()
        row = next(line for line in text.splitlines() if line.startswith(f'| {identifier} |'))
        cells = row.split('|')
        columns = ('task', 'path', 'dependencies', 'output', 'acceptance')
        for name, value in updates.items():
            cells[columns.index(name) + 1] = f' {value} '
        path.write_text(text.replace(row, '|'.join(cells)))

    def test_current_documents_pass(self):
        code, result = self.run_checker()
        self.assertEqual(code, 0, result)
        self.assertEqual(result['requirements'], 14)
        self.assertEqual(result['nonFunctional'], 8)
        self.assertEqual(result['scenarios'], 17)
        self.assertEqual(result['nonFunctionalMappings'], 8)
        self.assertEqual(result['executionTasks'], 31)

    def test_broken_link_fails(self):
        path = self.root / 'README.md'
        path.write_text(path.read_text() + '\n[Missing](docs/missing.md)\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('broken local link' in error for error in result['errors']))

    def test_missing_linked_script_fails(self):
        (self.root / 'scripts/m1/activate_candidate.mjs').unlink()
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any(
            'broken local link: ../../scripts/m1/activate_candidate.mjs' in error
            for error in result['errors']
        ))

    def test_missing_linked_template_fails(self):
        (self.root / 'infra/coder-lab/template/main.tf').unlink()
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any(
            'broken local link: ../../infra/coder-lab/template/main.tf' in error
            for error in result['errors']
        ))

    def test_missing_preview_source_fails(self):
        (self.root / 'packages/dsh-agent-studio/store.mjs').unlink()
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any(
            'broken local link: ../../packages/dsh-agent-studio/store.mjs' in error
            for error in result['errors']
        ))

    def test_missing_preview_profile_fails(self):
        (self.root / 'profiles/agent-studio-preview/sources.lock.json').unlink()
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any(
            'broken local link: profiles/agent-studio-preview/sources.lock.json' in error
            for error in result['errors']
        ))

    def test_undefined_requirement_fails(self):
        path = self.root / 'README.md'
        path.write_text(path.read_text() + '\nFR-99\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('undefined requirement FR-99' in error for error in result['errors']))

    def test_undefined_nonfunctional_requirement_fails(self):
        path = self.root / 'README.md'
        path.write_text(path.read_text() + '\nNF-99\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('README.md: undefined non-functional requirement NF-99', result['errors'])

    def test_missing_document_fails(self):
        path = self.root / 'docs/03-system-architecture.md'
        path.rename(path.with_suffix('.missing'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('missing required document' in error for error in result['errors']))

    def test_missing_acceptance_mapping_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| FR-12 |'))
        path.write_text(text.replace(line, '| FR-12 | 第二阶段尚无映射 |'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('no scenario for FR-12' in error for error in result['errors']))

    def test_missing_declared_pair_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| FR-04 |'))
        replacement = line.replace('SC-03、', '', 1)
        self.assertNotEqual(line, replacement)
        path.write_text(text.replace(line, replacement))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('acceptance matrix missing declared mapping FR-04 -> SC-03', result['errors'])

    def test_undeclared_pair_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| FR-04 |'))
        replacement = line.replace('| FR-04 |', '| FR-04 | SC-07、', 1)
        path.write_text(text.replace(line, replacement))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('acceptance matrix has undeclared mapping FR-04 -> SC-07', result['errors'])

    def test_missing_scenario_declaration_fails(self):
        path = self.root / 'docs/02-features-and-scenarios.md'
        path.write_text(path.read_text().replace('**需求：**', '**关联信息：**', 1))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('SC-01: missing primary requirement declarations', result['errors'])

    def test_duplicate_acceptance_row_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| FR-01 |'))
        path.write_text(text + '\n' + line + '\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('duplicate acceptance rows' in error for error in result['errors']))

    def test_additional_document_broken_link_fails(self):
        folder = self.root / 'docs/research'
        folder.mkdir(exist_ok=True)
        (folder / 'extra-link.md').write_text('# Extra research\n\n[Missing](not-found.md)\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('docs/research/extra-link.md' in error and 'broken local link' in error
                            for error in result['errors']))

    def test_additional_document_undefined_requirement_fails(self):
        folder = self.root / 'docs/research'
        folder.mkdir(exist_ok=True)
        (folder / 'extra-reference.md').write_text('# Extra research\n\nFR-99\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('docs/research/extra-reference.md: undefined requirement FR-99', result['errors'])

    def test_missing_nonfunctional_mapping_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| NF-07 |'))
        path.write_text(text.replace(line + '\n', ''))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('non-functional mapping does not cover all NF requirements' in error
                            for error in result['errors']))

    def test_missing_nonfunctional_section_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        start = text.index('## 4. 非功能验证映射')
        end = text.index('## 5. 测试层级')
        path.write_text(text[:start] + text[end:])
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('missing or duplicate non-functional verification mapping section', result['errors'])

    def test_invalid_priority_fails(self):
        path = self.root / 'docs/01-product-requirements.md'
        text = path.read_text()
        line = next(line for line in text.splitlines() if line.startswith('| FR-05 |'))
        path.write_text(text.replace(line, line.replace('| P0 |', '| P3 |', 1)))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('FR-05: invalid priority' in error for error in result['errors']))

    def test_missing_scenario_definition_fails(self):
        path = self.root / 'docs/02-features-and-scenarios.md'
        text = path.read_text()
        start = text.index('## SC-15')
        end = text.index('## SC-16')
        path.write_text(text[:start] + text[end:])
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('scenario definitions differ' in error for error in result['errors']))

    def test_duplicate_nonfunctional_mapping_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        row = next(line for line in text.splitlines() if line.startswith('| NF-04 |'))
        path.write_text(text.replace(row, row + '\n' + row))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('duplicate non-functional mappings' in error for error in result['errors']))

    def test_nonfunctional_mapping_without_target_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        original = path.read_text()
        row = next(line for line in original.splitlines() if line.startswith('| NF-04 |'))
        for replacement in ('| NF-04 | 无验证 |', '| NF-04 | |'):
            with self.subTest(replacement=replacement):
                path.write_text(original.replace(row, replacement))
                code, result = self.run_checker()
                self.assertNotEqual(code, 0)
                self.assertIn('NF-04: non-functional mapping needs a scenario or checkpoint', result['errors'])

    def test_undefined_checkpoint_mapping_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        path.write_text(path.read_text().replace('| NF-03 | CK-01 |', '| NF-03 | CK-99 |'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('non-functional mapping NF-03 references undefined target CK-99', result['errors'])

    def test_missing_checkpoint_definition_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        row = next(line for line in text.splitlines() if line.startswith('- **CK-02**'))
        path.write_text(text.replace(row + '\n', ''))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('non-functional mapping NF-04 references undefined target CK-02', result['errors'])

    def test_duplicate_checkpoint_definition_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        text = path.read_text()
        row = next(line for line in text.splitlines() if line.startswith('- **CK-02**'))
        path.write_text(text.replace(row, row + '\n' + row))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('duplicate checkpoint definitions' in error for error in result['errors']))

    def test_priority_phase_mismatch_fails(self):
        path = self.root / 'docs/01-product-requirements.md'
        path.write_text(path.read_text().replace('| FR-05 | P0 |', '| FR-05 | P2 |'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('第一阶段必需: phase declaration differs from P0 requirements', result['errors'])

    def test_p0_mapping_to_phase_two_fails(self):
        acceptance = self.root / 'docs/05-delivery-and-acceptance.md'
        acceptance.write_text(acceptance.read_text().replace('| FR-05 | SC-01、', '| FR-05 | SC-11、SC-01、'))
        scenarios = self.root / 'docs/02-features-and-scenarios.md'
        scenarios.write_text(scenarios.read_text().replace('**需求：** FR-12。', '**需求：** FR-12、FR-05。'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('FR-05: P0 requirement maps to phase-two SC-11', result['errors'])

    def test_missing_phase_declaration_fails(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        path.write_text(path.read_text().replace('**第一阶段必需：**', '**发布建议：**'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('第一阶段必需: expected one phase declaration', result['errors'])

    def test_nonfunctional_section_renumbering_passes(self):
        path = self.root / 'docs/05-delivery-and-acceptance.md'
        path.write_text(path.read_text().replace('## 4. 非功能验证映射', '## 10. 非功能验证映射'))
        code, result = self.run_checker()
        self.assertEqual(code, 0, result)

    def test_missing_execution_plan_fails(self):
        path = self.root / 'docs/08-execution-plan.md'
        path.rename(path.with_suffix('.missing'))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('docs/08-execution-plan.md: missing required document', result['errors'])

    def test_duplicate_execution_task_fails(self):
        path = self.root / 'docs/08-execution-plan.md'
        text = path.read_text()
        row = next(line for line in text.splitlines() if line.startswith('| T-101 |'))
        path.write_text(text.replace(row, row + '\n' + row))
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('duplicate execution tasks' in error for error in result['errors']))

    def test_undefined_execution_prerequisite_fails(self):
        self.update_task('T-102', dependencies='T-199')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('docs/08-execution-plan.md: undefined execution task T-199', result['errors'])

    def test_cyclic_execution_prerequisites_fail(self):
        self.update_task('T-101', dependencies='T-102')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertTrue(any('execution plan has cyclic dependencies' in error for error in result['errors']))

    def test_later_milestone_prerequisite_fails(self):
        self.update_task('T-404', dependencies='T-501')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('T-404: task depends on later milestone T-501', result['errors'])

    def test_invalid_execution_path_fails(self):
        for value, message in (
            ('P-Z', "T-101: invalid execution path 'P-Z'"),
            ('P-F', 'T-101: P-F is reserved for phase-two M5 tasks'),
        ):
            with self.subTest(path=value):
                self.update_task('T-101', path=value)
                code, result = self.run_checker()
                self.assertNotEqual(code, 0)
                self.assertIn(message, result['errors'])

    def test_empty_execution_output_fails(self):
        self.update_task('T-101', output='')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('T-101: task output must not be empty', result['errors'])

    def test_execution_task_without_acceptance_fails(self):
        for value in ('', '无验证'):
            with self.subTest(acceptance=value):
                self.update_task('T-101', acceptance=value)
                code, result = self.run_checker()
                self.assertNotEqual(code, 0)
                self.assertIn('T-101: task needs a scenario or checkpoint', result['errors'])

    def test_undefined_execution_acceptance_fails(self):
        self.update_task('T-101', acceptance='CK-99')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('T-101: task references undefined acceptance target CK-99', result['errors'])

    def test_undefined_execution_reference_fails(self):
        path = self.root / 'README.md'
        path.write_text(path.read_text() + '\nT-999\n')
        code, result = self.run_checker()
        self.assertNotEqual(code, 0)
        self.assertIn('README.md: undefined execution task T-999', result['errors'])


if __name__ == '__main__':
    unittest.main()
