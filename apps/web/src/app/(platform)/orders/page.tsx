import type { ReactElement } from "react";
import { OrderExecutionConsole } from "../../order-execution-console";

export default async function OrdersPage(props: {
  searchParams?: Promise<{ orderId?: string }>;
}): Promise<ReactElement> {
  const searchParams = await props.searchParams;
  return <OrderExecutionConsole initialOrderId={searchParams?.orderId} />;
}
