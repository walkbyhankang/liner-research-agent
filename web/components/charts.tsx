"use client";

// 차트 4종(설계 3.8, design-brief 6절). 새 라이브러리 없이 작은 SVG 로 그린다.
// 값은 막대·점 옆에 직접 쓰고(마우스 올리기에 두지 않는다), 흑백 인쇄에서도 칠과 빗금으로 구분된다.
// 같은 숫자는 2층 표에 있고, 차트마다 숫자를 담은 요약 문장을 화면 읽기 이름으로 단다.
import { useId } from "react";
import { eok, moneyText, num, shortCompany, wrapSvgText } from "@/lib/format";

const W = 300;
const INK = "var(--color-ink)";
const SUB = "var(--color-sub)";
const RULE = "var(--color-rule)";

function Hatch({ id, color = INK }: { id: string; color?: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill="var(--color-paper)" />
      <line x1="0" y1="0" x2="0" y2="5" stroke={color} strokeWidth="2" />
    </pattern>
  );
}

// ---------------------------------------------------------------- 재무 막대

export type FinanceRow = { year: string; revenue: number | null; operatingIncome: number | null };

/** 최근 사업연도 매출(칠)과 영업이익(빗금). 음수는 기준선 아래. 없는 연도는 0 막대가 아니라 "자료 없음" */
export function FinanceBars({ rows, small = false, label }: { rows: FinanceRow[]; small?: boolean; label?: string }) {
  const hid = useId().replace(/:/g, "");
  const vals = rows.flatMap((r) => [r.revenue, r.operatingIncome]).filter((v): v is number => v !== null);
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  // 음수 막대의 값 글은 막대 밑에 붙는다. 가장 낮은 막대 밑에도 글 한 줄 자리를 남겨 연도 글과 겹치지 않게 한다
  const negRoom = min < 0 ? 16 : 0;
  const H = (small ? 140 : 180) + negRoom;
  const top = 34;
  const bottom = H - 24 - negRoom;
  const span = max - min || 1;
  const y = (v: number) => top + ((max - v) / span) * (bottom - top);
  const base = y(0);
  const band = (W - 20) / Math.max(rows.length, 1);
  const bw = Math.min(30, band / 3);
  const summary = `${label ?? "매출과 영업이익"}: ${rows
    .map((r) => `${r.year} 사업연도 매출 ${r.revenue === null ? "자료 없음" : `${eok(r.revenue)}억원`}, 영업이익 ${r.operatingIncome === null ? "자료 없음" : `${eok(r.operatingIncome)}억원`}`)
    .join("; ")}`;
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible">
      <defs>
        <Hatch id={hid} />
      </defs>
      <g fontSize="12" fill={SUB}>
        <rect x="0" y="4" width="10" height="10" fill={INK} />
        <text x="14" y="13" fill={INK}>매출</text>
        <rect x="52" y="4" width="10" height="10" fill={`url(#${hid})`} stroke={INK} strokeWidth="1" />
        <text x="66" y="13" fill={INK}>영업이익</text>
        <text x={W} y="13" textAnchor="end">(단위: 억원)</text>
      </g>
      <line x1="0" x2={W} y1={base} y2={base} stroke={SUB} strokeWidth="1" />
      {rows.map((r, i) => {
        const cx = 10 + band * i + band / 2;
        const bars = [
          { v: r.revenue, x: cx - bw - 2, fill: INK },
          { v: r.operatingIncome, x: cx + 2, fill: `url(#${hid})` },
        ];
        return (
          <g key={r.year}>
            {bars.map((b, j) =>
              b.v === null ? (
                <text key={j} x={b.x + bw / 2} y={base - 6} fontSize="12" textAnchor="middle" fill={SUB}>
                  자료 없음
                </text>
              ) : (
                <g key={j}>
                  <rect x={b.x} width={bw} y={Math.min(y(b.v), base)} height={Math.max(1, Math.abs(y(b.v) - base))} fill={b.fill} stroke={j ? INK : "none"} strokeWidth="1" />
                  <text x={b.x + bw / 2} y={b.v >= 0 ? y(b.v) - 4 : y(b.v) + 13} fontSize="12" textAnchor="middle" fill={INK} className="num">
                    {eok(b.v)}
                  </text>
                </g>
              ),
            )}
            <text x={cx} y={H - 6} fontSize="12" textAnchor="middle" fill={SUB}>
              {r.year}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- 국민연금 선

export type NpsPoint = { month: string; members: number | null };

/** 12개월 가입자 수. 세로축이 0에서 시작하지 않으면 그 사실을 아래에 쓴다 */
export function NpsLine({ points, small = false }: { points: NpsPoint[]; small?: boolean }) {
  const H = small ? 130 : 170;
  const pts = points.filter((p): p is { month: string; members: number } => p.members !== null);
  const top = 22;
  const bottom = H - 40;
  const vs = pts.map((p) => p.members);
  const hi = Math.max(...vs, 1);
  const loRaw = Math.min(...vs, hi);
  const pad = Math.max(1, Math.round((hi - loRaw) * 0.15));
  const lo = Math.max(0, loRaw - pad);
  const span = hi + pad - lo || 1;
  const x = (i: number) => 12 + (i * (W - 40)) / Math.max(points.length - 1, 1);
  const y = (v: number) => top + ((hi + pad - v) / span) * (bottom - top);
  const idx = (m: string) => points.findIndex((p) => p.month === m);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(idx(p.month)).toFixed(1)} ${y(p.members).toFixed(1)}`).join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const summary = pts.length ? `국민연금 가입자 수: ${first.month} ${num(first.members)}명에서 ${last.month} ${num(last.members)}명` : "국민연금 가입자 자료 없음";
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible">
      <line x1="0" x2={W} y1={bottom} y2={bottom} stroke={RULE} />
      {pts.length > 0 && (
        <>
          <path d={d} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          {pts.map((p) => (
            <circle key={p.month} cx={x(idx(p.month))} cy={y(p.members)} r="2.4" fill={INK} />
          ))}
          {/* 값 이름이 선과 겹쳐도 읽히게 흰 테두리를 두른다 */}
          <text x={x(idx(first.month))} y={y(first.members) - 8} fontSize="12" fill={INK} stroke="#fff" strokeWidth="4" paintOrder="stroke" strokeLinejoin="round" className="num">
            {num(first.members)}명
          </text>
          <text x={x(idx(last.month))} y={y(last.members) - 8} fontSize="12" fill={INK} stroke="#fff" strokeWidth="4" paintOrder="stroke" strokeLinejoin="round" textAnchor="end" fontWeight="600" className="num">
            {num(last.members)}명
          </text>
          <text x={x(0)} y={bottom + 16} fontSize="12" fill={SUB}>{points[0].month}</text>
          <text x={x(points.length - 1)} y={bottom + 16} fontSize="12" fill={SUB} textAnchor="end">{points[points.length - 1].month}</text>
          {lo > 0 && (
            <text x="0" y={H - 4} fontSize="12" fill={SUB}>
              세로축은 {num(lo)}명부터
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- 특허 연도 선

export type PatentSeries = { name: string; byYear: Record<string, number>; mine: boolean };

/** 최근 5년 출원연도. 최근 2년은 공개 전 기간이라 빗금 띠. 여러 회사면 우리 회사만 잉크, 이름은 선 끝에 */
export function PatentLine({ series, endYear, small = false }: { series: PatentSeries[]; endYear: number; small?: boolean }) {
  const hid = useId().replace(/:/g, "");
  const H = small ? 140 : 170;
  const years = [endYear - 4, endYear - 3, endYear - 2, endYear - 1, endYear].map(String);
  const many = series.length > 1;
  const right = many ? 70 : 14;
  const top = 18;
  const bottom = H - 26;
  const hi = Math.max(1, ...series.flatMap((s) => years.map((y) => s.byYear[y] ?? 0)));
  const x = (i: number) => 14 + (i * (W - 14 - right)) / 4;
  const y = (v: number) => top + ((hi - v) / hi) * (bottom - top);
  const summary = series.map((s) => `${s.name} 출원연도별 특허: ${years.map((y) => `${y}년 ${s.byYear[y] ?? 0}건`).join(", ")}`).join("; ");
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible">
      <defs>
        <Hatch id={hid} color="var(--color-rule)" />
      </defs>
      <rect x={x(3) - (x(1) - x(0)) / 2} y={top - 4} width={x(4) - x(3) + (x(1) - x(0)) / 2 + 6} height={bottom - top + 4} fill={`url(#${hid})`} />
      <text x={x(4) + 4} y={top - 6} fontSize="12" fill={SUB} textAnchor="end">
        공개 전 기간
      </text>
      <line x1="0" x2={W} y1={bottom} y2={bottom} stroke={SUB} />
      {[...series].sort((a, b) => Number(a.mine) - Number(b.mine)).map((s) => {
        const d = years.map((yr, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(s.byYear[yr] ?? 0).toFixed(1)}`).join(" ");
        const color = s.mine ? INK : SUB;
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={color} strokeWidth={s.mine ? 2.2 : 1.4} strokeDasharray={s.mine ? undefined : "4 3"} />
            {years.map((yr, i) => (
              <g key={yr}>
                <circle cx={x(i)} cy={y(s.byYear[yr] ?? 0)} r={s.mine ? 2.6 : 2} fill={color} />
                {!many && (
                  <text x={x(i)} y={y(s.byYear[yr] ?? 0) - 7} fontSize="12" textAnchor="middle" fill={INK} className="num">
                    {s.byYear[yr] ?? 0}
                  </text>
                )}
              </g>
            ))}
            {many && (
              <text x={x(4) + 6} y={y(s.byYear[years[4]] ?? 0) + 4} fontSize="12" fill={color} fontWeight={s.mine ? 600 : 400}>
                {s.name.length > 6 ? `${s.name.slice(0, 6)}…` : s.name}
              </text>
            )}
          </g>
        );
      })}
      {years.map((yr, i) => (
        <text key={yr} x={x(i)} y={H - 6} fontSize="12" textAnchor="middle" fill={SUB}>
          {yr}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- 누적 투자 막대

export type InvestBar = { name: string; amount: number; basis: string; mine: boolean };

/** 통화마다 따로 그린다(환산하지 않음). 우리 회사는 잉크, 경쟁사는 빗금. 금액이 없는 회사는 막대 없이 아래에 이름만 */
export function InvestBars({ currency, bars }: { currency: string; bars: InvestBar[] }) {
  const hid = useId().replace(/:/g, "");
  const max = Math.max(...bars.map((b) => b.amount), 1);
  const labelW = 86;
  // 기준 글("라운드 금액 합계 (금액이 있는 라운드 1건만 더함)")은 그림 폭을 넘으면 잘리므로 낱말 단위로 줄을 나누고, 줄 수만큼 행을 높인다
  const rows = bars.map((b) => ({ b, lines: wrapSvgText(b.basis, W - labelW) }));
  const rowTop: number[] = [];
  let acc = 6;
  for (const r of rows) {
    rowTop.push(acc);
    acc += 26 + 15 * Math.max(1, r.lines.length);
  }
  const H = acc + 2;
  const summary = `누적 투자(${currency}): ${bars.map((b) => `${b.name} ${moneyText(b.amount, currency)} (${b.basis})`).join(", ")}`;
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
      <defs>
        <Hatch id={hid} />
      </defs>
      {rows.map(({ b, lines }, i) => {
        const len = Math.max(2, ((W - labelW - 70) * b.amount) / max);
        const yy = rowTop[i];
        const short = shortCompany(b.name);
        return (
          <g key={b.name}>
            <text x="0" y={yy + 14} fontSize="12" fill={INK} fontWeight={b.mine ? 600 : 400}>
              {short.length > 7 ? `${short.slice(0, 7)}…` : short}
            </text>
            <rect x={labelW} y={yy + 3} width={len} height="14" fill={b.mine ? INK : `url(#${hid})`} stroke={INK} strokeWidth={b.mine ? 0 : 1} />
            <text x={labelW + len + 6} y={yy + 14} fontSize="12" fill={INK} className="num">
              {moneyText(b.amount, currency)}
            </text>
            <text x={labelW} y={yy + 32} fontSize="12" fill={SUB}>
              {lines.map((l, j) => (
                <tspan key={j} x={labelW} dy={j ? 15 : 0}>
                  {l}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
