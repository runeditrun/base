# Fault injection for the real SSH deployment: uniquely identify the helper
# holding this installation, then interrupt it or replace its pathname.
import ctypes, os, select, signal, struct, sys, time
path = sys.argv[1]
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_CLOEXEC)
if fd < 0 or libc.inotify_add_watch(fd, path.encode(), 0x100) < 0:
    raise RuntimeError('Cannot watch staging directory')
identity = os.stat(path)
print('READY', flush=True)
try:
    if not select.select([fd], [], [], 30)[0]:
        raise RuntimeError('No stage creation')
    events = os.read(fd, 65536)
    at = 0
    stage = None
    while at < len(events):
        _, _, _, length = struct.unpack_from('iIII', events, at)
        name = events[at + 16:at + 16 + length].split(b'\0')[0]
        at += 16 + length
        if name.startswith(b'stage-'):
            stage = os.path.join(path, name.decode())
    if not stage:
        raise RuntimeError('Unexpected filesystem event')
    victims = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            command = open('/proc/' + pid + '/cmdline', 'rb').read()
            if b'python3\0-I\0-c\0' not in command or b'def deploy():' not in command:
                continue
            for entry in os.listdir('/proc/' + pid + '/fd'):
                target = os.stat('/proc/' + pid + '/fd/' + entry)
                if (target.st_dev, target.st_ino) == (identity.st_dev, identity.st_ino):
                    victims.append(int(pid))
                    break
        except (FileNotFoundError, PermissionError):
            continue
    if len(victims) != 1:
        raise RuntimeError('Cannot prove unique deployment helper')
    victim = victims[0]
    if len(sys.argv) == 2:
        os.kill(victim, signal.SIGKILL)
        print('STAGE_INTERRUPTED', flush=True)
    else:
        if len(sys.argv) == 5:
            # Wait for the real helper's first Docker subprocess after staging:
            # all exclusive writes and their inode records have then completed.
            end = time.monotonic() + 5
            while time.monotonic() < end:
                children = open('/proc/' + str(victim) + '/task/' + str(victim) + '/children').read().split()
                if children and os.path.isdir(stage) and set(os.listdir(stage)) == {'settings.env', 'compose.yaml', 'Caddyfile'}:
                    break
                time.sleep(0.001)
            else:
                raise RuntimeError('Deployment helper did not finish staging')
        os.kill(victim, signal.SIGSTOP)
        try:
            end = time.monotonic() + 5
            while time.monotonic() < end:
                if open('/proc/' + str(victim) + '/stat').read().split(') ')[1].split()[0] == 'T':
                    break
                time.sleep(0.01)
            else:
                raise RuntimeError('Deployment helper did not stop')
            if len(sys.argv) == 5:
                target = stage if sys.argv[3] == 'stage' else sys.argv[3]
                if os.path.dirname(target) != path:
                    raise RuntimeError('Replacement is outside the test installation')
                os.rename(target, sys.argv[4])
                os.rename(sys.argv[2], target)
                print('STAGE_GENERATION_REPLACED ' + target, flush=True)
            else:
                os.rename(path, path + '.saved')
                os.symlink(sys.argv[2], path)
                print('STAGE_PATH_REPLACED', flush=True)
        finally:
            os.kill(victim, signal.SIGCONT)
finally:
    os.close(fd)
