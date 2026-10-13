import os, pty, select, signal, time, json, pathlib, sys
root=pathlib.Path(sys.argv[1])
node=sys.argv[2]
secret='synthetic-private-pty-passphrase'
pid,fd=pty.fork()
if pid==0:
 os.chdir(root)
 for name in ['RER_JOB_POLICY','RER_JOB_MEMBERSHIP','RER_LOCAL_OPERATION']:
  os.environ.pop(name,None)
 os.environ.update(CI='false',RER_JOBS_DIR=str(root/'queue'),RER_JOBS_LOAD_THRESHOLD='100000',RER_JOBS_MIN_FREE_MEMORY_BYTES='0',PATH=str(pathlib.Path(node).parent)+':'+os.environ['PATH'])
 os.execv(node,[node,'scripts/rer.mjs','setup'])
output=b''
reaped=False
def until(text):
 global output
 deadline=time.monotonic()+30
 while text.encode() not in output:
  if time.monotonic()>deadline: raise RuntimeError('prompt deadline: '+text)
  if select.select([fd],[],[],0.2)[0]:
   try: chunk=os.read(fd,65536)
   except OSError: raise RuntimeError('PTY closed before '+text)
   if not chunk: raise RuntimeError('PTY ended before '+text)
   output+=chunk
try:
 for key,value in [('OWNER_EMAIL','terminal@example.test'),('WORKSPACE','Terminal workspace'),('ACCESS',secret)]:
  until('('+key+')');os.write(fd,(value+'\n').encode());time.sleep(0.1)
 until('(FINAL_FIELD)')
 os.kill(pid,signal.SIGTERM)
 deadline=time.monotonic()+15
 status=None
 while time.monotonic()<deadline:
  done,status=os.waitpid(pid,os.WNOHANG)
  if done:
   reaped=True
   break
  if select.select([fd],[],[],0.2)[0]:
   try:output+=os.read(fd,65536)
   except OSError:pass
 else:raise RuntimeError('cancel deadline')
 text=output.decode(errors='replace')
 result={'publicCommand':'node scripts/rer.mjs setup','prompted':['OWNER_EMAIL','WORKSPACE','ACCESS','FINAL_FIELD'],'secretWasEchoed':secret in text,'managedSecretPrompted':'(SESSION_SECRET)' in text or '(SETUP_TOKEN)' in text,'termination':os.waitstatus_to_exitcode(status)}
 print(json.dumps(result))
 assert not result['secretWasEchoed'];assert not result['managedSecretPrompted'];assert result['termination']==143
finally:
 if not reaped:
  try:os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:os.waitpid(pid,0)
  except ChildProcessError:pass
 os.close(fd)
