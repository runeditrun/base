# Vendored search dependencies

These files are bundled locally; no CDN or runtime package resolution is used.

- MiniSearch 7.2.0, MIT: 78,064 bytes (18,220 gzip); SHA-256 `9978b03db8b310d0f677bda3c244140c20e5de925fbd113d58f6bdf88f795ba0`. Source: [MiniSearch 7.2.0](https://registry.npmjs.org/minisearch/-/minisearch-7.2.0.tgz).
- stemmer 2.0.1, MIT: 4,210 bytes (1,381 gzip); SHA-256 `154936155f541e1dca18bb75f0fe47c5d881f7b68b2953d92bd33254aca5cc39`. Source: [stemmer 2.0.1](https://registry.npmjs.org/stemmer/-/stemmer-2.0.1.tgz).

The upstream ES module files and declarations are retained. The MiniSearch source-map
comment is removed because the source map is not shipped; a TypeScript nocheck
header preserves upstream unused parameters without altering the library. The
public declaration file still checks typed callers. Licence notices are in
`LICENSE.txt` and `STEMMER-LICENSE`. Both are MIT; they permit redistribution with
the included notices. MiniSearch owns the inverted index and BM25 scoring; the
small surrounding module supplies generic tokenization, field boosts and relevance
filtering. stemmer supplies the Porter algorithm rather than a custom stemmer.

The stemmer MIT copyright notice includes its author’s public contact identity,
verified in the pinned npm source archive above. Base declares that exact
identity in `.publish-check/config.json` using the maintained `publicEmails`
field; no scanner rule or licence text is changed. Adopters running the same
publication scanner preserve the notice and declare that same exact public
identity in their own publication config.
