const require = (condition, message) => { if (!condition) throw new Error(message); };

export default async function phaseFixtures({ phase, request, origin, cookie }) {
 require(typeof cookie === 'string' && cookie.length > 0, 'Phase fixtures require the native owner session');
 const issued = await request(new URL('/app/clients', origin).href, {
  method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `Native operations ${phase}` }),
 });
 require(issued.status === 201, `Native client issuance returned HTTP ${issued.status}`);
 const local = await issued.json();
 require(local.token && local.clientId && local.agent?.id && local.agent?.name && local.agent?.specialist, 'Native client issuance omitted its credential or identity');
 const headers = { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' };
 const value = crypto.randomUUID();
 const created = await request(new URL('/api/v1/records', origin).href, { method: 'POST', headers, body: JSON.stringify({ value }) });
 require(created.status === 201, `Native record mutation returned HTTP ${created.status}`);
 const { record, operation } = await created.json();
 require(record?.id && record.value === value && operation?.key && operation.clientId === local.clientId && operation.recordId === record.id, 'Native mutation did not retain client operation custody');
 const receiptUrl = new URL(`/api/v1/operations/${encodeURIComponent(operation.key)}`, origin).href;
 const invalid = await request(receiptUrl, { headers: { Authorization: `Bearer invalid-${crypto.randomUUID()}` } });
 require(invalid.status === 401, 'Native receipt accepted an invalid credential');
 await invalid.body?.cancel();
 const read = await request(receiptUrl, { headers });
 require(read.ok, `Native receipt read returned HTTP ${read.status}`);
 const receipt = await read.json();
 require(receipt.key === operation.key && receipt.clientId === local.clientId && receipt.recordId === record.id && receipt.value === value, 'Native receipt lost its operation custody');
 return { values: { record: { id: record.id }, operation: { key: operation.key } }, clients: { local } };
}
