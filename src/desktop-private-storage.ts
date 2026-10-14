import type { SupportCipher } from "./support-private-store.js";

/** The same Electron safeStorage capability used by private support summaries.
 * Linux's basic_text backend is explicitly not a secure credential store. */
export function privateEncryptionAvailable(cipher: SupportCipher | undefined): boolean {
  try { return !!cipher?.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== "basic_text"; }
  catch { return false; }
}
export type DesktopPrivateStorage = { appData?: string; cipher?: SupportCipher; available: boolean };
export function detectDesktopPrivateStorage(load: (name: string) => unknown = name => require(name)): DesktopPrivateStorage {
  let appData:string|undefined,cipher:SupportCipher|undefined;
  for (const name of ["@electron/remote", "electron"]) {
    try {
      const runtime=load(name) as {app?:{getPath(name:string):string};safeStorage?:SupportCipher};
      const directory=runtime.app?.getPath("appData");
      if (typeof directory==="string" && directory)appData=directory;
      if (runtime.safeStorage && (!cipher || privateEncryptionAvailable(runtime.safeStorage)))cipher=runtime.safeStorage;
      if (appData && privateEncryptionAvailable(cipher)) return {appData,cipher,available:true};
    } catch { /* An unavailable desktop capability never falls back to plaintext. */ }
  }
  return {...(appData?{appData}:{}),...(cipher?{cipher}:{}),available:false};
}
