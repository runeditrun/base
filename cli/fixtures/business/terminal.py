"""A real terminal for consent, without any host keychain or service calls."""
import errno
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, int(os.environ.get('TEST_COLUMNS', '120')), 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
buffer = b''
answered = 0
secret_answered = False
question_cli_answered = False
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            buffer += chunk
            if not secret_answered and b'Credential (hidden): ' in buffer:
                os.write(master, sys.stdin.buffer.readline())
                secret_answered = True
            if not question_cli_answered and b'] (none): ' in buffer:
                os.write(master, os.environ.get('TEST_QUESTION_CLI', 'none').encode() + b'\n')
                question_cli_answered = True
            count = buffer.count(b'[yes/no] ')
            if count > answered:
                os.write(master, b'yes\n')
                answered = count
        if child.poll() is not None and not ready:
            break
    else:
        child.kill()
    sys.exit(child.wait())
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
        child.wait()
