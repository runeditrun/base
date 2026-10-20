import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { lookFingerprints } from './look.mjs';
import { screenshotSet } from './screenshots.mjs';
import { validRelativePath } from './signature.mjs';
import { committedSource, git, newOutput } from './source.mjs';

function projectFile(source) {
  return source.entries.has('rer-project.json') ? JSON.parse(source.bytes('rer-project.json')) : {};
}

export function listingRepository(source) {
  const declared = projectFile(source).sourceRepository;
  if (declared) return declared;
  const remote = git(source.repo, 'remote').toString().split('\n').includes('origin') ? git(source.repo, 'remote', 'get-url', 'origin').toString().trim() : '';
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw Error('Listing needs rer-project.json sourceRepository or a credential-free GitHub origin');
  return `https://github.com/${match[1]}`;
}

export function listingContent(source, repository, previous = null) {
  const seed = source.seed, slug = repository.replace(/\.git$/, '').split('/').at(-1).toLowerCase().replace(/^run-/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seed.id)) throw Error('Invalid listing slug or ID');
  const homepage = seed.homepage ?? `https://run-${slug}.com`;
  const url = new URL(homepage);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Listing homepage must be a credential-free HTTP URL');
  if (seed.headline !== undefined && (typeof seed.headline !== 'string' || !seed.headline.trim())) throw Error('Listing headline must be nonempty text');
  const assets = [];
  const mark = (key, fallback, name) => {
    const path = seed.brand?.[key] ?? fallback;
    if (!validRelativePath(path)) throw Error('Brand mark must be a repository-relative path');
    if (!source.entries.has(path) && seed.brand?.[key] === undefined) return null;
    const bytes = source.bytes(path);
    if (!path.endsWith('.svg') || !/<svg[\s/>]/.test(bytes.toString())) throw Error('Brand mark must be SVG');
    const target = `assets/seeds/${seed.id}/${name}`;
    assets.push({ path: target, bytes });
    return target;
  };
  const css = source.entries.has('public/rer-theme.css') ? source.bytes('public/rer-theme.css').toString().replace(/\/\*[\s\S]*?\*\//g, '') : '';
  const token = name => new RegExp(`--rer-${name}\\s*:\\s*([^;}]+)`).exec(css)?.[1].trim() ?? null;
  const branding = source.entries.has('src/branding.json') ? JSON.parse(source.bytes('src/branding.json')) : {};
  const brand = { mark: mark('mark', 'public/brand/mark.svg', 'mark.svg'), markLight: mark('markLight', 'public/brand/mark-light.svg', 'mark-light.svg'),
    colours: { accent: branding.primaryColor ?? null, ink: token('text'), paper: token('page') } };
  const look = lookFingerprints(source), current = screenshotSet(source, seed.id);
  const selected = previous?.listing.shots.length && (previous.listing.look.app === look.app || (current.identity && current.identity === previous.shotIdentity)) ? previous : null;
  const shots = selected ? selected.listing.shots : current.shots;
  assets.push(...(selected ? selected.shotAssets : current.assets));
  return { listing: { slug, homepage, headline: seed.headline ?? null, brand, shots, look: { ...look, shotsAt: selected ? selected.listing.look.shotsAt : shots.length ? look.app : null } },
    assets, shotAssets: selected ? selected.shotAssets : current.assets, shotIdentity: selected ? selected.shotIdentity : current.identity };
}

export function writeListing({ repo, ref = 'HEAD', output }, previousReader) {
  const hydrateFrom = git(repo, 'remote').toString().split('\n').includes('origin') ? git(repo, 'remote', 'get-url', 'origin').toString().trim() : undefined;
  const source = committedSource(repo, ref, { hydrateFrom }), repository = listingRepository(source);
  const content = listingContent(source, repository, previousReader(source, repository));
  output = newOutput(source.repo, output);
  try {
    for (const asset of content.assets) {
      const target = resolve(output, asset.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, asset.bytes, { flag: 'wx' });
    }
    writeFileSync(resolve(output, 'listing.json'), JSON.stringify(content.listing, null, 2) + '\n', { flag: 'wx' });
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  return { path: resolve(output, 'listing.json'), revision: source.commit, listing: content.listing };
}
