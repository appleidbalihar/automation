"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { fetchIdentity } from "./auth-client";

// Base nav items visible to all authenticated users
const baseNavItems: Array<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/knowledge-connector", label: "Knowledge Connector" },
  { href: "/rag-assistant", label: "RAG Assistant" }
];

export function NavigationSidebar(): ReactElement {
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);
  const [navOpen, setNavOpen] = useState<boolean>(false);

  useEffect(() => {
    fetchIdentity()
      .then((identity) => setRoles(identity.roles))
      .catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const navItems = [...baseNavItems, { href: "/profile", label: "Profile" }];
  if (roles.includes("admin") || roles.includes("useradmin")) {
    navItems.push({ href: "/ai-agent-prompt", label: "AI Agent Prompt" });
  }
  if (roles.includes("admin")) {
    // Platform admin exclusive items
    navItems.push({ href: "/rag-stats", label: "RAG Stats" });
    navItems.push({ href: "/logs", label: "Logs" });
    navItems.push({ href: "/users", label: "Users" });
    navItems.push({ href: "/secrets", label: "Secrets" });
    navItems.push({ href: "/security", label: "Security Health" });
  }

  const renderNavItems = (): ReactElement[] =>
    navItems.map((item) => {
      const isActive = pathname === item.href;
      return (
        <Link
          key={item.href}
          href={item.href}
          className={`nav-item nav-item-link${isActive ? " nav-item-active" : ""}`}
          onClick={() => setNavOpen(false)}
        >
          {item.label}
        </Link>
      );
    });

  return (
    <aside className="left-nav">
      <div className="left-nav-bar">
        <button
          type="button"
          className="left-nav-menu-button"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((value) => !value)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="left-nav-brand">
          <strong>RapidRAG</strong>
          <span>End-to-end RAG Platform</span>
        </div>
      </div>
      {navOpen ? (
        <button
          type="button"
          className="left-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <div className={`left-nav-drawer${navOpen ? " left-nav-drawer-open" : ""}`}>
        <div className="left-nav-drawer-header">
          <div>
            <strong>RapidRAG</strong>
            <span>Navigation</span>
          </div>
          <button type="button" className="left-nav-close-button" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
            ×
          </button>
        </div>
        <nav className="left-nav-list" aria-label="Platform navigation">
          {renderNavItems()}
        </nav>
      </div>
    </aside>
  );
}
