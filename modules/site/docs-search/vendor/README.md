# Vendored search dependencies

These files are bundled locally; no CDN or runtime package resolution is used.

- MiniSearch 7.2.0, MIT: 77,980 bytes (18,165 gzip); SHA-256 `be655f42574cbfc32f7143d8f9ed20d287a98f70d76fe16e7d422918174b5c04`. Source: [MiniSearch 7.2.0](https://registry.npmjs.org/minisearch/-/minisearch-7.2.0.tgz).
- stemmer 2.0.1, MIT: 4,210 bytes (1,381 gzip); SHA-256 `154936155f541e1dca18bb75f0fe47c5d881f7b68b2953d92bd33254aca5cc39`. Source: [stemmer 2.0.1](https://registry.npmjs.org/stemmer/-/stemmer-2.0.1.tgz).

The upstream ES module files and declarations are retained. The MiniSearch source-map
comment is removed because the source map is not shipped. Licence notices are in
`LICENSE.txt` and `STEMMER-LICENSE`. Both are MIT; they permit redistribution with
the included notices. MiniSearch owns the inverted index and BM25 scoring; the
small surrounding module supplies generic tokenization, field boosts and relevance
filtering. stemmer supplies the Porter algorithm rather than a custom stemmer.
