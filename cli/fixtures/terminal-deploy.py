import json, os, pty, select, signal, sys, time

# A real terminal drives the public CLI, against the test's network edge.
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execv(sys.argv[2], [sys.argv[2], sys.argv[3], 'deploy', '--environment', sys.argv[4]])
output = b''
answered = False
reaped = False
prompt = b'Your name (hosted owner): '
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                output += os.read(fd, 65536)
            except OSError:
                pass
        if prompt in output and not answered:
            os.write(fd, b'Noah Patel\n')
            answered = True
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            reaped = True
            result = {'code': os.waitstatus_to_exitcode(status), 'prompts': output.count(prompt)}
            if result['code']:
                text = output.decode(errors='replace')
                for key, value in os.environ.items():
                    if value and any(word in key.upper() for word in ['SECRET', 'TOKEN', 'KEY', 'ACCOUNT_ID']):
                        text = text.replace(value, '[REDACTED]')
                result['failure'] = text[-3000:]
            print(json.dumps(result))
            break
    else:
        raise RuntimeError('Deploy terminal did not finish')
finally:
    if not reaped:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
    os.close(fd)
