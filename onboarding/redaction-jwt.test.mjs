import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedaction } from './redaction.mjs';

const short = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.test-signature';
const long = 'eyJ' + 'a'.repeat(750) + '.' + 'b'.repeat(750) + '.test-long-signature';
for (const prefix of ['session-', 'session_', 'x', 'x-', '9']) {
 for (const [size, jwt] of [['short', short], ['1.5 KB', long]]) {
  for (const unit of [0, 1, 3, 4096]) test(`JWT ${size} after ${prefix}: ${unit ? unit + '-byte stream' : 'whole text'}`, () => {
   const redaction = createRedaction(), input = `${prefix}${jwt} end`;
   let output = '';
   if (!unit) output = redaction.redact(input);
   else {
    const stream = redaction.stream(chunk => { output += chunk; }), bytes = Buffer.from(input);
    for (let offset = 0; offset < bytes.length; offset += unit) stream.write(bytes.subarray(offset, offset + unit));
    stream.end();
   }
   assert.equal(output, `${prefix}[REDACTED] end`, 'JWT leaked or nearby diagnostics changed');
  });
 }
}
