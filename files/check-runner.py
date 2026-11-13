import datetime,json,os,subprocess,time
from pathlib import Path
packet=Path.home()/'rer-consolidation/work/gr-base-auth-diagnostics-1/packet'
commands=[('dependency-setup',['node','--import','/tmp/gr-system-chromium.mjs','--test','cli/dependency-setup.test.mjs']),('typecheck',['pnpm','typecheck:modules'])]
results=[]
for name,command in commands:
    started=time.time()
    env=dict(os.environ,GIT_AUTHOR_NAME='Run Edit Run fleet',GIT_AUTHOR_EMAIL='fleet@runeditrun.com',GIT_COMMITTER_NAME='Run Edit Run fleet',GIT_COMMITTER_EMAIL='fleet@runeditrun.com')
    with (packet/(name+'.log')).open('w') as log:
        result=subprocess.run(['python3','/tmp/rer-reap.py',*command],stdout=log,stderr=subprocess.STDOUT,env=env)
    row=dict(check=name,command=command,exit_code=result.returncode,seconds=round(time.time()-started,3),started_utc=datetime.datetime.fromtimestamp(started,datetime.timezone.utc).isoformat(),log=name+'.log')
    results.append(row)
    (packet/'local-checks.json').write_text(json.dumps(dict(node=subprocess.check_output(['node','--version'],text=True).strip(),pnpm=subprocess.check_output(['pnpm','--version'],text=True).strip(),platform='Linux cloud VM; system Chromium /usr/bin/chromium --no-sandbox',results=results),indent=2)+'\n')
    print(json.dumps(row),flush=True)
