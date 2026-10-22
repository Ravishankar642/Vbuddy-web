// Runs in the VBuddy page before its own scripts, inside the iPhone app.
// It makes the page behave as it does when added to the Home Screen, gives it a working share sheet (for saving
// screenshots to Photos) and lets it reach the app (window.vbuddyNative).
(function () {
  "use strict";
  if (window.vbuddyNative) return;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.vbuddy;
  function post(m) {
    if (handler) handler.postMessage(m);
  }

  // 1. "Added to the Home Screen": navigator.standalone and (display-mode: standalone).
  try {
    Object.defineProperty(Navigator.prototype, "standalone", { get: function () { return true; }, configurable: true });
  } catch (e) {}
  var STANDALONE = /\(\s*display-mode\s*:\s*standalone\s*\)/i;
  if (window.matchMedia) {
    var realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (STANDALONE.test(String(q))) {
        var rest = String(q).replace(STANDALONE, "all");
        var r = realMatchMedia(rest);
        return {
          matches: r.matches, media: String(q), onchange: null,
          addListener: function () {}, removeListener: function () {},
          addEventListener: function () {}, removeEventListener: function () {},
          dispatchEvent: function () { return false; },
        };
      }
      return realMatchMedia(q);
    };
  }
  // The page's CSS has @media (display-mode: standalone) { … } blocks: switch them on where they are.
  function liftRules(rules) {
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.media && r.cssRules) {
        var t = r.media.mediaText;
        if (STANDALONE.test(t)) {
          try { r.media.mediaText = t.replace(STANDALONE, "all"); } catch (e) {}
        }
        liftRules(r.cssRules);
      }
    }
  }
  function liftAll() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules = null;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      liftRules(rules);
    }
  }
  document.addEventListener("DOMContentLoaded", liftAll);
  window.addEventListener("load", liftAll);
  try {
    new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var added = list[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeName === "STYLE") liftAll();
        else if (n.nodeName === "LINK") n.addEventListener("load", liftAll);
      }
    }
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}

  // 2. navigator.share through the iOS share sheet.
  var seq = 0;
  var waiting = {};
  window.__vbuddyShareDone = function (id, ok, err) {
    var w = waiting[id];
    if (!w) return;
    delete waiting[id];
    if (ok) w.resolve();
    else w.reject(new DOMException(err || "Share canceled", "AbortError"));
  };
  function readFile(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result);
        resolve({ name: f.name || "file", type: f.type || "application/octet-stream", data: s.slice(s.indexOf(",") + 1) });
      };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(f);
    });
  }
  function canShare(d) {
    return !!d && (!!d.url || !!d.text || !!d.title || (!!d.files && d.files.length > 0));
  }
  function share(d) {
    d = d || {};
    if (!canShare(d)) return Promise.reject(new TypeError("Nothing to share"));
    var files = Array.prototype.slice.call(d.files || []);
    return Promise.all(files.map(readFile)).then(function (list) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        waiting[id] = { resolve: resolve, reject: reject };
        post({ type: "share", id: id, title: d.title || "", text: d.text || "", url: d.url ? String(d.url) : "", files: list });
      });
    });
  }
  try {
    Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true, writable: true });
  } catch (e) {
    navigator.share = share;
    navigator.canShare = canShare;
  }

  // 3. The app, for the page's settings ("Change address").
  window.vbuddyNative = {
    platform: "ios",
    version: "__VBUDDY_APP_VERSION__",
    changeAddress: function () { post({ type: "changeAddress" }); },
    reload: function () { post({ type: "reload" }); },
    menu: function () { post({ type: "menu" }); },
  };
})();
