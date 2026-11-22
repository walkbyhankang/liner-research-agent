import type { Metadata } from "next";
import { Suspense } from "react";
import { CompanyFunding } from "@/components/funding/CompanyFunding";

export const metadata: Metadata = { title: "자금 조달" };

export default function CompanyFundingPage() {
  return (
    <Suspense fallback={null}>
      <CompanyFunding />
    </Suspense>
  );
}
