import type { Metadata } from "next";
import { AnalysisScreen } from "@/components/company/Analysis";

export const metadata: Metadata = { title: "회사 분석" };

export default function CompanyPage() {
  return <AnalysisScreen />;
}
