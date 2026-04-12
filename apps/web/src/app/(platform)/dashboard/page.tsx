import type { ReactElement } from "react";
import { DashboardOverview } from "../../dashboard-overview";
import { OpsPanels } from "../../ops-panels";

export default function DashboardPage(): ReactElement {
  return (
    <>
      <DashboardOverview />
      <OpsPanels />
    </>
  );
}
