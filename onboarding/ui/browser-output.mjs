import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Each browser check writes to its own directory: concurrent verifies in clones
// with the same name and the same TMPDIR must not delete each other's output.
export async function createOutputRoot(taskTemp) {
  const outputRoot = await mkdtemp(join(taskTemp, 'onboarding-ui-browser-check-'));
  await mkdir(join(outputRoot, 'screenshots'));
  await mkdir(join(outputRoot, 'axe'));
  return outputRoot;
}

// A passing check removes its screenshots and axe reports so repeated verifies
// do not fill TMPDIR; a failing check, or KEEP_BROWSER_CHECK=1, keeps them.
export async function finishOutputRoot(outputRoot, { passed, keep = process.env.KEEP_BROWSER_CHECK === '1' }) {
  if (!passed || keep) return false;
  await rm(outputRoot, { recursive: true, force: true });
  return true;
}
