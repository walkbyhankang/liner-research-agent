import assert from "node:assert/strict";
import test from "node:test";
import { getTask, resetTasks, runTask, subscribeTasks, taskCount } from "./tasks.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test("결과는 화면이 없어도 저장소에 남고, 구독한 쪽에 알린다", async () => {
  resetTasks();
  const d = deferred();
  let notified = 0;
  const off = subscribeTasks(() => (notified += 1));
  assert.equal(getTask("a").status, "idle");
  assert.equal(runTask("a", () => d.promise), true);
  assert.equal(getTask("a").status, "loading");
  off(); // 카드가 화면에서 사라진 상황
  d.resolve({ overall: "확인 후 판단" });
  await tick();
  assert.deepEqual(getTask("a"), { status: "done", data: { overall: "확인 후 판단" } });
  assert.equal(notified, 1);
});

test("진행 중인 작업은 다시 시작하지 않아 유료 호출이 겹치지 않는다", async () => {
  resetTasks();
  const d = deferred();
  let calls = 0;
  const work = () => ((calls += 1), d.promise);
  assert.equal(runTask("a", work), true);
  assert.equal(runTask("a", work), false);
  assert.equal(calls, 1);
  d.resolve(1);
  await tick();
  assert.equal(runTask("a", () => Promise.resolve(2)), true); // 끝난 뒤에는 다시 실행할 수 있다
  await tick();
  assert.equal(getTask("a").data, 2);
});

test("실패는 오류 문구로 남고, 입력이 다르면 열쇠가 달라 결과가 섞이지 않는다", async () => {
  resetTasks();
  runTask("a", () => Promise.reject(new Error("공고문 서버에 연결하지 못했습니다")));
  runTask("b", () => Promise.resolve("B 결과"));
  await tick();
  assert.deepEqual(getTask("a"), { status: "error", error: "공고문 서버에 연결하지 못했습니다" });
  assert.equal(getTask("b").data, "B 결과");
  assert.equal(getTask("c").status, "idle");
});

test("오래된 결과부터 지우되 진행 중인 작업은 지우지 않는다", async () => {
  resetTasks();
  const d = deferred();
  runTask("진행중", () => d.promise);
  for (let i = 0; i < 230; i++) runTask(`k${i}`, () => Promise.resolve(i));
  await tick();
  assert.equal(taskCount() <= 200, true);
  assert.equal(getTask("진행중").status, "loading");
  assert.equal(getTask("k0").status, "idle");
  assert.equal(getTask("k229").data, 229);
  d.resolve("늦게 온 결과");
  await tick();
  assert.equal(getTask("진행중").data, "늦게 온 결과");
});
