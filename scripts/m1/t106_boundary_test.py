"""T-106 repair regressions only; private fixtures, no network or remote workloads."""
import importlib.util
import json
import os
from pathlib import Path
import select
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t106_repair_runner', ROOT / 'scripts/m1/t106_run.py')
RUN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN)
TOOLS = RUN.tools
CACHE = ROOT / 'artifacts/m1/t106/tools-rg14-3211d20ec95e'


def publish_fixture(path):
    """Pause real json.dump after its first write inside the real publisher."""
    original = json.dump
    paused = False

    def split_dump(value, handle, **kwargs):
        class Writer:
            def write(self, text):
                nonlocal paused
                result = handle.write(text)
                if not paused:
                    paused = True
                    handle.flush()
                    print('partial-write-barrier', flush=True)
                    if not select.select([sys.stdin], [], [], 8)[0] or sys.stdin.readline().strip() != 'finish':
                        raise TimeoutError('T106_TEST_PUBLICATION_BARRIER')
                return result
        return original(value, Writer(), **kwargs)

    with patch.object(RUN.json, 'dump', side_effect=split_dump):
        RUN.publish_response(path, {'remote': {'synthetic': '完整 UTF-8 ' * 1000}})
    print('published', flush=True)


class BoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(tempfile.mkdtemp(prefix='boundary-tests-', dir=ROOT / 'artifacts/m1/t106'))
        cls.package = (CACHE / 'download/ripgrep.deb').read_bytes()
        cls.binary = (CACHE / 'extracted/rg').read_bytes()
        cls.manifest = (CACHE / 'manifest.json').read_bytes()
        assert TOOLS.digest(cls.package) == TOOLS.PACKAGE_SHA
        print('Private retained fixtures: ' + str(cls.base))

    def fixture(self, name):
        target = self.base / name
        target.mkdir(mode=0o700)
        (target / 'download').mkdir()
        (target / 'extracted').mkdir()
        (target / 'download/ripgrep.deb').write_bytes(self.package)
        (target / 'extracted/rg').write_bytes(self.binary)
        (target / 'manifest.json').write_bytes(self.manifest)
        return target

    def test_all_link_forms_rejected(self):
        for mode in ['download-directory', 'extracted-directory', 'manifest', 'cache-directory',
                     'package-leaf', 'binary-leaf', 'cache-ancestor']:
            with self.subTest(mode=mode):
                base = self.fixture(mode)
                manifest = base / 'manifest.json'
                relative = {'download-directory': 'download', 'extracted-directory': 'extracted',
                            'manifest': 'manifest.json', 'package-leaf': 'download/ripgrep.deb',
                            'binary-leaf': 'extracted/rg'}.get(mode)
                if relative:
                    target = base / relative
                    stored = target.with_name(target.name + '.owned-original')
                    target.rename(stored)
                    target.symlink_to(stored.name, target_is_directory=mode.endswith('directory'))
                elif mode == 'cache-directory':
                    linked = self.base / 'cache-link'
                    linked.symlink_to(base, target_is_directory=True)
                    manifest = linked / 'manifest.json'
                else:
                    linked = self.base / 'ancestor-link'
                    linked.symlink_to(self.base, target_is_directory=True)
                    manifest = linked / mode / 'manifest.json'
                with self.assertRaisesRegex(ValueError, 'T106_TOOL_CACHE_SYMLINK'):
                    TOOLS.verify_cached(manifest)

    def test_tampering_rejected(self):
        for mode in ['source', 'package', 'binary']:
            with self.subTest(mode=mode):
                base = self.fixture('tampered-' + mode)
                if mode == 'source':
                    row = json.loads(self.manifest)
                    row['sourceUrl'] = 'https://invalid.example/not-the-pinned-tool'
                    (base / 'manifest.json').write_text(json.dumps(row))
                else:
                    path = base / ('download/ripgrep.deb' if mode == 'package' else 'extracted/rg')
                    data = path.read_bytes()
                    path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
                with self.assertRaisesRegex(ValueError, 'T106_TOOL_(PROVENANCE|PACKAGE_DIGEST|BINARY_DIGEST)_MISMATCH'):
                    TOOLS.verify_cached(base / 'manifest.json')

    def test_genuine_cache_reuse_without_download(self):
        with patch.object(TOOLS, 'build_opener', side_effect=AssertionError('Network forbidden in regression')):
            metadata, data = TOOLS.ensure_tool(with_bytes=True)
        self.assertTrue(metadata['reused'])
        self.assertEqual(data, self.binary)
        self.assertEqual(metadata['verifiedInputs']['binary']['sha256'], TOOLS.digest(data))
        base = self.fixture('valid-copy')
        self.assertEqual(TOOLS.verify_cached(base / 'manifest.json')['binarySha256'], TOOLS.digest(data))

    def test_directory_swap_between_lstat_and_open_rejected(self):
        base = self.fixture('before-open-swap')
        original = TOOLS.os.open
        swapped = False

        def open_with_swap(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == 'download' and not swapped:
                swapped = True
                (base / 'download').rename(base / 'owned-download')
                (base / 'download').symlink_to('owned-download', target_is_directory=True)
            return original(path, flags, *args, **kwargs)

        with patch.object(TOOLS.os, 'open', side_effect=open_with_swap):
            with self.assertRaises((OSError, ValueError)):
                TOOLS.verify_cached(base / 'manifest.json')
        self.assertTrue(swapped)

    def test_open_cache_anchor_replacement_detected(self):
        base = self.fixture('opened-anchor-swap')
        original = TOOLS.read_at
        swapped = False

        def read_with_swap(parent, relative, maximum):
            nonlocal swapped
            data = original(parent, relative, maximum)
            if not swapped:
                swapped = True
                moved = base.with_name(base.name + '-owned-original')
                base.rename(moved)
                base.symlink_to(moved.name, target_is_directory=True)
            return data

        with patch.object(TOOLS, 'read_at', side_effect=read_with_swap):
            with self.assertRaisesRegex(ValueError, 'T106_TOOL_CACHE_OBJECT_CHANGED'):
                TOOLS.verify_cached(base / 'manifest.json')

    def test_archive_parser_receives_verified_snapshot_not_reopened_path(self):
        base = self.fixture('parser-snapshot')
        original = TOOLS.subprocess.run
        supplied = []

        def run_with_swap(args, **kwargs):
            self.assertEqual(args, ['dpkg-deb', '--fsys-tarfile', '-'])
            supplied.append(TOOLS.digest(kwargs['input']))
            (base / 'download/ripgrep.deb').write_bytes(b'not the verified archive')
            return original(args, **kwargs)

        with patch.object(TOOLS.subprocess, 'run', side_effect=run_with_swap):
            metadata, data = TOOLS.load_cached(base / 'manifest.json')
        self.assertEqual(supplied, [TOOLS.PACKAGE_SHA])
        self.assertEqual(data, self.binary)
        self.assertEqual(metadata['verifiedInputs']['package']['sha256'], TOOLS.PACKAGE_SHA)

    def test_runner_stages_verified_bytes_despite_later_path_replacement(self):
        base = self.fixture('stage-snapshot')
        metadata, data = TOOLS.load_cached(base / 'manifest.json')
        path = base / 'extracted/rg'
        path.rename(base / 'extracted/owned-original')
        (base / 'extracted/unverified').write_bytes(b'not rg')
        path.symlink_to('unverified')
        target = self.base / 'staged-run'
        target.mkdir()
        with patch.object(RUN.tools, 'ensure_tool', return_value=(metadata, data)) as ensure:
            result = RUN.stage_tool(target)
        ensure.assert_called_once_with(with_bytes=True)
        self.assertEqual((target / 'dependency/rg').read_bytes(), self.binary)
        self.assertEqual(result['binarySha256'], TOOLS.digest(self.binary))

    def test_publisher_no_overwrite_and_failed_serialization_not_visible(self):
        base = self.base / 'publish-failures'
        base.mkdir()
        path = base / 'observe-001.response.json'
        value = {'remote': {'complete': True}}
        RUN.publish_response(path, value)
        before = path.read_bytes()
        with self.assertRaises(FileExistsError):
            RUN.publish_response(path, {'must': 'not overwrite'})
        self.assertEqual(path.read_bytes(), before)
        invalid = base / 'observe-002.response.json'
        with self.assertRaises(TypeError):
            RUN.publish_response(invalid, {'unserializable': object()})
        self.assertFalse(invalid.exists())
        self.assertFalse(list(base.glob('*.pending')))
        self.assertEqual(json.loads(path.read_text()), value)


if __name__ == '__main__':
    if sys.argv[1:2] == ['publish-fixture']:
        publish_fixture(Path(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
