import { Suspense } from "react";
import { StartScreen } from "@/components/Start";

// 시작(/)과 회사 확정(/?name=). 주소의 이름은 브라우저에서 읽는다
export default function Home() {
  return (
    <Suspense fallback={null}>
      <StartScreen />
    </Suspense>
  );
}
