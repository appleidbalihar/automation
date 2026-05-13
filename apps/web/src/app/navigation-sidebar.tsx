"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { clearStoredToken, fetchIdentity } from "./auth-client";

type NavItem = { href: string; label: string; icon: string; section: "Workspace" | "Account" | "Admin" };

const baseNavItems: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: "OV", section: "Workspace" },
  { href: "/knowledge-connector", label: "Knowledge", icon: "KB", section: "Workspace" },
  { href: "/rag-assistant", label: "RAG Assistant", icon: "AI", section: "Workspace" }
];

export function NavigationSidebar(): ReactElement {
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [navOpen, setNavOpen] = useState<boolean>(false);

  useEffect(() => {
    fetchIdentity()
      .then((identity) => {
        setRoles(identity.roles);
        setUserId(identity.userId);
      })
      .catch(() => {
        setRoles([]);
        setUserId("");
      });
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const navItems: NavItem[] = [...baseNavItems, { href: "/profile", label: "Profile", icon: "ME", section: "Account" }];
  if (roles.includes("admin") || roles.includes("useradmin")) {
    navItems.push({ href: "/ai-agent-prompt", label: "AI Prompts", icon: "PR", section: "Workspace" });
    navItems.push({ href: "/chat-channels", label: "Chat Channels", icon: "CH", section: "Workspace" });
  }
  if (roles.includes("admin")) {
    // Platform admin exclusive items
    navItems.push({ href: "/rag-stats", label: "Analytics", icon: "AN", section: "Admin" });
    navItems.push({ href: "/logs", label: "Logs", icon: "LG", section: "Admin" });
    navItems.push({ href: "/users", label: "Users", icon: "US", section: "Admin" });
    navItems.push({ href: "/secrets", label: "Secrets", icon: "KY", section: "Admin" });
    navItems.push({ href: "/security", label: "Security", icon: "SC", section: "Admin" });
    navItems.push({ href: "/dify-config", label: "Dify Config", icon: "DC", section: "Admin" });
  }

  /** Sign the user out and force a full page reload to return to the login screen */
  function handleSignOut(): void {
    clearStoredToken();
    window.location.href = "/dashboard";
  }

  const renderNavItems = (): ReactElement[] =>
    (["Workspace", "Account", "Admin"] as const).flatMap((section) => {
      const sectionItems = navItems.filter((item) => item.section === section);
      if (!sectionItems.length) return [];
      return [
        <p className="left-nav-section-label" key={`${section}-label`}>{section}</p>,
        ...sectionItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item nav-item-link${isActive ? " nav-item-active" : ""}`}
              onClick={() => setNavOpen(false)}
            >
              <span className="nav-item-icon">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })
      ];
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
          <span className="left-nav-logo-mark">R</span>
          <div>
            <strong>RapidRAG</strong>
            <span>RAG-as-a-Service</span>
          </div>
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
            <span className="left-nav-logo-mark">R</span>
            <div>
              <strong>RapidRAG</strong>
              <span>Platform workspace</span>
            </div>
          </div>
          <button type="button" className="left-nav-close-button" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
            ×
          </button>
        </div>
        <nav className="left-nav-list" aria-label="Platform navigation">
          {renderNavItems()}
        </nav>
        {/* User identity + sign-out — pinned to the bottom of the drawer */}
        <div className="left-nav-user-footer">
          <div className="left-nav-user-info">
            <span className="left-nav-user-avatar">{userId ? userId.charAt(0).toUpperCase() : "?"}</span>
            <div className="left-nav-user-details">
              <strong>{userId || "loading…"}</strong>
              <span>{roles.join(", ") || "viewer"}</span>
            </div>
          </div>
          <button
            type="button"
            className="left-nav-signout-btn"
            aria-label="Sign out"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
