// Synthetic ground truth. The archived ticket is deliberately absent from List
// Tickets. Two different attachment ids have identical customer bytes.
export const origin = 'https://fixture-zendesk.zendesk.com';
export const key = JSON.stringify({ client_id: 'fixture-synthetic-zendesk-client-id', client_secret: 'synthetic-fixture-synthetic-zendesk-client-secret' });
export const token = 'synthetic-synthetic-zendesk-oauth-token';
export const blob = Buffer.from('original customer attachment\n');
export const largeBlob = Buffer.alloc(3 * 1024 * 1024, 65);
export const attachment = id => ({ id, file_name: `file-${id}.txt`, size: blob.length, content_type: 'text/plain', content_url: `${origin}/attachments/token-${id}/file.txt?download=1` });
export function fixture(large = false) {
 const attached = id => ({ ...attachment(id), ...(large ? { size: largeBlob.length } : {}) });
 const tickets = [
  { id: 10, status: 'open', subject: 'earlier version', generated_timestamp: 100, encoded_id: 'encoded-old-reply', via: { source: { from: { address: 'old@example.test' }, to: { address: 'support@example.test' }, rel: null } }, metadata: { system: { client: 'original-client', ip_address: '192.0.2.8' } } },
  { id: 20, status: 'deleted', generated_timestamp: 110 },
  { id: 900001, status: 'closed', subject: 'Archived high id', generated_timestamp: 120, archived: true },
 ];
 const secretShape = ['ghp', 'fixtureCredentialMustBeRemoved'].join('_');
 const comments = {
  10: [{ id: 101, public: true, body: `old reply ${secretShape}`, html_body: `<p>Original reply <img src="${attached(501).content_url}" alt="Customer attachment"></p>`, attachments: [attached(501)] }, { id: 102, public: false, body: 'Private customer note', html_body: '<p>Private customer note <a href="/attachments/token/inline/file.txt">Download attachment</a></p>', attachments: [attached(502), { id: 503, deleted: true, size: 0 }, { id: 504, size: 9, malware_scan_result: 'malware_found' }] }],
  900001: [{ id: 901, public: true, body: large ? 'Archived '.repeat(18_000) : 'Archived reply', attachments: [] }, { id: 902, public: false, body: 'Private archived reply', attachments: [] }],
 };
 return { tickets, latest: { ...tickets[0], subject: 'last version', generated_timestamp: 130 }, comments,
  users: [{ id: 1, name: 'Active', active: true, email: 'person@example.test' }, { id: 2, name: 'Inactive no email', active: false, email: null }],
  organizations: [{ id: 3, name: 'Fixture organization' }], ticket_fields: [{ id: 4, type: 'text', title: 'Original field' }],
  user_segments: [{ id: 5, name: 'Original restricted segment', group_ids: [3], organization_ids: [3], tags: ['original'] }],
  categories: [{ id: 6, name: 'Original category' }], sections: [{ id: 7, category_id: 6, name: 'Original section' }],
  articles: [{ id: 8, locale: 'en-us', source_locale: 'en-us', draft: true, user_segment_id: 5, user_segment_ids: [5], title: 'Restricted draft', body: '<p>Original body</p>' }],
  translations: [{ id: 9, locale: 'fr', title: 'Original translation' }], article_attachments: [{ ...attached(505), article_id: 8 }] };
}
