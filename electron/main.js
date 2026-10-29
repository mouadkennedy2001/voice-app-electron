"use strict";

const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  session,
  shell,
  Tray
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const APP_URL = "https://voice-app-hi19.onrender.com/";
const APP_ORIGIN = new URL(APP_URL).origin;
const preferencesPath = () => path.join(app.getPath("userData"), "preferences.json");
const iconPath = path.join(__dirname, "assets", "sout.ico");
const DEFAULT_PREFERENCES = Object.freeze({
  theme: "system",
  rememberRoom: true,
  lastRoom: "",
  launchAtLogin: false,
  startMinimized: false,
  closeToTray: false,
  muteWhenMinimized: false,
  keepAwake: false,
  windowMode: "standard",
  audioMuted: false
});

let mainWindow;
let tray;
let preferences = { ...DEFAULT_PREFERENCES };
let powerBlockerId;
let isQuitting = false;
let preferenceWriteQueue = Promise.resolve();

app.setName("SAWT");

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === APP_ORIGIN && url.protocol === "https:";
  } catch {
    return false;
  }
}

function showError(error, action) {
  console.error(`تعذر ${action}:`, error);
  dialog.showErrorBox("صوت", `تعذر ${action}.\n${error.message}`);
}

async function loadPreferences() {
  try {
    const saved = JSON.parse(await fs.readFile(preferencesPath(), "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw new Error("ملف التفضيلات ليس كائناً صالحاً.");
    }
    preferences = validatePreferences(saved, true);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("تعذر قراءة تفضيلات التطبيق:", error);
    }
  }
}

function validatePreferences(value, allowPartial = false) {
  const result = { ...DEFAULT_PREFERENCES };
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_PREFERENCES, key)) {
      throw new Error(`إعداد غير معروف: ${key}`);
    }
    if (key === "theme" && ["system", "dark", "light"].includes(entry)) result.theme = entry;
    else if (key === "windowMode" && ["compact", "standard", "theater"].includes(entry)) result.windowMode = entry;
    else if (key === "lastRoom" && typeof entry === "string" && entry.length <= 2048 &&
      (!entry || isAppUrl(entry))) result.lastRoom = entry;
    else if (key !== "theme" && key !== "windowMode" && key !== "lastRoom" && typeof entry === "boolean") {
      result[key] = entry;
    } else {
      throw new Error(`قيمة غير صالحة للإعداد: ${key}`);
    }
  }
  if (!allowPartial) {
    for (const key of Object.keys(DEFAULT_PREFERENCES)) {
      if (!Object.hasOwn(value, key)) throw new Error(`الإعداد مطلوب: ${key}`);
    }
  }
  return result;
}

function savePreferences(changes) {
  preferences = validatePreferences({ ...preferences, ...changes });
  const snapshot = JSON.stringify(preferences, null, 2);
  preferenceWriteQueue = preferenceWriteQueue.catch(() => {}).then(async () => {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(preferencesPath(), snapshot, "utf8");
  });
  return preferenceWriteQueue;
}

function effectiveTheme() {
  return preferences.theme === "system"
    ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
    : preferences.theme;
}

async function applyThemeToPage() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;

  const theme = effectiveTheme();
  const script = `(() => {
    const theme = ${JSON.stringify(theme)};
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sout-theme", theme);
    const color = theme === "dark" ? "#171326" : "#f4f0ff";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = color;
    const button = document.getElementById("theme-toggle");
    if (button) button.setAttribute("aria-label", theme === "dark" ? "تفعيل المظهر الفاتح" : "تفعيل المظهر الداكن");
    const style = document.getElementById("sout-brand-style") || document.createElement("style");
    style.id = "sout-brand-style";
    style.textContent = ${JSON.stringify(`
      :root[data-theme="dark"] {
        --bg: #100d19 !important;
        --panel: #181321 !important;
        --card: #211a30 !important;
        --card-strong: #2a2140 !important;
        --hover: #33294b !important;
        --border: #3b3151 !important;
        --text: #eeeaf9 !important;
        --text-strong: #fffaff !important;
        --muted: #b2a7c8 !important;
        --accent: #a78bfa !important;
        --accent-hover: #c4b5fd !important;
        --accent-soft: rgba(167,139,250,.16) !important;
        --green: #55d6be !important;
        --green-soft: rgba(85,214,190,.15) !important;
      }
      :root[data-theme="light"] {
        --bg: #f4f0ff !important;
        --panel: #fff !important;
        --card: #f7f4ff !important;
        --card-strong: #ece6fb !important;
        --hover: #e7e0f7 !important;
        --border: #ded5ef !important;
        --text: #28223a !important;
        --text-strong: #1a1529 !important;
        --muted: #766b89 !important;
        --accent: #6d4ad4 !important;
        --accent-hover: #5835bf !important;
        --accent-soft: rgba(109,74,212,.11) !important;
        --green: #138a76 !important;
        --green-soft: rgba(19,138,118,.1) !important;
      }
      :root { --radius: 16px !important; }
      body {
        background:
          radial-gradient(ellipse at 12% -12%, rgba(139,92,246,.13), transparent 36rem),
          radial-gradient(ellipse at 95% 0%, rgba(99,102,241,.08), transparent 32rem),
          var(--bg) !important;
      }
      .brand-mark {
        background: linear-gradient(145deg,#a78bfa,#6841d9) !important;
        box-shadow: 0 8px 26px rgba(109,74,212,.32) !important;
      }
      .topbar, .join-card, .drawer, dialog {
        backdrop-filter: blur(18px);
        border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
      }
      .join-card {
        box-shadow: 0 28px 80px rgba(74,49,139,.12);
      }
      .btn-accent {
        background: linear-gradient(135deg,#8b6bea,#6542c8) !important;
      }
      .btn-accent, .ctrl-primary:not(.is-muted) {
        box-shadow: 0 8px 24px rgba(109,74,212,.2);
      }
      button, .card, .participant-card { transition: background-color .18s ease, border-color .18s ease, transform .18s ease; }
      .icon-button:hover, .btn:hover { transform: translateY(-1px); }
    `)};
    if (!style.isConnected) document.head.append(style);
    const themeButton = document.getElementById("theme-toggle");
    if (themeButton && !themeButton.dataset.soutThemeSync) {
      themeButton.dataset.soutThemeSync = "true";
      themeButton.addEventListener("click", () => setTimeout(() => {
        window.soutDesktop?.setTheme(document.documentElement.dataset.theme);
      }, 0));
    }
  })()`;

  try {
    await mainWindow.webContents.executeJavaScript(script);
  } catch (error) {
    console.error("تعذر تطبيق مظهر التطبيق:", error);
  }
}

async function setTheme(theme) {
  if (!["system", "dark", "light"].includes(theme)) {
    throw new Error("اختيار المظهر غير صالح.");
  }

  await savePreferences({ theme });
  nativeTheme.themeSource = theme === "system" ? "system" : theme;
  await applyThemeToPage();
  buildApplicationMenu();
}

function runPageAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  action(mainWindow);
}

function buildApplicationMenu() {
  const template = [
    {
      label: "صوت",
      submenu: [
        {
          label: "إظهار التطبيق",
          accelerator: "CommandOrControl+Shift+S",
          click: () => showWindow()
        },
        { type: "separator" },
        { label: "حول صوت", click: () => showAbout() },
        { type: "separator" },
        { label: "إنهاء", accelerator: "CommandOrControl+Q", click: () => app.quit() }
      ]
    },
    {
      label: "النافذة",
      submenu: [
        { label: "تصغير", accelerator: "CommandOrControl+M", click: () => runPageAction((win) => win.minimize()) },
        {
          label: "تكبير / استعادة",
          accelerator: "CommandOrControl+Shift+M",
          click: () => runPageAction((win) => win.isMaximized() ? win.unmaximize() : win.maximize())
        },
        { label: "ملء الشاشة", accelerator: "F11", click: () => runPageAction((win) => win.setFullScreen(!win.isFullScreen())) },
        {
          label: "إبقاء النافذة في المقدمة",
          type: "checkbox",
          click: (item) => runPageAction((win) => win.setAlwaysOnTop(item.checked))
        },
        { type: "separator" },
        { label: "وضع مصغر — 900 × 680", type: "radio", checked: preferences.windowMode === "compact", click: () => void setWindowMode("compact") },
        { label: "الوضع القياسي — 1440 × 920", type: "radio", checked: preferences.windowMode === "standard", click: () => void setWindowMode("standard") },
        { label: "وضع المسرح — 1680 × 1050", type: "radio", checked: preferences.windowMode === "theater", click: () => void setWindowMode("theater") }
      ]
    },
    {
      label: "التنقل",
      submenu: [
        { label: "رجوع", accelerator: "Alt+Left", click: () => runPageAction((win) => { if (win.webContents.canGoBack()) win.webContents.goBack(); }) },
        { label: "تقدم", accelerator: "Alt+Right", click: () => runPageAction((win) => { if (win.webContents.canGoForward()) win.webContents.goForward(); }) },
        { label: "الصفحة الرئيسية", accelerator: "Alt+Home", click: () => runPageAction((win) => win.loadURL(APP_URL)) },
        { type: "separator" },
        { label: "إعادة تحميل", accelerator: "CommandOrControl+R", click: () => runPageAction((win) => win.webContents.reload()) },
        { label: "إعادة تحميل كاملة", accelerator: "CommandOrControl+Shift+R", click: () => runPageAction((win) => win.webContents.reloadIgnoringCache()) },
        { type: "separator" },
        { label: "تكبير الصفحة", accelerator: "CommandOrControl+Plus", click: () => runPageAction((win) => win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1)) },
        { label: "تصغير الصفحة", accelerator: "CommandOrControl+-", click: () => runPageAction((win) => win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 1)) },
        { label: "الحجم الافتراضي", accelerator: "CommandOrControl+0", click: () => runPageAction((win) => win.webContents.setZoomLevel(0)) },
        {
          label: "كتم صوت التطبيق",
          type: "checkbox",
          checked: preferences.audioMuted,
          click: (item) => {
            runPageAction((win) => win.webContents.setAudioMuted(item.checked || (preferences.muteWhenMinimized && win.isMinimized())));
            void updatePreference("audioMuted", item.checked, "حفظ إعداد كتم الصوت");
          }
        },
        { label: "أدوات المطور", accelerator: "CommandOrControl+Shift+I", click: () => runPageAction((win) => win.webContents.toggleDevTools()) }
      ]
    },
    {
      label: "الصفحة",
      submenu: [
        { label: "نسخ رابط الدعوة", accelerator: "CommandOrControl+Shift+C", click: () => copyPageUrl() },
        { label: "فتح الرابط في المتصفح", click: () => openPageInBrowser() },
        { label: "طباعة", accelerator: "CommandOrControl+P", click: () => printPage() },
        { label: "حفظ الصفحة", accelerator: "CommandOrControl+S", click: () => savePage() },
        { label: "حفظ لقطة شاشة", click: () => saveScreenshot() },
        { label: "مسح ذاكرة التخزين المؤقت", click: () => clearCache() }
      ]
    },
    {
      label: "إعدادات التطبيق",
      submenu: [
        {
          label: "تذكّر رابط الغرفة واستعادته",
          type: "checkbox",
          checked: preferences.rememberRoom,
          click: (item) => void updatePreference("rememberRoom", item.checked, "حفظ تفضيل الغرفة")
        },
        { label: "فتح آخر رابط محفوظ", click: () => openLastRoom() },
        {
          label: "تشغيل صوت مع بدء النظام",
          type: "checkbox",
          checked: preferences.launchAtLogin,
          click: (item) => void setLaunchAtLogin(item.checked)
        },
        {
          label: "البدء مخفياً في درج النظام",
          type: "checkbox",
          checked: preferences.startMinimized,
          click: (item) => void updatePreference("startMinimized", item.checked, "حفظ إعداد بدء التشغيل")
        },
        {
          label: "إخفاء النافذة إلى الدرج عند الإغلاق",
          type: "checkbox",
          checked: preferences.closeToTray,
          click: (item) => void updatePreference("closeToTray", item.checked, "حفظ إعداد الإغلاق")
        },
        {
          label: "كتم صوت التطبيق عند تصغيره",
          type: "checkbox",
          checked: preferences.muteWhenMinimized,
          click: (item) => void updatePreference("muteWhenMinimized", item.checked, "حفظ إعداد الصوت")
        },
        {
          label: "منع سكون الشاشة أثناء تشغيل التطبيق",
          type: "checkbox",
          checked: preferences.keepAwake,
          click: (item) => void setKeepAwake(item.checked)
        },
        { type: "separator" },
        { label: "تصدير الإعدادات", click: () => exportPreferences() },
        { label: "استيراد الإعدادات", click: () => importPreferences() },
        { label: "إعادة الإعدادات الافتراضية", click: () => resetPreferences() },
        { label: "حذف بيانات الدخول لهذا الموقع", click: () => clearSiteData() }
      ]
    },
    {
      label: "المظهر",
      submenu: [
        { label: "حسب النظام", type: "radio", checked: preferences.theme === "system", click: () => changeTheme("system") },
        { label: "داكن بنفسجي", type: "radio", checked: preferences.theme === "dark", click: () => changeTheme("dark") },
        { label: "فاتح بنفسجي", type: "radio", checked: preferences.theme === "light", click: () => changeTheme("light") }
      ]
    },
    {
      label: "مساعدة",
      submenu: [
        { label: "فتح الموقع في المتصفح", click: () => shell.openExternal(APP_URL) },
        { label: "إظهار الإشعار التجريبي", click: () => showNotification() }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function changeTheme(theme) {
  void setTheme(theme).catch((error) => showError(error, "حفظ المظهر"));
}

async function updatePreference(key, value, action) {
  try {
    await savePreferences({ [key]: value });
    if (key === "startMinimized" && preferences.launchAtLogin) syncLoginItemSettings();
    if (key === "muteWhenMinimized" && mainWindow?.isMinimized()) {
      mainWindow.webContents.setAudioMuted(preferences.muteWhenMinimized || preferences.audioMuted);
    }
    buildApplicationMenu();
  } catch (error) {
    showError(error, action);
  }
}

function getWindowSize(mode) {
  return {
    compact: { width: 900, height: 680 },
    standard: { width: 1440, height: 920 },
    theater: { width: 1680, height: 1050 }
  }[mode];
}

async function setWindowMode(mode) {
  const size = getWindowSize(mode);
  if (!size) {
    showError(new Error("حجم النافذة غير معروف."), "تغيير حجم النافذة");
    return;
  }
  try {
    await savePreferences({ windowMode: mode });
    runPageAction((win) => {
      win.setFullScreen(false);
      win.setSize(size.width, size.height);
      win.center();
    });
    buildApplicationMenu();
  } catch (error) {
    showError(error, "تغيير حجم النافذة");
  }
}

async function setLaunchAtLogin(enabled) {
  try {
    await savePreferences({ launchAtLogin: enabled });
    syncLoginItemSettings();
    buildApplicationMenu();
  } catch (error) {
    showError(error, "تحديث بدء التشغيل");
  }
}

function syncLoginItemSettings() {
  app.setLoginItemSettings({
    openAtLogin: preferences.launchAtLogin,
    args: preferences.launchAtLogin && preferences.startMinimized ? ["--start-minimized"] : []
  });
}

async function setKeepAwake(enabled) {
  try {
    if (enabled && !powerBlockerId) {
      powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    } else if (!enabled && powerBlockerId) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = undefined;
    }
    await savePreferences({ keepAwake: enabled });
    buildApplicationMenu();
  } catch (error) {
    showError(error, "تحديث إعداد منع السكون");
  }
}

async function openLastRoom() {
  if (!preferences.lastRoom || !isAppUrl(preferences.lastRoom)) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "صوت",
      message: "لا يوجد رابط غرفة محفوظ بعد."
    });
    return;
  }
  try {
    await mainWindow.loadURL(preferences.lastRoom);
  } catch (error) {
    showError(error, "فتح آخر غرفة");
  }
}

async function exportPreferences() {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "تصدير إعدادات صوت",
      defaultPath: "sout-settings.json",
      filters: [{ name: "إعدادات التطبيق", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return;
    await fs.writeFile(result.filePath, JSON.stringify(preferences, null, 2), "utf8");
  } catch (error) {
    showError(error, "تصدير الإعدادات");
  }
}

async function importPreferences() {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "استيراد إعدادات صوت",
      properties: ["openFile"],
      filters: [{ name: "إعدادات التطبيق", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePaths[0]) return;
    const imported = validatePreferences(JSON.parse(await fs.readFile(result.filePaths[0], "utf8")));
    await savePreferences(imported);
    syncLoginItemSettings();
    nativeTheme.themeSource = preferences.theme;
    if (preferences.keepAwake !== Boolean(powerBlockerId)) await setKeepAwake(preferences.keepAwake);
    const size = getWindowSize(preferences.windowMode);
    runPageAction((win) => {
      win.setSize(size.width, size.height);
      win.center();
    });
    await applyThemeToPage();
    buildApplicationMenu();
  } catch (error) {
    showError(error, "استيراد الإعدادات");
  }
}

async function resetPreferences() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "إعادة الإعدادات",
    message: "هل تريد إعادة إعدادات التطبيق إلى قيمها الافتراضية؟",
    buttons: ["إعادة الإعدادات", "إلغاء"],
    cancelId: 1,
    defaultId: 1,
    noLink: true
  });
  if (result.response !== 0) return;
  try {
    const shouldDisableStartup = preferences.launchAtLogin;
    if (shouldDisableStartup) app.setLoginItemSettings({ openAtLogin: false });
    await savePreferences({ ...DEFAULT_PREFERENCES });
    nativeTheme.themeSource = "system";
    if (powerBlockerId) powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = undefined;
    const size = getWindowSize("standard");
    runPageAction((win) => {
      win.setSize(size.width, size.height);
      win.center();
    });
    await applyThemeToPage();
    buildApplicationMenu();
  } catch (error) {
    showError(error, "إعادة الإعدادات");
  }
}

async function clearSiteData() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "حذف بيانات الموقع",
    message: "سيؤدي هذا إلى تسجيل خروجك وحذف بيانات الموقع المحفوظة على هذا الجهاز. هل تريد المتابعة؟",
    buttons: ["حذف البيانات", "إلغاء"],
    cancelId: 1,
    defaultId: 1,
    noLink: true
  });
  if (result.response !== 0) return;
  try {
    await session.defaultSession.clearStorageData({
      origin: APP_ORIGIN,
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
    });
    await mainWindow.loadURL(APP_URL);
  } catch (error) {
    showError(error, "حذف بيانات الموقع");
  }
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "حول صوت",
    message: "صوت | SAWT",
    detail: "مساحة صوتية خاصة للمحادثات ومشاركة الملفات مباشرةً بين المشاركين.\nتصميم مستقل بهوية بنفسجية أنيقة.",
    buttons: ["حسناً"]
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function showNotification() {
  if (!Notification.isSupported()) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "صوت",
      message: "إشعارات سطح المكتب غير متاحة على هذا الجهاز."
    });
    return;
  }
  new Notification({ title: "صوت", body: "إشعارات التطبيق جاهزة." }).show();
}

function copyPageUrl() {
  runPageAction((win) => {
    const url = win.webContents.getURL();
    if (isAppUrl(url)) {
      clipboard.writeText(url);
    }
  });
}

function openPageInBrowser() {
  runPageAction((win) => {
    const url = win.webContents.getURL();
    if (isAppUrl(url)) void shell.openExternal(url);
  });
}

function printPage() {
  runPageAction((win) => win.webContents.print({ printBackground: true }));
}

async function savePage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "حفظ صفحة صوت",
      defaultPath: "sout.html",
      filters: [{ name: "صفحة ويب كاملة", extensions: ["html"] }]
    });
    if (result.canceled || !result.filePath) return;
    await mainWindow.webContents.savePage(result.filePath, "HTMLComplete");
  } catch (error) {
    showError(error, "حفظ الصفحة");
  }
}

async function saveScreenshot() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "حفظ لقطة شاشة",
      defaultPath: "sout.png",
      filters: [{ name: "صورة PNG", extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) return;
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(result.filePath, image.toPNG());
  } catch (error) {
    showError(error, "حفظ لقطة الشاشة");
  }
}

async function clearCache() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.webContents.session.clearCache();
    mainWindow.webContents.reload();
  } catch (error) {
    showError(error, "مسح ذاكرة التخزين المؤقت");
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath)
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("صوت — غرف المحادثة الصوتية");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "إظهار صوت", click: () => showWindow() },
    { label: "إعادة تحميل", click: () => runPageAction((win) => win.webContents.reload()) },
    { type: "separator" },
    { label: "إنهاء", click: () => app.quit() }
  ]));
  tray.on("click", () => showWindow());
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isAppUrl(details.requestingUrl) &&
      mainWindow &&
      webContents === mainWindow.webContents;
    const audioOnly = permission === "media" &&
      Array.isArray(details.mediaTypes) &&
      details.mediaTypes.length > 0 &&
      details.mediaTypes.every((type) => type === "audio");
    callback(Boolean(trusted && (audioOnly || permission === "notifications")));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isAppUrl(request.securityOrigin)) {
      callback({});
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources.length || !mainWindow || mainWindow.isDestroyed()) {
        callback({});
        return;
      }

      const buttons = [...sources.map((source) => source.name), "إلغاء"];
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "مشاركة الشاشة",
        message: "اختر الشاشة أو النافذة التي تريد مشاركتها:",
        buttons,
        cancelId: buttons.length - 1,
        defaultId: 0,
        noLink: true
      });
      const source = sources[result.response];
      callback(source ? { video: source } : {});
    } catch (error) {
      console.error("تعذر بدء اختيار الشاشة:", error);
      callback({});
    }
  });
}

function configureDesktopBridge() {
  ipcMain.handle("sout:set-theme", async (event, theme) => {
    if (
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !isAppUrl(event.senderFrame.url)
    ) {
      throw new Error("مصدر طلب تغيير المظهر غير موثوق.");
    }
    await setTheme(theme);
  });
}

function createWindow() {
  const initialSize = getWindowSize(preferences.windowMode);
  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: 760,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: effectiveTheme() === "dark" ? "#171326" : "#f4f0ff",
    icon: iconPath,
    title: "صوت | SAWT — غرف المحادثة الصوتية",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (preferences.startMinimized || process.argv.includes("--start-minimized")) {
      showBackgroundNotification();
    } else {
      mainWindow.show();
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    void applyThemeToPage();
  });
  mainWindow.webContents.on("did-navigate-in-page", (_event, url) => rememberRoom(url));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.on("minimize", () => {
    if (preferences.muteWhenMinimized || preferences.audioMuted) {
      mainWindow.webContents.setAudioMuted(true);
    }
  });
  mainWindow.on("restore", () => mainWindow.webContents.setAudioMuted(preferences.audioMuted));
  mainWindow.on("close", (event) => {
    if (preferences.closeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      showBackgroundNotification();
    }
  });
  const startUrl = preferences.rememberRoom && preferences.lastRoom && isAppUrl(preferences.lastRoom)
    ? preferences.lastRoom
    : APP_URL;
  void mainWindow.loadURL(startUrl).catch((error) => showError(error, "تحميل موقع صوت"));
}

function rememberRoom(url) {
  if (!preferences.rememberRoom || !isAppUrl(url) || url === preferences.lastRoom) return;
  void savePreferences({ lastRoom: url }).catch((error) => showError(error, "حفظ رابط الغرفة"));
}

function showBackgroundNotification() {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "صوت | SAWT",
    body: "التطبيق يعمل في الخلفية. اضغط للعودة."
  });
  notification.on("click", () => showWindow());
  notification.show();
}

app.whenReady().then(async () => {
  await loadPreferences();
  nativeTheme.themeSource = preferences.theme;
  nativeTheme.on("updated", () => {
    if (preferences.theme === "system") void applyThemeToPage();
  });
  configureMediaPermissions();
  configureDesktopBridge();
  buildApplicationMenu();
  createTray();
  if (preferences.keepAwake) powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  createWindow();
  app.on("activate", () => showWindow());
}).catch((error) => {
  showError(error, "تشغيل التطبيق");
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !preferences.closeToTray) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (powerBlockerId) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = undefined;
  }
});
