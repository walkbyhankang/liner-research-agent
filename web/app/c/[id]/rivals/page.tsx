import type { Metadata } from "next";
import { RivalsScreen } from "@/components/company/Rivals";

export const metadata: Metadata = { title: "경쟁사 분석" };

export default function RivalsPage() {
  return <RivalsScreen />;
}
