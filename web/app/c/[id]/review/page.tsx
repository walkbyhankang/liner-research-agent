import type { Metadata } from "next";
import { Suspense } from "react";
import { ReviewScreen } from "@/components/review/Review";

export const metadata: Metadata = { title: "심사 준비" };

export default function ReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewScreen />
    </Suspense>
  );
}
