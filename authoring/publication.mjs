import { git } from './git.mjs';

// Authority comes only from the same committed family revision being published.
export function publication(family, sha, edition) {
  const descriptor = JSON.parse(git(family, 'show', `${sha}:family.json`));
  const mapping = JSON.parse(git(family, 'show', `${sha}:publication.json`));
  const canonical = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (descriptor.schemaVersion !== 1 || !canonical.test(descriptor.repository ?? '') ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.id ?? '') ||
      !canonical.test(descriptor.base?.repository ?? '') ||
      !/^[a-f0-9]{40}$/.test(descriptor.base?.commit ?? '') ||
      mapping.schemaVersion !== 1 || mapping.family !== descriptor.repository ||
      !mapping.editions || typeof mapping.editions !== 'object' || Array.isArray(mapping.editions) ||
      !Object.hasOwn(mapping.editions, edition))
    throw new Error('Invalid committed publication mapping');
  const repositories = Object.values(mapping.editions);
  if (Object.keys(mapping.editions).some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
      repositories.some(repo => !canonical.test(repo) || repo.split('/')[0] !== descriptor.repository.split('/')[0] || repo === descriptor.repository || repo === descriptor.base.repository) ||
      new Set(repositories).size !== repositories.length)
    throw new Error('Publication must map editions to distinct canonical repositories');
  return { descriptor, repository: mapping.editions[edition] };
}
