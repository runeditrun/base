"""Hold a per-user advisory scan slot until the real scan worker exits."""
import fcntl
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def parent_closed(seconds):
    ready, _, _ = select.select([sys.stdin], [], [], max(0, seconds))
    return bool(ready) and not os.read(sys.stdin.fileno(), 1)


def notify(message):
    os.write(3, (message + '\n').encode())


def main(*, wait_seconds=3600):
    # wait_seconds is injectable by the test interpreter, never a user knob.
    raw = os.environ.get('RER_SCAN_SLOTS', '3')
    if not raw.isdecimal() or not 1 <= int(raw) <= 8:
        notify('scan.slot-configuration')
        return 2
    directory = Path.home() / '.cache/rer/scan-slots'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    deadline = time.monotonic() + wait_seconds
    waiting = False
    while True:
        if waiting and time.monotonic() >= deadline:
            notify('scan.slot-timeout')
            return 2
        for number in range(int(raw)):
            fd = os.open(directory / f'slot-{number}', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                continue
            try:
                notify('acquired')
                worker = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('cli.py')),
                                           *sys.argv[1:]], stdin=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, pass_fds=(fd,))
                # Node's pipe closes even on SIGKILL. Stop only this private
                # group, so an orphan never consumes CPU or holds a slot.
                while worker.poll() is None:
                    if parent_closed(0.2):
                        os.killpg(os.getpgrp(), signal.SIGKILL)
                return worker.returncode
            finally:
                os.close(fd)
        if not waiting:
            print('waiting for a scan slot', file=sys.stderr, flush=True)
            waiting = True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            notify('scan.slot-timeout')
            return 2
        if parent_closed(min(2, remaining)):
            return 2


if __name__ == '__main__':
    raise SystemExit(main())
