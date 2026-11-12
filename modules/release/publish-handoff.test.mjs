import { caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffFixture } from './publish-handoff-fixture.mjs';

test('generated POSIX handoff requires command success for every pinned output', async t => {
  const f = handoffFixture(t);
  const commands = f.handoff.split('```sh\n')[1].split('\n```')[0].split('\n');
  const pushes = commands.filter(line => line.startsWith('release_git push '));
  assert.deepEqual(pushes, [`release_git push --atomic --no-follow-tags -- '${f.destination.url}' '${f.receipt.publicExport.commit}:refs/heads/main' '${f.receipt.publicExport.tagObject}:refs/tags/v1.2.3'`]);
  assert.equal(commands.at(-1), pushes[0]);
  // Execute only the actual generated guards. Publication is replaced by a marker.
  const guards = commands.slice(0, -1).concat(': > "$artifact/push-point"').join('\n');
  assert.doesNotMatch(guards, /release_git push /);

  const rows = [['successful real commands reach the marker from an unrelated cwd with shell metacharacters in the path', () => {
    const result = f.run(guards);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.reachedPush, true);
    assert.deepEqual(result.operations.map(operation => operation.label), Object.keys(f.expected));
    for (const operation of result.operations) {
      assert.equal(operation.status, 0);
      assert.equal(operation.stdout.replace(/\n+$/, ''), f.expected[operation.label]);
    }
  }]];

  for (const [guard, expected] of Object.entries(f.expected)) {
    rows.push([`${guard}: exact expected stdout with failed command status stops before publication`, () => {
      const result = f.run(guards, guard);
      assert.notEqual(result.status, 0);
      assert.equal(result.reachedPush, false);
      const operation = result.operations.at(-1);
      assert.ok(operation, result.stderr);
      assert.equal(operation.label, guard, result.stderr);
      assert.equal(operation.underlyingStatus, 0);
      assert.equal(operation.status, 79);
      assert.equal(operation.stdout.replace(/\n+$/, ''), expected);
    }]);
  }
  await caseRows(t, rows);
});
