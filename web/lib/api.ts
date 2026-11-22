// 분석 서버 부르기. 화면과 같은 주소의 /api/* 로 보내고 app/api/[...path]/route.ts 가 분석 서버로 넘긴다.
// 오류 글은 4xx 의 서버 문장(사용자에게 보여도 되는 한 줄)만 쓰고, 5xx 본문은 화면에 쓰지 않는다(G-14).
import { errorDetail, type ApiErrorCode } from "./contract.ts";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export class ApiFail extends Error {
  status: number;
  code: ApiErrorCode | null;
  retryAt: string | null;
  constructor(status: number, code: ApiErrorCode | null, message: string, retryAt: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

const SUSPICIOUS = /traceback|exception|error:|\/users\/|\/home\/|\.py\b|api_key|secret|token/i;

/** 화면에 보일 오류 문장 */
export function failText(status: number, body: unknown, code: ApiErrorCode | null): string {
  if (code === "rate_limited") return "요청이 잠시 많았습니다. 1분 뒤 다시 눌러 주세요.";
  if (status === 0) return "분석 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.";
  if (status >= 500) {
    if (code === "missing_config") return "이 기능을 쓰는 설정이 되어 있지 않습니다.";
    if (status === 504) return "분석 서버가 제때 응답하지 않았습니다. 잠시 뒤 다시 시도하세요.";
    return "분석 서버에서 응답을 받지 못했습니다. 잠시 뒤 다시 시도하세요.";
  }
  const d = errorDetail(body, "요청 형식이 올바르지 않습니다.");
  return d.length > 200 || SUSPICIOUS.test(d) ? "요청을 처리하지 못했습니다." : d;
}

export async function api<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiFail(0, null, failText(0, null, null), null);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as { code?: unknown; retryAt?: unknown } | null;
    const code = typeof b?.code === "string" ? (b.code as ApiErrorCode) : null;
    throw new ApiFail(res.status, code, failText(res.status, body, code), typeof b?.retryAt === "string" ? b.retryAt : null);
  }
  return body as T;
}

/** 404 이면 null */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 404) return null;
    throw e;
  }
}
