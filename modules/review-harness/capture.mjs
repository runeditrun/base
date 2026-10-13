import { resolve, join } from 'node:path';
import { privateDirectory, privateFile } from './files.mjs';
import { pageState } from './collect.mjs';
import { redact } from './privacy.mjs';
import { prepareAudit, finishAudit } from './audit.mjs';
export { AXE_TAGS } from './audit.mjs';

export const CAPTURE_POLICIES = Object.freeze(['canonical', 'failures', 'exhaustive']);
export function validateCapturePolicy(policy = 'canonical') {
  if (!CAPTURE_POLICIES.includes(policy)) throw new TypeError('capturePolicy must be canonical, failures or exhaustive');
  return policy;
}

export class CaptureError extends Error {
  constructor(entry) { super(`Capture ${entry.name} at ${entry.width}px failed: ${entry.gate.failures.join(', ')}`); this.entry = entry; }
}

export async function capture(page, name, options) {
  const state = pageState(page);
  const { evidence, secrets = state.secrets, onCapture, continueOnFailure = false,
    canonical = false, imageViews = ['full-page'] } = options;
  const policy = validateCapturePolicy(options.capturePolicy);
  if (typeof canonical !== 'boolean') throw new TypeError('canonical must be a boolean');
  if (!Array.isArray(imageViews) || !imageViews.length || imageViews.some(view => !['viewport', 'full-page'].includes(view)) || new Set(imageViews).size !== imageViews.length) {
    throw new TypeError('imageViews must name viewport, full-page or both, without duplicates');
  }
  if (options.keyboard === false && !options.keyboardReason?.trim()) throw new TypeError('Disabling keyboard requires keyboardReason');
  const width = page.viewportSize()?.width;
  if (!width) throw new Error('Capture requires an explicit viewport');
  const slug = redact(name, secrets).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new TypeError('Capture name must contain a letter or number');
  // Reserve the audited state even when its images will be omitted.
  const file = `${width}-${slug}.png`;
  const files = [...new Set([file, ...imageViews.map(view => view === 'full-page' ? file : `${width}-${slug}-viewport.png`)])];
  const keys = files.map(file => resolve(evidence, file));
  if (keys.some(key => state.captureFiles.has(key))) throw new Error(`Duplicate capture state: ${width}-${slug}`);
  for (const key of keys) state.captureFiles.add(key);
  const prepared = await prepareAudit(page, options);
  const selected = policy === 'exhaustive' || policy === 'canonical' && canonical;
  const images = [];
  let imageFailed = false;
  async function retainImages() {
    try {
      await privateDirectory(evidence);
      for (const view of imageViews) {
        const imageFile = view === 'full-page' ? file : `${width}-${slug}-viewport.png`;
        const png = await page.screenshot({ fullPage: view === 'full-page', animations: 'disabled' });
        await privateFile(join(evidence, imageFile), png);
        images.push({ file: imageFile, view, bytes: png.length });
      }
    } catch { imageFailed = true; }
  }
  // Known selected views retain the original pre-Tab image, as before. States
  // omitted by policy are audited without making an image unless they fail.
  if (selected) await retainImages();
  const entry = await finishAudit(page, name, options, prepared);
  if (!selected && !entry.gate.passed) await retainImages();
  if (imageFailed) {
    entry.gate.passed = false;
    entry.gate.failures.push('imageCreation');
  }
  const reason = imageFailed ? 'image-creation-failed' : !entry.gate.passed ? 'failure' : policy === 'exhaustive' ? 'exhaustive' : selected ? 'canonical' : policy === 'failures' ? 'passing-state' : 'noncanonical-state';
  entry.canonical = canonical;
  entry.imageRetention = { kept: images.length > 0, reason, requestedViews: [...imageViews] };
  entry.images = images;
  await onCapture?.(entry);
  if (!entry.gate.passed && !continueOnFailure) throw new CaptureError(entry);
  return entry;
}
