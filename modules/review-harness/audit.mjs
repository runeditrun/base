import { pageState, snapshotCollection } from './collect.mjs';
import { loadDependencies } from './versions.mjs';
import { safeUrl, sanitize } from './privacy.mjs';
import { settle, keyboardCheck } from './settle.mjs';
import { evaluateGates } from './gates.mjs';

export const AXE_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);

// The audit has no filesystem or image dependency. Every required capture
// runs the same checks, regardless of which images its policy retains.
export async function audit(page, name, options) {
  return finishAudit(page, name, options, await prepareAudit(page, options));
}

// Internal phases let capture preserve the selected view before Tab moves focus.
// The public audit always runs both phases and never makes an image.
export async function prepareAudit(page, options) {
  const state = pageState(page);
  const { secrets = state.secrets, cwd } = options;
  if (options.keyboard === false && !options.keyboardReason?.trim()) throw new TypeError('Disabling keyboard requires keyboardReason');
  const width = page.viewportSize()?.width;
  if (!width) throw new Error('Capture requires an explicit viewport');
  const { AxeBuilder } = loadDependencies(cwd);
  try { await settle(page, options); }
  catch { state.errors.settle.push('Page did not settle within its bound'); }
  return { state, secrets, width, AxeBuilder };
}

export async function finishAudit(page, name, options, { state, secrets, width, AxeBuilder }) {
  const result = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
  const violations = result.violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, targets: nodes.map(node => node.target) }));
  const counts = { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 };
  for (const violation of violations) counts[violation.impact ?? 'unknown']++;
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  const html = await page.content();
  const secretsFound = secrets.flatMap((value, index) => value && html.includes(value) ? [index] : []);
  const keyboard = await keyboardCheck(page, options);
  const entry = sanitize({ name, width, path: safeUrl(page.url(), secrets, true),
    axe: { counts, violations }, overflow, ...snapshotCollection(state), secretsFound, keyboard,
    documentStatus: state.documentStatus }, secrets);
  entry.gate = evaluateGates(entry, options);
  return entry;
}
