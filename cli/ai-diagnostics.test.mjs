import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

test('rer check and doctor report ambiguous AI transport and unsafe live-dev key storage without exposing keys', async t => {
  const seed = await portabilityFixture(t, { generated: false });
  const keys = ['synthetic-direct-key', 'mdl_synthetic_dev_key_for_diagnostics'];
  await writeFile(join(seed.root, '.dev.vars'), `AI_ENABLED=true\nAI_BASE_URL=https://direct.example/v1\nAI_API_KEY=${keys[0]}\nMODELS_SERVICE=https://models.example\nMODELS_KEY=${keys[1]}\n`, { mode: 0o600 });
  const check = await seed.run(['check'], 1), doctor = await seed.run(['doctor'], 3);
  assert.ok(check.at(-1).clauses.some(x => !x.ok && x.message?.includes('ai_misconfigured')));
  assert.ok(doctor.at(-1).diagnostics.ai.issues.some(x => x.code === 'ai_misconfigured'));
  for (const key of keys) assert.ok(!JSON.stringify([check, doctor]).includes(key));
  await writeFile(join(seed.root, '.dev.vars'), 'AI_ENABLED=false\n');
  await seed.run(['check']);
  await mkdir(join(seed.root, '.rer/local'), { recursive: true, mode: 0o700 });
  await chmod(join(seed.root, '.rer'), 0o700);
  await writeFile(join(seed.root, '.rer/local/models.json'), JSON.stringify({ service: 'https://models.example', key: keys[1] }), { mode: 0o644 });
  const unsafe = await seed.run(['check'], 1);
  assert.ok(unsafe.at(-1).clauses.some(x => !x.ok && x.message?.includes('permissions')));
  await chmod(join(seed.root, '.rer/local/models.json'), 0o600);
  await seed.run(['check']);
  await seed.run(['reset', '--yes']);
  await seed.run(['check']);
});
