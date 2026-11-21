"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "자금 찾기", match: (p: string) => p === "/" },
  { href: "/cases", label: "사례로 체험", match: (p: string) => p.startsWith("/cases") || p.startsWith("/s/") },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-sm">
      {items.map((it) => {
        const active = it.match(pathname);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`inline-flex min-h-10 items-center whitespace-nowrap rounded-full px-3 transition-colors ${
              active ? "bg-ink text-white" : "text-muted hover:bg-line/60 hover:text-ink"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
