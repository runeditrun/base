import { caseRow, runCases } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { NodePinnedTransport } from '../../core/node-transport.ts';
import { deniedAddresses, publicAddresses } from './public-address-cases.ts';

test('production transport checks every DNS answer before any HTTPS connection', async t => {
  const originalLookup = dns.lookup, originalRequest = https.request;
  let answers: { address: string; family: number }[] = [], connects = 0, lookups = 0;
  const reachedConnection = new Error('Test connection boundary reached');
  const host = 'receiver.example.com';
  // Each leaf owns the network module bindings and counters.
  async function withAnswers(run: () => Promise<void>) {
    answers = []; connects = 0; lookups = 0;
    dns.lookup = (async (hostname: string, options: unknown) => {
    lookups++;
    assert.equal(hostname, host);
    assert.deepEqual(options, { all: true, verbatim: true });
    return answers;
  }) as typeof dns.lookup;
  https.request = ((url: URL, options: https.RequestOptions) => {
    connects++;
    assert.equal(url.hostname, host);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    options.lookup!(host, { family: 0, hints: 0, all: false }, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, answers[0]!.address); assert.equal(family, answers[0]!.family);
    });
    options.lookup!(host, { family: 0, hints: 0, all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [answers[0]]);
    });
    // A test-only boundary prevents real network I/O even when the unfixed guard permits an address.
    throw reachedConnection;
  }) as typeof https.request;
  syncBuiltinESMExports();
    try { await run(); }
    finally {
      dns.lookup = originalLookup; https.request = originalRequest; syncBuiltinESMExports();
      answers = []; connects = 0; lookups = 0;
    }
  }
  const answer = (address: string) => ({ address, family: address.includes(':') ? 6 : 4 });
  const send = () => new NodePinnedTransport().send({ url: `https://${host}/events`, headers: {}, body: '{}' });

    await runCases(t, [['DNS rejects every denied address alone and in either mixed order', async row => {
      for (const address of deniedAddresses) await caseRow(row, `DNS rejects ${address} alone and in either mixed order`, async (t) => {
        await runCases(t, Array.from([[address], ['8.8.8.8', address], [address, '2606:4700:4700::1111']], (values, rowIndex) => [`${t.name}: values row ${rowIndex + 1}`, async t => {
        await withAnswers(async () => {
          answers = values.map(answer); const before = connects;
          await assert.rejects(send(), /Destination DNS is not public/, JSON.stringify(values));
          assert.equal(connects, before, JSON.stringify(values));

        });
}]));
      });
    }], ['empty and malformed answers reject', async (t) => {
      await runCases(t, Array.from([[], ['bad-address'], ['2606:::1'], ['8.8.8.256']], (values, rowIndex) => [`${t.name}: values row ${rowIndex + 1}`, async t => {
        await withAnswers(async () => {
        answers = values.map(answer); const before = connects;
        await assert.rejects(send(), /Destination DNS is not public/, JSON.stringify(values));
        assert.equal(connects, before, JSON.stringify(values));

        });
}]));
    }], ['public answers pin the first address with the original TLS hostname and no second resolution', async (t) => {
      await runCases(t, Array.from(publicAddresses, (address, rowIndex) => [`${t.name}: address row ${rowIndex + 1}`, async t => {
        await withAnswers(async () => {
        answers = [answer(address), answer('8.8.4.4')]; const before = lookups;
        await assert.rejects(send(), error => error === reachedConnection);
        assert.equal(lookups, before + 1);

        });
}]));
    }]]);

});
