import { basename } from 'node:path';

export const configKeyLimit = 200;

const directories = new Set(['config', 'configs', 'configuration', 'conf', '.github', '.circleci', '.buildkite',
 'deploy', 'deployment', 'deployments', 'helm', 'chart', 'charts', 'k8s', 'kubernetes', 'terraform', 'infra', 'infrastructure']);
const dataDirectories = new Set(['fixture', 'fixtures', '__fixtures__', 'test', 'tests', '__tests__',
 'translation', 'translations', 'locale', 'locales', 'i18n', 'l10n', 'sample', 'samples', 'export', 'exports',
 'snapshot', 'snapshots', '__snapshots__', 'generated', 'output', 'dist', 'build', 'coverage']);

// Data locations override config names: fixtures/config/settings.json is still
// a fixture. This policy only controls config keys; vendor extractors still run.
export function configuration(path) {
 const lower = path.toLowerCase(), parts = lower.split('/'), name = basename(lower);
 if (parts.slice(0, -1).some(part => dataDirectories.has(part))) return false;
 if (/(?:^|[._-])(?:lock|lockfile|generated|min|bundle)(?:[._-]|$)/.test(name) ||
  /^(?:npm-shrinkwrap|composer\.lock|cargo\.lock)/.test(name)) return false;
 return parts.slice(0, -1).some(part => directories.has(part)) ||
  /^(?:docker-)?compose(?:[._-].*)?\.ya?ml$/.test(name) ||
  /^(?:wrangler|serverless|settings|appsettings[^.]*|pulumi)\./.test(name) ||
  /^(?:app\.(?:json|ya?ml)|vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|chart\.ya?ml|values(?:[._-].*)?\.ya?ml)$/.test(name) ||
  /(?:^|\.)config\.(?:[cm]?[jt]s|jsonc?|ya?ml|toml)$/.test(name) ||
  /^(?:\.gitlab-ci|azure-pipelines|\.travis|bitbucket-pipelines)(?:[._-].*)?\.ya?ml$/.test(name) ||
  /^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/.test(name);
}
