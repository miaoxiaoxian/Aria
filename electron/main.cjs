const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerMonitor, clipboard, globalShortcut, shell, dialog } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { createLogger, serializeError } = require("./logger.cjs");
const { MpvAudioEngine } = require("./mpvEngine.cjs");

const logger = createLogger(app);
const { writeLog } = logger;
logger.writeRuntimeSnapshot("desktop.log", "main loaded");

// Optional native addon that answers the DWM iconic-thumbnail messages so
// the taskbar hover preview shows the album art (NetEase-style).
let iconicThumbAddon = null;
try {
  iconicThumbAddon = require("./native/aria-thumbnail/index.cjs");
} catch (error) {
  iconicThumbAddon = null;
  logger.writeLog("desktop.log", `iconic thumbnail addon unavailable: ${error?.message || error}`);
}

// Windows needs an app-provided iconic bitmap for the compact taskbar card.
// Keep an explicit opt-out for diagnostics, but enable the native DWM bridge
// by default on Windows so the taskbar does not fall back to a full-window
// capture. Electron still owns the thumbnail toolbar and clip region.
const nativeIconicThumbnailEnabled = process.platform === "win32" && process.env.ARIA_NATIVE_ICONIC_THUMBNAIL !== "0";

const apiPort = Number(process.env.ARIA_API_PORT || process.env.MUSICBOX_API_PORT || 3636);
const apiBase = `http://127.0.0.1:${apiPort}`;

let mainWindow = null;
let tray = null;
let backendProcess = null;
let isQuitting = false;
let backgroundEnabled = true;
let rendererRecoveries = 0;
let nativeAudioEngine = null;
let powerRecoveryAttached = false;
let taskbarPlayback = {
  title: "",
  artist: "",
  playing: false,
};
const taskbarRetryTimers = new Set();
let lastTaskbarClipLogKey = "";
// Taskbar hover preview: clip the window thumbnail to the current cover art.
// Electron BrowserWindow rectangles and renderer getBoundingClientRect() both
// use device-independent/CSS pixels. setThumbarButtons drops an existing
// clip, so it is re-applied after every thumbar update.
let taskbarClipRect = null;
let gpuVendorId = null;
let gpuDetectPromise = null;
let gpuOptimizeEnabled = true;
try {
  const rawGpuMode = fs.readFileSync(path.join(app.getPath("userData"), "gpu-mode.json"), "utf8");
  const parsedGpuMode = JSON.parse(rawGpuMode);
  if (typeof parsedGpuMode?.optimize === "boolean") gpuOptimizeEnabled = parsedGpuMode.optimize;
} catch {
  gpuOptimizeEnabled = true;
}

function detectGpuVendorAsync() {
  if (gpuDetectPromise) return gpuDetectPromise;
  gpuDetectPromise = new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty PNPDeviceID)",
        ],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => {
          const match = String(stdout || "").match(/VEN_([0-9A-Fa-f]{4})/);
          resolve(match ? Number.parseInt(match[1], 16) : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
  return gpuDetectPromise;
}

function applyTaskbarClip() {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setThumbnailClip !== "function") return;
  // Always keep the Electron thumbnail clipped to the square cover. The
  // native DWM handler supplies the same cover pixels when available, while
  // Electron remains the reliable fallback on systems that reject custom
  // iconic thumbnails.
  try {
    if (!taskbarClipRect) {
      mainWindow.setThumbnailClip({ x: 0, y: 0, width: 0, height: 0 });
      if (lastTaskbarClipLogKey !== "reset") {
        lastTaskbarClipLogKey = "reset";
        writeLog("desktop.log", "taskbar thumbnail clip reset");
      }
      return;
    }

    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    const requestedSide = Math.max(8, Math.min(taskbarClipRect.width, taskbarClipRect.height));
    const requestedX = taskbarClipRect.x + (taskbarClipRect.width - requestedSide) / 2;
    const requestedY = taskbarClipRect.y + (taskbarClipRect.height - requestedSide) / 2;
    const x = Math.max(0, Math.min(Math.round(requestedX), Math.max(0, contentWidth - 8)));
    const y = Math.max(0, Math.min(Math.round(requestedY), Math.max(0, contentHeight - 8)));
    const side = Math.max(8, Math.min(Math.round(requestedSide), contentWidth - x, contentHeight - y));
    const clip = { x, y, width: side, height: side };
    mainWindow.setThumbnailClip(clip);

    const key = `${clip.x}|${clip.y}|${clip.width}|${clip.height}|${contentWidth}|${contentHeight}`;
    if (lastTaskbarClipLogKey !== key) {
      lastTaskbarClipLogKey = key;
      writeLog("desktop.log", `taskbar thumbnail clip applied: ${JSON.stringify(clip)} content=${contentWidth}x${contentHeight}`);
    }
  } catch (error) {
    writeLog("desktop.log", `taskbar thumbnail clip failed: ${error?.stack || error}`);
  }
}
let globalShortcutConfig = {
  toggle: "Control+Alt+Space",
  previous: "Control+Alt+Left",
  next: "Control+Alt+Right",
  show: "Control+Alt+A",
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function mediaCommandFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.includes("--media-toggle")) return "toggle";
  if (argv.includes("--media-previous")) return "previous";
  if (argv.includes("--media-next")) return "next";
  return null;
}

let initialMediaCommand = mediaCommandFromArgv(process.argv);

app.setName("Aria");
app.setAppUserModelId("com.yrrlyb.aria");
Menu.setApplicationMenu(null);

function ensureWindowsTaskbarPreviewPolicy() {
  if (process.platform !== "win32") return;
  try {
    // Windows suppresses every taskbar thumbnail when this per-user flag is
    // set. Aria owns its taskbar card, so make the prerequisite explicit at
    // startup and ask Explorer to refresh its per-user shell parameters.
    execFileSync("reg.exe", [
      "ADD",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
      "/v",
      "DisablePreviewDesktop",
      "/t",
      "REG_DWORD",
      "/d",
      "0",
      "/f",
    ], { windowsHide: true, stdio: "ignore" });
    spawn("rundll32.exe", ["user32.dll,UpdatePerUserSystemParameters"], {
      windowsHide: true,
      stdio: "ignore",
      detached: true,
    }).unref();
    writeLog("desktop.log", "taskbar thumbnail preview policy enabled");
  } catch (error) {
    writeLog("desktop.log", `taskbar thumbnail preview policy unavailable: ${error?.message || error}`);
  }
}

ensureWindowsTaskbarPreviewPolicy();

// Chromium spends GPU process memory on the many frosted-glass layers; keep
// the app on the integrated GPU when a discrete one is present and cap every
// V8 heap so long sessions collect garbage instead of growing without bound.
// MediaSessionService is what publishes playback state to the OS media
// overlay / lock screen (SMTC) on Windows.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256 --expose-gc");
app.commandLine.appendSwitch("enable-features", "MediaSessionService");

function getNativeAudioEngine() {
  if (!nativeAudioEngine) {
    nativeAudioEngine = new MpvAudioEngine({
      app,
      writeLog,
      sendEvent: (payload) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
        mainWindow.webContents.send("aria:native-audio-event", payload);
      },
    });
  }
  return nativeAudioEngine;
}

function scheduleNativeAudioRecovery(reason, delayMs = 900) {
  setTimeout(() => {
    nativeAudioEngine?.recoverOutput?.(reason).catch((error) => {
      writeLog("native-audio.log", `scheduled recovery failed: ${error?.stack || error}`);
    });
  }, delayMs);
}

function attachPowerRecoveryHandlers() {
  if (powerRecoveryAttached) return;
  powerRecoveryAttached = true;
  powerMonitor.on("resume", () => scheduleNativeAudioRecovery("system-resume", 1100));
  powerMonitor.on("unlock-screen", () => scheduleNativeAudioRecovery("unlock-screen", 700));
  powerMonitor.on("suspend", () => writeLog("native-audio.log", "system suspend"));
}

logger.attachProcessHandlers("desktop.log");

function resolveServerEntry() {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "dist-server", "index.cjs");
    if (fs.existsSync(unpacked)) return unpacked;
    return path.join(process.resourcesPath, "app.asar", "dist-server", "index.cjs");
  }

  return path.join(__dirname, "..", "dist-server", "index.cjs");
}

function resolvePreload() {
  return path.join(__dirname, "preload.cjs");
}

function resolveIcon() {
  if (app.isPackaged) {
    // Prefer the real filesystem copy shipped via extraResources; Explorer and
    // Win32 icon APIs handle a loose file more reliably than an asar entry.
    const external = path.join(process.resourcesPath, "icon.ico");
    if (fs.existsSync(external)) return external;
  }
  return path.join(__dirname, "..", "build", "icon.ico");
}

function resolveTrayIcon() {
  return path.join(__dirname, "..", "build", "icon.png");
}

function trayIcon() {
  const iconPath = fs.existsSync(resolveTrayIcon()) ? resolveTrayIcon() : resolveIcon();
  if (fs.existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) return icon.resize({ width: 18, height: 18 });
  }

  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="9" fill="#f7f8fb"/>
      <path d="M9 23.5 15.2 7.8h3.4l6.4 15.7h-3.7l-1.2-3.1h-6.6l-1.1 3.1H9Zm5.6-6h4.4l-2.2-5.9-2.2 5.9Z" fill="#8fa7ff"/>
      <path d="M17.8 8.2c3.7 2.9 5.6 8 4 11.6-.8 1.9-2.4 3-4.1 3.2 1.8-2.3 2-5.4.6-8.4-.7-1.6-1.4-3.5-.5-6.4Z" fill="#e58de7" opacity=".82"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`).resize({ width: 18, height: 18 });
}

async function apiOnline(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/api/health`);
      if (response.ok) return true;
    } catch {
      // Wait for the child process to finish booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function urlOnline(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startBackend() {
  if (await apiOnline(500)) return;

  const serverEntry = resolveServerEntry();
  writeLog("desktop.log", `starting backend: ${serverEntry}`);
  // Cap the backend V8 heap so long sessions GC eagerly instead of letting V8
  // grow its old space with machine RAM on large-memory hosts.
  backendProcess = spawn(process.execPath, ["--max-old-space-size=384", serverEntry], {
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ARIA_API_PORT: String(apiPort),
      MUSICBOX_API_PORT: String(apiPort),
      ARIA_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: app.isPackaged ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });

  if (app.isPackaged) {
    backendProcess.stdout?.on("data", (chunk) => writeLog("backend.log", String(chunk).trimEnd()));
    backendProcess.stderr?.on("data", (chunk) => writeLog("backend.log", `ERR ${String(chunk).trimEnd()}`));
  }

  backendProcess.once("exit", (code, signal) => {
    writeLog("desktop.log", `backend exited: code=${code} signal=${signal}`);
    backendProcess = null;
    if (!isQuitting) {
      setTimeout(() => startBackend(), 1500);
    }
  });

  const online = await apiOnline(9000);
  writeLog("desktop.log", `backend online: ${online}`);
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send("aria:window-visibility", true);
}

function sendWindowVisibility(visible) {
  mainWindow?.webContents.send("aria:window-visibility", Boolean(visible));
}

function sendPlaybackCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("aria:playback-command", command);
}

function executeGlobalShortcut(command) {
  if (command === "show") {
    showWindow();
    return;
  }
  sendPlaybackCommand(command);
}

function sanitizeGlobalShortcut(value, fallback) {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  if (!candidate || candidate.length > 80 || !/(Control|Alt|Shift|Super)/i.test(candidate)) return fallback;
  return candidate;
}

function syncGlobalShortcuts(payload = {}) {
  globalShortcutConfig = {
    toggle: sanitizeGlobalShortcut(payload.toggle, globalShortcutConfig.toggle),
    previous: sanitizeGlobalShortcut(payload.previous, globalShortcutConfig.previous),
    next: sanitizeGlobalShortcut(payload.next, globalShortcutConfig.next),
    show: sanitizeGlobalShortcut(payload.show, globalShortcutConfig.show),
  };

  globalShortcut.unregisterAll();
  const registered = {};
  const usedAccelerators = new Set();
  for (const [command, accelerator] of Object.entries(globalShortcutConfig)) {
    const duplicate = usedAccelerators.has(accelerator.toLowerCase());
    const success = !duplicate && globalShortcut.register(accelerator, () => executeGlobalShortcut(command));
    registered[command] = success;
    if (success) usedAccelerators.add(accelerator.toLowerCase());
    else writeLog("desktop.log", `global shortcut unavailable: ${command}=${accelerator}`);
  }
  return { shortcuts: globalShortcutConfig, registered };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createTaskbarButtonIcon(kind) {
  const width = 20;
  const height = 20;
  const pixels = Buffer.alloc(width * height * 4);
  const setPixel = (x, y, red = 32, green = 36, blue = 43, alpha = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alpha;
  };
  const fillRect = (x, y, rectWidth, rectHeight) => {
    for (let row = y; row < y + rectHeight; row += 1) {
      for (let col = x; col < x + rectWidth; col += 1) setPixel(col, row);
    }
  };
  const drawTriangle = (direction, left, right) => {
    for (let row = 0; row < 12; row += 1) {
      const distance = row <= 6 ? row : 12 - row;
      const span = Math.max(1, Math.round((right - left) * distance / 6));
      const start = direction === "right" ? left : right - span;
      const end = direction === "right" ? left + span : right;
      for (let col = Math.min(start, end); col <= Math.max(start, end); col += 1) setPixel(col, 4 + row);
    }
  };

  if (kind === "play") drawTriangle("right", 6, 15);
  else if (kind === "pause") {
    fillRect(5, 4, 3, 12);
    fillRect(12, 4, 3, 12);
  } else if (kind === "previous") {
    fillRect(4, 4, 2, 12);
    drawTriangle("left", 8, 15);
  } else {
    fillRect(14, 4, 2, 12);
    drawTriangle("right", 5, 12);
  }

  const scanlines = Buffer.alloc((height * (width * 4 + 1)));
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (width * 4 + 1)] = 0;
    pixels.copy(scanlines, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const icon = nativeImage.createFromBuffer(png).resize({ width: 20, height: 20 });
  if (icon.isEmpty()) {
    writeLog("desktop.log", `taskbar button icon creation returned an empty image: ${kind}`);
  }
  return icon;
}

const taskbarIcons = {
  previous: createTaskbarButtonIcon("previous"),
  play: createTaskbarButtonIcon("play"),
  pause: createTaskbarButtonIcon("pause"),
  next: createTaskbarButtonIcon("next"),
};

function taskbarDescription() {
  const title = String(taskbarPlayback.title || "").trim();
  const artist = String(taskbarPlayback.artist || "").trim();
  if (!title) return "Aria";
  return artist ? `${title} - ${artist}` : title;
}

function syncTaskbarPlayback(reason = "state") {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const description = taskbarDescription();
  // Keep the native app identity stable for OOPZ/application-loopback. The
  // song title is published through the thumbnail tooltip and media session.
  mainWindow.setTitle("Aria");
  mainWindow.setThumbnailToolTip(description);
  tray?.setToolTip(description);

  if (process.platform !== "win32") return;
  const hasTrack = Boolean(taskbarPlayback.title);
  if (nativeIconicThumbnailEnabled && iconicThumbAddon?.available) {
    try {
      const stats = iconicThumbAddon.getStats?.();
      if (stats && stats.taskbarButtonReady === false && !reason.includes("fallback")) {
        writeLog("desktop.log", `taskbar buttons waiting for TaskbarButtonCreated reason=${reason}`);
        return;
      }
    } catch {
      // The optional readiness probe is best effort; Electron remains the fallback.
    }
  }
  try {
    const applied = mainWindow.setThumbarButtons([
      {
        tooltip: "上一首",
        icon: taskbarIcons.previous,
        flags: hasTrack ? [] : ["disabled"],
        click: () => sendPlaybackCommand("previous"),
      },
      {
        tooltip: taskbarPlayback.playing ? "暂停" : "播放",
        icon: taskbarPlayback.playing ? taskbarIcons.pause : taskbarIcons.play,
        flags: hasTrack ? [] : ["disabled"],
        click: () => sendPlaybackCommand("toggle"),
      },
      {
        tooltip: "下一首",
        icon: taskbarIcons.next,
        flags: hasTrack ? [] : ["disabled"],
        click: () => sendPlaybackCommand("next"),
      },
    ]);
    const iconState = Object.entries(taskbarIcons)
      .map(([name, icon]) => `${name}:${icon.isEmpty() ? "empty" : icon.getSize().width + "x" + icon.getSize().height}`)
      .join(",");
    writeLog(
      "desktop.log",
      `taskbar buttons applied: ${Boolean(applied)} track=${hasTrack} visible=${mainWindow.isVisible()} reason=${reason} icons=${iconState}`,
    );
  } catch (error) {
    writeLog("desktop.log", `taskbar buttons failed: ${error?.stack || error}`);
  }
  // setThumbarButtons clears an existing thumbnail clip; restore it so the
  // preview keeps showing the cover art instead of the whole window.
  applyTaskbarClip();
  const clipTimer = setTimeout(applyTaskbarClip, 80);
  clipTimer.unref?.();
}

function scheduleTaskbarSync(reason) {
  for (const timer of taskbarRetryTimers) clearTimeout(timer);
  taskbarRetryTimers.clear();

  syncTaskbarPlayback(`${reason}:now`);
  for (const delay of [100, 300, 700, 1500, 3000, 5000]) {
    const timer = setTimeout(() => {
      taskbarRetryTimers.delete(timer);
      syncTaskbarPlayback(`${reason}:${delay}ms${delay === 5000 ? ":fallback" : ""}`);
    }, delay);
    timer.unref?.();
    taskbarRetryTimers.add(timer);
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("Aria");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Aria", click: showWindow },
      { type: "separator" },
      { label: "播放 / 暂停", click: () => sendPlaybackCommand("toggle") },
      { label: "上一首", click: () => sendPlaybackCommand("previous") },
      { label: "下一首", click: () => sendPlaybackCommand("next") },
      { type: "separator" },
      { label: "后台托管", click: () => mainWindow?.hide() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", showWindow);
}

async function createWindow() {
  await startBackend();
  createTray();

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1160,
    minHeight: 720,
    show: false,
    frame: false,
    title: "Aria",
    icon: resolveIcon(),
    autoHideMenuBar: true,
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      // Media playback starts from the renderer without a user gesture when a
      // queue auto-plays; without this the OS media session can stay paused.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Re-assert the window icon explicitly. A missing or stale taskbar icon is
  // almost always Explorer failing to resolve the button icon, and forcing
  // WM_SETICON after creation makes the running window's identity explicit.
  try {
    const windowIcon = nativeImage.createFromPath(resolveIcon());
    if (!windowIcon.isEmpty()) {
      mainWindow.setIcon(windowIcon);
    } else {
      writeLog("desktop.log", "window icon resource resolved empty");
    }
  } catch (error) {
    writeLog("desktop.log", `window icon apply failed: ${error?.message || error}`);
  }
  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);
  if (process.platform === "win32" && typeof mainWindow.setAppDetails === "function") {
    // Keep the native window identity stable so Windows application-loopback
    // capture tools can associate the mpv child session with Aria.
    try {
      mainWindow.setAppDetails({
        appId: "com.yrrlyb.aria",
        appIconPath: resolveIcon(),
        appIconIndex: 0,
        relaunchDisplayName: "Aria",
        relaunchCommand: process.execPath,
      });
    } catch (error) {
      writeLog("desktop.log", `unable to set Windows app details: ${error?.stack || error}`);
    }
  }
  if (nativeIconicThumbnailEnabled && iconicThumbAddon?.available) {
    try {
      const attached = iconicThumbAddon.attach(mainWindow.getNativeWindowHandle());
      writeLog("desktop.log", `iconic thumbnail addon attached: ${Boolean(attached)}`);
    } catch (error) {
      writeLog("desktop.log", `iconic thumbnail attach failed: ${error?.message || error}`);
    }
  }

  syncTaskbarPlayback();

  mainWindow.once("ready-to-show", () => {
    showWindow();
    scheduleTaskbarSync("ready-to-show");
  });

  mainWindow.webContents.once("did-finish-load", () => {
    scheduleTaskbarSync("did-finish-load");
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeLog("desktop.log", `renderer gone: ${JSON.stringify(details)}`);
    if (!isQuitting && rendererRecoveries < 2) {
      rendererRecoveries += 1;
      setTimeout(() => mainWindow?.reload(), 800);
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeLog("desktop.log", `did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      writeLog("renderer.log", `${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting && backgroundEnabled) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("hide", () => {
    sendWindowVisibility(false);
  });
  mainWindow.on("minimize", () => {
    sendWindowVisibility(false);
  });
  mainWindow.on("show", () => {
    sendWindowVisibility(true);
    scheduleTaskbarSync("show");
  });
  mainWindow.on("restore", () => {
    sendWindowVisibility(true);
    scheduleTaskbarSync("restore");
  });
  mainWindow.on("closed", () => {
    for (const timer of taskbarRetryTimers) clearTimeout(timer);
    taskbarRetryTimers.clear();
  });

  if (!app.isPackaged) {
    const devUrl = process.env.ARIA_DEV_SERVER_URL || "http://127.0.0.1:5173";
    await urlOnline(devUrl);
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  if (initialMediaCommand) {
    const pendingCommand = initialMediaCommand;
    initialMediaCommand = null;
    setTimeout(() => {
      sendPlaybackCommand(pendingCommand);
      writeLog("desktop.log", `launch media command: ${pendingCommand}`);
    }, 1800);
  }
}

ipcMain.handle("aria:minimize-to-tray", () => {
  mainWindow?.hide();
  return true;
});

ipcMain.handle("aria:minimize-window", () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("aria:toggle-maximize-window", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.handle("aria:close-window", () => {
  mainWindow?.close();
  return true;
});

ipcMain.handle("aria:show", () => {
  showWindow();
  return true;
});

ipcMain.handle("aria:quit", () => {
  isQuitting = true;
  app.quit();
  return true;
});

ipcMain.handle("aria:set-background-enabled", (_event, enabled) => {
  backgroundEnabled = Boolean(enabled);
  return backgroundEnabled;
});

ipcMain.handle("aria:set-gpu-optimize", (_event, enabled) => {
  gpuOptimizeEnabled = Boolean(enabled);
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "gpu-mode.json"),
      JSON.stringify({ optimize: gpuOptimizeEnabled }),
      "utf8",
    );
  } catch {
    // Persistence is best-effort.
  }
  return gpuOptimizeEnabled;
});

async function collectDiagnosticsSnapshot(payload) {
  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
    memoryMb: Math.round((metric.memory?.workingSetSize ?? 0) / 1024 / 1024),
  }));
  let backendMemoryMb = null;
  if (backendProcess?.pid) {
    try {
      const memory = await process.getProcessMemoryInfo(backendProcess.pid);
      backendMemoryMb = Math.round(memory.workingSetSize / 1024 / 1024);
    } catch {
      backendMemoryMb = null;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cpuModel: (() => {
      try {
        return os.cpus()[0]?.model ?? null;
      } catch {
        return null;
      }
    })(),
    cpuCores: os.cpus().length,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    mainMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    backendPid: backendProcess?.pid ?? null,
    backendMemoryMb,
    gpuVendorId,
    gpuOptimizeEnabled,
    gpuFeatures: (() => {
      try {
        const status = app.getGPUFeatureStatus();
        return {
          gpuCompositing: status.gpu_compositing ?? "unknown",
          rasterization: status.rasterization ?? "unknown",
          webgl: status.webgl ?? "unknown",
          canvas2d: status["2d_canvas"] ?? "unknown",
          videoDecode: status.video_decode ?? "unknown",
        };
      } catch {
        return null;
      }
    })(),
    processes: metrics,
    runtime: payload && typeof payload === "object" ? payload : null,
  };
}

ipcMain.handle("aria:diagnostics:stats", async () => {
  try {
    return await collectDiagnosticsSnapshot(null);
  } catch (error) {
    writeLog("desktop.log", `diagnostics stats failed: ${error?.stack || error}`);
    return null;
  }
});

ipcMain.handle("aria:diagnostics:export-logs", async (_event, payload) => {
  try {
    const logsDir = logger.logDir();
    const exportBase = path.join(app.getPath("userData"), "exports");
    const folderName = `aria-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const folder = path.join(exportBase, folderName);
    fs.mkdirSync(folder, { recursive: true });

    let copiedLogs = 0;
    if (fs.existsSync(logsDir)) {
      for (const file of fs.readdirSync(logsDir)) {
        const source = path.join(logsDir, file);
        try {
          const stat = fs.statSync(source);
          if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
            fs.copyFileSync(source, path.join(folder, file));
            copiedLogs += 1;
          }
        } catch {
          // Skip unreadable log files.
        }
      }
    }

    const snapshot = await collectDiagnosticsSnapshot(payload);
    fs.writeFileSync(path.join(folder, "diagnostics.json"), JSON.stringify(snapshot, null, 2), "utf8");
    fs.writeFileSync(
      path.join(folder, "说明.txt"),
      [
        "Aria 诊断导出",
        `生成时间: ${snapshot.generatedAt}`,
        `包含: 日志文件 ${copiedLogs} 个 + diagnostics.json（各进程 CPU/内存占用与运行状态快照）`,
        "请将此文件夹整体发送给开发者排查问题。",
        "",
      ].join("\n"),
      "utf8",
    );

    shell.openPath(folder);
    return { ok: true, path: folder, copiedLogs };
  } catch (error) {
    writeLog("desktop.log", `export logs failed: ${error?.stack || error}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("aria:choose-music-folder", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择本地音乐文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("aria:update-taskbar-playback", (_event, payload) => {
  taskbarPlayback = {
    title: typeof payload?.title === "string" ? payload.title.slice(0, 180) : "",
    artist: typeof payload?.artist === "string" ? payload.artist.slice(0, 120) : "",
    playing: Boolean(payload?.playing),
  };
  syncTaskbarPlayback();
  return true;
});

// The Windows SMTC media card needs artwork as a real file: Chromium hands the
// OS a path/thumbnail, and data:/loopback URLs are frequently dropped. The
// renderer paints a 256x256 square JPEG and hands it over as a data URL; we
// persist it under userData and return a file:// URL for MediaMetadata.
ipcMain.handle("aria:save-media-artwork", (_event, dataUrl) => {
  try {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const payload = dataUrl.slice(comma + 1);
    if (!payload || payload.length > 6_000_000) return null;
    const buffer = Buffer.from(payload, "base64");
    if (!buffer.length) return null;

    const artworkDir = path.join(app.getPath("userData"), "artwork");
    fs.mkdirSync(artworkDir, { recursive: true });
    const target = path.join(artworkDir, "media-cover.jpg");
    fs.writeFileSync(target, buffer);
    return { url: pathToFileURL(target).href, bytes: buffer.length };
  } catch (error) {
    writeLog("desktop.log", `save media artwork failed: ${error?.message || error}`);
    return null;
  }
});

ipcMain.handle("aria:configure-global-shortcuts", (_event, payload) => {
  return syncGlobalShortcuts(payload || {});
});

ipcMain.handle("aria:copy-image", async (_event, payload) => {
  try {
    const dataUrl = typeof payload?.dataUrl === "string" && payload.dataUrl.startsWith("data:")
      ? payload.dataUrl
      : null;
    const url = typeof payload?.url === "string" && payload.url ? payload.url : null;
    let image = null;

    if (dataUrl) {
      image = nativeImage.createFromDataURL(dataUrl);
    } else if (url) {
      const response = await fetch(url);
      if (!response.ok) return false;
      const buffer = Buffer.from(await response.arrayBuffer());
      image = nativeImage.createFromBuffer(buffer);
    }

    if (!image || image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  } catch (error) {
    writeLog("desktop.log", `copy image failed: ${error?.stack || error}`);
    return false;
  }
});

ipcMain.handle("aria:log", (_event, payload) => {
  try {
    logger.logRendererPayload(payload);
    return true;
  } catch (error) {
    writeLog("renderer.log", "renderer log bridge failed", { error: serializeError(error) });
    return false;
  }
});

ipcMain.handle("aria:native-audio:supported", () => {
  return getNativeAudioEngine().isSupported();
});

// ASIO drivers register themselves under HKLM\SOFTWARE\ASIO with a CLSID;
// 32-bit-only drivers land in the WOW6432Node mirror. Both views are listed so
// the channel-mapping card targets the same driver foobar2000 uses.
function listAsioDrivers() {
  // reg.exe prints the full hive name (HKEY_LOCAL_MACHINE\...), so the query
  // path and the line prefix have to match that form.
  const roots = [
    { hive: "HKEY_LOCAL_MACHINE\\SOFTWARE\\ASIO", bits: 64 },
    { hive: "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\ASIO", bits: 32 },
  ];
  const drivers = [];
  for (const { hive, bits } of roots) {
    let names = [];
    try {
      names = execFileSync("reg", ["query", hive], { encoding: "utf8", windowsHide: true })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${hive}\\`))
        .map((line) => line.slice(hive.length + 1))
        .filter((name) => name && !name.includes("\\"));
    } catch {
      names = [];
    }
    for (const name of names) {
      let clsid = null;
      let description = "";
      try {
        const output = execFileSync("reg", ["query", `${hive}\\${name}`, "/v", "CLSID"], {
          encoding: "utf8",
          windowsHide: true,
        });
        clsid = (output.match(/CLSID\s+REG_SZ\s+(\{[0-9A-Fa-f-]+\})/) ?? [])[1] ?? null;
      } catch {
        clsid = null;
      }
      try {
        const output = execFileSync("reg", ["query", `${hive}\\${name}`, "/v", "Description"], {
          encoding: "utf8",
          windowsHide: true,
        });
        description = (output.match(/Description\s+REG_SZ\s+(.+)/) ?? [])[1]?.trim() ?? "";
      } catch {
        description = "";
      }
      if (!drivers.some((driver) => driver.clsid && driver.clsid === clsid)) {
        drivers.push({ name, clsid, description, bits });
      }
    }
  }
  return drivers;
}

ipcMain.handle("aria:asio:drivers", () => {
  try {
    return listAsioDrivers();
  } catch (error) {
    writeLog("desktop.log", `ASIO driver enumeration failed: ${error?.message ?? error}`);
    return [];
  }
});

ipcMain.handle("aria:native-audio:devices", async () => {
  return getNativeAudioEngine().listDevices();
});

ipcMain.handle("aria:native-audio:state", () => {
  return getNativeAudioEngine().snapshot();
});

ipcMain.handle("aria:native-audio:load", async (_event, payload) => {
  return getNativeAudioEngine().load(payload);
});

ipcMain.handle("aria:native-audio:load-next", async (_event, payload) => {
  return getNativeAudioEngine().loadNext(payload || {});
});

ipcMain.handle("aria:set-thumbnail-clip", (_event, rect) => {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return false;
  const valid =
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 8 &&
    rect.height >= 8;
  taskbarClipRect = valid
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : null;
  applyTaskbarClip();
  return true;
});

ipcMain.handle("aria:set-iconic-thumbnail", (_event, pixels, width, height) => {
  if (!nativeIconicThumbnailEnabled || !iconicThumbAddon?.available) return false;
  try {
    const ok = Boolean(iconicThumbAddon.setBitmap(Buffer.from(pixels), Number(width) || 0, Number(height) || 0));
    writeLog("desktop.log", `iconic thumbnail setBitmap: ${Number(width)}x${Number(height)} ok=${ok}`);
    return ok;
  } catch (error) {
    writeLog("desktop.log", `iconic thumbnail setBitmap failed: ${error?.message || error}`);
    return false;
  }
});

ipcMain.handle("aria:set-iconic-live-preview", (_event, pixels, width, height) => {
  if (!nativeIconicThumbnailEnabled || !iconicThumbAddon?.available || typeof iconicThumbAddon.setLiveBitmap !== "function") return false;
  try {
    const ok = Boolean(iconicThumbAddon.setLiveBitmap(Buffer.from(pixels), Number(width) || 0, Number(height) || 0));
    writeLog("desktop.log", `iconic live preview setBitmap: ${Number(width)}x${Number(height)} ok=${ok}`);
    return ok;
  } catch (error) {
    writeLog("desktop.log", `iconic live preview setBitmap failed: ${error?.message || error}`);
    return false;
  }
});

ipcMain.handle("aria:iconic-stats", () => {
  if (!nativeIconicThumbnailEnabled || !iconicThumbAddon?.available) return null;
  try {
    return iconicThumbAddon.getStats();
  } catch {
    return null;
  }
});

ipcMain.handle("aria:clear-iconic-thumbnail", () => {
  if (!nativeIconicThumbnailEnabled || !iconicThumbAddon?.available) return false;
  try {
    iconicThumbAddon.clearBitmap();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("aria:native-audio:pause", async (_event, paused) => {
  return getNativeAudioEngine().setPaused(Boolean(paused));
});

ipcMain.handle("aria:native-audio:seek", async (_event, position) => {
  return getNativeAudioEngine().seek(Number(position) || 0);
});

ipcMain.handle("aria:native-audio:volume", async (_event, volume) => {
  return getNativeAudioEngine().setVolume(Number(volume) || 0);
});

ipcMain.handle("aria:native-audio:equalizer", async (_event, payload) => {
  return getNativeAudioEngine().setEqualizer(payload || {});
});

// Equalizer preset files: the renderer builds the payload, the main process
// owns the native save/open dialogs and the disk write.
ipcMain.handle("aria:equalizer-export", async (_event, payload) => {
  try {
    const content = typeof payload?.content === "string" ? payload.content : "";
    if (!content) return { ok: false, error: "没有可导出的内容" };
    const defaultName = typeof payload?.defaultName === "string" && payload.defaultName
      ? payload.defaultName
      : "aria-equalizer.json";
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: "导出均衡器设置",
      defaultPath: path.join(app.getPath("documents"), defaultName),
      filters: [
        { name: "均衡器预设 (JSON)", extensions: ["json"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, content, "utf8");
    writeLog("desktop.log", `equalizer exported: ${result.filePath}`);
    return { ok: true, path: result.filePath };
  } catch (error) {
    writeLog("desktop.log", `equalizer export failed: ${error?.message || error}`);
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("aria:equalizer-import", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: "导入均衡器设置",
      properties: ["openFile"],
      filters: [
        { name: "均衡器预设", extensions: ["json", "txt", "eq", "csv"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    const filePath = result.canceled ? null : result.filePaths[0];
    if (!filePath) return { ok: false, canceled: true };
    const stats = fs.statSync(filePath);
    if (stats.size > 2 * 1024 * 1024) return { ok: false, error: "文件过大（限制 2MB）" };
    const content = fs.readFileSync(filePath, "utf8");
    writeLog("desktop.log", `equalizer imported: ${filePath}`);
    return { ok: true, path: filePath, name: path.basename(filePath), content };
  } catch (error) {
    writeLog("desktop.log", `equalizer import failed: ${error?.message || error}`);
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("aria:native-audio:configure", async (_event, payload) => {
  return getNativeAudioEngine().applyOutputSettings(payload || {});
});

ipcMain.handle("aria:native-audio:stop", async () => {
  return getNativeAudioEngine().stop();
});

app.on("second-instance", (_event, argv) => {
  showWindow();
  const command = mediaCommandFromArgv(argv);
  if (command) sendPlaybackCommand(command);
});

app.whenReady().then(async () => {
  gpuVendorId = await detectGpuVendorAsync();
  if (gpuVendorId === 0x1002 && gpuOptimizeEnabled) {
    // AMD GPUs are often blocklisted by Chromium for GPU compositing, which
    // falls back to CPU software rendering and drives CPU usage up. Push the
    // rendering work back to the GPU for AMD machines. Must run before any
    // BrowserWindow exists so the GPU process picks the switches up.
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
    app.commandLine.appendSwitch("enable-gpu-rasterization");
    app.commandLine.appendSwitch("enable-zero-copy");
    writeLog("desktop.log", "AMD GPU detected; GPU rendering flags applied");
  } else {
    writeLog("desktop.log", `GPU vendor id: 0x${(gpuVendorId ?? 0).toString(16)} (optimize=${gpuOptimizeEnabled})`);
  }
  attachPowerRecoveryHandlers();
  await createWindow();
  syncGlobalShortcuts(globalShortcutConfig);

  try {
    app.setJumpList([
      {
        type: "custom",
        name: "播放控制",
        items: [
          {
            type: "task",
            title: "播放 / 暂停",
            description: "播放或暂停当前歌曲",
            program: process.execPath,
            args: "--media-toggle",
            iconPath: process.execPath,
            iconIndex: 0,
          },
          {
            type: "task",
            title: "上一首",
            description: "切换到上一首",
            program: process.execPath,
            args: "--media-previous",
            iconPath: process.execPath,
            iconIndex: 0,
          },
          {
            type: "task",
            title: "下一首",
            description: "切换到下一首",
            program: process.execPath,
            args: "--media-next",
            iconPath: process.execPath,
            iconIndex: 0,
          },
        ],
      },
    ]);
    writeLog("desktop.log", "jump list installed (播放控制)");
  } catch (error) {
    writeLog("desktop.log", `jump list failed: ${error?.stack || error}`);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    showWindow();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  nativeAudioEngine?.teardown?.();
  iconicThumbAddon?.detach?.();
});
