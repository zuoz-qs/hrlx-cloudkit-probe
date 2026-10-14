"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const B = window.HRLXCore;
  let container = null;
  let authorized = false;
  let signedURL = null; // memory only; never printed, persisted or logged.
  let stage = "بانتظار تهيئة CloudKit";
  let info = [];
  const report = () => ["HRLX CLOUDKIT AUTH WEB PROBE / READ ONLY",
    "Container: iCloud.com.hrlx.cloudlab / development / private", stage, ...info].join("\n");
  const render = () => { $("status").textContent = report(); };
  const message = (s, items = []) => { stage = s; info = items; render(); };
  const authFailure = (prefix, e) => message(prefix, ["Code: " + B.safeErrorCode(e),
    "لا تُرسل رموز أو روابط أو الرسالة الخام للخطأ."]);
  function eraseURL() { signedURL = null; $("copyURL").disabled = true; }
  async function checkAuth() {
    if (!container) return;
    eraseURL();
    try {
      const identity = await container.setUpAuth();
      authorized = !!identity;
      $("fetchRecord").disabled = !authorized;
      message(authorized ? "تم تسجيل الدخول إلى CloudKit بنجاح" :
        "مطلوب تسجيل الدخول من زر Apple الرسمي ثم الضغط على تحقق من تسجيل الدخول");
    } catch (e) {
      authorized = false;
      $("fetchRecord").disabled = true;
      authFailure("فشل التحقق من تسجيل الدخول", e);
    }
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
      $("apiToken").value = ""; // Clear the input; SDK retains configuration in memory.
      container = CloudKit.getDefaultContainer();
      $("configure").disabled = true;
      $("checkAuth").disabled = false;
      await checkAuth();
    } catch(e) { authFailure("فشلت تهيئة CloudKit", e); }
  });
  $("checkAuth").addEventListener("click", checkAuth);
  window.addEventListener("focus", () => {
    if (container) void checkAuth();
  });
  $("fetchRecord").addEventListener("click", async () => {
    eraseURL();
    if (!authorized || !container) { message("سجل الدخول أولًا"); return; }
    const recordID = $("recordName").value.trim();
    if (!B.isValidRecordName(recordID)) { message("Record Name غير صالح"); return; }
    $("fetchRecord").disabled = true;
    message("جاري جلب بيانات السجل الحالية فقط من Private Database");
    try {
      const response = await container.privateCloudDatabase.fetchRecords(recordID,
        {zoneID:"_defaultZone",desiredKeys:["videoAsset"]});
      if (response.hasErrors || !response.records || response.records.length !== 1) {
        throw {code: "RECORD_FETCH_FAILED"};
      }
      const record = response.records[0];
      if (record.recordType !== "HRLXStreamProbe" || record.recordName !== recordID) {
        throw {code:"RECORD_MISMATCH"};
      }
      const facts = B.safeAssetFacts(record.fields && record.fields.videoAsset);
      signedURL = facts.url;
      $("copyURL").disabled = false;
      message("SUCCESS: تم إصدار رابط جديد من سجل CloudKit الخاص", [
        "Record Type: HRLXStreamProbe", "Asset host: " + facts.host,
        "Asset size: " + facts.bytes + " bytes", "Expiry (if provided): " + facts.expiry,
        "هذا إثبات وصول إلى metadata فقط، وليس إثبات HTTP Range أو تشغيل فيديو."]);
    } catch(e) { authFailure("FAIL: تعذّر استخراج رابط جديد",e); }
    finally { $("fetchRecord").disabled = !authorized; }
  });
  $("copyURL").addEventListener("click", async () => {
    if (!signedURL) return;
    try {
      await navigator.clipboard.writeText(signedURL);
      message("تم نسخ الرابط الخاص على هذا الجهاز فقط. الصقه داخل Swift Range Probe.", info);
    } catch (_) { message("تعذّر النسخ التلقائي. تحقق من إذن الحافظة للمتصفح.", info); }
  });
  $("copyReport").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(report()); }
    catch (_) { message("تعذّر نسخ التقرير. النص المعروض آمن للنسخ اليدوي.", info); }
  });
  $("clear").addEventListener("click", () => { eraseURL(); message("تم مسح الرابط من ذاكرة الصفحة. أغلق التبويب لإغلاق جلسة العمل."); });
  render();
})();
