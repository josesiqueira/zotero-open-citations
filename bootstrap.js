/* Zotero Open Citations - bootstrap entry point
 *
 * Modern Zotero 7/8/9 bootstrapped plugin. No XUL overlay, no install.rdf.
 * All real logic lives in lib/open-citations.js, loaded into this same scope
 * via loadSubScript so the `ZOC` namespace it defines is visible here.
 */

var ZOC;

function log(msg) {
  Zotero.debug("[OpenCitations/bootstrap] " + msg);
}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "lib/open-citations.js");
  try {
    await ZOC.init({ id, version, rootURI });
    log("started v" + version);
  } catch (e) {
    log("startup error: " + e + "\n" + (e && e.stack));
  }
}

function onMainWindowLoad({ window }) {
  if (ZOC) ZOC.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (ZOC) ZOC.removeFromWindow(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (ZOC) {
    try { ZOC.shutdown(); } catch (e) { log("shutdown error: " + e); }
  }
  ZOC = undefined;
}

function install() {}
function uninstall() {}
