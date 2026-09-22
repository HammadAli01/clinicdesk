// ClinicDesk desktop shell — main process.
//
// Option A from docs/12-electron.md: a thin window over the hosted web app.
// Nothing runs locally except this shell — the renderer just shows
// CLINICDESK_APP_URL. See that chapter for what would need to change for
// Option B (bundle the Next.js server) or Option C (offline-first + sync).
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, shell } from "electron";
import path from "node:path";

const appUrl = process.env.CLINICDESK_APP_URL ?? "http://localhost:3000";

// The origin we allow the window to navigate to at the top level. Computed
// once so every navigation check compares against the same value the window
// was actually loaded with.
const allowedOrigin = new URL(appUrl).origin;

let mainWindow: BrowserWindow | null = null;
// Electron garbage-collects a Tray with no remaining references, which
// silently removes the icon from the system tray. Keeping this module-level
// reference alive for the lifetime of the app is required, not decorative.
let tray: Tray | null = null;

function getOrCreateWindow(): BrowserWindow {
  if (mainWindow) {
    return mainWindow;
  }
  return createWindow();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Security posture (docs/12-electron.md, "What Electron actually is"):
      // the renderer is just Chromium showing our own web app, and web apps
      // get compromised (a dependency, a reflected XSS, a malicious embed).
      // These three flags decide what that compromise can do to the
      // receptionist's machine.
      nodeIntegration: false, // no `require`/Node globals reachable from page script — a renderer exploit can't touch the filesystem
      contextIsolation: true, // the preload script's JS realm is isolated from the page's; page script cannot reach the `ipcRenderer` reference preload holds, only what preload deliberately exposes via contextBridge
      sandbox: true, // renderer runs inside Chromium's OS-level sandbox, the same containment a regular browser tab gets
    },
  });

  void window.loadURL(appUrl);

  // Anything that would open a second window/tab (target="_blank",
  // window.open(), a middle-click) is handed to the OS browser instead.
  // Left alone, Electron would create a brand-new, equally privileged
  // BrowserWindow for whatever URL a link points to — including ones this
  // app never linked to itself (e.g. a compromised ad or third-party embed).
  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });

  // Pin top-level navigation to our own origin. Without this, a link click,
  // a redirect, or a compromised third-party script inside the page could
  // navigate the whole window away from ClinicDesk to an attacker's page —
  // which would still have this window's preload script attached, and so
  // would still have access to the `clinicdesk` API it exposes.
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.origin !== allowedOrigin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  mainWindow = window;
  return window;
}

function createTray(): Tray {
  const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png");
  const newTray = new Tray(iconPath);
  newTray.setToolTip("ClinicDesk");
  newTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open ClinicDesk",
        click: () => {
          const window = getOrCreateWindow();
          window.show();
          window.focus();
        },
      },
      {
        label: "Today's appointments",
        click: () => {
          const window = getOrCreateWindow();
          void window.loadURL(new URL("/admin", appUrl).toString());
          window.show();
          window.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  return newTray;
}

function registerIpcHandlers(): void {
  // IPC arguments cross a process boundary and arrive as `unknown` — the
  // preload side is typed, but nothing stops a future caller (or a bug) from
  // invoking these channels with the wrong shape, so we validate here rather
  // than trusting the renderer. Same boundary-validation reasoning as the
  // Zod checks at the web app's tRPC/webhook boundaries.
  ipcMain.handle("notify", (_event, ...args) => {
    const [title, body] = args;
    if (typeof title !== "string" || typeof body !== "string") {
      throw new Error("notify(title, body) expects two string arguments");
    }
    if (!Notification.isSupported()) {
      return;
    }
    new Notification({ title, body }).show();
  });

  ipcMain.handle("app:version", () => app.getVersion());
}

app
  .whenReady()
  .then(() => {
    createWindow();
    tray = createTray();
    registerIpcHandlers();
  })
  .catch((error: unknown) => {
    console.error("ClinicDesk desktop shell failed to start:", error);
  });

// macOS convention: apps stay running with no windows open (visible in the
// dock/tray) and reopen a window on `activate`. Every other platform quits
// when the last window closes, which is what users on those platforms expect.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  // Explicit cleanup rather than relying on process exit to reclaim it —
  // and it keeps the `tray` reference genuinely "used" for anyone reading
  // this file, not just a GC-prevention comment.
  tray?.destroy();
});
