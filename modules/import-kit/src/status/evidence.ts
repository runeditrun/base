import { receiptSha256 as sha256 } from '../receipt/encoding.ts';
import { verifyImporterVerificationReceipt } from '../receipt/index.ts';
import type { ImporterVerificationReceipt } from '../receipt/types.ts';
import type {
  ImporterEvidenceArtifact,
  ImporterEvidencePort,
  ImporterRecord,
  ImporterValidationIssue,
  ImporterValidationResult,
  VerifiedImporter,
} from './types.ts';

interface ImporterEvidenceReference extends ImporterEvidenceArtifact {
  research?: ImporterEvidenceArtifact;
}

const maximumEvidenceBytes = 8 * 1024 * 1024;

export async function validateImporterEvidence(
  records: ImporterRecord[],
  evidence: ImporterEvidencePort | undefined,
  issues: ImporterValidationIssue[],
): Promise<ImporterValidationResult['evidence']> {
  const counters: ImporterValidationResult['evidence'] = { required: 0, resolved: 0, verifiedReceipts: 0 };
  if (!evidence || typeof evidence.resolve !== 'function' || !Array.isArray(evidence.trustedHosts)
    || !evidence.trustedHosts.every((host) => typeof host === 'string' && host.length > 0 && host.trim() === host)) {
    issues.push({ code: 'EVIDENCE_PORT_REQUIRED', path: '$', message: 'Supply a resolver for linked artifact bytes and trusted publisher hosts.' });
    return counters;
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const path = `$.importers[${index}]`;
    const reference = record.evidence as ImporterEvidenceReference;
    const receipt = await resolveAndCheckArtifact(reference, evidence, `${path}.evidence`, issues, counters);
    if (!receipt) continue;

    if (record.status === 'verified') {
      const research = await resolveAndCheckArtifact(reference.research!, evidence, `${path}.evidence.research`, issues, counters);
      if (!research) continue;
      if (await verifyReceipt(receipt.bytes, research.bytes, record, evidence, path, issues)) counters.verifiedReceipts += 1;
    }
  }

  return counters;
}

async function resolveAndCheckArtifact(
  reference: ImporterEvidenceArtifact,
  evidence: ImporterEvidencePort,
  path: string,
  issues: ImporterValidationIssue[],
  counters: ImporterValidationResult['evidence'],
): Promise<{ url: string; bytes: Uint8Array } | undefined> {
  counters.required += 1;
  if (reference.link.trim() !== reference.link || reference.link.length === 0) {
    issues.push({ code: 'EVIDENCE_LINK_INVALID', path: `${path}.link`, message: 'Evidence links must be non-empty and trimmed.' });
    return undefined;
  }

  let linkUrl: URL;
  try {
    linkUrl = new URL(reference.link);
  } catch {
    issues.push({ code: 'EVIDENCE_LINK_INVALID', path: `${path}.link`, message: 'Evidence link must be an absolute HTTPS or evidence URL.' });
    return undefined;
  }
  if (linkUrl.protocol !== 'https:' && linkUrl.protocol !== 'evidence:') {
    issues.push({ code: 'EVIDENCE_LINK_SCHEME', path: `${path}.link`, message: 'Evidence links must use HTTPS or the consumer evidence scheme.' });
    return undefined;
  }
  if (linkUrl.username || linkUrl.password
    || [...linkUrl.searchParams.keys()].some((key) => /token|password|secret|api[_-]?key|authorization/i.test(key))) {
    issues.push({ code: 'EVIDENCE_LINK_CREDENTIALS', path: `${path}.link`, message: 'Evidence links cannot embed credentials.' });
    return undefined;
  }
  if (linkUrl.protocol === 'https:' && !isTrustedHost(linkUrl.hostname, evidence.trustedHosts)) {
    issues.push({ code: 'EVIDENCE_PUBLISHER_UNTRUSTED', path: `${path}.link`, message: 'The evidence host is not pinned by the consumer.' });
    return undefined;
  }

  let resolved: { url: string; bytes: Uint8Array } | undefined;
  try {
    resolved = await evidence.resolve(reference.link);
  } catch {
    issues.push({ code: 'EVIDENCE_RESOLUTION_FAILED', path: `${path}.link`, message: 'The evidence resolver could not resolve this link.' });
    return undefined;
  }
  if (!resolved) {
    issues.push({ code: 'EVIDENCE_NOT_FOUND', path: `${path}.link`, message: 'The linked evidence artifact was not found.' });
    return undefined;
  }
  if (resolved.url !== reference.link) {
    issues.push({ code: 'EVIDENCE_URL_MISMATCH', path: `${path}.link`, message: 'Resolved evidence URL differs from the requested link.' });
    return undefined;
  }
  if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength < 1 || resolved.bytes.byteLength > maximumEvidenceBytes) {
    issues.push({ code: 'EVIDENCE_BYTES_INVALID', path: `${path}.link`, message: `Evidence bytes must be between 1 and ${maximumEvidenceBytes} bytes.` });
    return undefined;
  }

  const snapshot = new Uint8Array(resolved.bytes);
  counters.resolved += 1;
  if (snapshot.byteLength !== reference.size) {
    issues.push({ code: 'EVIDENCE_SIZE_MISMATCH', path: `${path}.size`, message: 'Resolved bytes do not match the declared evidence size.' });
    return undefined;
  }
  if (await sha256(snapshot) !== reference.sha256) {
    issues.push({ code: 'EVIDENCE_HASH_MISMATCH', path: `${path}.sha256`, message: 'Resolved bytes do not match the declared SHA-256.' });
    return undefined;
  }
  return { url: resolved.url, bytes: snapshot };
}

function isTrustedHost(hostname: string, trustedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  return trustedHosts.some((trusted) => trusted.toLowerCase() === normalized);
}

async function verifyReceipt(
  receiptBytes: Uint8Array,
  researchBytes: Uint8Array,
  importer: VerifiedImporter,
  evidence: ImporterEvidencePort,
  path: string,
  issues: ImporterValidationIssue[],
): Promise<boolean> {
  const firstIssue = issues.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
  } catch {
    issues.push({ code: 'RECEIPT_NOT_JSON', path: `${path}.evidence.link`, message: 'The linked verification receipt is not valid UTF-8 JSON.' });
    return false;
  }

  const policy = evidence.receiptTrustPolicy ?? {
    environment: 'unrestricted',
    keys: Object.fromEntries(Object.entries(evidence.receiptPublicKeys ?? {}).map(([keyId, publicKey]) => [keyId, { publicKey }])),
  };
  const verified = await verifyImporterVerificationReceipt(parsed, policy, path);
  issues.push(...verified.issues);
  if (!verified.valid) return false;
  const receipt = parsed as ImporterVerificationReceipt;

  const payload = receipt.payload;
  if (payload.incumbent !== importer.incumbent || payload.product !== importer.product) {
    issues.push({ code: 'RECEIPT_PAIR_MISMATCH', path: `${path}.receipt.payload`, message: 'Receipt incumbent and product do not match the catalog row.' });
  }
  if (await sha256(researchBytes) !== payload.research.sha256 || payload.research.sha256 !== importer.evidence.research.sha256) {
    issues.push({ code: 'RESEARCH_HASH_MISMATCH', path: `${path}.receipt.payload.research.sha256`, message: 'The finished research artifact does not match the signed receipt.' });
  }

  return issues.length === firstIssue;
}
