import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verificationPlan } from '../../default-seed/scripts/verify-app.mjs';

// Runs every push shard of the reference seed's verification plan, in order.
export async function verifyReference() {
  const names = (await verificationPlan()).push.map(({ name }) => name);
  const cwd = fileURLToPath(new URL('../../default-seed/', import.meta.url));
  const queue = fileURLToPath(new URL('../../onboarding/queued-entry.mjs', import.meta.url));
  let child, signal, code = 0;
  const cancel = value => { signal ??= value; child?.kill(value); };
  const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    for (const name of names) {
      if (signal) break;
      console.log(`VERIFY_REFERENCE ${name}`);
      child = spawn(process.execPath, [queue, 'verify:reference', '--', process.execPath, 'scripts/verify-ci.mjs', name], { cwd, stdio: 'inherit' });
      code = await new Promise(resolve => {
        child.once('error', error => { console.error(error.message); resolve(1); });
        child.once('close', code => resolve(code ?? 1));
      });
      child = undefined;
      if (code !== 0) break;
    }
    return signal === 'SIGINT' ? 130 : signal ? 143 : code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
