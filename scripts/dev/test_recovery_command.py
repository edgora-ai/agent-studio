"""Offline regressions; importing this module never imports recovery.browser.py."""
import ast
import base64
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

import importlib.util

# Explicit sibling loading also works under Python -I; no browser import.
_spec = importlib.util.spec_from_file_location('recovery_command', Path(__file__).resolve().with_name('recovery_command.py'))
assert _spec is not None and _spec.loader is not None
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)
single_line_python_command = _helper.single_line_python_command
synthetic_program = _helper.synthetic_program


class RecoveryCommandTests(unittest.TestCase):
    def decoded_program(self, program):
        command = single_line_python_command(program)
        self.assertNotIn('\n', command)
        self.assertNotIn('\r', command)
        args = shlex.split(command)
        self.assertEqual(args[:5], ['exec', 'python3', '-I', '-u', '-c'])
        tree = ast.parse(args[5])
        literals = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant)]
        payload = next(value for value in literals if isinstance(value, str) and value not in ('<d08-synthetic>', 'exec'))
        return command, base64.b64decode(payload, validate=True)

    def test_exact_multiline_bytes_and_shell_quoting(self):
        for program in ["# 雪 / quotes '\" / dollar $ / backslash \\\nif True:\n print('nested')\n", b'# coding: latin-1\r\nx="\xe9"\r\nassert x\r\n', b'']:
            _, decoded = self.decoded_program(program)
            self.assertEqual(decoded, program.encode('utf-8') if isinstance(program, str) else program)

    def test_one_original_side_effect_and_no_execution_during_construction(self):
        with tempfile.TemporaryDirectory(prefix='agent-studio-recovery-command-') as directory:
            owned = Path(directory).resolve()
            self.assertTrue(owned.is_absolute())
            self.assertEqual(owned.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(owned.name.startswith('agent-studio-recovery-command-'))
            filename = "counter ' 雪 $.txt"
            run = "one original ' \" 雪 $"
            program = synthetic_program(filename, run, duration=0.04, interval=0.01)
            self.assertGreater(program.count('\n'), 6)
            command, decoded = self.decoded_program(program)
            self.assertEqual(decoded, program.encode('utf-8'))
            self.assertEqual(list(Path(directory).iterdir()), [])
            result = subprocess.run(['bash', '-c', command], cwd=directory, capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual((Path(directory) / filename).read_text(), run + '\n')
            self.assertEqual(result.stdout.count('D08_ORIGINAL_READY '), 1)
            ticks = [line for line in result.stdout.splitlines() if line.startswith('D08_ORIGINAL_TICK ')]
            self.assertTrue(ticks)
            self.assertTrue(all(line.endswith('COUNT 1') for line in ticks), ticks)
            self.assertEqual(result.stderr, '')
            self.assertEqual(Path(directory).resolve(), owned)
            self.assertEqual(owned.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(owned.name.startswith('agent-studio-recovery-command-'))

    def test_defaults_keep_the_original_bounded_task(self):
        program = synthetic_program('relative.txt', 'run')
        self.assertIn('end=time.monotonic()+90\n', program)
        self.assertIn('time.sleep(0.2)', program)
        self.assertEqual(program.count("with p.open('a')"), 1)
        with self.assertRaises(TypeError):
            single_line_python_command(None)
        with self.assertRaises(ValueError):
            synthetic_program('x', 'y', interval=0)


if __name__ == '__main__':
    unittest.main()
