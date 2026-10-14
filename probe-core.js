"use strict";
/* Read-only helpers. No media bytes are fetched and signed links are never logged. */
(function (root) {
  function isValidRecordName(value) {
    return /^[a-zA-Z0-9_.-]{1,255}$/.test(String(value || "").trim());
  }
  function normalizedAssetURL(raw) {
    if (typeof raw !== "string") throw Error("asset URL absent");
    // Documented CloudKit JS filename placeholder only. Do not change signed parameters.
    const prepared = raw.replaceAll("${f}", "HRLXProbe.mp4");
    const u = new URL(prepared);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password ||
        !(host === "icloud-content.com" || host.endsWith(".icloud-content.com"))) {
      throw Error("unexpected asset host");
    }
    return u.href;
  }
  function safeAssetFacts(asset) {
    const value = asset && asset.value;
    if (!value || typeof value.downloadURL !== "string") throw Error("downloadURL absent");
    const url = normalizedAssetURL(value.downloadURL);
    const u = new URL(url);
    const e = u.searchParams.get("e");
    let expiry = "غير متاح";
    if (e && /^\d{9,11}$/.test(e)) {
      const ms = Number(e) * 1000;
      if (Number.isFinite(ms)) expiry = new Date(ms).toISOString();
    }
    return { url, host: u.hostname, bytes: Number.isSafeInteger(value.size) ? value.size : "غير معروف", expiry };
  }
  function safeErrorCode(err) {
    // Never render exception messages or network URLs: they may contain auth tokens.
    const code = err && (err.serverErrorCode || err.errorCode || err.code);
    return typeof code === "string" && /^[A-Z_0-9-]{1,64}$/.test(code) ? code : "غير محدد";
  }
  root.HRLXCore = Object.freeze({ isValidRecordName, normalizedAssetURL, safeAssetFacts, safeErrorCode });
})(typeof window === "undefined" ? globalThis : window);
