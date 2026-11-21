"use client";

import { useSyncExternalStore } from "react";
import { IDLE, getTask, subscribeTasks, type Task } from "@/lib/tasks";

/** 공용 저장소에서 이 열쇠의 작업 상태를 읽는다. 같은 열쇠를 쓰는 모든 화면이 함께 갱신된다. */
export function useTask<T>(key: string): Task<T> {
  return useSyncExternalStore(subscribeTasks, () => getTask<T>(key), () => IDLE as Task<T>);
}
