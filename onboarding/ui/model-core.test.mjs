import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallerModel } from '../setup-manifest.mjs';

const manifest = {
  schema: 1, title: 'Example',
  fields: [{ name: 'TITLE', label: 'Title', kind: 'text', required: true, group: 'details' }, { name: 'REGION', label: 'Region', kind: 'select', required: true, group: 'location', options: [{ value: 'east', label: 'East' }, { value: 'west', label: 'West' }] }],
  groups: [{ id: 'details', label: 'Details' }, { id: 'location', label: 'Location' }],
  steps: [{ type: 'extension', id: 'fixture' }],
};
const presentation = { product: { name: 'Example' } };
test('manifest alone controls required fields without hosting, owner or artwork', () => {
  const model = createInstallerModel(manifest, presentation);
  assert.deepEqual(model.initialDraft({ draft: { TITLE: 'Team', password: 'private' } }), { TITLE: 'Team' });
  assert.deepEqual(model.setupModel({ TITLE: 'Team' }).missing, ['REGION']);
  assert.equal(model.nextIncompleteGroup({ TITLE: 'Team' }), 'location');
  const ready = { TITLE: 'Team', REGION: 'west' };
  assert.equal(model.setupModel(ready).ready, true);
  assert.deepEqual(model.installInput(ready), ready);
  assert.deepEqual(model.hostingModel(ready), { complete: true, accessReady: false });
});
test('agent updates preserve pending local answers and never merge unknown fields', () => {
  const model = createInstallerModel(manifest, presentation), draft = { TITLE: 'Local', REGION: 'east' };
  const result = model.mergeAgentDraft(draft, { draft: { TITLE: 'Agent', REGION: 'west', password: 'private' }, lastUpdate: { revision: 2, source: 'agent', keys: ['TITLE', 'REGION', 'password'] } }, 1, ['TITLE']);
  assert.deepEqual(result, { TITLE: 'Local', REGION: 'west' });
});

test('saved answers override defaults and edition secrets use declared readiness bindings', () => {
  const fields = manifest.fields.map(field => ({ ...field, default: field.name === 'TITLE' ? 'Default' : 'east' }));
  fields.push({ name: 'CREDENTIAL', label: 'Credential', kind: 'secret', input: 'entered', ownerVisible: true, required: true, when: { field: 'TITLE', nonEmpty: true } });
  const model = createInstallerModel({ ...manifest, fields }, presentation);
  assert.deepEqual(model.initialDraft({ draft: { TITLE: 'Saved' } }), { TITLE: 'Saved', REGION: 'east' });
  const draft = { TITLE: 'Saved', REGION: 'east' };
  assert.equal(model.setupModel(draft, { secretReadiness: { CREDENTIAL: true, scopes:{CREDENTIAL:{TITLE:'Saved'}} } }).ready, true);
  assert.deepEqual(model.setupModel(draft, { secretReadiness: { CREDENTIAL: true, scopes:{CREDENTIAL:{TITLE:'Different'}} } }).missing, ['CREDENTIAL']);
});

test('local hosting choices are preselected only by an explicit edition feature', () => {
  const declared = createInstallerModel(manifest, { ...presentation, features: { hosting: true, localTrialWithoutEmail: true } });
  const undeclared = createInstallerModel(manifest, { ...presentation, features: { hosting: true } });

  assert.equal(declared.initialDraft({}).target, 'local');
  assert.equal(declared.initialDraft({ draft: { target: 'remote' } }).target, 'remote');
  assert.equal(undeclared.initialDraft({}).target, undefined);
});

test('summary includes answered values and only manifest defaults', () => {
  const plain = createInstallerModel(manifest, presentation);
  const declared = createInstallerModel({ ...manifest, fields: manifest.fields.map(field => field.name === 'REGION' ? { ...field, default: 'east' } : field) }, presentation);

  assert.deepEqual(plain.summaryKeys({ TITLE: 'Team', REGION: 'east' }), []);
  assert.deepEqual(plain.summaryKeys({ TITLE: 'Team', REGION: 'east' }, { answered: ['TITLE'], sources: { REGION: 'agent' } }), ['TITLE', 'REGION']);
  assert.deepEqual(declared.summaryKeys({ TITLE: 'Team', REGION: 'east' }), ['REGION']);
});

test('failed-install details use the actual command output and installer log path', () => {
  const model = createInstallerModel(manifest, presentation);
  const details = model.failureDetails({
    phase: 'failed',
    step: 'Build workspace',
    logs: ['Build workspace', 'The build stopped on a missing file.'],
    error: 'Build workspace: exit 7, signal none.\nLast output (up to 40 lines):\nThe build stopped on a missing file.\nLog: /tmp/installer/install.log',
  });
  assert.deepEqual(details, {
    step: 'Build workspace',
    output: 'The build stopped on a missing file.',
    logPath: '/tmp/installer/install.log',
  });
  assert.equal(model.failureNote(details), 'Output from Build workspace is shown above. Installer log: /tmp/installer/install.log');
});

test('failed-install details do not invent output when the command recorded none', () => {
  const model = createInstallerModel(manifest, presentation);
  const details = model.failureDetails({
    step: 'Installing the workspace',
    error: 'Installing the workspace: exit 1, signal none.\nLast output (up to 40 lines):\n(no output)\nLog: /tmp/state/installer.log',
  });
  assert.deepEqual(details, {
    step: 'Installing the workspace',
    output: '',
    logPath: '/tmp/state/installer.log',
  });
  assert.equal(model.failureNote(details), 'Installation stopped during Installing the workspace. Review the installation activity above. Installer log: /tmp/state/installer.log');
});

test('a child log marker cannot replace the final installer path or truncate output', () => {
  const model = createInstallerModel(manifest, presentation);
  const output = 'compiler output\nLog: application-build.log\nfinal compiler failure';
  const details = model.failureDetails({
    step: 'Build workspace',
    error: `Build workspace: exit 23, signal none.\nLast output (up to 40 lines):\n${output}\nLog: /tmp/installer/install.log`,
  });
  assert.deepEqual(details, {
    step: 'Build workspace',
    output,
    logPath: '/tmp/installer/install.log',
  });
  assert.equal(model.failureNote(details), 'Output from Build workspace is shown above. Installer log: /tmp/installer/install.log');
});

test('a failure without command capture still gives the actual last-step guidance', () => {
  const model = createInstallerModel(manifest, presentation);
  const details = model.failureDetails({ step: 'Preparing the workspace', error: 'Installation stopped unexpectedly.' });
  assert.deepEqual(details, { step: 'Preparing the workspace', output: '', logPath: '' });
  assert.equal(model.failureNote(details), 'Installation stopped during Preparing the workspace. Review the installation activity above.');
});
