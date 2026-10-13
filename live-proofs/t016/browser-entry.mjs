import { browserJourney } from '../../scripts/qualification/browser.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
try {
  insist(process.platform === 'linux' && process.env.T016_BROWSER_CONTAINER === '1', 'isolated-browser-required');
  insist(!Object.keys(process.env).some(k => /(?:TOKEN|SECRET|API_KEY|PASSWORD)/.test(k) && process.env[k]), 'browser-provider-environment');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; insist(input.length < 64000, 'browser-input-too-large'); }
  const { chromium } = await import('/opt/browser/node_modules/playwright/index.mjs');
  // stdin contains only generated app-session/test inputs, never provider keys.
  console.log(JSON.stringify(await browserJourney(JSON.parse(input), chromium)));
} catch { console.error('Hosted browser journey failed.'); process.exitCode = 1; }
