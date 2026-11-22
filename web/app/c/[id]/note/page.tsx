import type { Metadata } from "next";
import { NoteScreen } from "@/components/Note";

export const metadata: Metadata = { title: "노트" };

export default function NotePage() {
  return <NoteScreen />;
}
