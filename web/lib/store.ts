// 브라우저 저장(IndexedDB "growthnote" 버전 1, 계약 12.3·data-needs 6절).
// IndexedDB 를 열 수 없으면(시크릿 창, 막힌 저장소) 메모리에 두고 화면은 그대로 돌아간다. 이때 state 가 "memory" 다.
// 열쇠: 회사 하나에 하나인 칸은 companyId 글, 여러 개인 칸은 [companyId, …] 배열.

export const DB_NAME = "growthnote";
export const DB_VERSION = 1;
export const STORES = ["companies", "snapshots", "jobs", "edits", "saved", "checks", "rivalChecks", "briefs", "rivalChoices", "prep", "notes", "salesKeywords"] as const;
export type StoreName = (typeof STORES)[number];
/** 열쇠가 [companyId, …] 배열인 칸 */
export const ARRAY_KEYED: readonly StoreName[] = ["saved", "checks", "rivalChecks", "briefs"];
export type Key = string | string[];
export type Row<T = unknown> = { key: Key; value: T };

export interface Backend {
  get(store: StoreName, key: Key): Promise<unknown>;
  put(store: StoreName, key: Key, value: unknown): Promise<void>;
  del(store: StoreName, key: Key): Promise<void>;
  /** 여러 열쇠를 한 번에(IndexedDB 는 트랜잭션 하나) 지운다. 하나라도 실패하면 아무것도 지우지 않는다 */
  delMany(store: StoreName, keys: Key[]): Promise<void>;
  /** companyId 를 주면 그 회사 것만 */
  all(store: StoreName, companyId?: string): Promise<Row[]>;
}

const keyText = (k: Key) => JSON.stringify(k);
const belongs = (k: Key, companyId: string) => (Array.isArray(k) ? k[0] === companyId : k === companyId);

/** 메모리 저장소. IndexedDB 를 못 쓸 때와 테스트에서 쓴다 */
export function memoryBackend(): Backend {
  const data = new Map<StoreName, Map<string, Row>>(STORES.map((s) => [s, new Map()]));
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(store, key) {
      return clone(data.get(store)!.get(keyText(key))?.value);
    },
    async put(store, key, value) {
      data.get(store)!.set(keyText(key), { key, value: clone(value) });
    },
    async del(store, key) {
      data.get(store)!.delete(keyText(key));
    },
    async delMany(store, keys) {
      for (const k of keys) data.get(store)!.delete(keyText(k));
    },
    async all(store, companyId) {
      return [...data.get(store)!.values()].filter((r) => companyId === undefined || belongs(r.key, companyId)).map((r) => ({ key: r.key, value: clone(r.value) }));
    },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbBackend(db: IDBDatabase): Backend {
  const tx = (store: StoreName, mode: IDBTransactionMode) => db.transaction(store, mode).objectStore(store);
  const done = (t: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  return {
    get: (store, key) => req(tx(store, "readonly").get(key as IDBValidKey)),
    async put(store, key, value) {
      const s = tx(store, "readwrite");
      s.put(value, key as IDBValidKey);
      await done(s.transaction);
    },
    async del(store, key) {
      const s = tx(store, "readwrite");
      s.delete(key as IDBValidKey);
      await done(s.transaction);
    },
    async delMany(store, keys) {
      const s = tx(store, "readwrite");
      for (const k of keys) s.delete(k as IDBValidKey);
      await done(s.transaction);
    },
    async all(store, companyId) {
      const s = tx(store, "readonly");
      const range = companyId === undefined ? undefined : ARRAY_KEYED.includes(store) ? IDBKeyRange.bound([companyId], [companyId, []]) : IDBKeyRange.only(companyId);
      const [keys, values] = await Promise.all([req(s.getAllKeys(range)), req(s.getAll(range))]);
      return keys.map((k, i) => ({ key: k as Key, value: values[i] }));
    },
  };
}

export type StorageState = "pending" | "idb" | "memory";
let state: StorageState = "pending";
let opening: Promise<Backend> | null = null;
let quotaHit = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const storageState = () => state;
export const quotaExceeded = () => quotaHit;
export function onStorageChange(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => reject(new Error("blocked")), 3000);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      resolve(r.result);
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(r.error);
    };
    r.onblocked = () => {
      clearTimeout(timer);
      reject(new Error("blocked"));
    };
  });
}

/** 저장소를 연다. 한 번만 열고, 실패하면 메모리로 바꾼다 */
export function backend(): Promise<Backend> {
  if (!opening) {
    opening = (typeof indexedDB === "undefined" ? Promise.reject(new Error("none")) : openIdb())
      .then((db) => {
        state = "idb";
        emit();
        return idbBackend(db);
      })
      .catch(() => {
        state = "memory";
        emit();
        return memoryBackend();
      });
  }
  return opening;
}

/** 테스트용: 저장소를 바꿔 끼운다 */
export function setBackendForTest(b: Backend) {
  opening = Promise.resolve(b);
  state = "memory";
}

const isQuota = (e: unknown) => e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22);

export async function put(store: StoreName, key: Key, value: unknown): Promise<boolean> {
  try {
    await (await backend()).put(store, key, value);
    return true;
  } catch (e) {
    if (isQuota(e) && !quotaHit) {
      quotaHit = true;
      emit();
    }
    return false;
  }
}
export async function get<T>(store: StoreName, key: Key): Promise<T | undefined> {
  try {
    return (await (await backend()).get(store, key)) as T | undefined;
  } catch {
    return undefined;
  }
}
export async function del(store: StoreName, key: Key): Promise<void> {
  try {
    await (await backend()).del(store, key);
  } catch {
    // 지우지 못해도 화면은 메모리 값으로 계속 간다
  }
}
/** 여러 열쇠를 한 트랜잭션으로 지운다. 실패하면 false(아무것도 지워지지 않음) */
export async function delMany(store: StoreName, keys: Key[]): Promise<boolean> {
  try {
    await (await backend()).delMany(store, keys);
    return true;
  } catch {
    return false;
  }
}
export async function all<T>(store: StoreName, companyId?: string): Promise<Row<T>[]> {
  try {
    return (await (await backend()).all(store, companyId)) as Row<T>[];
  } catch {
    return [];
  }
}

/** 이 회사의 브라우저 자료를 모두 지운다(서버 분석은 남는다) */
export async function clearCompany(companyId: string) {
  for (const s of STORES) for (const r of await all(s, companyId)) await del(s, r.key);
}
