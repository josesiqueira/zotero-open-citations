/* Open Citations - preferences pane script.
 * Runs in the Zotero preferences window. `document` is the prefs document;
 * `Zotero` is available. Talks to the plugin via the Zotero.OpenCitations API
 * exposed by lib/open-citations.js.
 */
var ZOC_Prefs = {
  BRANCH: "opencitations.",

  api() { return Zotero.OpenCitations || {}; },
  $(id) { return document.getElementById(id); },

  get(k, d) {
    const v = Zotero.Prefs.get(this.BRANCH + k);
    return (v === undefined || v === null || v === "") ? d : v;
  },
  set(k, v) { Zotero.Prefs.set(this.BRANCH + k, v); },

  init() {
    if (this._inited) return;
    try {
      this._inited = true;
      this.$("zoc-primary").value = this.get("primarySource", "openalex");
      this.$("zoc-fallback").checked = !!this.get("useFallback", true);
      this.$("zoc-email").value = this.get("email", "");
      this.$("zoc-autodaily").checked = !!this.get("autoDaily", true);
      this.$("zoc-staledays").value = this.get("staleDays", 30);
      this.$("zoc-dailymax").value = this.get("dailyMax", 50);
      this.$("zoc-writeextra").checked = !!this.get("writeExtra", false);

      this.$("zoc-primary").addEventListener("command",
        () => this.set("primarySource", this.$("zoc-primary").value));
      this.$("zoc-fallback").addEventListener("command",
        () => this.set("useFallback", this.$("zoc-fallback").checked));
      this.$("zoc-email").addEventListener("change",
        () => this.set("email", this.$("zoc-email").value.trim()));
      this.$("zoc-autodaily").addEventListener("command",
        () => this.set("autoDaily", this.$("zoc-autodaily").checked));
      this.$("zoc-staledays").addEventListener("change",
        () => this.set("staleDays", parseInt(this.$("zoc-staledays").value, 10) || 30));
      this.$("zoc-dailymax").addEventListener("change",
        () => this.set("dailyMax", parseInt(this.$("zoc-dailymax").value, 10) || 50));
      this.$("zoc-writeextra").addEventListener("command",
        () => this.set("writeExtra", this.$("zoc-writeextra").checked));

      this.$("zoc-refresh").addEventListener("command", () => this.render());
      this.$("zoc-updateall").addEventListener("command", () => this.updateAll());

      this.render();
    } catch (e) {
      Zotero.debug("[OpenCitations/prefs] init error: " + e);
    }
  },

  async updateAll() {
    const api = this.api();
    if (!api.updateEntireLibrary) return;
    this.$("zoc-updateall").disabled = true;
    try { await api.updateEntireLibrary(); } catch (e) { /* started in bg */ }
    // the sweep runs in the background; poll the report a few times
    let n = 0;
    const tick = () => {
      this.render().then((r) => {
        if (r && r.running && n++ < 600) setTimeout(tick, 2000);
        else this.$("zoc-updateall").disabled = false;
      });
    };
    setTimeout(tick, 1500);
  },

  async render() {
    const el = this.$("zoc-report");
    try {
      const api = this.api();
      if (!api.getReport) { el.textContent = "Plugin not ready (reopen this pane)."; return null; }
      const r = await api.getReport();
      el.textContent = this.format(r);
      return r;
    } catch (e) {
      el.textContent = "Report error: " + e;
      return null;
    }
  },

  format(r) {
    const when = (s) => s ? new Date(s).toLocaleString() : "never";
    const L = [];
    L.push("Plugin version:     " + (r.version || "?"));
    L.push("Data source:        " + r.primarySource + (r.useFallback ? "  (+ fallback)" : ""));
    L.push("");
    L.push("Library items:      " + r.libraryItems);
    L.push("With a count:       " + r.matched + "   (" + r.coveragePct + "% coverage)");
    L.push("No data found:      " + r.nodata);
    L.push("Not yet checked:    " + r.unchecked);
    L.push("Stale (>" + r.staleDays + "d):       " + r.stale);
    L.push("");
    L.push("Total citations:    " + r.totalCitations.toLocaleString());
    L.push("Average (matched):  " + r.avg);
    if (r.max) L.push("Most cited:         " + r.max.count + "  —  " + r.max.title);
    const bs = Object.entries(r.bySource || {}).map(([k, v]) => k + ": " + v).join(",  ");
    L.push("By source:          " + (bs || "—"));
    L.push("");
    L.push("Last updated:       " + when(r.lastUpdated));
    L.push("Last daily run:     " + when(r.lastDailyRun) + (r.autoDaily ? "" : "   (auto-daily OFF)"));
    if (r.running) L.push("\n** An update is running now — numbers refresh automatically. **");
    if (r.top && r.top.length) {
      L.push("\nTop cited:");
      r.top.forEach((t, i) => L.push("  " + (i + 1) + ". " + t.count + "  —  " +
        (t.title.length > 64 ? t.title.slice(0, 61) + "..." : t.title)));
    }
    return L.join("\n");
  },
};

// Self-bootstrap: the fragment's inline onload is unreliable in prefs panes, so
// poll briefly for our elements (they're injected into the prefs document) and
// initialize as soon as they exist.
(function boot(tries) {
  try {
    if (typeof document !== "undefined" && document.getElementById &&
        document.getElementById("zoc-report")) {
      ZOC_Prefs.init();
      return;
    }
  } catch (e) { /* not ready */ }
  if ((tries || 0) < 30) {
    setTimeout(() => boot((tries || 0) + 1), 100);
  }
})(0);
