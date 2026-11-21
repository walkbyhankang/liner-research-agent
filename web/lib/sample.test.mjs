import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { draftPatch, sameCompany } from "./draft.ts";

// 예시 회사 파일은 저장소에 넣지 않는다(.gitignore). 파일을 둔 곳에서만 형식을 확인하고, 없으면 건너뛴다
const file = new URL("../public/data/sample-company.json", import.meta.url);
const sample = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const when = { skip: sample ? false : "예시 회사 파일이 없다" };
const empty = { name: "", founded: "", industry: "", employees: "", revenue: "", need: "", notes: "" };
const http = (u) => /^https?:\/\//.test(u);

test("예시 회사 파일은 화면이 읽는 형식이고, 조회한 날짜가 적혀 있다", when, () => {
  assert.match(sample.savedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(sample.company.name.trim()); // 화면 단추에 이 이름이 나온다
  const l = sample.lookup;
  assert.ok(sameCompany(l.query, sample.company.name));
  assert.ok(Array.isArray(l.fields) && Array.isArray(l.investors) && Array.isArray(l.competitors) && Array.isArray(l.rivalFunding));
  assert.ok(l.investors.every((i) => typeof i.name === "string") && l.competitors.every((c) => typeof c.name === "string"));
  assert.ok(l.rivalFunding.every((r) => typeof r.company === "string" && Array.isArray(r.investors)));
});

test("예시 회사의 값에는 출처가 붙어 있고, 불확실한 값은 회사 정보 칸에 채우지 않는다", when, () => {
  const l = sample.lookup;
  const sure = new Set(l.fields.filter((f) => f.status === "confirmed" || f.status === "reported").map((f) => f.key));
  for (const key of ["founded", "industry", "employees", "revenue"]) if (l.draft[key]) assert.ok(sure.has(key), key);
  assert.ok(l.fields.every((f) => http(f.sourceUrl)));
  assert.ok(l.rivalFunding.every((r) => http(r.sourceUrl) && r.quote.length >= 6));
  assert.ok(l.competitors.filter((c) => c.figuresStatus === "reported").every((c) => http(c.figuresUrl)));
  // 내부 정보(인증·체납 등)는 지어내지 않는다. 필요한 자금은 예시임을 값에 적는다
  assert.deepEqual(Object.keys(sample.company).sort(), ["name", "need"]);
  assert.match(sample.company.need, /예시/);
  assert.doesNotMatch(JSON.stringify(sample), /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test("예시 회사를 불러오면 빈 회사 정보에 초안 값이 채워진다", when, () => {
  const patch = draftPatch({ ...empty, name: sample.company.name, need: sample.company.need }, sample.lookup.draft, sample.company.name);
  assert.equal(patch.founded, sample.lookup.draft.founded);
  assert.equal(patch.revenue, sample.lookup.draft.revenue);
  assert.equal(patch.need, undefined);
});
