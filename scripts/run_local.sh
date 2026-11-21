#!/usr/bin/env bash
# 펀딩노트(Next.js 화면 + FastAPI 분석 서버)와 기존 Streamlit 프로토타입을 서로 다른 포트로 띄운다.
# 두 화면은 서로 독립이라 하나만 띄워도 되고, 나란히 띄워 비교할 수도 있다.
#
#   scripts/run_local.sh              둘 다 띄운다(비교용)
#   scripts/run_local.sh fundingnote  펀딩노트만
#   scripts/run_local.sh streamlit    Streamlit 프로토타입만
#
# 포트(환경변수로 바꿀 수 있다)
#   FUNDING_WEB_PORT   펀딩노트 화면        기본 3100
#   FUNDING_API_PORT   펀딩노트 분석 서버   기본 8000
#   STREAMLIT_PORT     Streamlit 프로토타입  기본 8501
#   FUNDING_SKIP_BUILD=1 이면 화면을 다시 빌드하지 않는다
#
# 끝낼 때는 Ctrl+C. 키는 저장소 루트 .env 에서 읽는다(이 스크립트는 키를 다루지 않는다).
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-all}"
WEB_PORT="${FUNDING_WEB_PORT:-3100}"
API_PORT="${FUNDING_API_PORT:-8000}"
ST_PORT="${STREAMLIT_PORT:-8501}"
PY=.venv/bin/python

case "$MODE" in
  all | fundingnote | streamlit) ;;
  *)
    echo "사용법: scripts/run_local.sh [all|fundingnote|streamlit]" >&2
    exit 2
    ;;
esac
if [ ! -x "$PY" ]; then
  echo ".venv 가 없습니다. 먼저 실행: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi
# 띄울 화면에 필요한 Python 패키지가 있는지 먼저 본다. 예전에 만든 .venv 를 그대로 쓰면 나중에 추가된 패키지가 빠져 있을 수 있다
need=()
[ "$MODE" != "streamlit" ] && need+=(fastapi uvicorn pypdf httpx pydantic)
[ "$MODE" != "fundingnote" ] && need+=(streamlit plotly pandas httpx)
missing=$("$PY" -c 'import importlib.util, sys; print(" ".join(m for m in dict.fromkeys(sys.argv[1:]) if importlib.util.find_spec(m) is None))' "${need[@]}")
if [ -n "$missing" ]; then
  echo "Python 패키지가 설치돼 있지 않습니다: $missing" >&2
  echo "먼저 실행: .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

pids=()
cleanup() {
  [ "${#pids[@]}" -gt 0 ] && kill "${pids[@]}" 2>/dev/null
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$MODE" != "streamlit" ]; then
  [ -d web/node_modules ] || npm --prefix web install
  if [ "${FUNDING_SKIP_BUILD:-0}" != "1" ] || [ ! -f web/.next/BUILD_ID ]; then
    npm --prefix web run build
  fi
  "$PY" -m uvicorn api.main:app --host 127.0.0.1 --port "$API_PORT" --log-level warning &
  pids+=($!)
  # 화면은 같은 주소의 /api 로 요청하고, 화면 서버가 분석 서버로 넘긴다
  (cd web && FUNDING_API_ORIGIN="http://127.0.0.1:$API_PORT" exec node_modules/.bin/next start -H 127.0.0.1 -p "$WEB_PORT") &
  pids+=($!)
fi
if [ "$MODE" != "fundingnote" ]; then
  "$PY" -m streamlit run app.py --server.address 127.0.0.1 --server.port "$ST_PORT" --server.headless true --browser.gatherUsageStats false &
  pids+=($!)
fi

echo
[ "$MODE" != "streamlit" ] && echo "펀딩노트            http://127.0.0.1:$WEB_PORT   (분석 서버 http://127.0.0.1:$API_PORT)"
[ "$MODE" != "fundingnote" ] && echo "Streamlit 프로토타입  http://127.0.0.1:$ST_PORT"
echo "끝내려면 Ctrl+C"
wait
