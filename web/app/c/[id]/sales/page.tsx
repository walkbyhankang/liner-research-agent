import type { Metadata } from "next";
import { SalesScreen } from "@/components/Sales";

export const metadata: Metadata = { title: "판로" };

export default function SalesPage() {
  return <SalesScreen />;
}
