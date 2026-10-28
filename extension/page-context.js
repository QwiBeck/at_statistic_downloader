(() => {
  "use strict";
  const api = globalThis.ATStatisticDownloader ||= globalThis.BookStatsExporter || {};
  // Keep the earlier console API compatible with saved user scripts.
  globalThis.BookStatsExporter = api;
  api.application = Object.freeze({ name: "AT Statistic Downloader", version: "1.0.0-beta" });
  api.getPageContext = function getPageContext() {
    try {
      const url = new URL(location.href);
      if (url.origin !== "https://author.today") return null;
      const match = url.pathname.match(/^\/u\/([^/]+)\/works\/edit\/?$/);
      if (!match) return null;
      const username = decodeURIComponent(match[1]);
      if (!username || /[/\\\u0000-\u001f\u007f]/.test(username)) return null;
      return { username, pageUrl: url.origin + url.pathname, origin: url.origin };
    } catch { return null; }
  };
})();
