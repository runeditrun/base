import { jsonRequest } from './http.mjs';
import { insist, digest } from './operations.mjs';

// An owner selection is mandatory. Adding a provider requires a reviewed
// implementation of snapshot/readNew; arbitrary adapter paths are never loaded.
export function selectMailbox(env) {
  insist(env.T016_MAILBOX_ADAPTER, 'mailbox-choice-pending');
  insist(env.T016_MAILBOX_ADAPTER === 'gmail', 'mailbox-adapter-unsupported');
  return gmailMailbox({ token: env.T016_GMAIL_ACCESS_TOKEN, address: env.T016_TEST_MAILBOX });
}

// Real Gmail API readback. A SendGrid 202 or an app delivery row cannot satisfy
// this check. The token needs gmail.readonly for the dedicated test mailbox.
export function gmailMailbox({ token, address }) {
  insist(token && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address ?? ''), 'mailbox-unconfigured');
  const headers = { Authorization: `Bearer ${token}` };
  const get = path => jsonRequest(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers });
  const list = async () => {
    const result = await get('messages?maxResults=100&q=' + encodeURIComponent('in:anywhere newer_than:1d subject:"HappyToHelp email verification"'));
    insist(!result.nextPageToken, 'mailbox-window-overflow');
    return (result.messages ?? []).map(x => x.id);
  };
  return {
    async snapshot() {
      const profile = await get('profile');
      insist(profile.emailAddress?.toLowerCase() === address.toLowerCase(), 'mailbox-identity-mismatch');
      return new Set(await list());
    },
    async readNew(before, sender, sentAfter, correlation) {
      insist(/^t016-[a-f0-9]{32}$/.test(correlation ?? ''), 'mailbox-correlation-missing');
      for (let attempt = 0; attempt < 12; attempt++) {
        for (const id of await list()) {
          if (before.has(id)) continue;
          insist(/^[a-f0-9]+$/.test(id), 'mailbox-invalid-id');
          const message = await get(`messages/${id}?format=full`);
          const header = name => (message.payload?.headers ?? []).find(h => h.name.toLowerCase() === name)?.value ?? '';
          const containsAddress = (value, address) => value.toLowerCase().split(/[\s<>,]+/).includes(address.toLowerCase());
          const body = part => Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8') + (part.parts ?? []).map(body).join('\n');
          if (Number(message.internalDate) < sentAfter || !containsAddress(header('to'), address) || !containsAddress(header('from'), sender) ||
            !header('from').includes(`Qualification ${correlation}`)) continue;
          insist(header('subject') === 'HappyToHelp email verification' && header('message-id') &&
            body(message.payload).includes('Your configured HappyToHelp email provider delivered this verification message.'), 'mailbox-content-mismatch');
          return { adapter: 'gmail', mailboxMessageId: id, messageId: header('message-id'),
            receivedUtc: new Date(Number(message.internalDate)).toISOString(), correlation,
            contentSha256: digest(body(message.payload)) };
        }
        if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 5000));
      }
      throw new Error('mailbox-message-absent');
    },
  };
}
