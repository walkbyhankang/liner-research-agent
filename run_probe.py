"""CLI 실행기: 기업 1개를 분석하고 결과 파일을 저장한다.
사용: python run_probe.py "회사명" [국가] [--no-agent] [--budget N] [--results N] [--premium] [--alias 별칭] [--homepage 도메인]
기본: 검색 12회, 결과 15개, Agent 사용(1회). --premium 은 Premium Data 비교(유료 1회)."""
from __future__ import annotations

import sys

import config
import pipeline as pl
from liner_client import LinerClient


def _opt(argv: list[str], name: str, default: str = "") -> str:
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default


def main(argv: list[str]) -> int:
    flags_with_value = {"--budget", "--results", "--alias", "--homepage", "--exclude", "--industry"}
    args, skip = [], False
    for i, a in enumerate(argv):
        if skip:
            skip = False
        elif a in flags_with_value:
            skip = True
        elif not a.startswith("--"):
            args.append(a)
    if not args:
        print('사용법: python run_probe.py "회사명" [국가] [--no-agent] [--budget N] [--results N] [--premium]')
        return 2
    company = args[0]
    country = args[1] if len(args) > 1 else "대한민국"
    key, source = config.resolve_api_key()
    if not key:
        print("API 키가 없습니다 (LINER_API_KEY 환경변수 또는 .env).")
        return 1
    budget = int(_opt(argv, "--budget", str(config.MAX_SEARCH_CALLS)))
    n = int(_opt(argv, "--results", str(config.SEARCH_MAX_RESULTS)))
    if n not in config.SEARCH_RESULT_CHOICES:
        print(f"--results 는 {config.SEARCH_RESULT_CHOICES} 중 하나여야 합니다.")
        return 2
    opts = pl.default_options(search_budget=budget, max_results=n, use_agent="--no-agent" not in argv,
                              hints={"aliases": _opt(argv, "--alias"), "homepage": _opt(argv, "--homepage"),
                                     "exclude": _opt(argv, "--exclude"), "industry": _opt(argv, "--industry")})
    client = LinerClient(key, source, limits={"search": budget})
    try:
        run = pl.run_analysis(company, country, client, progress=print, options=opts)
        if "--premium" in argv:
            pl.run_premium_compare(run, client, progress=print)
        out = pl.save_results(run, client.secrets)
    finally:
        client.close()
    print("상태:", run["status"])
    for e in run["errors"]:
        print("오류:", e["stage"], e["message"])
    print("호출 사용량:", client.usage())
    print("호출:", [(c["label"], c["http_status"], c["elapsed_sec"]) for c in run["calls"]])
    print("인증정보 노출 검사:", "이상 없음" if not run["secret_leaks"] else run["secret_leaks"])
    print("저장:", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
