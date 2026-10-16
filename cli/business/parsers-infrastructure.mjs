import { identifier } from './parsers-syntax.mjs';
import { terraformNames } from './parsers-terraform.mjs';

function registryHost(image) {
 if (typeof image !== 'string' || /[\s?#\\]|:\/\//.test(image)) return undefined;
 const slash = image.indexOf('/'); if (slash < 1) return undefined;
 const first = image.slice(0, slash); if (first.includes('@')) return undefined;
 // Docker interprets a dotted first component, localhost or a host:port as
 // an explicit registry. An unqualified image does not identify a registry.
 if (!first.includes('.') && first !== 'localhost' && !first.includes(':')) return undefined;
 const host = first.replace(/:[0-9]{1,5}$/, '');
 if (first !== host && !/^\d{1,5}$/.test(first.slice(host.length + 1))) return undefined;
 if (host === 'localhost' || (host.length <= 253 && host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)))) return host.toLowerCase();
 return undefined;
}

function ciNames(source, entries, add) {
 for (const match of source.matchAll(/\b(?:secrets|vars)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g)) add('ci-secret', match[1] ?? match[3]);
 for (const { path, value } of entries) {
  const parent = path.at(-2), key = path.at(-1);
  if (['env', 'environment', 'variables', 'secrets'].includes(parent) && identifier.test(key)) add('ci-secret', key);
  if (parent === '[]' && ['env', 'variables'].includes(path.at(-3))) {
   if (key === 'name' && typeof value === 'string' && identifier.test(value)) add('ci-secret', value);
  }
  if (key === '[]' && path.some(part => ['env', 'environment', 'variables'].includes(part)) && typeof value === 'string') {
   const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value); if (match) add('ci-secret', match[1]);
  }
 }
}

export function infrastructureDocument(pathname, entries) {
 return /\.(?:tf|hcl|tf\.json)$/i.test(pathname)
  || /(?:^|\/)(?:charts?|helm)\//i.test(pathname)
  || /(?:^|\/)Pulumi[^/]*\.(?:ya?ml|json)$/i.test(pathname)
  || entries.some(({ path }) => path.length === 1 && path[0] === 'Resources')
  || entries.some(({ path }) => path.at(-1) === 'apiVersion') && entries.some(({ path }) => path.at(-1) === 'kind');
}

export function infrastructureNames(pathname, source, entries, ci, add) {
 if (ci) ciNames(source, entries, add);
 if (/\.(?:tf|hcl)$/i.test(pathname)) terraformNames(source, add);
 const kubernetes = new Set(entries.filter(entry => entry.path.at(-1) === 'apiVersion').map(entry => entry.path.slice(0, -1).join('\0')));
 const images = ci || infrastructureDocument(pathname, entries);
 for (const { path, value } of entries) {
  if (/\.tf\.json$/i.test(pathname)) {
   if (path[0] === 'provider' && path.length === 2) add('iac-provider', path[1]);
   if (['resource', 'data'].includes(path[0]) && path.length === 2) add('iac-resource', path[1]);
   if (path.includes('required_providers') && path.at(-1) === 'source' && typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){1,2}$/.test(value)) add('iac-provider', value);
  }
  if (typeof value !== 'string') continue;
  const key = path.at(-1);
  if (key === 'kind' && kubernetes.has(path.slice(0, -1).join('\0')) && /^[A-Za-z][A-Za-z0-9]*$/.test(value)) add('iac-resource', value);
  if (/^(?:Type|type)$/.test(key)) {
   if (path[0] === 'Resources' && path.length === 3 && /^[A-Za-z][A-Za-z0-9]*::[A-Za-z][A-Za-z0-9]*::[A-Za-z][A-Za-z0-9]*$/.test(value)) add('iac-resource', value);
   if (path[0] === 'resources' && path.length === 3 && /(?:^|\/)Pulumi[^/]*\.(?:ya?ml|json)$/i.test(pathname) && /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_./-]*:[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    const provider = /^pulumi:providers:([A-Za-z][A-Za-z0-9_-]*)$/.exec(value);
    add(provider ? 'iac-provider' : 'iac-resource', provider?.[1] ?? value);
   }
  }
  if (images && (key === 'image' || (key === 'repository' && path.includes('image')))) {
   const host = registryHost(value); if (host) add('iac-provider', host);
  }
  if (images && key === 'registry' && path.includes('image')) {
   const host = registryHost(`${value}/_`); if (host) add('iac-provider', host);
  }
 }
}
