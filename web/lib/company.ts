"use client";

// 회사 정보(자격 대조에 쓰는 값)와 백엔드 연결 상태를 여러 컴포넌트가 함께 쓰기 위한 작은 저장소.
// 회사 정보는 이 브라우저에만 저장한다.
import { useSyncExternalStore } from "react";
import { EMPTY_DRAFT, appliedFrom, clearAutofill, draftPatch, isBlankCompany, sameCompany, staleAutofill, type Draft, type Previous } from "@/lib/draft";

// 기본은 화면과 같은 주소의 /api (app/api/[...path]/route.ts 가 분석 서버로 넘긴다)
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export type Company = { name: string; founded: string; industry: string; employees: string; revenue: string; need: string; notes: string };
export const EMPTY_COMPANY: Company = { name: "", founded: "", industry: "", employees: "", revenue: "", need: "", notes: "" };
const KEY = "fundingnote.company.v1";
const LIMITS: Record<keyof Company, number> = { name: 60, founded: 7, industry: 80, employees: 30, revenue: 60, need: 120, notes: 400 };

let company: Company = EMPTY_COMPANY;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
    const next = { ...EMPTY_COMPANY };
    for (const k of Object.keys(EMPTY_COMPANY) as (keyof Company)[]) if (typeof raw[k] === "string") next[k] = raw[k].slice(0, LIMITS[k]);
    company = next;
  } catch {
    // 저장소를 쓸 수 없으면 빈 값으로 시작한다
  }
}

export function setCompany(patch: Partial<Company>) {
  const next = { ...company };
  for (const [k, v] of Object.entries(patch) as [keyof Company, string][]) next[k] = String(v ?? "").slice(0, LIMITS[k]);
  company = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(company));
  } catch {
    // 저장하지 못해도 이번 화면에서는 그대로 쓴다
  }
  emit();
}

/**
 * 조회 결과를 지금의 회사 정보에 반영한다. 조회를 시작할 때가 아니라 응답이 온 시점의 값을 기준으로 한다.
 * 그 사이 회사명이 바뀌었으면 반영하지 않고 false 를 돌려준다.
 */
export function applyDraft(draft: Draft, requestedName: string): Draft | null {
  load();
  loadLookup();
  // 직전 조회가 채운 뒤 손대지 않은 값만 새 값으로 바꾼다. 사용자가 적은 값은 건드리지 않는다
  const patch = draftPatch(company, draft, requestedName, previousOf(lookup));
  if (patch === null) return null;
  if (Object.keys(patch).length) setCompany(patch);
  return appliedFrom(patch, draft);
}

function subscribeCompany(cb: () => void) {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const useCompany = () => useSyncExternalStore(subscribeCompany, () => company, () => EMPTY_COMPANY);

export const companyFilled = (c: Company) => [c.founded, c.industry, c.employees, c.revenue, c.need].filter((v) => v.trim()).length;

// ---------- 백엔드 연결 상태 ----------

export type Health = { state: "checking" | "up" | "down"; hasKey: boolean };
let health: Health = { state: "checking", hasKey: false };
let healthStarted = false;
const healthListeners = new Set<() => void>();

function subscribeHealth(cb: () => void) {
  healthListeners.add(cb);
  if (!healthStarted) {
    healthStarted = true;
    fetch(`${API_BASE}/api/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("health"))))
      .then((j) => (health = { state: "up", hasKey: Boolean(j.hasKey) }))
      .catch(() => (health = { state: "down", hasKey: false }))
      .finally(() => healthListeners.forEach((l) => l()));
  }
  return () => healthListeners.delete(cb);
}

const SERVER_HEALTH: Health = { state: "checking", hasKey: false };
export const useHealth = () => useSyncExternalStore(subscribeHealth, () => health, () => SERVER_HEALTH);

// ---------- 자격 대조 결과 형식 ----------

export type Verdict = "충족" | "미충족" | "확인 필요" | "판단 대상 아님";
export type CheckRow = { field: string; requirement: string; quote: string; verdict: Verdict; reason: string };
export type Analysis = {
  program: { id: string; title: string; url: string; docUrl: string };
  extraction: { summary: string; notStated: string[]; doc: { kind: string; pages: number | null; chars: number; truncated: boolean }; model: string; extractedAt: string; dropped: number; cached: boolean };
  match: { overall: "신청 검토 가능" | "대상 아님" | "확인 후 판단"; overallReason: string; rows: CheckRow[]; questions: string[]; documents: string[]; model: string; costUsd: number | null; elapsedSec: number | null };
};

// ---------- 회사명 조회 결과(기업분석 엔진) ----------

export type LookupField = { key: string; label: string; value: string; status: string; sourceUrl: string; evidence: string; note: string };
export type Investor = { name: string; round: string; date: string; status: string; sourceUrl: string };
export type Competitor = {
  name: string; relation: string; products: string; revenue: string; employees: string; funding: string; asOf: string; status: string; sourceUrl: string;
  /** 수치(직원 수·매출·투자)를 검색 결과에서 근거와 함께 확인했으면 'reported' */
  figuresStatus?: string;
  figuresUrl?: string;
  /** 검색 결과에서 확인한 설립 시기(자료 표기 그대로, 예: 2015년) */
  founded?: string;
};
export type RivalRound = { company: string; round: string; amount: string; date: string; investors: string[]; quote: string; sourceUrl: string };
export type Lookup = {
  /** 이 조회가 실제로 회사 정보 칸에 채운 값. 조회 응답에는 없고 화면이 반영한 뒤 기록한다. */
  applied?: Draft;
  /** 저장해 둔 예시 회사의 결과일 때 그 결과를 조회한 날짜(YYYY-MM-DD). 방금 조회한 결과에는 없다. */
  savedAt?: string;
  query: string;
  competitors?: Competitor[];
  rivalFunding?: RivalRound[];
  draft: { name: string; founded: string; foundedYear: string; region: string; industry: string; employees: string; revenue: string };
  fields: LookupField[];
  investors: Investor[];
};
const LOOKUP_KEY = "fundingnote.lookup.v1";

/** 저장된 조회에서 '실제로 채운 값' 기록을 꺼낸다. 기록이 없으면 채운 값이 없는 것으로 본다. */
const previousOf = (l: Lookup | null): Previous => (l ? { query: l.query, draft: l.applied ?? EMPTY_DRAFT } : null);
let lookup: Lookup | null = null;
let lookupLoaded = false;
const lookupListeners = new Set<() => void>();

const isLookup = (v: unknown): v is Lookup => {
  const o = v as Lookup;
  const named = (list: unknown, key: string) => list === undefined || (Array.isArray(list) && list.every((x) => x && typeof x[key] === "string"));
  return Boolean(
    o && typeof o.query === "string" && o.draft && Array.isArray(o.fields) && Array.isArray(o.investors) && o.investors.every((i) => i && typeof i.name === "string") &&
      named(o.competitors, "name") && named(o.rivalFunding, "company") && (o.rivalFunding ?? []).every((r) => Array.isArray(r.investors)),
  );
};

export function setLookup(next: Lookup | null) {
  lookup = next;
  try {
    if (next) localStorage.setItem(LOOKUP_KEY, JSON.stringify(next));
    else localStorage.removeItem(LOOKUP_KEY);
  } catch {
    // 저장하지 못해도 이번 화면에서는 그대로 쓴다
  }
  lookupListeners.forEach((l) => l());
}

function loadLookup() {
  if (lookupLoaded) return;
  lookupLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(LOOKUP_KEY) ?? "null");
    if (isLookup(raw)) lookup = raw;
  } catch {
    // 값이 깨져 있으면 없는 것으로 본다
  }
}

function subscribeLookup(cb: () => void) {
  loadLookup();
  lookupListeners.add(cb);
  return () => lookupListeners.delete(cb);
}

const useStoredLookup = () => useSyncExternalStore(subscribeLookup, () => lookup, () => null);

/** 지금 입력된 회사의 조회 결과만 돌려준다. 회사명을 바꾸면 이전 회사의 결과는 쓰지 않는다. */
export function useLookup(): Lookup | null {
  const stored = useStoredLookup();
  const current = useCompany();
  return stored && sameCompany(stored.query, current.name) ? stored : null;
}
export const isLookupResponse = isLookup;

export const statusLabel: Record<string, string> = { confirmed: "원문에서 확인", reported: "보도·자료 기재", inferred: "추정", conflicting: "출처 간 불일치" };

/** 회사명이 바뀌었는데 이전 회사 조회로 채운 값이 남아 있으면 그 조회의 회사명과 칸 수를 알려준다. */
export function useLeftover(): { from: string; count: number } | null {
  const stored = useStoredLookup();
  const current = useCompany();
  const keys = staleAutofill(current, previousOf(stored));
  return stored && keys.length ? { from: stored.query, count: keys.length } : null;
}

/** 조회 결과를 지운다. 그 조회로 채워진 뒤 바뀌지 않은 값도 함께 지워, 출처를 알 수 없는 값이 남지 않게 한다. */
export function removeLookup() {
  load();
  loadLookup();
  const patch = clearAutofill(company, previousOf(lookup));
  if (Object.keys(patch).length) setCompany(patch);
  setLookup(null);
}

/** 회사 정보를 모두 비운다. */
export function resetCompany() {
  setCompany({ ...EMPTY_COMPANY });
  setLookup(null);
}

type Sample = { name: string; need: string; savedAt: string; lookup: Lookup };

/** 예시 회사 파일의 내용이 화면이 쓸 수 있는 형식이면 꺼내고, 아니면 null. */
function readSample(body: unknown): Sample | null {
  const b = body as { savedAt?: unknown; company?: { name?: unknown; need?: unknown }; lookup?: unknown } | null;
  const name = typeof b?.company?.name === "string" ? b.company.name.trim() : "";
  const savedAt = typeof b?.savedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.savedAt) ? b.savedAt : "";
  if (!name || !savedAt || !isLookup(b?.lookup) || !sameCompany(b.lookup.query, name)) return null;
  return { name, need: typeof b?.company?.need === "string" ? b.company.need : "", savedAt, lookup: b.lookup };
}

/**
 * 예시 회사 파일(public/data/sample-company.json). 실제 기업의 조회 결과라 저장소에는 넣지 않으므로 없는 것이 보통이다.
 * 한 번만 받아 오고, 없거나 형식이 다르면 null 이다.
 */
let sampleFile: Promise<Sample | null> | null = null;
const fetchSample = () =>
  (sampleFile ??= fetch("/data/sample-company.json")
    .then((res) => {
      if (res.ok) return res.json();
      void res.body?.cancel(); // 읽지 않을 본문을 닫아 연결을 놓는다
      return null;
    })
    .then(readSample)
    .catch(() => null));

let sampleName: string | null = null;
const sampleListeners = new Set<() => void>();
function subscribeSample(fn: () => void) {
  sampleListeners.add(fn);
  if (sampleName === null)
    void fetchSample().then((found) => {
      if (!found || sampleName !== null) return;
      sampleName = found.name;
      sampleListeners.forEach((f) => f());
    });
  return () => void sampleListeners.delete(fn);
}
/** 예시 회사 파일이 있으면 그 회사 이름, 없으면 null. 단추는 이름이 있을 때만 보인다. */
export const useSampleName = () => useSyncExternalStore(subscribeSample, () => sampleName, () => null);

/**
 * 저장해 둔 예시 회사의 조회 결과를 불러와 회사 정보와 조회 결과를 그 회사로 바꾼다.
 * 실제 조회는 2분 넘게 걸리고 실행마다 결과가 달라, 처음 보는 사람이 기다리지 않고 흐름을 볼 수 있게 한 것이다.
 * 분석 서버와 유료 호출이 필요 없다. 화면에는 언제 조회해 저장한 결과인지 표시한다.
 * 파일을 받는 사이 사용자가 회사 정보를 적기 시작했으면 그 값을 지우지 않고 예시를 버린다(false 를 돌려준다).
 */
export async function loadSample(): Promise<boolean> {
  const found = await fetchSample();
  if (!found) throw new Error("예시 회사 파일을 읽지 못했습니다");
  load();
  if (!isBlankCompany(company)) return false;
  resetCompany();
  setCompany({ name: found.name, need: found.need });
  const applied = applyDraft(found.lookup.draft, found.name);
  setLookup({ ...found.lookup, applied: applied ?? EMPTY_DRAFT, savedAt: found.savedAt });
  return true;
}
