"use client";

// 값 하나(Value)를 보이는 부품: 1층의 값 + 상태 낱말, 엇갈림 두 값 나란히, 미확보 사유, 3층 출처 상자(screens 1.3).
import type { ReactNode } from "react";
import type { Value } from "@/lib/contract";
import { DetailRow, SourceLine, StatusWord } from "@/components/kit";
import type { Word } from "@/lib/view";

export const WORD_MEANING: Record<Word, string> = {
  confirmed: "원문 본문이나 공공 기관 원자료에서 값을 확인했습니다.",
  reported: "기사, 자료, 투자 DB에 적혀 있지만 원문 본문으로 확인하지는 않았습니다.",
  inferred: "모델이 판단했거나 간접 근거로 짐작한 값입니다.",
  conflicting: "자료마다 값이 다릅니다. 어느 한쪽을 고르지 않고 함께 보여 줍니다.",
  unavailable: "자료를 얻지 못했습니다. 사유를 함께 적습니다.",
  reference: "같은 값이 아니라 대신 볼 수 있는 값입니다. 예: 국민연금 가입자 수는 직원 수와 다릅니다.",
  edited: "이 브라우저에서 고친 값입니다. 새로 분석해도 바뀌지 않습니다.",
};

/** 엇갈림 값의 두 줄(1층에서 접지 않는다). 첫 줄: 값과 짧은 출처, 둘째 줄부터 "다른 자료:" */
export function ConflictLines({ v }: { v: Value }) {
  const alts = v.values ?? [];
  return (
    <span className="block">
      {alts.map((a, i) => (
        <span key={i} className="block">
          {i > 0 && <span className="text-sub">다른 자료: </span>}
          <span className="num font-medium">{a.display}</span> <span className="text-sm text-sub">{a.source ? `(${a.source.org || a.source.name})` : ""}</span>
        </span>
      ))}
      {alts.length < 2 && v.note && <span className="block text-sm text-sub">{v.note}</span>}
    </span>
  );
}

/** 1층의 값 글. 미확보는 "미확보: 사유", 엇갈림은 두 줄 */
export function ValueText({ v, edit, pendingText = "확인 중" }: { v: Value | null | undefined; edit?: string | null; pendingText?: string }) {
  if (edit) return <span className="num font-medium">{edit}</span>;
  if (!v) return <span className="text-sub">{pendingText}</span>;
  if (v.status === "unavailable")
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2">
        <StatusWord w="unavailable" />
        <span className="font-medium">{v.reason ?? "자료 없음"}</span>
      </span>
    );
  if (v.status === "conflicting") return <ConflictLines v={v} />;
  return <span className="num font-medium">{v.display}</span>;
}

export const wordOf = (v: Value | null | undefined, edit?: string | null): Word | null => (edit ? "edited" : v ? v.status : null);

/** 3층 출처 상자: 상태 뜻 → 출처 → 근거 문장 → 메모 → 엇갈림의 다른 값 → 직접 입력이면 원래 값과 되돌리기 */
export function ValueBox({ v, edit, onRevert, usedNote, extra }: { v: Value | null | undefined; edit?: string | null; onRevert?: () => void; usedNote?: string; extra?: ReactNode }) {
  const w = wordOf(v, edit);
  return (
    <div className="space-y-2">
      {w && (
        <p className="flex flex-wrap items-center gap-2">
          <StatusWord w={w} />
          <span>{WORD_MEANING[w]}</span>
        </p>
      )}
      {edit && (
        <div className="space-y-1">
          <p>
            <span className="text-sub">원래 분석 값: </span>
            {v ? <ValueText v={v} /> : "분석 값 없음"} {v && <StatusWord w={v.status} />}
          </p>
          {v?.source && <SourceLine source={v.source} />}
          {onRevert && (
            <button type="button" className="btn" onClick={onRevert}>
              분석 값으로 되돌리기
            </button>
          )}
        </div>
      )}
      {!edit && v && v.status !== "conflicting" && v.source && <SourceLine source={v.source} />}
      {!edit && v?.quote && v.status !== "conflicting" && <Quote text={v.quote} />}
      {!edit && v?.note && <p className="text-sm text-sub">{v.note}</p>}
      {!edit && v?.status === "conflicting" &&
        (v.values ?? []).map((a, i) => (
          <div key={i}>
            <p>
              {i > 0 && <span className="text-sub">다른 자료: </span>}
              <span className="num font-medium">{a.display}</span>
            </p>
            <SourceLine source={a.source} />
            {a.quote && <Quote text={a.quote} />}
          </div>
        ))}
      {!edit && v?.status === "conflicting" && <p className="text-sm text-sub">{usedNote ?? (v.usedIndex !== null ? "업력 계산과 자격 대조에는 공공 API 값을 씁니다." : "공공 API 값이 없어 계산과 자격 대조에는 쓰지 않습니다.")}</p>}
      {extra}
    </div>
  );
}

/**
 * 근거 문장(원문 그대로). 3줄을 넘으면 접고 "전체 보기".
 * 인용 선은 회색 1px 로 펼친 덩어리의 녹색 2px 선보다 가볍게, 바깥 선과 띄워 둔다(qa-report 4절 "경계와 펼침", 주석 20)
 */
export function Quote({ text }: { text: string }) {
  const long = text.length > 120;
  return (
    <blockquote className="ml-1 border-l border-rule pl-3 text-sm">
      {long ? (
        <details>
          <summary className="list-none">
            <span className="clamp-3">“{text}”</span>
            <span className="link text-sm">전체 보기</span>
          </summary>
          <span className="block">“{text}”</span>
        </details>
      ) : (
        <span>“{text}”</span>
      )}
    </blockquote>
  );
}

/** 이름표와 값 한 줄(개요 기업 사실, 노트). 1층은 상태 낱말 하나만, 누르면 3층 출처 상자 */
export function FactRow({ label, v, edit, onRevert, memoryKey, pendingText }: { label: string; v: Value | null | undefined; edit?: string | null; onRevert?: () => void; memoryKey?: string; pendingText?: string }) {
  const w = wordOf(v, edit);
  const head = (
    <span className="grid grid-cols-[5.5em_1fr] items-start gap-x-3">
      <span className="text-sub">{label}</span>
      <span className="flex flex-wrap items-start gap-x-2">
        <span className="min-w-0">
          <ValueText v={v} edit={edit} pendingText={pendingText} />
        </span>
        {w && w !== "unavailable" && <StatusWord w={w} className="mt-1" />}
      </span>
    </span>
  );
  if (!v && !edit) return <div className="row-btn cursor-default hover:bg-transparent" aria-busy="true">{head}</div>;
  return (
    <DetailRow head={head} memoryKey={memoryKey}>
      <ValueBox v={v} edit={edit} onRevert={onRevert} />
    </DetailRow>
  );
}
