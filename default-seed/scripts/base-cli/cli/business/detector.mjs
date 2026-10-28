// Inspect every outbound string, including locators and repository names. There
// is no diagnostic containing a match, and no value-masking stage.
const shapes = [
 /-----\s*BEGIN\b/i,
 /(?:sk_live_|rk_live_|AKIA|ghp_|gho_|github_pat_|xox[abpr]-)/,
 /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
 /\b(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-[\w-]+)\s+[A-Za-z0-9+/=]+/,
 /\bMII[A-Za-z0-9+/]{40,}={0,2}/,
 /(?:^|[^a-z])(?:TunnelSecret|TunnelID|AccountTag)(?:$|[^a-z])/i,
 /[\u0000-\u001f\u007f]/,
];

function entropy(value) {
 const counts = new Map();
 for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
 let bits = 0;
 for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
 return bits;
}

function highEntropy(text, tokens) {
 for (const match of text.matchAll(tokens)) {
  const value = match[0];
  if (/^[a-f\d]{32,}$/i.test(value) && entropy(value.toLowerCase()) >= 3.5) return true;
  if (entropy(value) >= 4.2) return true;
 }
 return false;
}

/** A known credential shape (private keys, provider token prefixes, JWTs, SSH keys, certificates). */
export const credentialShaped = text => shapes.some(pattern => pattern.test(text));

export function sensitive(text) {
 return credentialShaped(text) || highEntropy(text, /[A-Za-z0-9_+\/=\-]{24,}/g);
}

function sensitivePath(path) {
 // Keep shape checks across the full path, but never combine ordinary path
 // segments into an apparent high-entropy credential.
 return shapes.some(pattern => pattern.test(path)) ||
  path.split('/').some(part => highEntropy(part, /[A-Za-z0-9_+=\-]{24,}/g));
}

export const blockedSignal = signal => Object.entries(signal).some(([key, value]) =>
 typeof value === 'string' && (key === 'locator' || key === 'repo' ? sensitivePath(value) : sensitive(value)));
