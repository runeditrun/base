import { comments, jsonEntries } from './parsers-syntax.mjs';
import { configNames, tomlEntries, yamlEntries } from './parsers-config.mjs';
import { environmentNames, packageNames } from './parsers-packages.mjs';
import { infrastructureDocument, infrastructureNames } from './parsers-infrastructure.mjs';
import { pulumiNames } from './parsers-pulumi.mjs';

const examples = /(?:^|[/.\-_])(?:examples?|samples?|templates?|fixtures?)(?:[/.\-_]|$)/i;
const manifests = /^(?:package\.json|composer\.json|requirements[^/]*\.txt|pyproject\.toml|gemfile|go\.mod|cargo\.toml)$/;
const code = /\.(?:[cm]?[jt]sx?|py|go|cs)$/i;

function entriesFor(pathname, source) {
 if (/\.jsonc?(?:\.(?:example|sample|template|tpl))?$/i.test(pathname)) return jsonEntries(source);
 if (/\.toml(?:\.(?:example|sample|template|tpl))?$/i.test(pathname)) return tomlEntries(source);
 if (/\.ya?ml(?:\.(?:example|sample|template|tpl))?$/i.test(pathname)) return yamlEntries(source);
 return [];
}

// No I/O, evaluation or diagnostics containing input. Each extractor emits a
// narrow syntactic name at its source, rather than redacting scalar values later.
export function parseNames(relativePath, text) {
 if (typeof relativePath !== 'string' || typeof text !== 'string') return [];
 const pathname = relativePath.replace(/\\/g, '/'), filename = pathname.split('/').at(-1).toLowerCase();
 const ci = /(?:^|\/)(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci(?:[./-]|$)|azure-pipelines[./-]|\.travis[./-]|jenkinsfile$|bitbucket-pipelines[./-]|\.buildkite\/)/i.test(pathname);
 const env = /(?:^|\/)(?:\.?env(?:[.\-_]|$)|[^/]*(?:env|config|settings)[^/]*(?:example|sample|template))/i.test(pathname);
 const helm = /(?:^|\/)(?:charts?|helm)\/.*(?:^|\/)templates\//i.test(pathname)
  || /(?:^|\/)(?:charts?|helm)\/templates\//i.test(pathname);
 const explicitExample = /(?:^|[/.\-_])(?:examples?|samples?|fixtures?)(?:[/.\-_]|$)/i.test(pathname);
 const manifest = manifests.test(filename), classification = examples.test(pathname) && (!helm || explicitExample) ? 'trace' : 'live-use';
 const result = [], seen = new Set();
 const emit = evidenceClass => (kind, value) => {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value)) return;
  const key = `${evidenceClass}\0${kind}\0${value}`;
  if (!seen.has(key)) { seen.add(key); result.push({ kind, value, class: evidenceClass }); }
 };
 const parse = (source, evidenceClass, isComment) => {
  const entries = entriesFor(pathname, source);
  const deployed = !isComment && !explicitExample && (ci || infrastructureDocument(pathname, entries));
  const add = emit(deployed ? 'live-use' : evidenceClass);
  if (manifest) packageNames(filename, source, entries, add);
  if (env) environmentNames(source, add);
  if (!manifest && !code.test(pathname)) configNames(entries, add);
  infrastructureNames(pathname, source, entries, ci, add);
  if (code.test(pathname)) pulumiNames(pathname, source, add);
  // Commented-out env declarations are useful traces even in config files.
  if (isComment && !manifest) environmentNames(source, add);
 };
 try {
  const templateTraces = [];
  const templateClean = text.replace(/\{\{\s*\/\*([\s\S]*?)\*\/\s*\}\}/g, (whole, content) => {
   templateTraces.push(content); return whole.replace(/[^\n]/g, ' ');
  });
  const { clean, traces } = comments(templateClean, filename === 'go.mod' || /\.(?:jsonc?|tf|hcl|[cm]?[jt]sx?|go|cs)(?:\.(?:example|sample|template|tpl))?$/i.test(pathname));
  parse(clean, classification, false);
  // Group consecutive comment lines so commented TOML/YAML sections retain
  // their structural context. Comments never inherit live-use classification.
  if (traces.length) parse(traces.join('\n'), 'trace', true);
  for (const trace of templateTraces) parse(trace, 'trace', true);
 } catch {
  // Invalid/unsupported syntax is not permission to expose its scalar text.
 }
 return result;
}
