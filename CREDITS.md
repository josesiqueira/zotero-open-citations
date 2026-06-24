# Credits and lineage

`zotero-open-citations` stands on the shoulders of the original **Zotero Scholar
Citations** plugin and its community. It is an independent rewrite for the
modern Zotero 7/8/9 bootstrap architecture, and it changes the data source from
Google Scholar scraping to open citation APIs (OpenAlex, Semantic Scholar). The
core idea — fetch a citation count for each item and make the library sortable
by it — and the `ZSCC:` `extra`-field marker come directly from that lineage.

## Original author

- **Anton Beloglazov** ([@beloglazov](https://github.com/beloglazov)) —
  created [zotero-scholar-citations](https://github.com/beloglazov/zotero-scholar-citations),
  the original Zotero plugin that fetched citation counts from Google Scholar
  and made items sortable by them. Copyright (C) 2011-2013 Anton Beloglazov.

## Contributors to the original

- **Texot / tete1030** ([@tete1030](https://github.com/tete1030)) — added robot
  / captcha detection and the "No Citation Data" handling.
- Other contributors to the upstream project (see the original repository's
  history).

## The maintained fork this was studied from

- **Max Kühn** ([@MaxKuehn](https://github.com/MaxKuehn)) — maintainer of the
  most-starred fork,
  [MaxKuehn/zotero-scholar-citations](https://github.com/MaxKuehn/zotero-scholar-citations).
  This fork's refactor, its sortable zero-padded `ZSCC: 0000042` `extra` format,
  the staleness counter, and its honest documentation of the Google Scholar
  rate-limit / captcha problem directly informed this project's design.

## This rewrite

- **Jose Siqueira de Cerqueira** ([@josesiqueira](https://github.com/josesiqueira))
  — Zotero 7/8/9 bootstrap rewrite, the OpenAlex / Semantic Scholar data
  sources, the registered "Citation" item-tree column, and the paced daily
  background refresh.

## License

Like the upstream project, this plugin is distributed under the
**Mozilla Public License 2.0** (see [LICENSE](LICENSE)). The original plugin
carried "Copyright (C) 2011-2013 Anton Beloglazov, distributed under the
Mozilla Public License (MPL)"; this project keeps that license out of respect
for, and continuity with, that lineage.

## Data sources

- **OpenAlex** — <https://openalex.org> (open catalog of scholarly works;
  `cited_by_count`). Please set your email in the `email` pref to use OpenAlex's
  polite pool.
- **Crossref** — <https://www.crossref.org> (REST API; `is-referenced-by-count`).
  The same `email` pref is used for Crossref's polite pool.
- **Semantic Scholar** — <https://www.semanticscholar.org> (Academic Graph API;
  `citationCount`). Optional, used only when an API key is configured.
