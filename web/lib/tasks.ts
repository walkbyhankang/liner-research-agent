// 유료 분석(공고 자격 대조, 경쟁사 조건 대조, 운용사 요약)의 진행 상태와 결과를 카드 밖에 둔다.
// 카드가 화면에서 사라지거나(접기, 저장 보기 전환, 필터 변경) 같은 항목이 두 곳에 보여도
// 진행 중인 요청의 결과가 버려지지 않고, 같은 입력이면 같은 결과를 함께 본다.
// 페이지를 새로 열면 지워진다(브라우저에 저장하지 않는다).

export type Task<T> = { status: "idle" | "loading" | "done" | "error"; data?: T; error?: string; startedAt?: number };

export const IDLE: Task<never> = { status: "idle" };
const MAX_TASKS = 200;
const tasks = new Map<string, Task<unknown>>();
const listeners = new Set<() => void>();

export const getTask = <T>(key: string): Task<T> => (tasks.get(key) as Task<T> | undefined) ?? IDLE;

export function subscribeTasks(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function put(key: string, task: Task<unknown>) {
  tasks.delete(key);
  tasks.set(key, task);
  // 오래된 것부터 지우되, 진행 중인 것은 결과를 받아야 하므로 남긴다
  for (const k of tasks.keys()) {
    if (tasks.size <= MAX_TASKS) break;
    if (tasks.get(k)?.status !== "loading") tasks.delete(k);
  }
  listeners.forEach((l) => l());
}

/**
 * 작업을 시작한다. 같은 열쇠의 작업이 이미 진행 중이면 다시 시작하지 않고 false 를 돌려준다(유료 호출이 겹치지 않게).
 * 끝난 작업은 다시 시작할 수 있다.
 */
export function runTask<T>(key: string, work: () => Promise<T>): boolean {
  if (tasks.get(key)?.status === "loading") return false;
  put(key, { status: "loading", startedAt: Date.now() });
  work().then(
    (data) => put(key, { status: "done", data }),
    (e) => put(key, { status: "error", error: e instanceof Error ? e.message : "요청 실패" }),
  );
  return true;
}

/** 테스트용: 저장된 작업을 모두 지운다. */
export function resetTasks() {
  tasks.clear();
  listeners.forEach((l) => l());
}

export const taskCount = () => tasks.size;
