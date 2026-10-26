# Own every descendant of the Node driver, then reap only our children.
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys

if sys.platform == 'linux':
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), 'could not become child subreaper')
child = subprocess.Popen(sys.argv[1:])
code = child.wait()
while True:
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
        if pid == 0:
            # These are children adopted from the fixture, never host PIDs.
            if sys.platform == 'linux':
                owned = []
                for entry in Path('/proc').iterdir():
                    if not entry.name.isdigit():
                        continue
                    try:
                        fields = (entry / 'stat').read_text().rsplit(') ', 1)[1].split()
                        if int(fields[1]) == os.getpid():
                            owned.append(int(entry.name))
                    except FileNotFoundError:
                        pass
                for pid in owned:
                    os.kill(pid, signal.SIGKILL)
            os.waitpid(-1, 0)
    except ChildProcessError:
        break
sys.exit(code)
