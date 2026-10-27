import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeSlackText, renderSlackEvent, serializeSlackMessage, slackEventTemplates, validateSlackMessage } from '../../slack/index.ts';

const { default: Ajv } = await import(process.env.SLACK_TEST_AJV_MODULE ?? 'ajv');
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true }).compile(read('block-kit.schema.json'));

test("Slack messages preserve event semantics and neutralize all user control syntax", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['official Slack sample and every emitted event/path validate against documented Block Kit schema', async (t) => {
  assert.equal(validate(read('slack-official-section.json')), true, JSON.stringify(validate.errors));
  await runCases(t, Array.from(Object.keys(slackEventTemplates), (event, rowIndex) => [`${t.name}: event row ${rowIndex + 1}`, async t => {
    const message = renderSlackEvent(event, { title: 'Payment processing', detail: 'Investigating elevated errors.' }, slackEventTemplates);
    await runCases(t, Array.from([undefined, 'CLOCAL123'], (channel, rowIndex) => [`${t.name}: channel row ${rowIndex + 1}`, async t => {
      assert.equal(validate(JSON.parse(serializeSlackMessage(message, channel))), true, JSON.stringify(validate.errors));
}]));
}]));
}]);
foldedCases.push(['schema independently rejects wrong block/text types, length/count limits and illegal optional fields', async (t) => {
  const official = read('slack-official-section.json');
  const invalid = [
    { blocks: [{ type: 'event', text: { type: 'plain_text', text: 'hello' } }] },
    { blocks: [{ type: 'section', text: { type: 'text', text: 'hello' } }] },
    { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hello', emoji: true } }] },
    { blocks: [{ type: 'section', text: { type: 'plain_text', text: '' } }] },
    { blocks: [{ type: 'section', text: { type: 'plain_text', text: 'x'.repeat(3001) } }] },
    { blocks: Array.from({ length: 51 }, () => official.blocks[0]) },
    { blocks: [{ type: 'section', fields: Array.from({ length: 11 }, () => ({ type: 'plain_text', text: 'x' })) }] },
    { blocks: [{ type: 'section', fields: [{ type: 'plain_text', text: 'x'.repeat(2001) }] }] },
    { blocks: [{ type: 'section' }] },
    { ...official, event: 'invented_wrapper' },
  ];
  await runCases(t, Array.from(invalid, (value, rowIndex) => [`${t.name}: value row ${rowIndex + 1}`, async t => {
assert.equal(validate(value), false);
}]));
}]);
foldedCases.push(['templates select event semantics, preserve user text as Slack-escaped literals, support custom events and fail visibly', async t => {

  const data = { title: '<!channel> & title', detail: 'A *literal* detail' };
  await runCases(t, [
['resolved event', async t => {
  assert.match(renderSlackEvent('incident.resolved', data, slackEventTemplates).text, /^Incident resolved:/);
}],
['opened event', async t => {
  assert.equal(renderSlackEvent('incident.opened', data, slackEventTemplates).blocks[0]!.text.text, 'Incident opened: &lt;!channel&gt; &amp; title');
  assert.equal(renderSlackEvent('incident.opened', data, slackEventTemplates).blocks[1]!.text.text, data.detail);
}],
['custom event', async t => {
  const custom = renderSlackEvent('job.done', { count: 7 }, { 'job.done': d => ({ summary: `Finished ${d.count}`, sections: [`${d.count} records`] }) });
  assert.equal(custom.text, 'Finished 7'); assert.equal(validate(custom), true);
}],
['prototype event refuses', async t => {
  assert.throws(() => renderSlackEvent('toString', data, slackEventTemplates), /Unknown/);
}],
['missing event refuses', async t => {
  assert.throws(() => renderSlackEvent('missing', data, slackEventTemplates), /Unknown/);
}],
['empty detail refuses', async t => {
  assert.throws(() => renderSlackEvent('incident.opened', { ...data, detail: '' }, slackEventTemplates), /failed/);
}],
['long detail refuses', async t => {
  assert.throws(() => renderSlackEvent('incident.opened', { ...data, detail: 'x'.repeat(3001) }, slackEventTemplates), /failed/);
}],
['invalid Unicode detail refuses', async t => {
  assert.throws(() => renderSlackEvent('incident.opened', { ...data, detail: '\ud800' }, slackEventTemplates), /failed/);
}]
  ]);
}]);
foldedCases.push(['every Slack control sequence in user content is neutralised in every field the notifier writes', async (t) => {
  await runCases(t, Array.from(injections, (injection, rowIndex) => [`${t.name}: injection row ${rowIndex + 1}`, async t => {
    await runCases(t, Array.from([
      renderSlackEvent('incident.opened', { title: injection, detail: injection }, slackEventTemplates),
      renderSlackEvent('job.done', { name: injection }, { 'job.done': d => ({ summary: `Job ${d.name}`, sections: [`Name ${d.name}`, d.name] }) }),
    ], (message, rowIndex) => [`${t.name}: message row ${rowIndex + 1}`, async t => {
      await runCases(t, Array.from([undefined, 'CLOCAL123'], (channel, rowIndex) => [`${t.name}: channel row ${rowIndex + 1}`, async t => {
        const wire = serializeSlackMessage(message, channel);
        assert.doesNotMatch(wire, /[<>]/, injection);
        assert.equal(validate(JSON.parse(wire)), true, JSON.stringify(validate.errors));
}]));
      assert.equal(message.text.includes(escapeSlackText(injection)), true, injection);
      let blockRow = 0;
      for (const block of message.blocks) {
        await runCases(t, [[`${t.name} > block row ${++blockRow}`, async () => {
          assert.equal(block.text.text.includes(escapeSlackText(injection)), true, injection);
        }]]);
      }
}]));
}]));
  assert.equal(escapeSlackText('<!channel>'), '&lt;!channel&gt;');
  assert.equal(escapeSlackText('&lt;!channel&gt;'), '&amp;lt;!channel&amp;gt;');
  assert.equal(escapeSlackText('<https://evil.example|click>'), '&lt;https://evil.example|click&gt;');
}]);
foldedCases.push(['a plain ampersand round-trips as &amp; and templates need not escape', () => {
  const message = renderSlackEvent('incident.opened', { title: 'Fish & Chips', detail: 'a & b' }, slackEventTemplates);
  assert.equal(message.text, 'Incident opened: Fish &amp; Chips');
  assert.equal(message.blocks[1]!.text.text, 'a &amp; b');
  assert.equal(JSON.parse(serializeSlackMessage(message)).blocks[1].text.text, 'a &amp; b');
  assert.equal(validate(message), true, JSON.stringify(validate.errors));
}]);
foldedCases.push(['hand-built messages with raw angle brackets are refused by validation and serialisation', async (t) => {
  const base = renderSlackEvent('incident.opened', { title: 'ok', detail: 'ok' }, slackEventTemplates);
  await runCases(t, Array.from(injections.filter(value => /[<>]/.test(value)), (injection, rowIndex) => [`${t.name}: injection row ${rowIndex + 1}`, async t => {
    const topLevel = { ...base, text: injection }, block = { ...base, blocks: [{ ...base.blocks[0]!, text: { ...base.blocks[0]!.text, text: injection } }] };
    await runCases(t, Array.from([topLevel, block], (bad, rowIndex) => [`${t.name}: bad row ${rowIndex + 1}`, async t => {
      assert.throws(() => validateSlackMessage(bad), /Unescaped/);
      assert.throws(() => serializeSlackMessage(bad as typeof base), /Unescaped/);
}]));
}]));
}]);
  await runCases(t, foldedCases);
});



const injections = ['<!channel>', '<!here>', '<!everyone>', '<@U123>', '<#C123>', '<!subteam^S123>', '<https://evil.example|click>', '&lt;!channel&gt;'];
