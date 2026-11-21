import Link from "next/link";
import { scenarios } from "@/lib/data";
import { Card } from "@/components/ui";

const steps = [
  { n: "1", title: "회사와 목적", desc: "회사명, 자금 용도, 희망 금액, 조달 우선순위를 정합니다." },
  { n: "2", title: "근거 수집", desc: "공식 원문을 찾아 대상·용도·기간·투자 분야와 근거 문장을 뽑습니다." },
  { n: "3", title: "조달 경로 비교", desc: "빌리기와 투자받기 두 갈래로 후보를 대조하고 이유를 보여줍니다." },
  { n: "4", title: "상담 메모", desc: "고른 후보의 문의처, 첫 상담 질문, 준비자료를 한 장에 모읍니다." },
];

export default function CasesPage() {
  return (
    <div className="space-y-10">
      <section>
        <p className="text-sm font-semibold text-accent">사례로 체험</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">라이너의 세 시점</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          그때 내가 라이너의 자금조달 담당자였다면 누구를 만나고 무엇을 준비했을까요? 후보를 찾은 뒤 상담 메모까지 이어지는 과정을
          시점별로 체험합니다.
        </p>
        <p className="mt-3 max-w-2xl rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          사례 화면의 기업 수치와 투자사 명단은 원문 대조 전이고, “(가상)” 표시 항목은 화면 확인용 가상 데이터입니다.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {scenarios.map((s) => (
            <Link key={s.id} href={`/s/${s.id}`} className="group">
              <Card className="flex h-full flex-col p-5 transition-shadow group-hover:shadow-md">
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">{s.round}</span>
                  <span className="text-xs text-muted">{s.when}</span>
                </div>
                <h2 className="mt-4 text-lg font-bold leading-snug">{s.cardTitle}</h2>
                <p className="mt-1 text-sm text-muted">{s.cardQuestion}</p>
                <div className="mt-5 border-t border-line pt-3">
                  <p className="text-xs font-semibold text-muted">에이전트가 만드는 결과물</p>
                  <p className="mt-0.5 text-sm font-semibold">{s.deliverable}</p>
                </div>
                {s.id === "b" && (
                  <p className="mt-3 rounded-lg bg-equity-soft px-3 py-2 text-xs text-equity">추천 시연: “110억 원은 전부 투자금이었을까요?”</p>
                )}
                <span className="mt-auto pt-4 text-sm font-semibold text-accent">이 시점으로 검토하기 →</span>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold tracking-tight">진행 순서</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((st) => (
            <li key={st.n} className="rounded-xl border border-line bg-card p-4">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{st.n}</span>
              <p className="mt-3 font-semibold">{st.title}</p>
              <p className="mt-1 text-sm text-muted">{st.desc}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
