// Provider protocol fixtures are test-only and never exported by the public module.
export function fixtureMessage() {
  return { deliveryId: 'worker-command-1', from: 'Sender <sender@example.com>', to: ['reader@example.net'], cc: ['copy@example.net'], bcc: ['blind@example.net'], replyTo: 'replies@example.com',
    subject: 'Unicode ✓', text: 'Plain body', html: '<p>HTML body</p>',
    headers: { 'Message-ID': '<new@example.com>', 'In-Reply-To': '<parent@example.com>', References: '<first@example.com> <parent@example.com>' },
    attachments: [{ filename: 'bytes.bin', contentType: 'application/octet-stream', content: Uint8Array.of(0, 255, 128, 10), disposition: 'attachment' }],
    unsubscribe: { url: 'https://example.com/unsubscribe?id=1', oneClick: true },
  };
}
export function fixtureResponse(provider) {
  if (provider === 'sendgrid') return new Response(null, { status: 202, headers: { 'x-message-id': 'sg-worker-receipt' } });
  if (provider === 'resend') return Response.json({ id: 'resend-worker-receipt' });
  return Response.json({ success: true, errors: [], messages: [], result: {
    message_id: 'cf-worker-receipt', delivered: ['reader@example.net'], queued: ['copy@example.net', 'blind@example.net'],
    permanent_bounces: [], suppressed_recipients: [],
  } });
}
