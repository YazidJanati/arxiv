interface NativeBridge { postMessage(message: Record<string, unknown>): Promise<unknown> }
declare global { interface Window { webkit?: { messageHandlers?: { arxiv?: NativeBridge } }; arxivCommand?: (command: string) => void; arxivBeforeQuit?: () => Promise<boolean> } }
const bridge = window.webkit?.messageHandlers?.arxiv;
export const desktop = !!bridge;
export async function native<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!bridge) throw new Error("Native bridge unavailable");
  return await bridge.postMessage({ operation, ...args }) as T;
}
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("arxiv-reader", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not open local storage."));
  });
}
export async function read<T>(key: string): Promise<T | null> {
  if (desktop) return native<T | null>("read", { key });
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("records", "readonly");
    const request = tx.objectStore("records").get(key);
    request.onsuccess = () => resolve((request.result ?? null) as T | null);
    request.onerror = () => reject(new Error("Could not read local storage."));
  });
}
export async function write(key: string, value: unknown): Promise<void> {
  if (desktop) return native<void>("write", { key, value });
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("records", "readwrite");
    tx.objectStore("records").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error("Could not save locally. Check available disk space."));
    tx.onabort = () => reject(new Error("Local save was interrupted."));
  });
}
export async function request(path: string): Promise<string> {
  if (desktop) return native<string>("fetch", { path });
  const response = await fetch(`/arxiv${path}`, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) {
    if (response.status === 404) throw new Error("arXiv could not find this section. Check the category code in Settings.");
    throw new Error(`arXiv is unavailable (HTTP ${response.status}). Try refreshing in a moment.`);
  }
  return response.text();
}
export async function openExternal(url: string): Promise<void> {
  if (desktop) await native("open", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
export function setAppearance(theme: string): void {
  if (desktop) void native("appearance", { theme }).catch(() => {});
}
