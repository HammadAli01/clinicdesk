// ---------------------------------------------------------------------------
// TEMPORARY STAND-IN TYPES — delete this file the moment `electron` is
// actually installed (`pnpm add -D electron electron-builder`, see
// ../README.md).
//
// `electron` is deliberately not a dependency of this repo (it's a ~100 MB
// dev dependency; see docs/12-electron.md). That means the real
// `node_modules/electron/electron.d.ts` types don't exist, and the root
// `tsconfig.json` includes `**/*.ts` — so without this file, `pnpm typecheck`
// would fail on every `import ... from "electron"` in desktop/main.ts and
// desktop/preload.ts with "Cannot find module 'electron'".
//
// This file plugs that hole with hand-written types for the *exact* handful
// of Electron APIs desktop/main.ts and desktop/preload.ts use — nothing
// more. It is intentionally not a full re-implementation of @types/electron.
//
// Once `electron` is installed, its package ships its own ambient
// `declare module "electron"` types, and having two of them in the same
// program is a conflict (duplicate/incompatible declarations), not a
// harmless no-op. Delete this file as the first step after installing.
// ---------------------------------------------------------------------------

declare module "electron" {
  // --- app -------------------------------------------------------------
  interface App {
    whenReady(): Promise<void>;
    on(event: "window-all-closed", listener: () => void): this;
    on(event: "activate", listener: () => void): this;
    on(event: "before-quit", listener: () => void): this;
    quit(): void;
    getVersion(): string;
  }
  export const app: App;

  // --- BrowserWindow -----------------------------------------------------
  interface WebPreferences {
    preload?: string;
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
  }

  interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    webPreferences?: WebPreferences;
  }

  interface OpenExternalHandlerDetails {
    url: string;
  }

  type WindowOpenHandlerResponse = { action: "deny" } | { action: "allow" };

  interface NavigationEvent {
    preventDefault(): void;
  }

  interface WebContents {
    setWindowOpenHandler(
      handler: (details: OpenExternalHandlerDetails) => WindowOpenHandlerResponse,
    ): void;
    on(event: "will-navigate", listener: (event: NavigationEvent, url: string) => void): void;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    static getAllWindows(): BrowserWindow[];
    loadURL(url: string): Promise<void>;
    show(): void;
    focus(): void;
    on(event: "closed", listener: () => void): this;
    webContents: WebContents;
  }

  // --- Menu / Tray -------------------------------------------------------
  interface MenuItemConstructorOptions {
    label?: string;
    click?: () => void;
    type?: "separator";
  }

  export class Menu {
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  }

  export class Tray {
    constructor(image: string);
    setToolTip(text: string): void;
    setContextMenu(menu: Menu): void;
    destroy(): void;
  }

  // --- shell ---------------------------------------------------------------
  interface Shell {
    openExternal(url: string): Promise<void>;
  }
  export const shell: Shell;

  // --- Notification --------------------------------------------------------
  interface NotificationConstructorOptions {
    title?: string;
    body?: string;
  }
  export class Notification {
    constructor(options?: NotificationConstructorOptions);
    static isSupported(): boolean;
    show(): void;
  }

  // --- ipcMain (main process side) -----------------------------------------
  interface IpcMainInvokeEvent {
    readonly sender: WebContents;
  }
  interface IpcMain {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void;
  }
  export const ipcMain: IpcMain;

  // --- preload side: contextBridge + ipcRenderer ---------------------------
  interface ContextBridge {
    exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
  }
  export const contextBridge: ContextBridge;

  interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  }
  export const ipcRenderer: IpcRenderer;
}
