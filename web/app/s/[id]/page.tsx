import { notFound } from "next/navigation";
import { getScenario, scenarios } from "@/lib/data";
import { Workspace } from "@/components/Workspace";

export async function generateStaticParams() {
  return scenarios.map((s) => ({ id: s.id }));
}

export default async function ScenarioPage({ params }: PageProps<"/s/[id]">) {
  const { id } = await params;
  const scenario = getScenario(id);
  if (!scenario) notFound();
  return <Workspace key={scenario.id} scenario={scenario} />;
}
