"use client";

// 노트(screens 8절): 상담·미팅 전에 한 장으로 정리해 인쇄하거나 나눈다. 노트는 내보내는 문서라 출처를 값 옆에 그대로 쓴다.
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { fmtMD, fmtTime, isStale } from "@/lib/format";
import { noticeCompany } from "@/lib/company-values";
import { replaceLocal, saveMemo, savedNotices, type SavedItem } from "@/lib/local";
import {
  capConditions, exportFile, exportName, linerTotal, NOT_CHECKED_TEXT, NOT_EXPORT_FILE, noteNotice, noteRows, noteText, noticeCountsText, noticeDue, noticeGroups, numberGroups, parseImport, WORD_LEGEND,
  type ExportFile, type NoteNotice, type NoteRow,
} from "@/lib/note";
import { noticeEnd, openValues } from "@/lib/review";
import { QUESTIONS } from "@/lib/prep";
import { onStorageChange, storageState } from "@/lib/store";
import { Dialog, StatusWord, VerdictMark, toast } from "@/components/kit";
import { useCompany } from "@/components/company/context";
import { usePublicData } from "@/components/funding/Board";

type Item = { key: string; node: ReactNode; text: string };

/** 날짜(2026-11-22, 2026-10)는 줄 끝에서 하이픈 뒤로 쪼개지지 않게 묶는다(꼬리표 옆 좁은 값 칸, 휴대폰). 글자는 그대로다 */
function KeepDates({ text }: { text: string }) {
  return text.split(/(\d{4}-\d{2}(?:-\d{2})?)/).map((p, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{p}</span> : p));
}

/**
 * 회사 정보(QA 주석21·22): 이름표 열과 값 열을 고정하고, 출처·기준일은 값 바로 아래 같은 왼쪽 끝에 둔다.
 * 엇갈림은 이름표 옆에 "엇갈림" 한 번 + 두 값(둘째는 "다른 자료"), 공식 자료와 웹 조사 칸은 값 앞 이름으로 가른다.
 * 미확보는 "미확보" + 사유. 화면과 인쇄가 같은 마크업이라 순서가 같다(휴대폰에서만 이름표를 값 위에 쌓는다).
 */
function CompanyInfo({ rows }: { rows: NoteRow[] }) {
  return (
    <dl className="mt-3 border-t border-rule text-sm">
      {rows.map((r) => (
        <div key={r.label} data-row className="grid break-inside-avoid items-start gap-x-5 gap-y-1 border-b border-rule py-2.5 sm:grid-cols-[10.5em_minmax(0,1fr)] print:grid-cols-[10.5em_minmax(0,1fr)] print:py-1">
          <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sub">
            {r.label}
            {r.conflict && <StatusWord w="conflicting" />}
          </dt>
          <dd className="min-w-0 space-y-1.5 print:space-y-0.5">
            {r.pending && <p className="text-sub">확인 중</p>}
            {r.values.map((v, i) => (
              // 꼬리표(공식 자료·웹 조사·다른 자료)가 붙은 값은 [꼬리표 | 값과 출처] 두 칸으로 놓는다. 출처 줄이 꼬리표 아래가 아니라
              // 값 글 왼쪽 끝에서 시작한다(screens 8절 "값 바로 아래 같은 왼쪽 끝", N-14). 꼬리표 없는 값은 한 칸 그대로
              <div key={i} className={v.tag ? "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2" : undefined}>
                {v.tag && <span className="meta min-w-[4.6em] font-semibold text-ink">{v.tag}</span>}
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    {v.word === "unavailable" ? (
                      <>
                        <StatusWord w="unavailable" /> <span>{v.text}</span>
                      </>
                    ) : (
                      <>
                        <span className="num font-medium"><KeepDates text={v.text} /></span> {/* "엇갈림"은 항목 이름 옆에 한 번만. 같은 줄의 따로 확인된 값(예: 공식 자료 업종)은 제 상태를 그대로 보인다 */}
                        {!(r.conflict && v.word === "conflicting") && <StatusWord w={v.word} />}
                      </>
                    )}
                  </p>
                  {v.source && (
                    <p data-src className="text-xs text-sub">
                      <KeepDates text={v.source} />
                    </p>
                  )}
                </div>
              </div>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 공고 하나(QA 주석23·4절): 제목·마감 → 판정 요약 → (들여 써서) 미충족·확인 필요 조건 → 근거 줄. 조건은 처음 5개, 넘으면 "외 n건" */
function NoticeBlock({ x }: { x: NoteNotice }) {
  const { shown, more } = capConditions(x.conditions, 5);
  return (
    <article data-note-notice={x.key} className="break-inside-avoid">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h4 className="min-w-0 font-semibold">{x.title}</h4>
        <span className="num text-sm text-sub">{x.agency ? `${x.agency}, ` : ""}<span className="whitespace-nowrap">{noticeDue(x.end)}</span></span>
      </div>
      <p className="text-sm">{x.counts ? `${noticeCountsText(x.counts)}.${x.reason ? ` ${x.reason}` : ""}` : NOT_CHECKED_TEXT}</p>
      {shown.length > 0 && (
        <div className="mt-2 space-y-1.5 pl-5 print:mt-1 print:space-y-0.5 print:pl-4" data-conditions>
          {shown.map((g) => (
            <div key={g.verdict}>
              <h5 className="leading-snug">
                <VerdictMark v={g.verdict} count={g.total} />
              </h5>
              <ul className="list-disc pl-5 text-sm">
                {g.items.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          ))}
          {more > 0 && <p className="text-sm text-sub">외 {more}건</p>}
        </div>
      )}
      {x.basis && <p className="mt-1.5 text-xs text-sub">{x.basis}</p>}
    </article>
  );
}

/** 담은 자금 후보: 공고 전체 상태로 묶는다. 화면은 처음 5건 + "{n}개 더 보기", 인쇄는 10건까지 + "외 {n}개"(PR-02). 화면과 인쇄가 같은 마크업 */
function NoticeGroups({ notices }: { notices: NoteNotice[] }) {
  const [all, setAll] = useState(false);
  if (!notices.length) return <p className="text-sub">없음</p>;
  const placed = numberGroups(noticeGroups(notices));
  const vis = (i: number) => `${!all && i >= 5 ? "hidden print:block" : ""} ${i >= 10 ? "print:hidden" : ""}`;
  return (
    <>
      {placed.map((g) => (
        <div key={g.state} data-notice-group={g.state} className={`mt-4 border-t border-rule pt-3 print:mt-2 print:pt-1.5 ${vis(g.items[0].i)}`}>
          <h3 className="break-after-avoid text-lg font-semibold">
            {g.state} <span className="num font-normal text-sub">{g.items.length}건</span>
          </h3>
          <ul className="mt-2 space-y-4 print:mt-1 print:space-y-2">
            {g.items.map(({ x, i }) => (
              <li key={x.key} className={vis(i)}>
                <NoticeBlock x={x} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!all && notices.length > 5 && (
        <button type="button" className="btn no-print mt-3" onClick={() => setAll(true)}>
          {notices.length - 5}개 더 보기
        </button>
      )}
      {notices.length > 10 && <p className="print-only mt-1">외 {notices.length - 10}개</p>}
    </>
  );
}

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
  // 자격 대조 대상 공고: 자금 공고(program)와 판로 갈래에서 담은 지원사업(salesProgram)을 공고 id 하나로(savedNotices, 심사 준비와 같은 셈).
  // 판로 탭에서 담아 대조한 지원사업도 판정·조건·근거가 노트에 나온다. 그래서 판로 후보에는 입찰공고만 남겨 같은 공고가 두 번 나오지 않게 한다
  const progs = savedNotices(saved);
  const gps = saved.filter((s) => s.kind === "gp");
  const sales = saved.filter((s) => s.kind === "bid");
  // 마감일은 회사 분석 "확인이 필요한 정보"·심사 준비와 같은 기준(지금 공고 자료 먼저, 없으면 담을 때 저장값)
  const endOf = (s: SavedItem) => noticeEnd(s, data?.programs);
  // 대조한 뒤 회사 값이 바뀌었는지 보려고 지금 회사 값을 만든다(심사 준비 카드의 "이전 회사 값으로 한 대조"와 같은 견줌)
  const current = noticeCompany(job, c.local.edits);
  const notices: NoteNotice[] = progs.map((s) => noteNotice(s, c.local.checks[s.itemId], endOf(s), current));
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
    const end = s.kind === "bid" ? (typeof s.meta.deadline === "string" ? s.meta.deadline : null) : endOf(s);
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
    notices, gps: gpItems.map((i) => i.text), sales: salesItems.map((i) => i.text),
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
      {/* 쪽 아래 글과, 이 문서의 인쇄 제목 단계(globals.css 노트 인쇄 규칙 위에 덧씀: 구역 14 > 상태 묶음 13 > 공고 12 > 본문 11.5).
          제목은 내용과 떨어지지 않게(break-after), 공고 하나·회사 정보 한 줄은 쪽에서 쪼개지지 않게(break-inside) 둔다 */}
      <style>{`@media print { @page { @bottom-center { content: "${footer}, " counter(page) "/" counter(pages); font-size: 9pt; color: #586377; } }
  [data-note] [data-part] > h2 { font-size: 14px !important; line-height: 1.3 !important; }
  [data-note] h3 { font-size: 13px !important; line-height: 1.35 !important; }
  [data-note] h4 { font-size: 12px !important; line-height: 1.4 !important; }
  [data-note] h5 > span { font-size: 11.5px !important; }
  [data-note] :is(h2, h3, h4, h5) { break-after: avoid; }
  [data-note] [data-note-notice], [data-note] [data-row] { break-inside: avoid; } }`}</style>
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
        {/* 위계(QA 주석22): 문서 제목·기준일 → 회사 정보 → 담은 자금 후보. 큰 구역 사이는 여백 40, 제목과 내용은 8~12 */}
        <header className="border-b-2 border-ink pb-4" data-part="head">
          <p className="text-2xl font-semibold">{job.company.name} 성장노트</p>
          <p className="num mt-1 text-sm text-sub">
            {today} 작성, 회사 분석 {job.analyzedAt ? `${fmtTime(job.analyzedAt)} 기준` : "진행 중"}
            {stale ? ", 오래된 분석" : ""}
          </p>
        </header>

        <section className="mt-8" data-part="values">
          <h2 className="break-after-avoid text-xl font-semibold">회사 정보</h2>
          <CompanyInfo rows={rows} />
        </section>

        {empty ? (
          <section className="mt-10" data-part="empty">
            <p>담은 항목이 없습니다. 자금·판로에서 공고, 운용사, 판로 기회를 담으면 노트에 모입니다.</p>
            <Link href={`/c/${c.cid}/funding`} className="link no-print">
              자금·판로로 가기
            </Link>
          </section>
        ) : (
          <>
            <section className="mt-10" data-part="programs">
              <h2 className="break-after-avoid text-xl font-semibold">
                담은 자금 후보 <span className="num font-normal text-sub">{notices.length}건</span>
              </h2>
              <NoticeGroups notices={notices} />
            </section>
            <section className="mt-10" data-part="gps">
              <h2 className="break-after-avoid text-xl font-semibold">운용사</h2>
              <div className="mt-2">
                <NoteList items={gpItems} />
              </div>
            </section>
            <section className="mt-10" data-part="sales">
              <h2 className="break-after-avoid text-xl font-semibold">판로 후보</h2>
              <div className="mt-2">
                <NoteList items={salesItems} />
              </div>
            </section>
          </>
        )}

        <section className="mt-10" data-part="todo">
          <h2 className="break-after-avoid text-xl font-semibold">다음 할 일</h2>
          <p className="mt-3 break-after-avoid font-semibold">기관에 물을 질문</p>
          <NoteList items={askAgency} />
          <p className="mt-4 break-after-avoid font-semibold">운용사에 물을 것</p>
          <NoteList items={askGp} />
          <p className="mt-4 break-after-avoid font-semibold">준비할 자료</p>
          <NoteList items={docs} />
          {askMemo.length > 0 && (
            <>
              <p className="mt-4 break-after-avoid font-semibold">투자 미팅 예상 질문 메모</p>
              <NoteList items={askMemo} />
            </>
          )}
        </section>

        <section className="mt-10" data-part="memo">
          <h2 className="text-xl font-semibold">
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
