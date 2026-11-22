import type { Metadata } from "next";
import { Suspense } from "react";
import { BrowseFunding } from "@/components/funding/BrowseFunding";

export const metadata: Metadata = { title: "자금 둘러보기" };

export default function FundingPage() {
  return (
    <Suspense fallback={null}>
      <BrowseFunding />
    </Suspense>
  );
}
