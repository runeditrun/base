export const fixturePolicy={
  product:'synthetic-portable-product',partBytes:4096,excludeTables:['private_notes'],
  secretColumns:{effects:['credential']},replaceableTables:['settings'],requiredConfiguration:['PROVIDER_KEY'],
  buckets:{FILES:{objectReferences:{table:'files',keyColumn:'key'}}},
  exportRow(table,row){if(table==='effects'){row.enabled=0;if(row.delivery==='queued')row.delivery='review';}return row;},
};
