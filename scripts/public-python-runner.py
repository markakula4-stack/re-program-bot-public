"""Isolated stdlib checks only; test isolation, not an OS security sandbox."""
import runpy
import sys
from pathlib import Path

if sys.version_info < (3, 11):
    raise SystemExit("Public SQLite checks require Python 3.11 or newer")


def offline(event, args):
    if event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn", "os.posix_spawn")) or event in {
        "os.system", "os.fork", "os.forkpty", "os.startfile", "os.startfile/2", "pty.spawn"
    }:
        raise RuntimeError("PUBLIC_TEST_PYTHON_NETWORK_OR_CHILD_BLOCKED")


sys.addaudithook(offline)
root = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
# Schema manifest generators must remain read-only. The two probe generators
# only print synthetic seed SQL; they accept no switches or output paths.
builders = {
    (root / 'scripts/v1.4.1-build-foundation-schema.py'): ('--check',),
    (root / 'scripts/v1.4.1-build-privacy-schema.py'): ('--check',),
    (root / 'scripts/v1.4.3-build-lifecycle-schema.py'): ('--check',),
    (root / 'scripts/v1.4.1-p05-probe-schema.py'): (),
    (root / 'scripts/v1.4.1-p06-probe-schema.py'): (),
}
if len(args) == 2 and args[0] == "-c":
    sys.argv = ["-c"]
    exec(compile(args[1], "<offline-public-test>", "exec"), {"__name__": "__main__"})
elif args and builders.get(Path(args[0]).resolve()) == tuple(args[1:]):
    sys.argv = args
    runpy.run_path(args[0], run_name="__main__")
else:
    raise SystemExit("PUBLIC_TEST_PYTHON_ENTRY_BLOCKED")
