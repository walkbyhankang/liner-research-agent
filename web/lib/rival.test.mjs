import assert from "node:assert/strict";
import test from "node:test";
import { rivalCompany, usableRival } from "./rival.ts";

const mine = { region: "대전", biz: "venture", need: "운전자금 3억" };
const rival = { name: "나다라", relation: "직접 경쟁", products: "기업용 검색", revenue: "120억 원 (2025)", employees: "80명", funding: "시리즈 B 300억", status: "reported" };

test("확인되거나 보도된 경쟁사 값은 대조에 넣고, 지역·유형·필요 자금은 우리 회사 값을 둔다", () => {
  assert.deepEqual(rivalCompany(rival, mine), {
    name: "나다라", region: "대전", biz: "venture", founded: "", industry: "기업용 검색", employees: "80명", revenue: "120억 원 (2025)",
    need: "운전자금 3억", notes: "관계: 직접 경쟁, 투자 유치: 시리즈 B 300억",
  });
  assert.equal(usableRival({ status: "confirmed" }), true);
});

test("추정이거나 출처가 엇갈리는 경쟁사 값은 사실처럼 넘기지 않는다", () => {
  for (const status of ["inferred", "conflicting", "", "unavailable"]) {
    const out = rivalCompany({ ...rival, status }, mine);
    assert.equal(usableRival({ status }), false);
    assert.deepEqual({ industry: out.industry, employees: out.employees, revenue: out.revenue, notes: out.notes }, { industry: "", employees: "", revenue: "", notes: "" });
    assert.deepEqual({ name: out.name, region: out.region, need: out.need }, { name: "나다라", region: "대전", need: "운전자금 3억" });
  }
});

test("길이 제한을 넘는 값은 서버가 받는 길이로 자른다", () => {
  const out = rivalCompany({ ...rival, name: "가".repeat(80), products: "나".repeat(100), funding: "다".repeat(500) }, mine);
  assert.equal(out.name.length, 60);
  assert.equal(out.industry.length, 80);
  assert.equal(out.notes.length, 400);
});

test("기록은 추정이어도 수치를 검색에서 확인했으면 그 수치는 대조에 쓴다", () => {
  const verified = { ...rival, status: "inferred", figuresStatus: "reported", employees: "188명 (2025)", revenue: "", funding: "시리즈 B 300억 원" };
  assert.equal(usableRival(verified), true);
  const out = rivalCompany(verified, mine);
  assert.equal(out.employees, "188명 (2025)");
  assert.equal(out.revenue, "");
  // 엔진이 추정한 사업 내용과 관계는 보내지 않고, 확인된 수치만 보낸다
  assert.equal(out.industry, "");
  assert.equal(out.notes, "투자 유치: 시리즈 B 300억 원");
  assert.equal(usableRival({ status: "inferred", figuresStatus: "" }), false);
  assert.equal(usableRival({ status: "conflicting" }), false);
});

test("확인된 설립 시기는 메모로 보내고 설립 연월 칸은 비워 둔다", () => {
  const out = rivalCompany({ ...rival, founded: "2015년" }, mine);
  assert.equal(out.founded, "");
  assert.equal(out.notes, "관계: 직접 경쟁, 설립: 2015년, 투자 유치: 시리즈 B 300억");
  assert.equal(rivalCompany({ ...rival, status: "inferred", founded: "2015년" }, mine).notes, "");
});
