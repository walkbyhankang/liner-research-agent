"""공고문 자격 대조 실험: 공고문을 읽어 조건을 뽑고, 근거를 원문과 대조하고, 회사 조건과 견준다.

실행(유료 호출): .venv/bin/python scripts/analyze_notice.py --find "문화산업특화보증" --find "구매조건 생산지원자금"
  --models 를 여러 개 주면 같은 공고로 추출 품질·지연·비용을 비교한다. 대조는 첫 번째 모델로 한다.
결과는 results/notice_<시각>/ 에 저장한다(공고문 발췌가 들어 있어 Git 에서 제외).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from analysis import scrub  # noqa: E402
from funding import docs, notice  # noqa: E402
from liner_client import LinerAPIError, LinerClient, extract_chat_text  # noqa: E402

DEFAULT_MODELS = ["anthropic/claude-opus-5.5", "openai/gpt-6.2-sol", "liner-mark", "anthropic/claude-haiku-5.5"]
DEFAULT_COMPANY = """(가상 회사) 대전 소재 AI 소프트웨어 기업
- 본사: 대전광역시 유성구 (사업자등록 소재지 동일)
- 설립: 2023년 9월 (법인, 업력 3년 2개월)
- 업종: 소프트웨어 개발 및 공급업(기업용 SaaS). 제조 시설 없음
- 상시근로자 12명, 2025년 매출 8억 원
- 벤처기업 확인 보유, 기존 금융권 대출 없음, 세금 체납 없음
- 필요 자금: 운전자금 3억 원(인건비·클라우드 비용)"""
OFFICIAL_SUFFIXES = (".go.kr", ".or.kr", ".re.kr")


def find_program(programs: list[dict], needle: str) -> dict:
    hits = [p for p in programs if needle in p["title"] or needle == p["id"]]
    if not hits:
        raise SystemExit(f"스냅샷에서 찾지 못함: {needle}")
    return hits[0]


def run_extract(client: LinerClient, model: str, title: str, text: str) -> dict:
    user, truncated = notice.build_extract_user(title, text)
    row: dict = {"model": model, "truncated": truncated}
    try:
        data, rec = client.chat_json(model, notice.EXTRACT_SYSTEM, user, schema=notice.EXTRACT_SCHEMA,
                                     schema_name="notice_conditions", label=f"extract:{model}")
    except LinerAPIError as e:
        last = client.calls[-1]
        return {**row, "ok": False, "error": str(e)[:300], "elapsed_sec": last.get("elapsed_sec")}
    raw = notice.parse_json(extract_chat_text(data))
    conditions = notice.verify_quotes(notice.clean_conditions(raw), text)
    verified = sum(1 for c in conditions if c["status"] == "확인됨")
    return {**row, "ok": raw is not None, "valid_json": raw is not None, "response_model": rec.get("response_model"),
            "elapsed_sec": rec.get("elapsed_sec"), "cost_usd": rec.get("cost_usd"),
            "input_tokens": rec.get("input_tokens"), "output_tokens": rec.get("output_tokens"),
            "finish_reason": ((data.get("choices") or [{}])[0] or {}).get("finish_reason"),
            "summary": (raw or {}).get("summary"), "not_stated": (raw or {}).get("not_stated"),
            "conditions": conditions, "n_conditions": len(conditions), "n_verified": verified}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--find", action="append", required=True, help="공고명에 들어 있는 글자 또는 공고 ID")
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--company", default=DEFAULT_COMPANY)
    ap.add_argument("--no-search", action="store_true")
    args = ap.parse_args()

    key, source = config.resolve_api_key()
    if not key:
        raise SystemExit("LINER_API_KEY 가 없습니다.")
    programs = json.loads((ROOT / "web" / "public" / "data" / "programs.json").read_text(encoding="utf-8"))
    out = config.RESULTS_DIR / f"notice_{datetime.now():%Y%m%d_%H%M%S}"
    out.mkdir(parents=True, exist_ok=True)
    n_calls = len(args.find) * (len(args.models) + 1)
    client = LinerClient(key, source, limits={"model": n_calls, "search": len(args.find)})
    report = []
    try:
        for needle in args.find:
            p = find_program(programs, needle)
            print(f"\n=== {p['title']} ({p['id']}) ===")
            item: dict = {"id": p["id"], "title": p["title"], "url": p["url"], "docUrl": p["docUrl"]}
            try:
                doc = docs.extract_text(docs.fetch_document(p["docUrl"]))
            except docs.DocumentError as e:
                print("  공고문을 읽지 못함:", e)
                report.append({**item, "error": f"공고문: {e}"})
                continue
            text = doc["text"]
            item.update(doc_kind=doc["kind"], doc_pages=doc["pages"], doc_chars=len(text))
            print(f"  공고문: {doc['kind'].upper()} · {doc['pages'] or '-'}쪽 · {len(text):,}자")

            if not args.no_search:
                try:
                    data, rec = client.search_web(f"{p['title']} {p['operator']}", country_code="kr", lang="ko",
                                                  max_results=8, label="notice_search")
                    results = [{"title": r.get("title"), "url": r.get("url"), "hostname": r.get("hostname"), "date": r.get("date")}
                               for r in data.get("results") or []]
                    official = [r for r in results if str(r["hostname"] or "").endswith(OFFICIAL_SUFFIXES)]
                    item["search"] = {"elapsed_sec": rec.get("elapsed_sec"), "results": results, "n_official": len(official)}
                    print(f"  Liner Search: {len(results)}건, 공공기관 도메인 {len(official)}건, {rec.get('elapsed_sec')}초")
                    for r in results[:5]:
                        print(f"    - {r['hostname']} | {(r['title'] or '')[:50]}")
                except LinerAPIError as e:
                    item["search"] = {"error": str(e)[:200]}
                    print("  Liner Search 오류:", str(e)[:120])

            item["extract"] = []
            for model in args.models:
                row = run_extract(client, model, p["title"], text)
                item["extract"].append(row)
                if row.get("ok"):
                    print(f"  추출 {model}: 조건 {row['n_conditions']}개, 원문 확인 {row['n_verified']}개, "
                          f"{row['elapsed_sec']}초, ${row['cost_usd']}, 토큰 {row['input_tokens']}→{row['output_tokens']}")
                else:
                    print(f"  추출 {model}: 실패 — {row.get('error') or 'JSON 아님'} ({row.get('elapsed_sec')}초)")

            best = next((r for r in item["extract"] if r.get("ok") and r["n_verified"]), None)
            if best:
                confirmed = [c for c in best["conditions"] if c["status"] == "확인됨"]
                try:
                    data, rec = client.chat_json(args.models[0], notice.MATCH_SYSTEM,
                                                 notice.build_match_user(args.company, confirmed),
                                                 schema=notice.MATCH_SCHEMA, schema_name="notice_match", label="match")
                    match = notice.clean_match(notice.parse_json(extract_chat_text(data)), len(confirmed))
                    item["match"] = {"model": args.models[0], "based_on": best["model"], "elapsed_sec": rec.get("elapsed_sec"),
                                     "cost_usd": rec.get("cost_usd"), "conditions": confirmed, "result": match}
                    if match:
                        print(f"  대조({args.models[0]}): {match['overall']} — {match['overall_reason'][:110]}")
                except LinerAPIError as e:
                    item["match"] = {"error": str(e)[:300]}
                    print("  대조 오류:", str(e)[:120])
            report.append(item)
    finally:
        client.close()
        calls = [{k: c.get(k) for k in ("call_no", "kind", "label", "model", "http_status", "ok", "elapsed_sec",
                                         "input_tokens", "output_tokens", "cost_usd", "est_cost_usd", "error")} for c in client.calls]
        payload = scrub({"company": args.company, "models": args.models, "notices": report, "calls": calls}, client.secrets)
        (out / "report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        total = sum((c.get("cost_usd") or c.get("est_cost_usd") or 0) for c in client.calls)
        print(f"\n호출 {len(client.calls)}회, 비용 합계 약 ${total:.4f} · 결과: {out / 'report.json'}")


if __name__ == "__main__":
    main()
