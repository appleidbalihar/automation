"use client";

import type { ReactElement } from "react";
import Link from "next/link";

export function DashboardOverview(): ReactElement {
  return (
    <>
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Platform Overview</h1>
        <p style={{ marginBottom: 0 }}>
          The platform is focused on Operations AI, log exploration, user/profile management, secrets, and security administration.
        </p>
      </section>

      <div className="card-grid">
        <section className="card">
          <h4 style={{ marginTop: 0 }}>Operations AI</h4>
          <p>Chat with your Dify-backed operations knowledge base once your source setup is ready.</p>
          <Link href="/operations-ai">Open Operations AI</Link>
        </section>

        <section className="card">
          <h4 style={{ marginTop: 0 }}>Operations AI Setup</h4>
          <p>Connect your own GitHub, GitLab, Google Drive, or web source in a separate setup area.</p>
          <Link href="/operations-ai/setup">Open Setup</Link>
        </section>

        <section className="card">
          <h4 style={{ marginTop: 0 }}>Logs</h4>
          <p>Search and filter operational logs across the remaining platform services.</p>
          <Link href="/logs">Open Logs</Link>
        </section>

        <section className="card">
          <h4 style={{ marginTop: 0 }}>Admin Tools</h4>
          <p>Platform admins can continue managing secrets, users, and certificate/security health.</p>
        </section>
      </div>
    </>
  );
}
