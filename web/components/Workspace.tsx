"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { researchSteps, scenarios, type Candidate, type Lane, type Scenario } from "@/lib/data";
import { Card, SectionTitle, StatusBadge, Tag, VerdictBadge, laneBar, laneColor, laneDesc, laneName, laneSoft } from "@/components/ui";

const tabs = [
  { id: "situation", label: "① 상황" },
  { id: "compare", label: "② 조달 경로" },
  { id: "research", label: "③ 조사 과정" },
  { id: "memo", label: "④ 상담 메모" },
  { id: "actual", label: "⑤ 실제 결과" },
] as const;
type TabId = (typeof tabs)[number]["id"];

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
function useHashTab(): [TabId, (t: TabId) => void] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  const tab = tabs.some((t) => t.id === hash) ? (hash as TabId) : "situation";
  const setTab = (t: TabId) => {
    window.location.hash = t;
    window.scrollTo({ top: 0 });
  };
  return [tab, setTab];
}

export function Workspace({ scenario }: { scenario: Scenario }) {
  const [tab, setTab] = useHashTab();
  const [pi, setPi] = useState<0 | 1>(0);
  const [saved, setSaved] = useState<string[]>([]);
  const priority = scenario.priorities[pi];
  const toggleSave = (id: string) => setSaved((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const savedCandidates = scenario.candidates.filter((c) => saved.includes(c.id));

  return (
    <div>
      <div className="no-print flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">시점 선택</span>
        {scenarios.map((s) => (
          <Link
            key={s.id}
            href={`/s/${s.id}`}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              s.id === scenario.id ? "border-accent bg-accent text-white" : "border-line bg-card text-muted hover:text-ink"
            }`}
          >
            {s.round} · {s.when.slice(0, 4)}
          </Link>
        ))}
      </div>

      <div className="mt-4">
        <p className="text-sm text-muted">
          라이너 · {s_label(scenario)}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{scenario.cardTitle}</h1>
      </div>

      <div className="no-print mt-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold ${
              tab === t.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.id === "memo" && saved.length > 0 && (
              <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-white">{saved.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "situation" && <Situation scenario={scenario} onNext={() => setTab("compare")} />}
        {tab === "compare" && (
          <Compare scenario={scenario} pi={pi} setPi={setPi} saved={saved} toggleSave={toggleSave} onMemo={() => setTab("memo")} />
        )}
        {tab === "research" && <Research />}
        {tab === "memo" && (
          <Memo scenario={scenario} pi={pi} candidates={savedCandidates} priorityLabel={priority.label} onPick={() => setTab("compare")} />
        )}
        {tab === "actual" && <Actual scenario={scenario} />}
      </div>
    </div>
  );
}

const s_label = (s: Scenario) => `${s.round} 직전 · ${s.when}`;

/* ① 상황 */
function Situation({ scenario, onNext }: { scenario: Scenario; onNext: () => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card className="p-6">
          <p className="text-xs font-semibold text-accent">창업자가 에이전트에 묻는 질문</p>
          <p className="mt-2 text-xl font-bold leading-snug">“{scenario.founderQuestion}”</p>
        </Card>
        <Card className="p-6">
          <SectionTitle title="당시 회사 상태" desc="공개자료에서 가져온 값입니다. 값마다 출처와 확인 상태를 붙입니다." />
          <dl className="divide-y divide-line">
            {scenario.company.map((f) => (
              <div key={f.label} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="text-sm text-muted">{f.label}</dt>
                <dd>
                  <p className="text-sm font-medium">{f.value}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <StatusBadge status={f.status} />
                    <span>출처: {f.source}</span>
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <div className="space-y-6 lg:col-span-2">
        <Card className="p-6">
          <SectionTitle title="당시 시장 상황" />
          <ul className="space-y-3 text-sm">
            {scenario.market.map((m) => (
              <li key={m} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="border-dashed p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-bold">이번 검토의 가정</h3>
            <StatusBadge status="시연 가정" />
          </div>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 text-muted">용도</dt>
              <dd className="font-medium">{scenario.assumption.purpose}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 text-muted">금액</dt>
              <dd className="font-medium">{scenario.assumption.amount}</dd>
            </div>
          </dl>
        </Card>
        <Card className="bg-accent-soft p-6">
          <p className="text-xs font-semibold text-accent">에이전트가 만드는 결과물</p>
          <p className="mt-1 text-lg font-bold">{scenario.deliverable}</p>
          <p className="mt-2 text-sm text-ink/80">{scenario.deliverableDesc}</p>
          <button onClick={onNext} className="no-print mt-4 w-full rounded-lg bg-ink px-4 py-3 text-sm font-semibold text-white hover:bg-ink/85">
            조달 경로 찾기 →
          </button>
        </Card>
      </div>
    </div>
  );
}

/* ② 조달 경로 */
function Compare({
  scenario, pi, setPi, saved, toggleSave, onMemo,
}: {
  scenario: Scenario; pi: 0 | 1; setPi: (p: 0 | 1) => void; saved: string[]; toggleSave: (id: string) => void; onMemo: () => void;
}) {
  const priority = scenario.priorities[pi];
  const lanes: Lane[] = priority.first === "debt" ? ["debt", "equity"] : ["equity", "debt"];
  return (
    <div>
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-muted">조달 우선순위</p>
            <p className="mt-0.5 text-sm text-muted">우선순위를 바꾸면 레인 순서와 첫 상담 질문이 함께 바뀝니다.</p>
          </div>
          <div className="inline-flex rounded-lg border border-line bg-paper p-1">
            {scenario.priorities.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setPi(i as 0 | 1)}
                aria-pressed={pi === i}
                className={`rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                  pi === i ? "bg-ink text-white shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-sm">
          <span className="font-semibold">{priority.label}</span> — {priority.hint}
        </p>
      </Card>

      <div key={priority.id} className="rise mt-6 grid gap-6 lg:grid-cols-2">
        {lanes.map((lane, idx) => (
          <LaneColumn key={lane} lane={lane} first={idx === 0} scenario={scenario} pi={pi} saved={saved} toggleSave={toggleSave} />
        ))}
      </div>

      {saved.length > 0 && (
        <div className="no-print sticky bottom-4 mt-6 flex items-center justify-between gap-3 rounded-xl border border-ink/10 bg-ink px-4 py-3 text-white shadow-lg">
          <p className="text-sm">후보 {saved.length}곳을 담았습니다.</p>
          <button onClick={onMemo} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink">
            상담 메모 만들기 →
          </button>
        </div>
      )}
    </div>
  );
}

const verdictOrder = { match: 0, check: 1, excluded: 2 } as const;

function LaneColumn({
  lane, first, scenario, pi, saved, toggleSave,
}: {
  lane: Lane; first: boolean; scenario: Scenario; pi: 0 | 1; saved: string[]; toggleSave: (id: string) => void;
}) {
  const all = scenario.candidates
    .filter((c) => c.lane === lane)
    .sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict] || a.rank[pi] - b.rank[pi]);
  const active = all.filter((c) => c.verdict !== "excluded");
  const excluded = all.filter((c) => c.verdict === "excluded");
  return (
    <div>
      <div className={`flex items-center justify-between rounded-t-xl px-4 py-3 ${laneSoft[lane]}`}>
        <div>
          <h3 className={`text-lg font-bold ${laneColor[lane]}`}>{laneName[lane]}</h3>
          <p className="text-xs text-muted">{laneDesc[lane]}</p>
        </div>
        {first && <span className="rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-white">먼저 볼 경로</span>}
      </div>
      <div className={`h-1 ${laneBar[lane]}`} />
      <div className="mt-3 space-y-3">
        {active.map((c) => (
          <CandidateCard key={c.id} c={c} pi={pi} saved={saved.includes(c.id)} toggleSave={() => toggleSave(c.id)} />
        ))}
        {excluded.length > 0 && (
          <div className="rounded-xl border border-dashed border-line p-4">
            <p className="text-xs font-semibold text-muted">제외한 후보 {excluded.length}건</p>
            <ul className="mt-2 space-y-2">
              {excluded.map((c) => (
                <li key={c.id} className="text-sm">
                  <span className="font-semibold text-muted line-through decoration-muted/50">{c.name}</span>
                  <span className="ml-1 text-xs text-muted">· {c.provider}</span>
                  <p className="mt-0.5 text-xs text-warn">{c.excludedWhy}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({ c, pi, saved, toggleSave }: { c: Candidate; pi: 0 | 1; saved: boolean; toggleSave: () => void }) {
  const q = c.questions[pi][0] ?? c.questions[0][0];
  return (
    <Card className={`p-4 ${saved ? "ring-2 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>{c.kind}</Tag>
        {c.relation === "existing" && <Tag className="border-equity/30 text-equity">기존 관계</Tag>}
        {c.relation === "new" && <Tag>신규 후보</Tag>}
        {c.sample && <Tag className="border-dashed">가상 데이터</Tag>}
        <span className="ml-auto">
          <VerdictBadge verdict={c.verdict} />
        </span>
      </div>
      <h4 className="mt-2 font-bold leading-snug">{c.name}</h4>
      <p className="text-xs text-muted">{c.provider}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-accent">맞는 이유</p>
          <ul className="mt-1 space-y-1 text-sm">
            {c.reasons.map((r) => (
              <li key={r} className="flex gap-1.5">
                <span className="text-accent">✓</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold text-debt">추가로 확인할 점</p>
          <ul className="mt-1 space-y-1 text-sm">
            {c.checks.map((r) => (
              <li key={r} className="flex gap-1.5">
                <span className="text-debt">?</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {q && (
        <div className="mt-3 rounded-lg bg-paper px-3 py-2">
          <p className="text-xs font-semibold text-muted">첫 상담 질문</p>
          <p className="mt-0.5 text-sm">“{q}”</p>
        </div>
      )}

      <div className="no-print mt-3 flex items-center justify-between gap-2">
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">근거 보기</summary>
          <p className="mt-1">POC 단계: 원문 인용과 확인일은 실제 조사 연결 후 표시됩니다.</p>
        </details>
        <button
          onClick={toggleSave}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
            saved ? "bg-accent text-white" : "border border-ink/20 bg-card hover:border-ink/50"
          }`}
        >
          {saved ? "담음 ✓" : "상담 메모에 담기"}
        </button>
      </div>
    </Card>
  );
}

/* ③ 조사 과정 */
const engineStyle = {
  search: "bg-equity-soft text-equity",
  model: "bg-accent-soft text-accent",
  fetch: "bg-line/70 text-ink",
  public: "bg-debt-soft text-debt",
  rule: "bg-paper text-ink border border-line",
} as const;

function Research() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <SectionTitle
          title="에이전트가 조사한 순서"
          desc="어떤 도구가 어떤 자료를 가져왔고, 그 자료가 어느 판단에 쓰였는지 보여줍니다."
        />
        <ol className="space-y-3">
          {researchSteps.map((st, i) => (
            <li key={st.title} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span>
                {i < researchSteps.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
              </div>
              <Card className="mb-1 flex-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-bold">{st.title}</h4>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${engineStyle[st.engine]}`}>{st.tool}</span>
                </div>
                <p className="mt-2 text-sm">
                  <span className="text-muted">가져오는 것 </span>
                  {st.output}
                </p>
                <p className="mt-1 text-sm">
                  <span className="text-muted">쓰이는 판단 </span>
                  {st.usedFor}
                </p>
              </Card>
            </li>
          ))}
        </ol>
      </div>
      <div className="space-y-4">
        <Card className="p-5">
          <h3 className="font-bold">Liner API 역할 분담</h3>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="font-semibold text-equity">Liner Search API</dt>
              <dd className="text-muted">공식 원문과 보도를 찾는 검색. 모델에는 내장 웹 검색이 없어 이 API가 유일한 검색 경로입니다.</dd>
            </div>
            <div>
              <dt className="font-semibold text-accent">Liner Gateway(Model API)</dt>
              <dd className="text-muted">Claude 등 프런티어 모델을 직접 지정해 역할 분류, 조건 추출, 상담 질문 작성에 씁니다.</dd>
            </div>
            <div>
              <dt className="font-semibold text-debt">공공 API</dt>
              <dd className="text-muted">기업마당 지원사업정보, 한국벤처투자 펀드현황.</dd>
            </div>
          </dl>
        </Card>
        <Card className="border-dashed p-5">
          <p className="text-sm text-muted">
            POC 단계에서는 설계된 흐름만 보여줍니다. 실제 호출 수, 소요 시간, 비용, 출처 목록은 API 연결 후 이 자리에 표시됩니다.
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ④ 상담 메모 */
// 복사본과 인쇄물에도 남아야 하는 고지. 화면 상단 경고 띠는 인쇄에서 숨겨지므로 메모 본문에 넣는다.
const MEMO_NOTICE =
  "POC 예시 메모입니다. 용도·금액·우선순위는 시연 가정이고, 기관·상품 조건과 맞는 이유는 원문 대조 전이며, “(가상)” 항목은 가상 데이터입니다. 실제 상담 근거로 쓰지 마세요.";
function Memo({
  scenario, pi, candidates, priorityLabel, onPick,
}: {
  scenario: Scenario; pi: 0 | 1; candidates: Candidate[]; priorityLabel: string; onPick: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (candidates.length === 0) {
    return (
      <Card className="p-10 text-center">
        <p className="text-lg font-bold">아직 담은 후보가 없습니다</p>
        <p className="mt-1 text-sm text-muted">조달 경로에서 상담할 후보 2~3곳을 담으면 메모가 만들어집니다.</p>
        <button onClick={onPick} className="mt-5 rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white">
          조달 경로에서 고르기
        </button>
      </Card>
    );
  }
  const qs = (c: Candidate) => (c.questions[pi].length ? c.questions[pi] : c.questions[0]);
  const markdown = [
    `# 자금조달 상담 메모 — 라이너 (${scenario.round}, ${scenario.when})`,
    ``,
    `> ${MEMO_NOTICE}`,
    ``,
    `- 자금 용도(시연 가정): ${scenario.assumption.purpose}`,
    `- 희망 금액(시연 가정): ${scenario.assumption.amount}`,
    `- 우선순위(시연 가정): ${priorityLabel}`,
    ``,
    ...candidates.flatMap((c, i) => [
      `## ${i + 1}. ${c.name} (${c.provider})`,
      `- 구분: ${laneName[c.lane]} · ${c.kind}`,
      `- 데이터 상태: ${c.sample ? "가상 데이터(화면 확인용)" : "원문 대조 전"}`,
      `- 왜 이곳인가: ${c.reasons.join(" / ")}`,
      `- 확인할 점: ${c.checks.join(" / ")}`,
      `- 첫 상담 질문:`,
      ...qs(c).map((q) => `  - ${q}`),
      `- 준비자료: ${c.documents.join(", ")}`,
      `- 문의 경로: ${c.contact}`,
      ``,
    ]),
  ].join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center justify-end gap-2">
        <button onClick={copy} className="rounded-lg border border-ink/20 bg-card px-3 py-2 text-sm font-semibold hover:border-ink/50">
          {copied ? "복사됨 ✓" : "Markdown 복사"}
        </button>
        <button onClick={() => window.print()} className="rounded-lg bg-ink px-3 py-2 text-sm font-semibold text-white">
          인쇄 · PDF 저장
        </button>
      </div>
      <article className="mx-auto max-w-3xl rounded-xl border border-line bg-card p-6 sm:p-10">
        <header className="border-b-2 border-ink pb-4">
          <p className="text-xs font-semibold text-accent">자금조달 상담 메모</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">
            라이너 · {scenario.round} ({scenario.when})
          </h2>
          <p className="mt-3 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">{MEMO_NOTICE}</p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">자금 용도 (시연 가정)</dt>
              <dd className="font-medium">{scenario.assumption.purpose}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">희망 금액 (시연 가정)</dt>
              <dd className="font-medium">{scenario.assumption.amount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">우선순위 (시연 가정)</dt>
              <dd className="font-medium">{priorityLabel}</dd>
            </div>
          </dl>
        </header>
        {candidates.map((c, i) => (
          <section key={c.id} className="border-b border-line py-6 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${laneSoft[c.lane]} ${laneColor[c.lane]}`}>
                {laneName[c.lane]} · {c.kind}
              </span>
              <Tag className="border-dashed">{c.sample ? "가상 데이터" : "원문 대조 전"}</Tag>
            </div>
            <h3 className="mt-2 text-lg font-bold">
              {i + 1}. {c.name}
            </h3>
            <p className="text-sm text-muted">{c.provider}</p>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-accent">왜 이곳인가</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                  {c.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs font-semibold text-debt">상담 전에 확인할 점</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                  {c.checks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold">첫 상담에서 물을 질문</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm">
                  {qs(c).map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ol>
                <p className="mt-3 text-xs font-semibold">준비자료</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {c.documents.map((d) => (
                    <li key={d} className="flex gap-2">
                      <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-ink/40" />
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-4 rounded-lg bg-paper px-3 py-2 text-xs text-muted">문의 경로 · {c.contact}</p>
          </section>
        ))}
      </article>
    </div>
  );
}

/* ⑤ 실제 결과 */
const roleStyle: Record<string, string> = {
  "투자 주도": "bg-equity text-white",
  "투자 참여": "bg-equity-soft text-equity",
  "후속 투자": "bg-equity-soft text-equity",
  "보증부 대출": "bg-debt-soft text-debt",
};

function Actual({ scenario }: { scenario: Scenario }) {
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const quiz = scenario.quiz;
  const revealed = quiz ? pick !== null : open;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {quiz ? (
        <Card className="p-6">
          <p className="text-xs font-semibold text-accent">먼저 맞혀 보세요</p>
          <p className="mt-2 text-xl font-bold">{quiz.question}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {quiz.options.map((o) => {
              const chosen = pick === o;
              const correct = o === quiz.answer;
              return (
                <button
                  key={o}
                  onClick={() => setPick(o)}
                  className={`rounded-lg border px-3 py-3 text-sm font-semibold ${
                    pick === null
                      ? "border-ink/20 bg-card hover:border-ink/50"
                      : correct
                        ? "border-accent bg-accent-soft text-accent"
                        : chosen
                          ? "border-warn/40 bg-warn-soft text-warn"
                          : "border-line bg-card text-muted"
                  }`}
                >
                  {o}
                </button>
              );
            })}
          </div>
        </Card>
      ) : (
        !open && (
          <Card className="p-8 text-center">
            <p className="text-lg font-bold">당시 상황으로 먼저 검토해 보셨나요?</p>
            <p className="mt-1 text-sm text-muted">실제 조달 결과는 검토를 마친 뒤에 열어 비교합니다.</p>
            <button onClick={() => setOpen(true)} className="mt-5 rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white">
              실제 조달 결과 열기
            </button>
          </Card>
        )
      )}

      {revealed && (
        <div className="rise space-y-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-muted">
                  실제 조달 결과 · {scenario.round} ({scenario.when})
                </p>
                <p className="mt-1 text-2xl font-bold">{scenario.actual.headline}</p>
              </div>
              <StatusBadge status="대조 전" />
            </div>
            <ul className="mt-5 divide-y divide-line">
              {scenario.actual.parties.map((p) => (
                <li key={p.name} className="flex flex-wrap items-center gap-3 py-3">
                  <span className={`w-24 shrink-0 rounded-full px-2 py-1 text-center text-xs font-semibold ${roleStyle[p.role]}`}>{p.role}</span>
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-sm text-muted">{p.note}</span>
                </li>
              ))}
            </ul>
          </Card>
          <div className="grid gap-6 sm:grid-cols-2">
            <Card className="p-6">
              <h3 className="font-bold">공개자료에서 확인되지 않는 것</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {scenario.actual.undisclosed.map((u) => (
                  <li key={u} className="flex items-center gap-2">
                    <StatusBadge status="미공개" />
                    {u}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">확인되지 않는 값은 추정하지 않고 미공개로 둡니다.</p>
            </Card>
            <Card className="p-6">
              <h3 className="font-bold">에이전트가 지키는 판단 규칙</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {scenario.actual.cautions.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="text-accent">✓</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
