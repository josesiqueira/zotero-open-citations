# Zotero Open Citations

A modern **Zotero 7, 8, and 9** plugin that adds a sortable **Citation** column
to your library, filled from open citation APIs (OpenAlex and Semantic Scholar).
It can keep your whole library refreshed automatically once a day, with no
clicking and no captchas.

> Lineage: this is an independent rewrite for the Zotero 7+ bootstrap
> architecture of the original
> [beloglazov/zotero-scholar-citations](https://github.com/beloglazov/zotero-scholar-citations)
> and the maintained
> [MaxKuehn fork](https://github.com/MaxKuehn/zotero-scholar-citations). It keeps
> their citation-count idea and the `ZSCC:` `extra` marker, but swaps Google
> Scholar scraping for open APIs. Full attribution in [CREDITS.md](CREDITS.md).

## Why it does NOT scrape Google Scholar

The original plugins query Google Scholar by scraping its HTML. Google Scholar
has no API and aggressively fingerprints automated access:

- ~100 requests/hour/IP before throttling; ~5-10 requests/minute is the "safe"
  ceiling, and reliable scraping needs 60+ second gaps.
- A hard block returns HTTP 429 and can lock you out for ~24 hours.
- "Scrape 60 at once" only works with rotating residential proxies + paid
  captcha-solving services, which is not appropriate for a personal plugin
  hitting Scholar from your home IP.

The old fork's real bug was firing **all** requests into the event loop at once
(a `while` loop with no pacing). That burst is exactly what triggers the captcha
at ~60 items while ~3 sails through.

So this plugin uses real citation APIs instead, which never captcha:

- **OpenAlex** (primary, default) — free, no API key, 250M+ works, excellent DOI
  matching. Counts run somewhat lower than Google Scholar.
- **Semantic Scholar** (fallback) — free, counts closer to Scholar, but a shared
  rate limit (~1 request / 3-4s), so it is paced and used as a backup.

You still get a sortable citation column; you just get it reliably.

## The "Citation" column

The plugin registers a real item-tree column called **Citation** via Zotero's
`ItemTreeManager.registerColumn` API. Right-click the column header in your item
list to enable it, then click it to sort your library by citation count. The
column sorts numerically and shows the plain number.

Counts are persisted in a sidecar file,
`zotero-open-citations-state.json`, in your Zotero data directory (this keeps
your `extra` field clean). Note: a sidecar file does **not** sync across devices
via Zotero sync. If you want the counts mirrored into `extra` (as
`ZSCC: 0000042`, which does sync and survives a reinstall), set the `writeExtra`
pref to `true`; the column still reads from `extra` as a fallback on a fresh
machine.

## How it matches an item

1. **By DOI** when the item has one (exact, no ambiguity).
2. Otherwise by **title search**, with a token-similarity check (Jaccard >= 0.6)
   so it does not blindly trust the first hit the way the originals did.

## How updates run

- **Right-click an item** (or a multi-selection) -> "Update citation count (Open Citations)". Tip: press Ctrl+A / Cmd+A in the item list first to update everything you can see.
- **Right-click a collection** -> "Update citations in collection (Open Citations)".
- **Tools menu** -> "Update entire library now (Open Citations)" sweeps the whole library, uncapped (it asks for confirmation past 100 items).
- **Tools menu** -> "Update stale citations now (Open Citations)" refreshes only stale items, up to `dailyMax` per click (the same job the daily timer runs).

The context-menu and Tools entries carry a small citation icon.
- **Daily background trickle** (on by default): about once every 24h it refreshes
  only items not updated in the last `staleDays` (default 30), oldest first, one
  at a time with randomized 1.5-4s gaps, capped at `dailyMax` (default 50) per
  day. A large library naturally spreads across many days. Progress is persisted
  to the sidecar file, so a pause or a rate-limit never loses work.

Is a daily whole-library refresh "too much"? No, because it trickles instead of
bursting. That is the safe pattern even against an API: paced, incremental, and
self-throttling on a 429.

## Preferences pane and coverage report

Settings -> **Open Citations** opens a dedicated pane with all the controls
below (no Config Editor needed) plus a live **Citation coverage report**:
plugin version and active source; library size; how many items have a count
(coverage %), how many returned no data, and how many are not yet checked;
total / average / most-cited; a per-source breakdown; the last-updated and
last-daily-run times; and the top 5 most-cited items. It also has a
**"Update entire library now"** button that runs the full sweep and
auto-refreshes the numbers as it goes.

The same prefs are also under `extensions.zotero.opencitations.*` in the Config
Editor:

| Pref | Default | Meaning |
|---|---|---|
| `primarySource` | `openalex` | `openalex` or `semanticscholar` |
| `useFallback` | `true` | try the other source when the primary misses |
| `email` | `""` | your email for OpenAlex's polite pool (recommended) |
| `autoDaily` | `true` | run the daily background refresh |
| `staleDays` | `30` | only refresh items older than this |
| `dailyMax` | `50` | max items refreshed per daily pass |
| `minDelayMs` / `maxDelayMs` | `1500` / `4000` | pacing gap between requests |
| `writeExtra` | `false` | also mirror the count into `extra` (syncs across devices) |

Tip: set `email` to your address. OpenAlex's "polite pool" is faster and more
reliable for identified callers.

## Compatibility

Zotero **7, 8, and 9** (`strict_min_version` 6.999, `strict_max_version` 9.*).
Bootstrapped plugin, no XUL overlay.

## Install

This is a build-free bootstrap plugin. To make the installable XPI:

```
cd zotero-open-citations
zip -r -X ../zotero-open-citations.xpi manifest.json bootstrap.js lib icons README.md CREDITS.md LICENSE
```

Then in Zotero: Tools -> Plugins (or Add-ons) -> gear -> Install Plugin From File
-> pick the `.xpi`.

## Layout

- `manifest.json` — Zotero plugin manifest (id `open-citations@zotero-plugin.org`).
- `bootstrap.js` — lifecycle entry; loads `lib/open-citations.js`.
- `lib/open-citations.js` — all logic: sources, matching, the Citation column,
  paced queue, daily scheduler, menu UI.
- `CREDITS.md` — attribution and lineage.
- `LICENSE` — Mozilla Public License 2.0.

## License

[Mozilla Public License 2.0](LICENSE), continuing the license of the upstream
project. See [CREDITS.md](CREDITS.md).
