import Link from "next/link";
import { Finder } from "@/components/Finder";

export default function Home() {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1 sm:mb-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-3xl">우리 회사가 신청할 수 있는 자금 찾기</h1>
          <p className="mt-1 hidden text-sm text-muted sm:block">흩어진 정책자금 공고와 벤처펀드를 한곳에서 조건과 대조합니다. 밑줄 친 부분만 바꿔 보세요.</p>
        </div>
        <Link href="/cases" className="hidden min-h-10 items-center text-sm font-semibold text-accent hover:underline sm:inline-flex">
          상담 준비 사례 보기 →
        </Link>
      </div>
      <Finder />
    </div>
  );
}
