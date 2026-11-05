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


def hold_slot(*, wait_seconds):
    # wait_seconds is injectable by the test interpreter, never a user knob.
    raw = os.environ.get('RER_SCAN_SLOTS', '3')
    if not raw.isdecimal() or not 1 <= int(raw) <= 8:
        notify('scan.slot-configuration')
        return 2
    directory = Path.home() / '.cache/rer/scan-slots'
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as error:
        return failure('slot.directory', error)
    deadline = time.monotonic() + wait_seconds
    waiting = False
    while True:
        if waiting and time.monotonic() >= deadline:
            notify('scan.slot-timeout')
            return 2
        for number in range(int(raw)):
            try:
                fd = os.open(directory / f'slot-{number}', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            except OSError as error:
                return failure('slot.open', error)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                continue
            except OSError as error:
                os.close(fd)
                return failure('slot.lock', error)
            try:
                notify('acquired')
                try:
                    worker = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('cli.py')),
                                               *sys.argv[1:]], stdin=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL, pass_fds=(fd,))
                except OSError as error:
                    return failure('worker.launch', error)
                # Node's pipe closes even on SIGKILL. Stop only this private
                # group, so an orphan never consumes CPU or holds a slot.
                while worker.poll() is None:
                    if parent_closed(0.2):
                        os.killpg(os.getpgrp(), signal.SIGKILL)
                if worker.returncode < 0:
                    notify(f'worker.signal:{-worker.returncode}')
                else:
                    notify(f'worker.exit:{worker.returncode}')
                return worker.returncode
            finally:
                os.close(fd)
        if not waiting:
            notify('waiting')
            waiting = True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            notify('scan.slot-timeout')
            return 2
        if parent_closed(min(2, remaining)):
            return 2


def failure(stage, error):
    # Only an OS errno crosses fd 3, never paths, argv or exception messages.
    number = error.errno if isinstance(error.errno, int) and 0 < error.errno < 1000 else 0
    notify(f'{stage}:{number}')
    return 2


def main(*, wait_seconds=3600):
    try:
        return hold_slot(wait_seconds=wait_seconds)
    except OSError as error:
        return failure('slot.wait', error)


if __name__ == '__main__':
    raise SystemExit(main())
