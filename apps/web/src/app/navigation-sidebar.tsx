"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { fetchIdentity } from "./auth-client";

const baseNavItems: Array<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/integrations", label: "External Integrations" },
  { href: "/workflows", label: "Workflow Builder" },
  { href: "/orders", label: "Orders" },
  { href: "/approvals", label: "Approvals" },
  { href: "/logs", label: "Logs" },
  { href: "/assistant", label: "Assistant" }
];

export function NavigationSidebar(): ReactElement {
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);

  useEffect(() => {
    fetchIdentity()
      .then((identity) => setRoles(identity.roles))
      .catch(() => setRoles([]));
  }, []);

  const navItems = [...baseNavItems, { href: "/profile", label: "Profile" }];
  if (roles.includes("admin")) {
    navItems.push({ href: "/users", label: "Users" });
    navItems.push({ href: "/secrets", label: "Secrets" });
    navItems.push({ href: "/security", label: "Security Health" });
  }

  return (
    <aside className="left-nav">
      <h2 style={{ marginTop: 0 }}>Automation Platform</h2>
      <p style={{ opacity: 0.8, marginTop: 0 }}>Enterprise Operations Suite</p>
      <nav>
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item nav-item-link${isActive ? " nav-item-active" : ""}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
