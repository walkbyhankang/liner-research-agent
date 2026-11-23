"use client";

// 노트(screens 8절): 상담·미팅 전에 한 장으로 정리해 인쇄하거나 나눈다. 노트는 내보내는 문서라 출처를 값 옆에 그대로 쓴다.
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { fmtMD, fmtTime, isStale } from "@/lib/format";
import { replaceLocal, saveMemo } from "@/lib/local";
import { exportFile, exportName, linerTotal, NOT_EXPORT_FILE, noteRows, noteText, parseImport, WORD_LEGEND, type ExportFile } from "@/lib/note";
import { openValues, verdictCounts } from "@/lib/review";
import { QUESTIONS } from "@/lib/prep";
import { onStorageChange, storageState } from "@/lib/store";
import { Dialog, StatusWord, toast } from "@/components/kit";
import { useCompany } from "@/components/company/context";
import { usePublicData } from "@/components/funding/Board";

type Item = { key: string; node: ReactNode; text: string };

/** 목록마다 처음 5개 + "{n}개 더 보기". 인쇄에서는 10개까지와 "외 {n}개"(PR-02) */
function NoteList({ items, empty }: { items: Item[]; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="text-sub">{empty ?? "없음"}</p>;
  return (
    <>
      <ul className="no-print list-disc space-y-1 pl-5" data-note-list>
        {(all ? items : items.slice(0, 5)).map((i) => (
          <li key={i.key}>{i.node}</li>
        ))}
      </ul>
      {!all && items.length > 5 && (
        <button type="button" className="btn no-print mt-2" onClick={() => setAll(true)}>
          {items.length - 5}개 더 보기
        </button>
      )}
      <ul className="print-only list-disc space-y-0.5 pl-5">
        {items.slice(0, 10).map((i) => (
          <li key={i.key}>{i.node}</li>
        ))}
        {items.length > 10 && <li>외 {items.length - 10}개</li>}
      </ul>
    </>
  );
}

export function NoteScreen() {
  const c = useCompany();
  const job = c.job;
  const { data } = usePublicData();
  const storage = useSyncExternalStore(onStorageChange, storageState, () => "pending" as const);
  const [memo, setMemo] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState<ExportFile | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);

  // "더 보기" 메뉴는 Esc 나 바깥을 누르면 닫는다. Esc 로 닫으면 초점은 메뉴 단추로 돌아간다
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      menuBox.current?.querySelector<HTMLElement>("[aria-controls=note-menu]")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);


  if (!job) {
    return (
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-semibold">노트</h1>
        <p className="mt-3 text-sub">회사 분석을 받으면 노트를 만듭니다.</p>
      </main>
    );
  }

  const today = c.today;
  const memoText = memo ?? c.local.notes?.memo ?? "";
  const stale = Boolean(job.analyzedAt && isStale(job.analyzedAt));
  const rows = noteRows(job, c.local.edits, today);
  const saved = c.local.saved;
  const progs = saved.filter((s) => s.kind === "program");
  const gps = saved.filter((s) => s.kind === "gp");
  const sales = saved.filter((s) => s.kind === "bid" || s.kind === "salesProgram");
  const endOf = (id: string, meta: Record<string, unknown>) => data?.programs.find((p) => p.id === id)?.period.end ?? (typeof meta.end === "string" ? meta.end : null);

  const progItems: Item[] = progs.map((s) => {
    const rec = c.local.checks[s.itemId];
    const end = endOf(s.itemId, s.meta);
    const r = rec?.result;
    const vc = r ? verdictCounts(r) : null;
    const gapsList = r ? r.match.rows.filter((x) => x.verdict === "미충족" || x.verdict === "확인 필요").slice(0, 5) : [];
    const text = `${s.title} (${end ? `${fmtMD(end)} 마감` : "신청기간 미기재"}) ${r && vc ? `${r.match.overall}, 충족 ${vc.met}, 미충족 ${vc.unmet}, 확인 필요 ${vc.check}` : "대조 전"}${gapsList.length ? `. 조건: ${gapsList.map((g) => `${g.verdict} ${g.requirement}`).join("; ")}` : ""}`;
    return {
      key: s.itemId,
      text,
      node: (
        <span>
          <span className="font-medium">{s.title}</span> <span className="num text-sm text-sub">{end ? `${fmtMD(end)} 마감` : "신청기간 미기재"}</span>
          <span className="block text-sm">{r && vc ? `${r.match.overall}. 충족 ${vc.met}, 미충족 ${vc.unmet}, 확인 필요 ${vc.check}` : "대조 전"}</span>
          {gapsList.length > 0 && (
            <span className="block text-sm text-sub">
              {gapsList.map((g, i) => (
                <span key={i} className="block">
                  {g.verdict}: {g.requirement}
                </span>
              ))}
            </span>
          )}
        </span>
      ),
    };
  });
  const gpItems: Item[] = gps.map((s) => {
    const b = c.local.briefs[s.itemId]?.result;
    const field = b?.facts.find((f) => f.kind === "투자 분야")?.text;
    const fit = b?.fit.slice(0, 2).map((f) => f.text) ?? [];
    const text = `${s.itemId}${s.meta.existing ? " (이미 투자함)" : ""}: ${b ? `투자 분야 ${field ?? "미확보"}${fit.length ? `. 맞닿는 점: ${fit.join("; ")}` : ""}` : "요약 전"}`;
    return {
      key: s.itemId,
      text,
      node: (
        <span>
          <span className="font-medium">{s.itemId}</span> {s.meta.existing ? <span className="text-sm">이미 투자함</span> : null}
          <span className="block text-sm">{b ? `투자 분야: ${field ?? "미확보"}` : "요약 전"}</span>
          {fit.map((f) => (
            <span key={f} className="block text-sm text-sub">
              맞닿는 점: {f}
            </span>
          ))}
        </span>
      ),
    };
  });
  const salesItems: Item[] = sales.map((s) => {
    const agency = typeof s.meta.agency === "string" ? s.meta.agency : "";
    const end = s.kind === "bid" ? (typeof s.meta.deadline === "string" ? s.meta.deadline : null) : endOf(s.itemId, s.meta);
    const kind = s.kind === "bid" ? "입찰공고" : "판로 지원사업";
    const text = `[${kind}] ${s.title}, ${agency}${end ? `, ${fmtMD(end)} 마감` : ""}`;
    return { key: `${s.kind}:${s.itemId}`, text, node: <span><span className="text-sm text-sub">{kind} </span>{s.title} <span className="text-sm text-sub">{agency}{end ? `, ${fmtMD(end)} 마감` : ""}</span></span> };
  });
  const askAgency: Item[] = progs.flatMap((s) => (c.local.checks[s.itemId]?.result?.match.questions ?? []).map((q, i) => ({ key: `${s.itemId}:${i}`, text: `${s.title}: ${q}`, node: <span><span className="text-sm text-sub">{s.title} </span>{q}</span> })));
  const askGp: Item[] = gps.flatMap((s) => (c.local.briefs[s.itemId]?.result?.questions ?? []).map((q, i) => ({ key: `${s.itemId}:${i}`, text: `${s.itemId}: ${q}`, node: <span><span className="text-sm text-sub">{s.itemId} </span>{q}</span> })));
  const docs: Item[] = [
    ...progs.flatMap((s) => (c.local.checks[s.itemId]?.result?.match.documents ?? []).map((d, i) => ({ key: `d:${s.itemId}:${i}`, text: `${d} (${s.title})`, node: <span>{d} <span className="text-sm text-sub">{s.title}</span></span> }))),
    ...openValues(job).map((o) => ({ key: `o:${o.label}`, text: `미팅 전에 정리할 값: ${o.label} (${o.kind === "conflict" ? "엇갈림" : "미확보"})`, node: <span>미팅 전에 정리할 값: {o.label} <StatusWord w={o.value.status} /></span> })),
  ];
  const askMemo: Item[] = QUESTIONS.filter((q) => c.local.prep.questions[q.id]?.memo?.trim()).map((q) => ({
    key: q.id, text: `${q.text} 메모: ${c.local.prep.questions[q.id].memo.trim()}`, node: <span>{q.text} <span className="block text-sm text-sub">메모: {c.local.prep.questions[q.id].memo.trim()}</span></span>,
  }));
  const liner = linerTotal(job);

  const textModel = {
    name: job.company.name, analyzedAt: job.analyzedAt, stale, today, rows,
    programs: progItems.map((i) => i.text), gps: gpItems.map((i) => i.text), sales: salesItems.map((i) => i.text),
    todo: [
      { title: "기관에 물을 질문", items: askAgency.map((i) => i.text) },
      { title: "운용사에 물을 것", items: askGp.map((i) => i.text) },
      { title: "준비할 자료", items: docs.map((i) => i.text) },
      { title: "투자 미팅 예상 질문 메모", items: askMemo.map((i) => i.text) },
    ],
    memo: memoText, liner,
  };

  const copyText = async () => {
    setMenu(false);
    try {
      await navigator.clipboard.writeText(noteText(textModel));
      toast("노트를 복사했습니다.");
    } catch {
      toast("이 브라우저에서는 복사하지 못했습니다.");
    }
  };
  const copyUrl = async () => {
    setMenu(false);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/c/${c.cid}`);
      toast("주소를 복사했습니다. 담은 항목과 메모는 주소에 들어가지 않습니다.");
    } catch {
      toast("이 브라우저에서는 복사하지 못했습니다.");
    }
  };
  const doExport = () => {
    setMenu(false);
    const file = exportFile(c.cid, job.company.name, c.local, new Date().toISOString());
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportName(job.company.name, today);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("이 브라우저에 저장된 고친 값, 담은 항목, 대조 결과, 노트를 파일로 저장합니다.");
  };
  const onMemo = (v: string) => {
    setMemo(v);
    setSavedAt(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const ok = await saveMemo(c.cid, v);
      if (ok) setSavedAt(new Date().toISOString());
    }, 1000);
  };
  const footer = `${job.company.name.replace(/["\\]/g, "")} 성장노트, ${today} 인쇄`;
  const empty = !progs.length && !gps.length && !sales.length;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
      <style>{`@media print { @page { @bottom-center { content: "${footer}, " counter(page) "/" counter(pages); font-size: 9pt; color: #586377; } } }`}</style>
      {/* 제목과 단추 줄은 문서 폭에 맞춰, 단추가 문서 오른쪽 끝에 붙어 보이게 한다 */}
      <div className="no-print flex max-w-[760px] flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">노트</h1>
        <div ref={menuBox} className="relative flex gap-2">
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            인쇄·PDF 저장
          </button>
          <button type="button" className="btn hidden sm:inline-flex" onClick={() => void copyText()}>
            텍스트 복사
          </button>
          <button type="button" className="btn" aria-expanded={menu} aria-controls="note-menu" onClick={() => setMenu(!menu)}>
            더 보기
          </button>
          {menu && (
            <ul id="note-menu" className="absolute right-0 top-12 z-30 w-60 rounded-md border border-rule bg-paper p-1 shadow-[0_8px_24px_rgba(30,42,63,0.12)]">
              <li className="sm:hidden">
                <button type="button" className="btn w-full justify-start border-0" onClick={() => void copyText()}>
                  텍스트 복사
                </button>
              </li>
              <li>
                <button type="button" className="btn w-full justify-start border-0" onClick={() => void copyUrl()}>
                  회사 분석 주소 복사
                </button>
              </li>
              <li>
                <button type="button" className="btn w-full justify-start border-0" onClick={doExport}>
                  파일로 내보내기
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="btn w-full justify-start border-0"
                  onClick={() => {
                    setMenu(false);
                    fileRef.current?.click();
                  }}
                >
                  파일에서 불러오기
                </button>
              </li>
            </ul>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="노트 파일 고르기"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const r = parseImport(await f.text(), c.cid);
              if (r.ok) {
                setImportErr(null);
                setImporting(r.data);
              } else setImportErr(r.message);
            }}
          />
        </div>
      </div>
      {importErr && (
        <p role="alert" className="no-print mt-3 font-medium text-amber">
          {importErr}
        </p>
      )}

      <article className="mt-6 max-w-[760px] rounded-sm border border-rule px-5 py-6 sm:px-10 sm:py-10 print:border-0 print:p-0" data-note>
        <header className="border-b-2 border-ink pb-3" data-part="head">
          <p className="text-2xl font-semibold">{job.company.name} 성장노트</p>
          <p className="num text-sm text-sub">
            {today} 작성, 회사 분석 {job.analyzedAt ? fmtTime(job.analyzedAt) : "진행 중"}
            {stale ? ", 오래된 분석" : ""}
          </p>
        </header>

        <section className="mt-6" data-part="values">
          <h2 className="text-base font-bold">회사 핵심 값</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {rows.map((r) => (
                // 휴대폰에서는 이름표를 값 위에 쌓아 값 열이 좁아지지 않게 한다(인쇄는 표 그대로)
                <tr key={r.label} className="border-b border-rule align-top max-sm:block max-sm:py-2 print:table-row">
                  <th scope="row" className="w-[8.5em] py-2 pr-3 text-left font-normal text-sub max-sm:block max-sm:w-auto max-sm:py-0 print:table-cell">
                    {r.label}
                  </th>
                  <td className="py-2 max-sm:block max-sm:py-0 print:table-cell">
                    {r.pending && <span className="text-sub">확인 중</span>}
                    {r.values.map((v, i) => (
                      <span key={i} className="block">
                        {v.word === "unavailable" ? (
                          <>
                            <StatusWord w="unavailable" /> <span className="font-medium">{v.text}</span>
                          </>
                        ) : (
                          <>
                            <span className="num font-medium">{v.text}</span> <StatusWord w={v.word} />
                          </>
                        )}
                        {v.source && <span className="block text-xs text-sub">{v.source}</span>}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {empty ? (
          <section className="mt-6" data-part="empty">
            <p>담은 항목이 없습니다. 자금 조달에서 공고, 운용사, 판로 기회를 담으면 노트에 모입니다.</p>
            <Link href={`/c/${c.cid}/funding`} className="link no-print">
              자금 조달로 가기
            </Link>
          </section>
        ) : (
          <>
            <section className="mt-6" data-part="programs">
              <h2 className="text-base font-bold">담은 자금 후보</h2>
              <NoteList items={progItems} />
            </section>
            <section className="mt-6" data-part="gps">
              <h2 className="text-base font-bold">운용사</h2>
              <NoteList items={gpItems} />
            </section>
            <section className="mt-6" data-part="sales">
              <h2 className="text-base font-bold">판로 후보</h2>
              <NoteList items={salesItems} />
            </section>
          </>
        )}

        <section className="mt-6" data-part="todo">
          <h2 className="text-base font-bold">다음 할 일</h2>
          <p className="mt-2 text-sm font-semibold">기관에 물을 질문</p>
          <NoteList items={askAgency} />
          <p className="mt-3 text-sm font-semibold">운용사에 물을 것</p>
          <NoteList items={askGp} />
          <p className="mt-3 text-sm font-semibold">준비할 자료</p>
          <NoteList items={docs} />
          {askMemo.length > 0 && (
            <>
              <p className="mt-3 text-sm font-semibold">투자 미팅 예상 질문 메모</p>
              <NoteList items={askMemo} />
            </>
          )}
        </section>

        <section className="mt-6" data-part="memo">
          <h2 className="text-base font-bold">
            <label htmlFor="note-memo">메모</label>
          </h2>
          <textarea
            id="note-memo"
            rows={5}
            value={memoText}
            onChange={(e) => onMemo(e.target.value)}
            maxLength={4000}
            className="no-print mt-2 block w-full rounded-md border border-edge p-3 text-base outline-none focus:border-ledger"
          />
          <p className="print-only whitespace-pre-wrap">{memoText || "없음"}</p>
          <p className="no-print mt-1 h-5 text-xs text-sub" aria-live="polite">
            {savedAt ? "저장됨" : ""}
          </p>
          {storage === "memory" && <p className="text-sm text-amber">이 브라우저에서는 메모를 저장할 수 없습니다. 텍스트 복사나 파일로 내보내기로 남겨 두세요.</p>}
        </section>

        <footer className="mt-8 border-t border-rule pt-3 text-xs text-sub" data-part="foot">
          <p>회사 분석에 쓴 Liner 호출 {liner}회</p>
          <p className="mt-1">{WORD_LEGEND}</p>
          <p className="print-only mt-1">점수나 선정 확률은 만들지 않습니다. 값마다 확인 상태와 출처를 붙입니다.</p>
        </footer>
      </article>

      <Dialog
        open={Boolean(importing)}
        title="파일에서 불러오기"
        onClose={() => setImporting(null)}
        actions={
          <>
            <button type="button" className="btn" data-autofocus onClick={() => setImporting(null)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                if (!importing) return;
                const { version: _v, companyId: _c, name: _n, exportedAt: _e, ...rest } = importing;
                void _v; void _c; void _n; void _e;
                try {
                  await replaceLocal(c.cid, rest);
                } catch {
                  // 레코드를 만들다 어긋나면 지우기 전에 멈춘다(지금 자료는 그대로)
                  setImporting(null);
                  setImportErr(NOT_EXPORT_FILE);
                  return;
                }
                setMemo(rest.notes?.memo ?? "");
                setImporting(null);
                toast("파일의 내용을 불러왔습니다.");
              }}
            >
              불러오기
            </button>
          </>
        }
      >
        <p>파일의 내용으로 이 회사의 고친 값, 담은 항목, 노트를 바꿀까요? 지금 브라우저에 있는 내용은 바뀝니다.</p>
      </Dialog>
    </main>
  );
}
