import { Suspense } from "react";
import { CompanyShell } from "@/components/company/Shell";

// 회사 화면 틀. 분석 상태는 이 레이아웃에 남아, 단계를 옮겨도 분석이 계속 채워진다
export default function CompanyLayout({ children }: LayoutProps<"/c/[id]">) {
  return (
    <Suspense fallback={null}>
      <CompanyShell>{children}</CompanyShell>
    </Suspense>
  );
}
