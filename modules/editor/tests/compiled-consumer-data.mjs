/** Real compiled edit input for the separately committed native test consumer. */
export const compiledCases = [
  { path: '/records', before: 'Server-rendered public record', after: 'Published public record' },
  { path: '/reference', publishedPaths: ['/reference', '/reference/'], before: 'Reference snapshot', after: 'Published reference snapshot' },
  { path: '/app', before: 'Native session protected operator app', after: 'Published operator workspace' },
];
export const notFoundCase = { path: '/missing-document', before: 'Document not found', after: 'Published missing document' };
export const compiledSnapshot = {
  revision: 6,
  // Static HTML redirects direct requests to /reference/; client routing uses
  // /reference. Compiled edits intentionally bind exact paths in both cases.
  edits: [...compiledCases, notFoundCase].flatMap(({ path, publishedPaths = [path], before, after }, index) => publishedPaths.map((publishedPath, variant) => ({
    id: `native-leaf-${index}-${variant}`, revision: index + 1, path: publishedPath,
    target: { selector: 'main:nth-child(2) > section:nth-child(1) > h1:nth-child(1)', tag: 'h1', role: '', beforeText: before },
    change: { text: after },
  }))),
};
