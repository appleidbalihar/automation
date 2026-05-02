"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { fetchIdentity } from "./auth-client";

const baseNavItems: Array<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/knowledge-connector", label: "Knowledge Connector" },
  { href: "/rag-assistant", label: "RAG Assistant" },
  { href: "/logs", label: "Logs" }
];

export function NavigationSidebar(): ReactElement {
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);
  const [pinned, setPinned] = useState<boolean>(true);

  useEffect(() => {
    fetchIdentity()
      .then((identity) => setRoles(identity.roles))
      .catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("platform-left-nav:pinned");
    setPinned(stored !== "false");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("platform-left-nav:pinned", pinned ? "true" : "false");
  }, [pinned]);

  const navItems = [...baseNavItems, { href: "/profile", label: "Profile" }];
  if (roles.includes("admin")) {
    navItems.push({ href: "/users", label: "Users" });
    navItems.push({ href: "/secrets", label: "Secrets" });
    navItems.push({ href: "/security", label: "Security Health" });
  }

  return (
    <aside className={`left-nav${pinned ? "" : " left-nav-collapsed"}`}>
      <div className="left-nav-topbar">
        <button type="button" className="left-nav-pin-button" onClick={() => setPinned((value) => !value)}>
          {pinned ? "Unpin" : "Pin"}
        </button>
      </div>
      {pinned ? (
        <>
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
        </>
      ) : (
        <div className="left-nav-collapsed-content">
          <button type="button" className="left-nav-reveal-button" onClick={() => setPinned(true)}>
            Show Navigation
          </button>
        </div>
      )}
    </aside>
  );
}
