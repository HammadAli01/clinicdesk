// ClinicDesk desktop shell — preload script.
//
// This is the only file that runs with any Node/Electron access inside the
// renderer's process, and even then in an isolated JS realm (contextIsolation:
// true, sandbox: true — see main.ts). It is, deliberately, the entire attack
// surface exposed to the web app.
//
// We expose two named, single-purpose functions via `contextBridge` — never
// the raw `ipcRenderer`. If page script (including an XSS payload, or a
// compromised third-party dependency of the Next.js app) got the real
// `ipcRenderer`, it could `invoke` ANY IPC channel, including ones added
// later for privileged main-process work this file was never audited
// against. Exposing named functions means the renderer's capabilities are
// exactly the two things below, forever — adding a new capability means
// touching this file, not just a channel string somewhere in the renderer.
import { contextBridge, ipcRenderer } from "electron";

async function notify(title: string, body: string): Promise<void> {
  await ipcRenderer.invoke("notify", title, body);
}

async function getVersion(): Promise<string> {
  const result = await ipcRenderer.invoke("app:version");
  // `ipcRenderer.invoke` resolves with whatever the main process sent —
  // typed as `unknown` here on purpose. Validate at the boundary rather than
  // trusting the other process, the same reasoning as the Zod checks at the
  // web app's tRPC/webhook boundaries.
  if (typeof result !== "string") {
    throw new Error("app:version did not return a string");
  }
  return result;
}

contextBridge.exposeInMainWorld("clinicdesk", {
  notify,
  getVersion,
});
