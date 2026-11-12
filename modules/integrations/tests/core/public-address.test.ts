import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, validateDestination, declareEgress, validateEgressConfiguration } from '../../index.ts';
import { deniedAddresses, publicAddresses, literalUrl } from './public-address-cases.ts';

const declaration = declareEgress({
  id: 'public-events', required: true, provider: { id: 'receiver', name: 'Receiver' },
  destination: { kind: 'custom', id: 'events', description: 'Event receiver' },
  why: 'Send authorized events.', dataFields: ['event'], adapters: ['integrations.webhook.v1'], custody: [],
});
function save(address: string) {
  return validateEgressConfiguration(declaration, {
    providerId: 'receiver', destinationId: 'events', destinationUrl: literalUrl(address), secrets: {},
  });
}
// Every range endpoint and spelling remains a security assertion. Register each
// boundary once; the address table is one refusal behaviour, not separate flows.
test('public-address policy rejects every denied range endpoint and spelling', () => {
  for (const address of deniedAddresses) assert.equal(isPublicAddress(address), false, address);
});
test('literal configuration rejects every denied range endpoint and spelling', () => {
  for (const address of deniedAddresses) {
    assert.throws(() => validateDestination(literalUrl(address)), /not public/, address);
    assert.throws(() => save(address), /Invalid public HTTPS egress destination/, address);
  }
});
test('public controls remain valid for the portable guard and saved egress configuration', () => {
  for (const address of publicAddresses) {
    assert.equal(isPublicAddress(address), true, address);
    assert.ok(validateDestination(literalUrl(address)));
    assert.equal(save(address).destinationId, 'events');
  }
});
test('portable guard rejects noncanonical IPv4 spellings', () => {
  for (const address of ['0177.0.0.1', '010.0.0.1', '08.8.8.8', '8.08.8.8', '8.8.08.8',
    '8.8.8.08', '8.00.0.1', '8.0.000.1', '8.8.8.0000', '0008.8.8.8', '８.８.８.８',
    '8\n.8.8.8', '8.8\n.8.8', '8.8.8\n.8', '8.8.8.8\n', '8.8.8.8\r']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});
test('canonical decimal IPv4 and single-zero octets retain their public/private policy', () => {
  for (const address of ['177.0.0.1', '8.0.0.1', '8.8.8.0']) {
    assert.equal(isPublicAddress(address), true, address);
    assert.equal(validateDestination(literalUrl(address)).hostname, address);
    assert.equal(save(address).destinationUrl, literalUrl(address));
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '0.0.0.0', '0.8.8.8']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});
test('WHATWG-normalized private IPv4 aliases still reject at both save boundaries', () => {
  for (const host of ['0177.0.0.1', '012.0.0.1', '0x7f000001', '2130706433', '１２７.０.０.１']) {
    assert.throws(() => validateDestination(literalUrl(host)), /not public/);
    assert.throws(() => save(host), /Invalid public HTTPS egress destination/);
  }
});
test('malformed addresses reject and URL-normalized private aliases cannot bypass saving', () => {
  for (const address of ['', 'example.com', '8.8.8.256', '8.8.8', '8.8.8.8.8', '-1.1.1.1',
    '2606:::1', '2606::1::2', '2606:12345::1', '2606:1:2:3:4:5:6', '2606:1:2:3:4:5:6:7:8',
    '2606:1:2:3:4:5:6:7::', 'fe80::1%eth0', '2606::1%eth0', ' 2606::1', '2606::1/32']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const host of ['2130706433', '0x7f000001', '0177.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:8.8.8.8]']) {
    assert.throws(() => validateDestination(`https://${host}/`), /not public/);
  }
});
