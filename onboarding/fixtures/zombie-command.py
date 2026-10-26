import os
import signal
import sys
import time

# The live case acknowledges SIGTERM only after a visible grace period.
if sys.argv[1] == 'live':
    def finish(*_):
        time.sleep(0.35)
        sys.exit(0)
    signal.signal(signal.SIGTERM, finish)
    print('LIVE ' + str(os.getpid()), flush=True)
else:
    child = os.fork()
    if child == 0:
        os._exit(0)
    # Keep the dead child unreaped until cleanup terminates this parent.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print('ZOMBIE ' + str(child), flush=True)
while True:
    time.sleep(0.05)
