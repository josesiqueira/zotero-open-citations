/* Zotero Open Citations - core logic
 *
 * Data sources: OpenAlex (primary, default) and Semantic Scholar (fallback).
 * No Google Scholar scraping -> no captchas, fully automatable.
 *
 * Counts surface in a sortable "Citation" item-tree column and persist in a
 * sidecar JSON (zotero-open-citations-state.json in the Zotero data dir),
 * tracking per-item {count, source, updatedAt} so the daily pass can refresh
 * only stale items. Optionally also mirrored into the `extra` field as
 * "ZSCC: 0000042" (the de-facto marker from the original Scholar Citations
 * plugins) for cross-device sync.
 *
 * Lineage: an independent Zotero 7/8/9 rewrite of the citation-count idea from
 * beloglazov/zotero-scholar-citations and the MaxKuehn fork. See CREDITS.md.
 */

ZOC = (function () {
  const { classes: Cc, interfaces: Ci } = Components;

  // ---- config ------------------------------------------------------------
  const PREF_BRANCH = "opencitations.";
  const DEFAULTS = {
    primarySource: "openalex",     // "openalex" | "semanticscholar"
    useFallback: true,             // try the other source if primary misses
    email: "",                     // OpenAlex polite-pool contact (recommended)
    autoDaily: true,               // run the daily background trickle
    staleDays: 30,                 // refresh items older than this many days
    dailyMax: 50,                  // max items refreshed per daily pass
    minDelayMs: 1500,              // pacing: min gap between requests
    maxDelayMs: 4000,              // pacing: max gap between requests
    writeExtra: false,             // also mirror the count into `extra` (syncs)
    lastDailyRun: "0",
  };

  const PLUGIN_ID = "open-citations@zotero-plugin.org";
  const COLUMN_KEY = "ocCitation";

  const EXTRA_PREFIX = "ZSCC";
  const COUNT_LEN = 7;
  const NO_DATA = "NoCitationData";
  // Matches a leading ZSCC token (new or legacy formats) + captures the rest.
  const EXTRA_REGEX = new RegExp(
    "^(?:" + EXTRA_PREFIX + ":\\s*)?" +
    "((?:\\d{" + COUNT_LEN + "}|" + NO_DATA + "|\\d{5}|No Citation Data))?" +
    "\\s*([^]*)$"
  );

  // ---- module state ------------------------------------------------------
  let _version = "";
  let _state = {};
  let _running = false;
  let _cancel = false;
  let _timer = null;
  let _menuEls = [];
  let _columnKey = null;
  let _rootURI = "";
  let _skipFallbackThisRun = false; // set when the fallback source 429s mid-run
  const _liveTimers = new Set();

  // ---- small helpers -----------------------------------------------------
  function log(msg) { Zotero.debug("[OpenCitations] " + msg); }

  function getPref(k) {
    const v = Zotero.Prefs.get(PREF_BRANCH + k);
    return v === undefined || v === null || v === "" ? DEFAULTS[k] : v;
  }
  function setPref(k, v) { Zotero.Prefs.set(PREF_BRANCH + k, v); }

  function pad(n, len) {
    let s = String(Math.max(0, n | 0));
    while (s.length < len) s = "0" + s;
    return s;
  }

  function jitter() {
    const lo = Number(getPref("minDelayMs"));
    const hi = Number(getPref("maxDelayMs"));
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
  }

  // nsITimer-backed sleep (setTimeout is not a global in the bootstrap scope).
  function sleep(ms) {
    return new Promise((res) => {
      const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      _liveTimers.add(t);
      t.initWithCallback(
        { notify: () => { _liveTimers.delete(t); res(); } },
        ms, Ci.nsITimer.TYPE_ONE_SHOT
      );
    });
  }

  function notify(msg) {
    log(msg);
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline("Open Citations");
      pw.addDescription(msg);
      pw.show();
      pw.startCloseTimer(5000);
    } catch (e) { /* headless / no window */ }
  }

  function mainWindows() {
    return typeof Zotero.getMainWindows === "function"
      ? Zotero.getMainWindows()
      : [Zotero.getMainWindow()].filter(Boolean);
  }

  // Force the item tree to re-run dataProviders (the column reads live state).
  function refreshTree() {
    for (const w of mainWindows()) {
      try {
        const pane = w.ZoteroPane;
        if (pane && pane.itemsView && pane.itemsView.tree) {
          pane.itemsView.tree.invalidate();
        }
      } catch (e) { /* tree not ready */ }
    }
  }

  function rateLimitError() {
    const e = new Error("rate-limited");
    e._rateLimit = true;
    return e;
  }
  function isRateLimit(e) {
    return !!(e && (e._rateLimit || e.status === 429 ||
      (e.xmlhttp && e.xmlhttp.status === 429)));
  }

  // ---- item field helpers ------------------------------------------------
  function getDOI(item) {
    let d = "";
    try { d = item.getField("DOI") || ""; } catch (e) { /* type has no DOI */ }
    if (!d) {
      const ex = (item.getField("extra") || "");
      const m = ex.match(/10\.\d{4,9}\/[^\s]+/);
      if (m) d = m[0];
    }
    return d.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  }

  function norm(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  // Guard against matching the wrong paper when searching by title.
  function titleMatches(item, candidate) {
    const a = norm(item.getField("title"));
    const b = norm(candidate);
    if (!a || !b) return false;
    if (a === b) return true;
    const A = new Set(a.split(" "));
    const B = new Set(b.split(" "));
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const jac = inter / (A.size + B.size - inter);
    return jac >= 0.6;
  }

  // ---- extra-field write -------------------------------------------------
  function buildCountString(count) {
    return EXTRA_PREFIX + ": " + (count < 0 ? NO_DATA : pad(count, COUNT_LEN));
  }

  async function writeCount(item, count) {
    const cur = item.getField("extra") || "";
    const m = cur.match(EXTRA_REGEX);
    let rest = m ? (m[2] || "") : cur;
    rest = rest.replace(/^\s*\n?/, "");
    let next = buildCountString(count);
    if (rest && rest.trim()) next += " \n" + rest;
    item.setField("extra", next);
    await item.saveTx();
  }

  // ---- data sources ------------------------------------------------------
  async function httpJson(url) {
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 30000,
      successCodes: false,
    });
    if (resp.status === 429) throw rateLimitError();
    if (resp.status < 200 || resp.status >= 300) return null;
    return resp.response !== undefined && resp.response !== null
      ? resp.response
      : (resp.responseText ? JSON.parse(resp.responseText) : null);
  }

  async function fetchOpenAlex(item) {
    const doi = getDOI(item);
    const mailto = (getPref("email") || "").trim();
    let url;
    if (doi) {
      url = "https://api.openalex.org/works/doi:" +
        encodeURIComponent(doi) + "?select=id,title,cited_by_count";
    } else {
      const title = item.getField("title");
      if (!title) return null;
      url = "https://api.openalex.org/works?per_page=1&select=id,title,cited_by_count&filter=title.search:" +
        encodeURIComponent(title);
    }
    if (mailto) url += "&mailto=" + encodeURIComponent(mailto);

    const data = await httpJson(url);
    if (!data) return null;
    const work = doi ? data : (data.results && data.results[0]);
    if (!work || typeof work.cited_by_count !== "number") return null;
    if (!doi && !titleMatches(item, work.title)) return null;
    return { count: work.cited_by_count, source: "OpenAlex" };
  }

  async function fetchSemanticScholar(item) {
    const doi = getDOI(item);
    let url;
    if (doi) {
      url = "https://api.semanticscholar.org/graph/v1/paper/DOI:" +
        encodeURIComponent(doi) + "?fields=title,citationCount";
    } else {
      const title = item.getField("title");
      if (!title) return null;
      url = "https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title,citationCount&query=" +
        encodeURIComponent(title);
    }
    const data = await httpJson(url);
    if (!data) return null;
    const paper = doi ? data : (data.data && data.data[0]);
    if (!paper || typeof paper.citationCount !== "number") return null;
    if (!doi && !titleMatches(item, paper.title)) return null;
    return { count: paper.citationCount, source: "SemanticScholar" };
  }

  function sourceOrder() {
    const primary = getPref("primarySource");
    let order = primary === "semanticscholar"
      ? ["semanticscholar", "openalex"]
      : ["openalex", "semanticscholar"];
    if (!getPref("useFallback")) order = [order[0]];
    return order;
  }

  // Updates one item. A rate-limited source is a SOFT failure: we never abort
  // the whole run for it. If we couldn't get a definitive answer because a
  // source was rate-limited (or skipped because it already 429'd this run), we
  // throw a `_deferred` error so the queue skips the item and retries later
  // (rather than wrongly recording "no data").
  async function updateOne(item) {
    let sawRateLimit = false, skippedFallback = false;
    for (const src of sourceOrder()) {
      // once the fallback (Semantic Scholar) 429s, stop hammering it this run
      if (src === "semanticscholar" && _skipFallbackThisRun) {
        skippedFallback = true;
        continue;
      }
      try {
        const res = src === "openalex"
          ? await fetchOpenAlex(item)
          : await fetchSemanticScholar(item);
        if (res && typeof res.count === "number") {
          recordState(item, res.count, res.source);
          if (getPref("writeExtra")) await writeCount(item, res.count);
          return res;
        }
      } catch (e) {
        if (isRateLimit(e)) {
          sawRateLimit = true;
          if (src === "semanticscholar") _skipFallbackThisRun = true;
        } else {
          log("source " + src + " error for " + item.key + ": " + e);
        }
      }
    }
    // Only record a genuine "no data" when every source was actually queried
    // and returned a clean miss. If anything was rate-limited/skipped, defer.
    if (sawRateLimit || skippedFallback) {
      const e = new Error("deferred"); e._deferred = true; throw e;
    }
    recordState(item, -1, "none");
    return null;
  }

  // ---- sidecar state -----------------------------------------------------
  const STATE_FILE = "zotero-open-citations-state.json";
  const LEGACY_STATE_FILE = "zscj-state.json"; // pre-rename name; migrated once
  function statePath() {
    return PathUtils.join(Zotero.DataDirectory.dir, STATE_FILE);
  }
  async function loadState() {
    const candidates = [
      PathUtils.join(Zotero.DataDirectory.dir, STATE_FILE),
      PathUtils.join(Zotero.DataDirectory.dir, LEGACY_STATE_FILE),
    ];
    for (const p of candidates) {
      try {
        const t = await IOUtils.readUTF8(p);
        _state = JSON.parse(t) || {};
        return;
      } catch (e) { /* try the next candidate */ }
    }
    _state = {};
  }
  async function saveStateNow() {
    try { await IOUtils.writeUTF8(statePath(), JSON.stringify(_state)); }
    catch (e) { log("saveState error: " + e); }
  }
  function stateKey(item) { return item.libraryID + "/" + item.key; }
  function recordState(item, count, source) {
    _state[stateKey(item)] = {
      count, source, updatedAt: new Date().toISOString(),
    };
  }

  // The value behind the "Citation" column. Reads the sidecar state first,
  // then falls back to parsing a ZSCC token out of `extra` (covers synced or
  // legacy data on a fresh machine). Returns a number, or null if unknown.
  function citationFor(item) {
    const st = _state[stateKey(item)];
    if (st && typeof st.count === "number") return st.count;
    const ex = item.getField("extra") || "";
    const m = ex.match(/ZSCC:\s*(\d{1,9})/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  // ---- paced queue -------------------------------------------------------
  async function runQueue(items, label) {
    if (_running) { notify("Already updating; please wait."); return; }
    _running = true;
    _cancel = false;
    _skipFallbackThisRun = false;
    let done = 0, ok = 0, deferred = 0;
    try {
      for (const item of items) {
        if (_cancel) break;
        try {
          const r = await updateOne(item);
          if (r && r.count >= 0) ok++;
        } catch (e) {
          if (e && e._deferred) deferred++;
          else log("item " + item.key + " failed: " + e);
        }
        done++;
        await saveStateNow();
        if (done < items.length && !_cancel) await sleep(jitter());
      }
    } finally {
      _running = false;
      await saveStateNow();
      refreshTree();
      let msg = label + ": updated " + ok + "/" + items.length;
      if (deferred) msg += " (" + deferred + " deferred, source busy - will retry)";
      notify(msg);
    }
  }

  // ---- daily trickle -----------------------------------------------------
  async function runStalePass(manual) {
    const staleDays = Number(getPref("staleDays"));
    const dailyMax = Number(getPref("dailyMax"));
    const cutoff = Date.now() - staleDays * 86400000;
    const libId = Zotero.Libraries.userLibraryID;

    const all = await Zotero.Items.getAll(libId, true);
    const candidates = [];
    for (const it of all) {
      if (!it.isRegularItem()) continue;
      if (!it.getField("title")) continue;
      const st = _state[stateKey(it)];
      const ts = st ? new Date(st.updatedAt).getTime() : 0;
      if (!st || ts < cutoff) candidates.push({ it, ts });
    }
    candidates.sort((a, b) => a.ts - b.ts); // oldest first
    const batch = candidates.slice(0, dailyMax).map((c) => c.it);
    if (!batch.length) {
      if (manual) notify("All items are up to date.");
      return;
    }
    notify("Refreshing " + batch.length + " stale item(s) in the background...");
    await runQueue(batch, manual ? "Manual refresh" : "Daily refresh");
  }

  async function maybeRunDaily() {
    if (!getPref("autoDaily")) return;
    if (_running) return;
    const last = Number(getPref("lastDailyRun") || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    setPref("lastDailyRun", String(Date.now()));
    try { await runStalePass(false); } catch (e) { log("daily pass error: " + e); }
  }

  function startScheduler() {
    _timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    _timer.initWithCallback(
      { notify: () => { maybeRunDaily(); } },
      30 * 60 * 1000, Ci.nsITimer.TYPE_REPEATING_SLACK
    );
    // also check ~2 min after startup so a long-running Zotero still updates
    sleep(120000).then(() => maybeRunDaily());
  }

  // ---- UI ----------------------------------------------------------------
  function updateSelected() {
    const pane = Zotero.getActiveZoteroPane();
    const items = (pane ? pane.getSelectedItems() : [])
      .filter((i) => i.isRegularItem());
    if (!items.length) { notify("No regular items selected."); return; }
    runQueue(items, "Selection");
  }

  function updateCollection() {
    const pane = Zotero.getActiveZoteroPane();
    const col = pane ? pane.getSelectedCollection() : null;
    if (!col) { notify("No collection selected."); return; }
    const items = col.getChildItems(false).filter((i) => i.isRegularItem());
    if (!items.length) { notify("Collection has no items."); return; }
    runQueue(items, "Collection");
  }

  // Sweep the ENTIRE user library, uncapped (unlike the daily stale pass).
  async function updateEntireLibrary() {
    const libId = Zotero.Libraries.userLibraryID;
    const all = await Zotero.Items.getAll(libId, true);
    const items = all.filter((i) => i.isRegularItem() && i.getField("title"));
    if (!items.length) { notify("No items to update."); return; }
    const win = mainWindows()[0];
    if (win && items.length > 100) {
      const mins = Math.max(1, Math.ceil((items.length * 3) / 60));
      const ok = win.confirm(
        "Open Citations will update all " + items.length + " items in your " +
        "library, one at a time. This may take about " + mins + " minute(s) " +
        "and runs in the background. Continue?"
      );
      if (!ok) return;
    }
    runQueue(items, "Full library");
  }

  // Compute the coverage report shown in the preferences pane.
  async function getReport() {
    const libId = Zotero.Libraries.userLibraryID;
    const all = await Zotero.Items.getAll(libId, true);
    const regular = all.filter((i) => i.isRegularItem() && i.getField("title"));
    const staleDays = Number(getPref("staleDays"));
    const cutoff = Date.now() - staleDays * 86400000;

    let matched = 0, nodata = 0, unchecked = 0, total = 0, stale = 0, max = null;
    const bySource = {};
    const ranked = [];
    for (const it of regular) {
      const st = _state[stateKey(it)];
      if (!st) { unchecked++; stale++; continue; }
      if (new Date(st.updatedAt).getTime() < cutoff) stale++;
      if (typeof st.count === "number" && st.count >= 0) {
        matched++;
        total += st.count;
        bySource[st.source] = (bySource[st.source] || 0) + 1;
        const title = it.getField("title");
        ranked.push({ count: st.count, title });
        if (!max || st.count > max.count) max = { count: st.count, title };
      } else {
        nodata++;
      }
    }
    ranked.sort((a, b) => b.count - a.count);

    let lastUpdated = 0;
    for (const v of Object.values(_state)) {
      const t = new Date(v.updatedAt).getTime();
      if (t > lastUpdated) lastUpdated = t;
    }
    const lastDaily = Number(getPref("lastDailyRun") || 0);

    return {
      version: _version,
      primarySource: getPref("primarySource"),
      useFallback: !!getPref("useFallback"),
      autoDaily: !!getPref("autoDaily"),
      dailyMax: Number(getPref("dailyMax")),
      staleDays,
      libraryItems: regular.length,
      matched, nodata, unchecked, stale,
      coveragePct: regular.length ? Math.round((matched / regular.length) * 100) : 0,
      totalCitations: total,
      avg: matched ? Math.round(total / matched) : 0,
      max, bySource,
      lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
      lastDailyRun: lastDaily ? new Date(lastDaily).toISOString() : null,
      running: _running,
      top: ranked.slice(0, 5),
    };
  }

  function addToWindow(window) {
    if (!window || !window.document) return;
    const doc = window.document;
    const mk = (id, label, handler, parentId) => {
      if (doc.getElementById(id)) return;
      const parent = doc.getElementById(parentId);
      if (!parent) return;
      const mi = doc.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", label);
      mi.classList.add("menuitem-iconic");
      if (_rootURI) mi.setAttribute("image", _rootURI + "icons/citation.svg");
      mi.addEventListener("command", handler);
      parent.appendChild(mi);
      _menuEls.push(mi);
    };
    mk("zoc-item-update", "Update citation count (Open Citations)",
      updateSelected, "zotero-itemmenu");
    mk("zoc-collection-update", "Update citations in collection (Open Citations)",
      updateCollection, "zotero-collectionmenu");
    mk("zoc-tools-updateall", "Update entire library now (Open Citations)",
      updateEntireLibrary, "menu_ToolsPopup");
    mk("zoc-tools-runall", "Update stale citations now (Open Citations)",
      () => runStalePass(true), "menu_ToolsPopup");
  }

  function removeFromWindow(window) {
    if (!window || !window.document) return;
    const doc = window.document;
    for (const id of ["zoc-item-update", "zoc-collection-update", "zoc-tools-updateall", "zoc-tools-runall"]) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
    _menuEls = _menuEls.filter((el) => el.ownerDocument !== doc);
  }

  // ---- lifecycle ---------------------------------------------------------
  async function registerColumn() {
    try {
      _columnKey = await Zotero.ItemTreeManager.registerColumn({
        dataKey: COLUMN_KEY,
        label: "Citation",
        pluginID: PLUGIN_ID,
        // Zero-padded so the column sorts numerically (string sort under the
        // hood); renderCell shows the clean number.
        dataProvider: (item, dataKey) => {
          const c = citationFor(item);
          return (c === null || c < 0) ? "" : pad(c, COUNT_LEN);
        },
        renderCell: (index, data, column, isFirstColumn, doc) => {
          const span = doc.createElement("span");
          span.className = "cell " + (column ? column.className : "");
          span.innerText = data ? String(parseInt(data, 10)) : "";
          return span;
        },
      });
    } catch (e) { log("registerColumn failed: " + e); }
  }

  function registerPrefPane() {
    try {
      Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        src: "prefs.xhtml",
        scripts: ["prefs.js"],
        label: "Open Citations",
        image: "icons/citation.svg",
      });
    } catch (e) { log("registerPrefPane failed: " + e); }
  }

  async function init({ id, version, rootURI }) {
    _version = version;
    _rootURI = rootURI || "";
    await loadState();
    await registerColumn();
    registerPrefPane();
    // expose the public API so the prefs pane (and the console) can call in
    Zotero.OpenCitations = {
      getReport, updateEntireLibrary, runStalePass, getPref, setPref,
    };
    for (const w of mainWindows()) addToWindow(w);
    startScheduler();
  }

  function shutdown() {
    _cancel = true;
    if (_timer) { try { _timer.cancel(); } catch (e) {} _timer = null; }
    for (const el of _menuEls) { try { el.remove(); } catch (e) {} }
    _menuEls = [];
    if (_columnKey) {
      try { Zotero.ItemTreeManager.unregisterColumn(_columnKey); } catch (e) {}
      _columnKey = null;
    }
    try { delete Zotero.OpenCitations; } catch (e) {}
    saveStateNow();
  }

  return {
    init, shutdown, addToWindow, removeFromWindow,
    // exposed for debugging / manual triggering from the console
    _runStalePass: runStalePass,
    _updateOne: updateOne,
    _getPref: getPref,
  };
})();
