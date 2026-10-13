export const BASE_IMAGE = 'node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae';
export const SOURCE_GATE = Object.freeze({ commit: '99491b8e58110832b9c11fadee33f5f1933f1962', verdict: 'PASS', reference: 'root-dispatched independent source/security gate; Linux runtime remains separate' });
export const PROOFS = ['runtime-images', 'installed-closures', 'namespace-adversary', 'generic-success', 'install-failure', 'build-failure', 'artifact-adversary', 'h2h-v020-source', 'h2h-v021-source', 'h2h-v020-build', 'h2h-v021-build', 'chromium-headless', 'browser-boundary', 'cleanup'];
export const EVIDENCE = ['docker-inspect', 'namespaces', 'dependency-closures', 'os-packages', 'browser-binaries', 'browser-runtime', 'public-sources', 'archives', 'build-artifacts', 'failure-observations', 'cleanup'];
export const PUBLIC = [
  { id: 'v020', tag: 'v0.2.0', sha: '3b34df590cff61358afc07ab56ea886461ca74fd', archive: '51607bcaef48d80b9d6aee8bb9a8f82762b4432d48931707160fd3d90eef1d2e' },
  { id: 'v021', tag: 'v0.2.1', sha: '59c6e2e1beb321e9f1cb5493efd05e20fc068638', archive: 'df12d75e77417bbab5e24509fb35b3b1d63f8880f26029d1ef05685b40cba032' },
];
export const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com'];
