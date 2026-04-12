import type { ReactElement, ReactNode } from "react";
import { AuthGate } from "../auth-gate";
import { NavigationSidebar } from "../navigation-sidebar";

export default function PlatformLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <AuthGate>
      <main className="app-shell">
        <NavigationSidebar />
        <section className="workspace">{children}</section>
      </main>
    </AuthGate>
  );
}
