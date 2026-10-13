// Independent policy examples: include both endpoints, not values derived from the guard's table.
const ipv4Endpoints = [
  ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
  ['168.63.129.16'], ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'], ['192.0.0.0', '192.0.255.255'],
  ['192.0.2.0', '192.0.2.255'], ['192.31.196.0', '192.31.196.255'],
  ['192.52.193.0', '192.52.193.255'], ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'], ['192.175.48.0', '192.175.48.255'],
  ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'], ['224.0.0.0', '255.255.255.255'],
];
const ipv6Endpoints = [
  ['::', '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['4000::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2620:4f:8000::', '2620:4f:8000:ffff:ffff:ffff:ffff:ffff'],
  ['3ffe::', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff::', '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  // ISATAP interface identifiers can appear under any otherwise-public prefix.
  ['2606:4700::5efe:0:0', '2606:4700::5efe:ffff:ffff'],
  ['2606:4700::200:5efe:0:0', '2606:4700::200:5efe:ffff:ffff'],
  ['::1', '::ffff:7f00:1', '64:ff9b::808:808', '100::1', 'fc00::', 'fe80::', 'ff00::'],
];
function expanded(address: string): string {
  const [left, right] = address.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  return [...a, ...Array(address.includes('::') ? 8 - a.length - b.length : 0).fill('0'), ...b]
    .map(word => word.padStart(4, '0')).join(':');
}
export const deniedAddresses = [...new Set([
  ...ipv4Endpoints.flat(), ...ipv6Endpoints.flat().flatMap(address => [address, expanded(address).toUpperCase()]),
])];
export const publicAddresses = [
  '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0',
  '168.63.129.15', '168.63.129.17', '172.15.255.255', '172.32.0.0',
  '192.1.0.0', '192.31.195.255', '192.31.197.0', '192.52.192.255', '192.52.194.0',
  '192.88.98.255', '192.88.100.0', '192.175.47.255', '192.175.49.0',
  '198.17.255.255', '198.20.0.0', '223.255.255.255',
  '2000::', '2001:200::', '2001:4860:4860::8888', '2003::',
  '2606:4700:4700::1111', '2606:4700::5efd:ffff:ffff', '2606:4700::201:5efe:1:1',
  '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff', '2620:4f:8001::',
  '3ffd:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];
export const literalUrl = (address: string) => `https://${address.includes(':') ? `[${address}]` : address}/events`;
