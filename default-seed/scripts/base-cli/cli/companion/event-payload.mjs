// Truncation text is JSON-escaped again in transit. Bound the resulting payload,
// not just its source string, so one progress event cannot block the outbox.
export function boundedEventPayload(payload) {
  const encoded=JSON.stringify(payload);
  if(encoded.length<60000)return payload;
  return {truncated:true,originalCharacters:encoded.length,text:encoded.slice(0,24000)};
}
