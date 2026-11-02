"""Pure D08 command construction; safe to import without browser or service work."""
import base64
import shlex


def single_line_python_command(program):
    """Return one shell line that compiles the original Python source bytes.

    Encoding the source, not quoting its literal newlines, avoids textarea/terminal
    paste newline normalization. This only constructs a command; it never runs it.
    """
    if isinstance(program, str):
        program = program.encode('utf-8')
    if not isinstance(program, bytes):
        raise TypeError('program must be str or bytes')
    encoded = base64.b64encode(program).decode('ascii')
    runner = ('import base64;exec(compile(base64.b64decode("' + encoded +
              '"),"<d08-synthetic>","exec"))')
    command = 'exec ' + shlex.join(['python3', '-I', '-u', '-c', runner])
    assert '\n' not in command and '\r' not in command
    return command


def synthetic_program(filename, run, duration=90, interval=0.2):
    """The original single-side-effect synthetic task, with short offline bounds."""
    if duration < 0 or interval <= 0:
        raise ValueError('invalid synthetic timing')
    return (
        "import os,time,pathlib\n"
        "p=pathlib.Path(" + repr(str(filename)) + ")\n"
        "with p.open('a') as f: f.write(" + repr(run + '\n') + ")\n"
        "print('D08_ORIGINAL_READY',os.getpid(),flush=True)\n"
        "end=time.monotonic()+" + repr(duration) + "\n"
        "i=0\n"
        "while time.monotonic()<end:\n"
        " print('D08_ORIGINAL_TICK',i,'COUNT',len(p.read_text().splitlines()),flush=True);i+=1;time.sleep(" + repr(interval) + ")\n"
    )
