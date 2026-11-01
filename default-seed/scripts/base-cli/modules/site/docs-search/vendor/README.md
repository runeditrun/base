# Vendored search dependencies

These files are bundled locally; no CDN or runtime package resolution is used.

- MiniSearch 7.2.0, MIT: 78,064 bytes (18,220 gzip); SHA-256 `9978b03db8b310d0f677bda3c244140c20e5de925fbd113d58f6bdf88f795ba0`. Source: [MiniSearch 7.2.0](https://registry.npmjs.org/minisearch/-/minisearch-7.2.0.tgz).
- wink-porter2-stemmer 2.0.1, MIT: 11,958 bytes (3,672 gzip); SHA-256 `e7f232f86875dd46fb3e66fa35c8e40c9ae14bd4a09b439bc6715857ba7e5639`. Source: [wink-porter2-stemmer 2.0.1](https://registry.npmjs.org/wink-porter2-stemmer/-/wink-porter2-stemmer-2.0.1.tgz).

The upstream ES module files and declarations are retained. The MiniSearch source-map
comment is removed because the source map is not shipped; a TypeScript nocheck
header preserves upstream unused parameters without altering the library. The
public declaration file still checks typed callers. wink-porter2-stemmer has only
a mechanical CommonJS-to-ES-module export conversion and the same lint header.
Licence notices are in
`LICENSE.txt` and `STEMMER-LICENSE`. Both are MIT; they permit redistribution with
the included notices. MiniSearch owns the inverted index and BM25 scoring; the
small surrounding module supplies generic tokenization, field boosts and relevance
filtering. wink-porter2-stemmer supplies the Porter2 algorithm rather than a custom stemmer.

The complete module copies into a clean app without a publication policy
exception or an additional runtime package. Its licence attribution is retained.
