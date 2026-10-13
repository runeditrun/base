// Synthetic archive adversaries are test inputs, never application artifacts.
export function tarEntry(name, { type = '0', link = '', body = Buffer.from('test') } = {}) {
  const header = Buffer.alloc(512); const put = (s, offset, n) => header.write(s, offset, n, 'utf8');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12);
  put('        ', 148, 8); put(type, 156, 1); put(link, 157, 100); put('ustar\0', 257, 6); put('00', 263, 2);
  put([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]);
}
