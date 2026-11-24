# 공개 서버 운영 (macOS launchd)

시연 기간에 성장노트를 터미널과 상관없이 계속 띄우는 방법입니다. 심사용 실행에는 필요 없습니다(README의 `scripts/run_local.sh`로 충분합니다).

## 구성

- 팀원에게 공개하는 방법(네트워크 공유 설정)은 이 문서에서 다루지 않습니다. 운영자가 따로 관리하며, 공개할 때도 화면 서버(3100)만 열고 분석 서버(8000)는 이 컴퓨터 안에만 둡니다.

- 커밋된 코드만 둔 별도 워크트리(이하 공개 폴더)에서 띄웁니다. 개발 폴더에서 다시 빌드해도 떠 있는 화면이 깨지지 않게 하기 위해서입니다.
- 서버마다 macOS 사용자 LaunchAgent 하나: `local.growthnote.api`(분석 서버 8000), `local.growthnote.web`(화면 3100). 관리자 권한은 필요 없습니다.
- 로그인하면 시작하고, 서버가 죽으면 launchd가 다시 띄웁니다(`KeepAlive`, 연속 실패 시 15초 간격).
- 실행기 `~/Library/Application Support/growthnote/serve.sh api|web`와 `~/Library/LaunchAgents/local.growthnote.{api,web}.plist`는 저장소 밖에 둡니다. 키는 넣지 않습니다(분석 서버가 공개 폴더의 `.env`를 읽습니다).
- 화면 실행기는 공개 폴더의 커밋이 마지막 빌드와 다르면 먼저 다시 빌드합니다(`package-lock.json`이 바뀌었으면 `npm ci`도 실행).
- 서버가 도는 동안 `caffeinate`로 잠들기를 막습니다. 덮개를 닫거나 로그아웃·재시동하면 멈춥니다.
- 로그: `~/Library/Logs/growthnote/{api,web}.log`(이전 로그 1개 보관, 20MB를 넘으면 비움).

## 새 커밋 반영

아래 블록을 차례로 실행하고, 앞 블록이 성공했을 때만 다음으로 넘어갑니다.

```bash
SERVE_DIR="$HOME/path/to/growthnote-serve"   # 공개 폴더 경로로 바꾼다
```

```bash
# GitHub 최신 커밋을 미리 받는다(공개 폴더의 코드는 아직 바꾸지 않는다)
git -C "${SERVE_DIR:?SERVE_DIR 를 먼저 정하세요}" fetch origin
```

공개 폴더의 코드를 바꾸는 일(옮기기)과 다시 시작은 아래 확인을 마친 뒤 한 번에 합니다. 떠 있는 화면은 공개 폴더의 자료 파일을 바로 읽으므로, 먼저 옮겨 두면 다시 시작하기 전까지 화면과 분석 서버가 서로 다른 자료를 쓸 수 있습니다.

분석 서버를 다시 시작하면 진행 중인 유료 작업은 중단되고, 이미 쓴 호출은 되돌릴 수 없습니다. 그래서 반영은 아무도 쓰지 않는 시간에만 합니다.

1. 사용자에게 반영 시간을 미리 알리고, 그동안 새 분석·요청 시 실행·공고문 대조·운용사 요약을 누르지 말아 달라고 합니다.
2. 진행 중인 작업이 모두 끝났는지 확인합니다. 아래 값(`running`)은 기본 분석만 세고, 요청 시 실행(논문 동향·경쟁사 깊이 비교)과 공고문 대조·운용사 요약은 세지 않습니다. 분석 서버 로그에도 요청 기록이 남지 않습니다. 따라서 이 값이 0이고, 사용자에게서 진행 중인 작업이 없다는 확인을 받았을 때만 다시 시작합니다.
3. 확인할 수 없으면 반영을 미룹니다.

성장노트에는 새 요청을 막는 기능이 없습니다. 그래서 확인한 뒤 다시 시작할 때까지는 사용자의 협조에 의존하며, 이 사이에 누군가 유료 단추를 누르면 그 요청은 중단될 수 있습니다. 확인 직후 곧바로 아래 블록을 실행합니다.

```bash
curl -s --max-time 5 http://127.0.0.1:8000/api/health | grep -o '"running":[0-9]*'
```

```bash
# 확인을 마친 뒤: 받은 커밋으로 옮기고 곧바로 두 서버를 다시 시작한다(분석 서버는 1초 안팎, 화면은 다시 빌드한 뒤 뜬다)
U=gui/$(id -u)
PREV=$(git -C "${SERVE_DIR:?SERVE_DIR 를 먼저 정하세요}" rev-parse HEAD); echo "직전 커밋: $PREV"   # 되돌릴 때 쓴다
git -C "${SERVE_DIR:?}" checkout --detach origin/main \
  && launchctl kickstart -k "$U/local.growthnote.api" && launchctl kickstart -k "$U/local.growthnote.web"
```

위 블록이 오류로 끝나거나, 아래 확인을 화면 빌드가 끝날 때까지(빌드 표시가 새 커밋과 같아질 때까지) 되풀이해 10분이 지나도 두 주소가 200이 아니면(로그: `~/Library/Logs/growthnote/`), 직전 커밋으로 되돌리고 두 서버를 다시 시작합니다. 빌드 중에는 화면 주소가 응답하지 않는 것이 정상이므로 한 번 실패했다고 바로 되돌리지 않습니다.

```bash
# 옮기기가 성공했을 때만 두 서버를 각각 다시 시작하고, 하나라도 실패하면 알린다
git -C "${SERVE_DIR:?}" checkout --detach "${PREV:?직전 커밋을 넣으세요}" && {
  launchctl kickstart -k "$U/local.growthnote.api"; a=$?
  launchctl kickstart -k "$U/local.growthnote.web"; w=$?
  [ "$a" = 0 ] && [ "$w" = 0 ] || echo "다시 시작 실패(api=$a, web=$w)" >&2
}
```

```bash
# 확인: 앞의 두 줄이 같으면 화면이 그 커밋으로 빌드된 것이고, 두 주소가 200이면 응답한다
git -C "${SERVE_DIR:?}" rev-parse HEAD
cat "${SERVE_DIR:?}/web/.next/growthnote-built-commit"
curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/health
curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/
```

## 유지보수

```bash
U=gui/$(id -u)
launchctl bootout "$U/local.growthnote.web"                                  # 멈추기(api 도 같다)
launchctl bootstrap "$U" ~/Library/LaunchAgents/local.growthnote.web.plist   # 다시 켜기
launchctl print "$U/local.growthnote.web" | grep -E 'state|pid =|runs|last exit'   # 상태
tail -f ~/Library/Logs/growthnote/web.log                                   # 로그
```
