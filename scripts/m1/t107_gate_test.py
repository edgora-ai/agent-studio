"""Focused regressions for evidence completeness and non-greenwashing gates."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('t107_matrix_under_test', ROOT / 'scripts/m1/t107_matrix.py')
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


class GateEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.value = json.loads((ROOT / 'docs/implementation/t107-m1-matrix.json').read_text())

    def test_exact_eleven_clauses_and_gate_lookup(self):
        matrix.validate(self.value)
        self.assertEqual(len({g['id']: g for g in self.value['gates']}), 11)

    def test_cannot_omit_a_failed_gate(self):
        value = copy.deepcopy(self.value)
        value['gates'] = [g for g in value['gates'] if g['id'] != 'M1-10']
        with self.assertRaises(AssertionError):
            matrix.validate(value)

    def test_cannot_greenwash_recovery_or_release(self):
        for field, replacement in [('m1Passed', True), ('t201Ready', True), ('independentAcceptance', True)]:
            value = copy.deepcopy(self.value)
            value[field] = replacement
            with self.subTest(field=field), self.assertRaises(AssertionError):
                matrix.validate(value)
        value = copy.deepcopy(self.value)
        value['recovery']['providerWindowMs'] = 0
        with self.assertRaises(AssertionError):
            matrix.validate(value)

    def test_changed_evidence_hash_rejected(self):
        value = copy.deepcopy(self.value)
        value['gates'][0]['evidence'][0]['sha256'] = '0' * 64
        with self.assertRaises(AssertionError):
            matrix.validate(value)

    def test_real_small_boundary_results_are_separate(self):
        rows = {row['id']: row for row in self.value['newRuntime']['capacity']['probe']['cases']}
        self.assertEqual([r['truncated'] for r in rows['CAP-DIR']['lists']], [True, False, False])
        self.assertEqual(rows['CAP-FILE']['aboveLimitDispatchCount'], 0)
        self.assertEqual([r['observedBytes'] for r in rows['CAP-OUTPUT']['outputs']], [131071, 131072, 131073])
        self.assertEqual(rows['CAP-TIMEOUT']['rpcTimeout']['kind'], 'timeout')
        self.assertFalse(rows['CAP-TIMEOUT']['termination']['final']['running'])
        self.assertEqual(rows['CAP-SEARCH']['found'], ['bytes-33.bin'])
        self.assertIn('not tested', rows['CAP-OUTPUT']['helperTruncation'])

    def test_actual_entrypoints_observed_not_fake_denials(self):
        runtime = self.value['newRuntime']['entrypoints']
        rows = {row['id']: row for row in runtime['cases']}
        self.assertEqual(len(runtime['actions']), 3)
        self.assertEqual(rows['EP-00']['observed']['status'], 403)
        self.assertEqual(rows['EP-04']['registeredId'], 'workspace.openLocal')
        self.assertEqual(rows['EP-04']['resolved'], 'handled')
        self.assertEqual(len(rows['EP-03']['navigations']), 1)
        self.assertTrue(all(rows[f'EP-{n:02}']['safetyStatus'] == 'fail' for n in range(1, 6)))
        self.assertEqual(rows['EP-06']['safetyStatus'], 'pass')
        self.assertFalse(runtime['authenticationTested'])
        self.assertFalse(runtime['productBindingImplemented'])
        self.assertEqual(runtime['routesRemaining'], 0)

    def test_frozen_and_new_sources_match_written_evidence(self):
        for key in ['sourceSha256']:
            for path, digest in self.value[key].items():
                self.assertEqual(matrix.sha(ROOT / path), digest, path)
        for path, digest in self.value['integrity']['unchangedSources'].items():
            self.assertEqual(matrix.sha(ROOT / path), digest, path)
        self.assertEqual(len(self.value['integrity']['candidateFiles']), 298)
        self.assertEqual(len(self.value['integrity']['installedFiles']), 26)
        self.assertTrue(self.value['newRuntime']['capacity']['directStorageMatchesHelperReadback'])
        self.assertTrue(self.value['newRuntime']['capacity']['sameContainerSet'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
