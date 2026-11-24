#!/usr/bin/env bash
# 성장노트(Next.js 화면 + FastAPI 분석 서버)를 띄운다.
# 두 서버 모두 127.0.0.1 에만 연다(같은 컴퓨터에서만 접속). 터미널과 상관없이 계속 띄우는 방법은 docs/operations.md.
#
#   scripts/run_local.sh              성장노트(화면 + 분석 서버)
#   scripts/run_local.sh growthnote   같음(옛 이름 fundingnote 도 받는다)
#
# 포트(환경변수로 바꿀 수 있다)
#   FUNDING_WEB_PORT   성장노트 화면        기본 3100
#   FUNDING_API_PORT   성장노트 분석 서버   기본 8000
#   FUNDING_SKIP_BUILD=1 이면 화면을 다시 빌드하지 않는다
#
# 끝낼 때는 Ctrl+C. 키는 저장소 루트 .env 에서 읽는다(이 스크립트는 키를 다루지 않는다).
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-growthnote}"
WEB_PORT="${FUNDING_WEB_PORT:-3100}"
API_PORT="${FUNDING_API_PORT:-8000}"
PY=.venv/bin/python

case "$MODE" in
  growthnote | fundingnote) ;;  # fundingnote 는 예전 이름(그대로 받는다)
  *)
    echo "사용법: scripts/run_local.sh [growthnote]" >&2
    exit 2
    ;;
esac
if [ ! -x "$PY" ]; then
  echo ".venv 가 없습니다. 먼저 실행: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi
# 필요한 Python 패키지가 있는지 먼저 본다. 예전에 만든 .venv 를 그대로 쓰면 나중에 추가된 패키지가 빠져 있을 수 있다
missing=$("$PY" -c 'import importlib.util, sys; print(" ".join(m for m in sys.argv[1:] if importlib.util.find_spec(m) is None))' \
  fastapi uvicorn pypdf httpx pydantic dotenv)
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

[ -d web/node_modules ] || npm --prefix web install
if [ "${FUNDING_SKIP_BUILD:-0}" != "1" ] || [ ! -f web/.next/BUILD_ID ]; then
  npm --prefix web run build
fi
# 분석 서버는 프로세스 하나로 띄운다(하루 사용량 파일 results/usage/ 를 한 프로세스가 센다. --workers 를 늘리지 않는다)
"$PY" -m uvicorn api.main:app --host 127.0.0.1 --port "$API_PORT" --log-level warning &
pids+=($!)
# 화면은 같은 주소의 /api 로 요청하고, 화면 서버가 분석 서버로 넘긴다
(cd web && FUNDING_API_ORIGIN="http://127.0.0.1:$API_PORT" exec node_modules/.bin/next start -H 127.0.0.1 -p "$WEB_PORT") &
pids+=($!)

echo
echo "성장노트            http://127.0.0.1:$WEB_PORT   (분석 서버 http://127.0.0.1:$API_PORT)"
echo "끝내려면 Ctrl+C"
wait
