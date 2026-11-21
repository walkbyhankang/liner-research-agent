// 화면과 같은 주소에서 분석 서버(FastAPI)를 부르기 위한 통로.
// 브라우저가 분석 서버 주소를 직접 알 필요가 없어, 터널 등으로 화면만 공개해도 기능이 동작한다.
import http from "node:http";
import https from "node:https";

const BACKEND = new URL(process.env.FUNDING_API_ORIGIN ?? "http://127.0.0.1:8000");
// 설정된 주소의 프로토콜을 그대로 따른다. https 주소에 평문으로 보내지 않는다
const TRANSPORT = BACKEND.protocol === "https:" ? https : BACKEND.protocol === "http:" ? http : null;
const BACKEND_PORT = BACKEND.port || (BACKEND.protocol === "https:" ? 443 : 80);
const MAX_BODY = 4000;

// 기다리는 시간은 분석 서버가 그 요청에서 쓸 수 있는 최대 시간보다 길게 잡는다.
// 중간에 끊으면 서버는 유료 호출을 계속하는데 결과만 버려지기 때문이다.
// - 자격 대조: 모델 2회, 회당 최대 약 125초에 재시도 1회 → 약 9분
// - 운용사 요약: 검색 1회와 모델 1회, 각각 재시도 1회 → 약 7분
// - 회사 조회: 2분 넘게 걸리므로 작업을 시작만 하고(곧바로 응답) 진행 상황을 따로 묻는다
const SHORT = 30_000;
const ROUTES: { method: "GET" | "POST"; path: RegExp; timeoutMs: number }[] = [
  { method: "GET", path: /^health$/, timeoutMs: SHORT },
  { method: "POST", path: /^notice\/analyze$/, timeoutMs: 12 * 60_000 },
  { method: "POST", path: /^gp\/brief$/, timeoutMs: 10 * 60_000 },
  { method: "POST", path: /^company\/lookup$/, timeoutMs: SHORT },
  { method: "GET", path: /^company\/lookup\/[0-9a-f]{32}$/, timeoutMs: SHORT },
];

type Ctx = { params: Promise<{ path: string[] }> };
const json = (detail: string, status: number) => Response.json({ detail }, { status });

/** fetch 는 응답 머리말을 5분까지만 기다리므로, 더 오래 걸릴 수 있는 요청을 위해 http 모듈을 직접 쓴다. */
function send(method: string, path: string, body: string | undefined, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (!TRANSPORT) {
      reject(new Error("protocol"));
      return;
    }
    const req = TRANSPORT.request(
      { hostname: BACKEND.hostname, port: BACKEND_PORT, path: `/api/${path}`, method, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function forward(req: Request, ctx: Ctx): Promise<Response> {
  const path = (await ctx.params).path.join("/");
  const route = ROUTES.find((r) => r.method === req.method && r.path.test(path));
  if (!route) return json("없는 경로입니다", 404);
  const body = req.method === "POST" ? await req.text() : undefined;
  if (body !== undefined && body.length > MAX_BODY) return json("요청이 너무 큽니다", 413);
  try {
    const res = await send(req.method, path, body, route.timeoutMs);
    return new Response(res.text, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "";
    if (reason === "timeout") return json("분석 서버가 제때 응답하지 않았습니다", 504);
    if (reason === "protocol") return json("분석 서버 주소 설정(FUNDING_API_ORIGIN)은 http 또는 https 여야 합니다", 500);
    return json("분석 서버에 연결하지 못했습니다", 502);
  }
}

export const GET = forward;
export const POST = forward;
