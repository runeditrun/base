import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildSearchIndex, indexAsset } from './index-build.mjs';

/** A self-contained, local build step. No network or runtime resource setup. */
export async function buildSearchArtifacts({ corpus, assets, output }) {
  const pages = JSON.parse(await readFile(corpus, 'utf8'));
  await mkdir(output, { recursive: true });
  const indexPath = resolve(output, 'index.json');
  let previous;
  try { previous = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const built = buildSearchIndex(pages, { previous });
  await writeFile(`${indexPath}.new`, built.bytes);
  await rename(`${indexPath}.new`, indexPath);
  await writeFile(resolve(assets, indexAsset.slice(1)), built.bytes);
  console.log(`Docs search: total=${built.counts.total} reused=${built.counts.reused} reindexed=${built.counts.reindexed} bytes=${built.counts.bytes} gzip=${built.counts.gzipBytes} ms=${built.elapsedMs.toFixed(1)}`);
  return built;
}
