"use client";

// 회사 정보 수정 창(screens 1.8). 넓은·중간 화면은 오른쪽 패널, 좁은 화면은 화면 전체.
// "저장"을 누르기 전에는 브라우저 저장소와 서버에 아무것도 쓰지 않는다(C-18). 분석 값과 같으면 고친 값으로 남기지 않는다.
import { useEffect, useId, useRef, useState } from "react";
import { regionOptions } from "@/lib/finder";
import { BIZ_LABEL, EDIT_FIELDS, EDIT_LABEL, noticeCompany, type EditField, type Edits } from "@/lib/company-values";
import { saveEdits } from "@/lib/local";
import { STATUS_LABEL, type Value } from "@/lib/contract";
import { StatusWord, toast } from "@/components/kit";
import { useCompany } from "@/components/company/context";

const PLACEHOLDER: Partial<Record<EditField, string>> = {
  industry: "예: 소프트웨어 개발 및 공급업",
  employees: "예: 12명",
  revenue: "예: 8억 원",
  need: "예: 운전자금 3억 원(인건비)",
  notes: "예: 벤처기업 확인, 기존 대출 없음, 세금 체납 없음",
};

const shortSrc = (v: Value | null) => (v?.source ? v.source.org || v.source.name : "");
function analysisLine(v: Value | null, display?: string) {
  if (!v || v.status === "unavailable") return "분석 값 없음";
  if (v.status === "conflicting" && v.values?.length) return `분석 값: ${v.values.map((a) => `${a.display} (${a.source.org || a.source.name})`).join(", 다른 자료: ")} (엇갈림)`;
  return `분석 값: ${display ?? v.display} (${STATUS_LABEL[v.status]}, ${shortSrc(v)})`;
}

export function EditSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { job, local, cid } = useCompany();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const defaults = job ? noticeCompany(job, {}) : null;
  const base: Record<EditField, string> = {
    region: defaults?.region ?? "", bizType: "", founded: defaults?.founded ?? "", industry: defaults?.industry ?? "", employees: defaults?.employees ?? "",
    revenue: defaults?.revenue ?? "", need: "", notes: "",
  };
  const initial = () => Object.fromEntries(EDIT_FIELDS.map((f) => [f, local.edits[f]?.value ?? base[f]])) as Record<EditField, string>;
  const [draft, setDraft] = useState<Record<EditField, string>>(initial);
  const [ask, setAsk] = useState<"close" | "reset" | null>(null);
  const firstRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setDraft(initial());
      setAsk(null);
      d.showModal();
      firstRef.current?.focus();
    } else if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!job) return null;
  const m = job.merged;
  const isEdited = (f: EditField) => draft[f].trim() !== base[f].trim() && draft[f].trim() !== "";
  const dirty = EDIT_FIELDS.some((f) => draft[f].trim() !== (local.edits[f]?.value ?? base[f]).trim());
  const editedCount = EDIT_FIELDS.filter((f) => local.edits[f]).length;
  const set = (f: EditField, v: string) => setDraft((d) => ({ ...d, [f]: v }));

  const tryClose = () => {
    if (dirty) setAsk("close");
    else onClose();
  };
  const save = () => {
    const at = new Date().toISOString();
    const next: Edits = {};
    for (const f of EDIT_FIELDS) {
      const v = draft[f].trim();
      if (v && v !== base[f].trim()) next[f] = { value: v, updatedAt: local.edits[f]?.value === v ? local.edits[f]!.updatedAt : at };
    }
    saveEdits(cid, next);
    const after = noticeCompany(job, next);
    const stale = Object.values(local.checks).filter((c) => c.result && JSON.stringify(c.company) !== JSON.stringify(after)).length;
    toast(stale ? `회사 정보를 저장했습니다.\n자격 대조 ${stale}건은 이전 회사 값으로 한 결과입니다. 심사 준비에서 다시 대조할 수 있습니다.` : "회사 정보를 저장했습니다.");
    onClose();
  };

  const npsCount = typeof m.npsLatest?.raw === "number" ? m.npsLatest.raw : null;
  const analysisText: Record<EditField, string> = {
    region: analysisLine(m.region),
    bizType: m.bizTypeHint ? `분석 값 없음. ${BIZ_LABEL[m.bizTypeHint.id]}으로 보입니다(추정): ${m.bizTypeHint.reason}` : "분석 값 없음",
    founded: analysisLine(m.founded),
    industry: m.industry.official && m.industry.official.status !== "unavailable" ? analysisLine(m.industry.official) : analysisLine(m.industry.web),
    employees: analysisLine(m.employees),
    revenue: m.revenue.official && m.revenue.official.status !== "unavailable" ? analysisLine(m.revenue.official, defaults?.revenue) : analysisLine(m.revenue.web),
    need: "분석 값 없음",
    notes: "분석 값 없음",
  };
  const input = "mt-1 block min-h-11 w-full rounded-md border border-edge bg-paper px-3 text-base outline-none focus:border-ledger";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        tryClose();
      }}
      className="m-0 ml-auto h-full max-h-none w-full max-w-none border-l border-rule bg-paper p-0 text-ink backdrop:bg-ink/30 sm:max-w-[520px]"
    >
      {open && (
        <form
          className="flex h-full flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="border-b border-rule px-5 py-4">
            <h2 id={titleId} className="text-xl font-semibold">
              회사 정보 수정
            </h2>
            <p className="mt-1 text-sm">자격 대조와 운용사 요약에 쓰는 정보입니다. 필요한 자금이나 인증처럼 공개 자료에 없는 정보도 넣을 수 있습니다.</p>
            <p className="mt-1 text-sm text-sub">고친 값은 이 브라우저에만 저장됩니다. 공고문 자격 대조나 운용사 요약을 실행할 때만 분석 서버로 보냅니다.</p>
          </div>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {EDIT_FIELDS.map((f) => {
              const id = `edit-${f}`;
              return (
                <div key={f}>
                  <label htmlFor={id} className="flex items-center gap-2 text-sm font-semibold">
                    {EDIT_LABEL[f]}
                    {isEdited(f) && <StatusWord w="edited" />}
                  </label>
                  {f === "region" ? (
                    <select id={id} ref={firstRef} className={input} value={draft.region} onChange={(e) => set("region", e.target.value)}>
                      <option value="">고르지 않음</option>
                      {regionOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : f === "bizType" ? (
                    <select id={id} className={input} value={draft.bizType} onChange={(e) => set("bizType", e.target.value)}>
                      <option value="">고르지 않음</option>
                      {(Object.keys(BIZ_LABEL) as (keyof typeof BIZ_LABEL)[]).map((b) => (
                        <option key={b} value={b}>
                          {BIZ_LABEL[b]}
                        </option>
                      ))}
                    </select>
                  ) : f === "notes" ? (
                    <textarea id={id} rows={3} className={`${input} py-2`} placeholder={PLACEHOLDER.notes} value={draft.notes} onChange={(e) => set("notes", e.target.value)} maxLength={400} />
                  ) : (
                    <input
                      id={id}
                      type={f === "founded" ? "month" : "text"}
                      className={input}
                      placeholder={PLACEHOLDER[f]}
                      value={draft[f]}
                      onChange={(e) => set(f, e.target.value)}
                      maxLength={f === "need" ? 120 : f === "industry" ? 80 : f === "revenue" ? 60 : 30}
                    />
                  )}
                  <p className="mt-1 text-sm text-sub">{analysisText[f]}</p>
                  {f === "employees" && npsCount !== null && <p className="text-sm text-sub">국민연금 가입자 수({npsCount}명)는 상시근로자 수와 다릅니다.</p>}
                  {isEdited(f) && base[f] && (
                    <button type="button" className="btn btn-quiet mt-1 text-sm" onClick={() => set(f, base[f])}>
                      분석 값으로 되돌리기
                    </button>
                  )}
                </div>
              );
            })}
            <p className="text-sm">비워 둔 칸은 자격 대조에서 &lsquo;확인 필요&rsquo;로 나옵니다. 확인된 특허 수와 국민연금 가입자 수는 대조할 때 함께 보냅니다.</p>
            {editedCount > 0 &&
              (ask === "reset" ? (
                <div className="rounded-md border border-rule p-3" role="alert">
                  <p>고친 값 {editedCount}개를 분석 값으로 되돌릴까요?</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="btn" onClick={() => setAsk(null)}>
                      취소
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        saveEdits(cid, {});
                        setDraft({ ...base });
                        setAsk(null);
                        toast("고친 값을 모두 되돌렸습니다.");
                      }}
                    >
                      되돌리기
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-quiet text-sm" onClick={() => setAsk("reset")}>
                  고친 값 모두 되돌리기
                </button>
              ))}
          </div>
          <div className="border-t border-rule px-5 py-3">
            {ask === "close" ? (
              <div role="alert">
                <p>고친 내용을 저장하지 않고 닫을까요?</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setAsk(null)}>
                    계속 고치기
                  </button>
                  <button type="button" className="btn btn-primary" onClick={onClose}>
                    닫기
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={tryClose}>
                  취소
                </button>
                <button type="submit" className="btn btn-primary">
                  저장
                </button>
              </div>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}
