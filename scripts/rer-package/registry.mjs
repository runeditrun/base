// A local npm registry for @runeditrun/rer alone. It serves the metadata and
// tarballs published to it, so an install, an update or a package-mode
// checkout can use a locally built tarball without anything being published.
// Point the scope at it (`@runeditrun:registry=URL/`, see npmrc()) and every
// other package still comes from the caller's own registry.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readPackage } from '../../global/update/archive.mjs';

const name = '@runeditrun/rer';
export const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export async function localRegistry() {
 const tarballs = new Map(), versions = {}, tags = {};
 const server = createServer((request, response) => {
  if (['/@runeditrun%2frer', '/@runeditrun%2Frer', '/@runeditrun/rer'].includes(request.url)) {
   response.setHeader('content-type', 'application/json');
   return response.end(JSON.stringify({ name, 'dist-tags': tags, versions }));
  }
  const bytes = tarballs.get(request.url);
  if (!bytes) { response.statusCode = 404; return response.end('{}'); }
  response.setHeader('content-type', 'application/octet-stream');
  response.end(bytes);
 });
 await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
 const url = `http://127.0.0.1:${server.address().port}`;
 return {
  url,
  // The scope line for an npmrc file that sends @runeditrun here.
  npmrc: () => `@runeditrun:registry=${url}/\n`,
  // dist overrides stand for a registry whose record does not match the bytes.
  publish(version, bytes, { latest = true, dist = {} } = {}) {
   const path = `/@runeditrun/rer/-/rer-${version}.tgz`;
   tarballs.set(path, bytes);
   // A registry records the package's manifest, file count and unpacked size
   // for archives it can read.
   let manifest = {}, counts = {};
   try {
    const files = readPackage(bytes, { integrity: integrity(bytes) });
    manifest = JSON.parse(files.find(file => file.path === 'package.json').data);
    counts = { fileCount: files.length, unpackedSize: files.reduce((sum, file) => sum + file.data.length, 0) };
   } catch {}
   versions[version] = { engines: { node: '>=22' }, ...manifest, name, version, dist: { tarball: url + path, integrity: integrity(bytes), ...counts, ...dist } };
   if (latest) tags.latest = version;
  },
  close: () => new Promise(resolveClose => { server.closeAllConnections?.(); server.close(resolveClose); }),
 };
}
