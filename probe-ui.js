"use strict";
/* HRLX CloudKit: one-tap, read-only private CKAsset/HTTP Range probe. */
(function () {
  const $ = id => document.getElementById(id);
  const B = window.HRLXCore;
  let container = null;
  let authorized = false;
  let busy = false;
  let signedURL = null; // In memory, never logged, persisted, or included in the report.
  let stage = "بانتظار تهيئة CloudKit";
  let info = [];

  const report = () => ["HRLX CLOUDKIT ONE-TAP PROBE / READ ONLY",
    "Container: iCloud.com.hrlx.cloudlab / development / private", stage, ...info].join("\n");
  const render = () => { $("status").textContent = report(); };
  const message = (s, items = []) => { stage = s; info = items; render(); };
  const safeCloudCode = e => {
    const raw = e && (e.ckErrorCode || e.serverErrorCode || e.errorCode || e.code);
    return typeof raw === "string" && /^[A-Za-z_0-9-]{1,64}$/.test(raw) ? raw : "UNSPECIFIED";
  };
  const eraseURL = () => { signedURL = null; $("copyURL").disabled = true; };
  function authFailure(prefix, e) {
    message(prefix, ["Code: " + safeCloudCode(e),
      "No secret token, signed URL, record ID or raw error appears in this report."]);
  }
  function setBusy(value) {
    busy = value;
    $("fetchRecord").disabled = busy || !authorized;
  }

  // No record identifier needs to be copied. Reuse the existing page and controls.
  const recordInput = $("recordName");
  if (recordInput) {
    recordInput.hidden = true;
    recordInput.style.display = "none"; // Existing input CSS declares display:block.
    const label = document.querySelector('label[for="recordName"]');
    if (label) { label.hidden = true; label.style.display = "none"; }
    const section = recordInput.closest("section");
    if (section) {
      const explanation = section.querySelector("p");
      if (explanation) explanation.textContent =
        "بعد تسجيل الدخول، اضغط فحص واحدًا: يبحث تلقائيًا عن فيديو الاختبار في قاعدة Private، ويجرب HTTP Range بدون تنزيل الفيديو كاملًا.";
    }
  }
  $("fetchRecord").textContent = "فحص CloudKit بضغطة واحدة";
  $("copyURL").textContent = "نسخ الرابط محليًا للاختبار عبر Swift إذا منع Safari القراءة";

  async function checkAuth() {
    if (!container || busy) return;
    try {
      const identity = await container.setUpAuth();
      authorized = !!identity;
      $("fetchRecord").disabled = !authorized;
      message(authorized ? "تم تسجيل الدخول. اضغط فحص CloudKit بضغطة واحدة." :
        "سجّل الدخول من زر Apple الرسمي، ثم اضغط تحقق من تسجيل الدخول.");
    } catch (e) {
      authorized = false;
      $("fetchRecord").disabled = true;
      authFailure("فشل التحقق من تسجيل الدخول", e);
    }
  }

  // CloudKit JS official performQuery uses an indexed record type in the default private zone.
  // No user-provided UUID or a hard-coded record ID; never modify anything in the database.
  async function discoverAsset(db) {
    let query = {recordType: "HRLXStreamProbe"};
    let options = {zoneID: "_defaultZone", desiredKeys: ["videoAsset"], resultsLimit: 20};
    let pages = 0;
    let found = 0;
    let best = null;
    while (pages < 4) {
      const response = await db.performQuery(query, options);
      pages++;
      if (response.hasErrors) {
        throw Array.isArray(response.errors) && response.errors.length
          ? response.errors[0] : {code: "QUERY_ERROR_NO_DETAILS"};
      }
      if (!Array.isArray(response.records)) throw {code: "QUERY_RESPONSE_MALFORMED"};
      for (const record of response.records) {
        if (record.recordType !== "HRLXStreamProbe") continue;
        found++;
        try {
          const asset = B.safeAssetFacts(record.fields && record.fields.videoAsset);
          const size = Number(asset.bytes);
          if (!best || (Number.isSafeInteger(size) && size > best.size)) {
            best = {...asset, size: Number.isSafeInteger(size) ? size : -1};
          }
        } catch (_) {
          // Some rows may not have a downloadable videoAsset. Do not report raw URLs.
        }
      }
      if (!response.moreComing && !response.continuationMarker) break;
      if (pages === 4) throw {code: "QUERY_PAGE_LIMIT"};
      query = response; // Apple-documented continuation: performQuery(response).
      options = undefined;
    }
    if (!found) throw {code: "NO_PRIVATE_PROBE_RECORDS"};
    if (!best) throw {code: "NO_VALID_ASSET_URL"};
    return {found, asset: best};
  }

  // CDN fetch must not download the whole video: only request 1024 bytes and cancel
  // response body immediately. HTTP 200 on a Range request is NOT accepted as streaming.
  async function sampleRequest(url, range, timeoutMs = 12000) {
    const controller = new AbortController();
    const kill = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const headers = range ? {Range: `bytes=${range.start}-${range.end}`} : {};
      const response = await fetch(url, {
        method: "GET", mode: "cors", credentials: "omit", redirect: "error",
        headers, cache: "no-store", signal: controller.signal
      });
      const status = response.status;
      const contentRange = response.headers.get("content-range");
      const contentLength = response.headers.get("content-length");
      // Do not read any media bytes; abort an ignored Range/normal GET immediately.
      controller.abort();
      if (response.body) { try { await response.body.cancel(); } catch (_) {} }
      return {kind: "http", status, contentRange, contentLength,
        seconds: Math.round((performance.now() - started) / 10) / 100};
    } catch (e) {
      return {kind: e && e.name === "AbortError" ? "timeout" : "browser_blocked",
        seconds: Math.round((performance.now() - started) / 10) / 100};
    } finally { clearTimeout(kill); }
  }

  function evaluateRange(result, requested, knownBytes) {
    if (result.kind !== "http") return result.kind === "timeout" ? "TIMEOUT" : "BROWSER_CORS_OR_NETWORK";
    if (result.status !== 206) return `HTTP_${result.status}`;
    if (!result.contentRange) return "HTTP_206_CONTENT_RANGE_NOT_EXPOSED";
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(result.contentRange.trim());
    if (!m) return "INVALID_CONTENT_RANGE";
    const start = Number(m[1]), end = Number(m[2]);
    const total = m[3] === "*" ? -1 : Number(m[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start !== requested.start || end !== requested.end ||
        (knownBytes > 0 && total !== knownBytes)) return "CONTENT_RANGE_MISMATCH";
    if (knownBytes <= 0 && (!Number.isSafeInteger(total) || total <= requested.end)) {
      return "UNKNOWN_ASSET_LENGTH";
    }
    return "VALID_206";
  }

  async function runRangeProbe(asset, found) {
    const bytes = asset.size;
    const prefix = ["Records discovered: " + found,
      "Asset bytes (metadata): " + (bytes > 0 ? bytes : "UNKNOWN"),
      "Asset host: " + asset.host,
      "Fresh downloadURL: YES (kept in memory only)"];
    if (!Number.isSafeInteger(bytes) || bytes < 4096) {
      message("STOP: لا يمكن تحديد حجم الفيديو المناسب للفحص", prefix.concat("Code: INVALID_ASSET_SIZE"));
      return;
    }
    const ranges = [
      {name:"البداية", start:0, end:1023},
      {name:"المنتصف", start:Math.floor(bytes/2), end:Math.floor(bytes/2)+1023},
      {name:"النهاية", start:bytes-1024, end:bytes-1}
    ];
    const lines = [...prefix];
    let firstResult = null;
    for (const range of ranges) {
      message("اختبار " + range.name + " مباشرة من خادم Apple", lines);
      const result = await sampleRequest(asset.url, range);
      const verdict = evaluateRange(result, range, bytes);
      lines.push(`${range.name}: ${verdict} | ${result.seconds}s`);
      if (!firstResult) firstResult = {result, verdict};
      if (verdict !== "VALID_206") {
        if (range === ranges[0] && result.kind === "http" && result.status !== 206) {
          // Differentiate an invalid asset URL from a Range-specific failure.
          message("التحقق من تنزيل عادي بأقل بيانات ممكنة", lines);
          const normal = await sampleRequest(asset.url, null);
          lines.push(`GET العادي: ${normal.kind === "http" ? "HTTP_" + normal.status : normal.kind.toUpperCase()} | ${normal.seconds}s`);
          if (normal.kind === "http" && normal.status === 200) {
            message("NOT PROVEN: التنزيل العادي متاح لكن Range لم ينجح", lines);
          } else if (normal.kind === "http" && normal.status >= 400) {
            message("BLOCKED: رابط CKAsset أو خادم Apple فشل حتى في التنزيل العادي", lines);
          } else {
            message("INCONCLUSIVE: فحص المتصفح غير حاسم", lines);
          }
        } else if (verdict === "BROWSER_CORS_OR_NETWORK" || verdict === "HTTP_206_CONTENT_RANGE_NOT_EXPOSED") {
          message("INCONCLUSIVE: Safari لا يتيح التحقق الكامل من الاستجابة. استخدم Swift Range Probe المحلي إذا لزم.", lines);
        } else {
          message("NOT PROVEN: أحد نطاقات الفيديو لم يحقق شروط HTTP Range", lines);
        }
        return;
      }
    }
    message("SUCCESS: تم إثبات HTTP Range في البداية والمنتصف والنهاية عبر المتصفح", lines.concat(
      "ملاحظة: هذا ليس إثباتًا لسرعة AVPlayer أو لعمله أثناء التحميل على الجهاز."));
  }

  $("configure").addEventListener("click", async () => {
    eraseURL();
    if (container) { message("CloudKit مهيأ مسبقًا. أعد تحميل الصفحة لتغيير API Token."); return; }
    const token = $("apiToken").value.trim();
    if (!/^[A-Za-z0-9._~-]{12,4096}$/.test(token)) {
      message("API Token غير موجود أو صيغته غير متوقعة"); return;
    }
    if (location.protocol !== "https:") {
      message("افتح الصفحة من موقع HTTPS بدل ملف محلي"); return;
    }
    if (typeof CloudKit === "undefined") {
      message("CloudKit JS من Apple لم يُحمّل. تحقق من اتصال الإنترنت."); return;
    }
    try {
      CloudKit.configure({locale:"ar", containers:[{
        containerIdentifier:"iCloud.com.hrlx.cloudlab", environment:"development",
        apiTokenAuth:{apiToken:token,persist:false,
          signInButton:{id:"apple-sign-in-button",theme:"black"},
          signOutButton:{id:"apple-sign-out-button",theme:"black"}}
      }]});
      $("apiToken").value = "";
      container = CloudKit.getDefaultContainer();
      $("configure").disabled = true;
      $("checkAuth").disabled = false;
      await checkAuth();
    } catch(e) { authFailure("فشلت تهيئة CloudKit", e); }
  });
  $("checkAuth").addEventListener("click", checkAuth);
  window.addEventListener("focus", () => { if (container && !busy) void checkAuth(); });

  $("fetchRecord").addEventListener("click", async () => {
    if (!authorized || !container || busy) {
      message("سجّل الدخول إلى Apple أولًا."); return;
    }
    eraseURL();
    setBusy(true);
    message("جاري العثور على فيديو الاختبار تلقائيًا داخل CloudKit Private");
    try {
      const {found, asset} = await discoverAsset(container.privateCloudDatabase);
      signedURL = asset.url;
      $("copyURL").disabled = false;
      await runRangeProbe(asset, found);
    } catch(e) {
      authFailure("FAIL: لم تكتمل قراءة فيديو الاختبار من Private Database", e);
    } finally { setBusy(false); }
  });
  $("copyURL").addEventListener("click", async () => {
    if (!signedURL) return;
    try {
      await navigator.clipboard.writeText(signedURL);
      message("تم نسخ رابط التنزيل الخاص على هذا الجهاز فقط.", info.concat(
        "لا ترسله في الدردشة ولا تنشره. الصقه في Swift Range Probe فقط."));
    } catch (_) { message("تعذّر النسخ. افحص أذونات الحافظة.", info); }
  });
  $("copyReport").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(report()); }
    catch (_) { message("تعذّر نسخ التقرير. النص المعروض آمن للنسخ اليدوي.", info); }
  });
  $("clear").addEventListener("click", () => {
    eraseURL(); message("مُسح رابط التنزيل من ذاكرة الصفحة. أغلق التبويب لإغلاق جلسة العمل.");
  });
  render();
})();
