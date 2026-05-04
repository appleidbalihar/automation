import Link from "next/link";
import type { ReactElement } from "react";

export default function LandingPage(): ReactElement {
  return (
    <div className="rr-landing">
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="rr-nav">
        <div className="rr-nav-inner">
          <span className="rr-logo">
            <span className="rr-logo-mark">R</span>RapidRAG
          </span>
          <nav className="rr-nav-links">
            <a href="#how-it-works">How it works</a>
            <a href="#use-cases">Use cases</a>
            <a href="#why">Why RapidRAG</a>
          </nav>
          <Link href="/dashboard" className="rr-btn-outline">Sign in</Link>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="rr-hero">
        <div className="rr-hero-inner">
          <p className="rr-eyebrow">End-to-end RAG in minutes</p>
          <h1 className="rr-headline">
            Stop building RAG.<br />Start answering.
          </h1>
          <p className="rr-subheadline">
            RapidRAG turns your documentation — GitHub, Google Drive, SharePoint, Notion and more — into a smart answer engine, then deploys chatbots to Slack, Telegram, and WhatsApp in minutes. No custom code. No integration hell.
          </p>
          <div className="rr-hero-ctas">
            <Link href="/dashboard" className="rr-btn-primary">
              🚀 Start free trial — connect your first source in 3 min
            </Link>
            <a href="#how-it-works" className="rr-btn-ghost">
              📅 Watch a 2-min demo
            </a>
          </div>
          <div className="rr-hero-badges">
            <span className="rr-badge">GitHub &amp; GitLab</span>
            <span className="rr-badge">Google Drive</span>
            <span className="rr-badge">Confluence &amp; Notion</span>
            <span className="rr-badge">Slack &amp; Telegram</span>
            <span className="rr-badge">WhatsApp</span>
            <span className="rr-badge">20+ connectors</span>
          </div>
        </div>
      </section>

      {/* ── Problem ─────────────────────────────────────────────────────── */}
      <section className="rr-section rr-section-alt">
        <div className="rr-container">
          <p className="rr-section-eyebrow">The Problem</p>
          <h2 className="rr-section-title">We know you feel this</h2>
          <div className="rr-problem-grid">
            <div className="rr-problem-card">
              <span className="rr-problem-icon">👨‍💻</span>
              <strong>Developers</strong>
              <p>You waste weeks stitching together embeddings, vector DBs, retrieval logic, and chat APIs — then maintain it forever.</p>
            </div>
            <div className="rr-problem-card">
              <span className="rr-problem-icon">⚖️</span>
              <strong>Legal teams</strong>
              <p>Critical contract and policy questions get buried in PDFs. You wait hours for someone to search manually.</p>
            </div>
            <div className="rr-problem-card">
              <span className="rr-problem-icon">🧑‍💼</span>
              <strong>Team leads</strong>
              <p>Your team asks repetitive questions already answered in internal docs — but nobody finds them in time.</p>
            </div>
            <div className="rr-problem-card">
              <span className="rr-problem-icon">🏢</span>
              <strong>Companies</strong>
              <p>You have a goldmine of knowledge in Drive, Notion, GitHub — but it&apos;s trapped. No single interface to query it all.</p>
            </div>
          </div>
          <div className="rr-cost-banner">
            <strong>The real cost:</strong> hours of lost productivity, delayed decisions, and frustrated employees who stop using your own documentation.
          </div>
        </div>
      </section>

      {/* ── Solution ─────────────────────────────────────────────────────── */}
      <section className="rr-section">
        <div className="rr-container">
          <p className="rr-section-eyebrow">The Solution</p>
          <h2 className="rr-section-title">One roof. End-to-end RAG. Zero waste.</h2>
          <p className="rr-section-lead">
            RapidRAG is the first fully integrated RAG operations platform that lets any team — not just engineering — connect document sources, sync them automatically, and deploy AI chatbots to the channels people already use.
          </p>
          <div className="rr-checks">
            <div className="rr-check-item">
              <span className="rr-check">✅</span>
              <div>
                <strong>No building</strong> — we handle chunking, embedding, retrieval, and LLM orchestration.
              </div>
            </div>
            <div className="rr-check-item">
              <span className="rr-check">✅</span>
              <div>
                <strong>No integration hassles</strong> — pre-built connectors for GitHub, GitLab, Google Drive, Confluence, Notion, and 20+ more.
              </div>
            </div>
            <div className="rr-check-item">
              <span className="rr-check">✅</span>
              <div>
                <strong>No new UI to learn</strong> — your team asks questions in Slack or Telegram, gets cited answers back instantly.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="rr-section rr-section-dark" id="how-it-works">
        <div className="rr-container">
          <p className="rr-section-eyebrow rr-eyebrow-light">Simple as 1-2-3</p>
          <h2 className="rr-section-title rr-title-light">How RapidRAG works</h2>
          <div className="rr-steps">
            <div className="rr-step">
              <div className="rr-step-num">1</div>
              <h3>Connect your sources</h3>
              <p>Choose from our connector library: GitHub repos, Google Drive folders, GitLab wikis, SharePoint, Dropbox, and more. OAuth login → pick your folders → done.</p>
            </div>
            <div className="rr-step-divider">→</div>
            <div className="rr-step">
              <div className="rr-step-num">2</div>
              <h3>Sync &amp; index automatically</h3>
              <p>RapidRAG ingests your documents, splits them intelligently, creates vector embeddings, and builds a searchable knowledge base. Sync runs on a schedule or on demand.</p>
            </div>
            <div className="rr-step-divider">→</div>
            <div className="rr-step">
              <div className="rr-step-num">3</div>
              <h3>Deploy chatbots</h3>
              <p>Generate a bot token for Slack, Telegram, or WhatsApp. Paste it into your channel — your bot is live. Users ask questions, RapidRAG retrieves relevant chunks, generates answers, and cites sources.</p>
            </div>
          </div>
          <p className="rr-steps-callout">Total setup time: under 5 minutes for a simple source + bot.</p>
        </div>
      </section>

      {/* ── Benefits ─────────────────────────────────────────────────────── */}
      <section className="rr-section">
        <div className="rr-container">
          <p className="rr-section-eyebrow">Benefits</p>
          <h2 className="rr-section-title">For everyone on your team</h2>
          <div className="rr-benefits-grid">
            <div className="rr-benefit-card">
              <div className="rr-benefit-icon">👨‍💻</div>
              <h3>For Developers</h3>
              <ul>
                <li>Stop building infrastructure — we provide the full RAG pipeline.</li>
                <li>No vendor lock-in — export your vectors or bring your own LLM key.</li>
                <li>Full logging &amp; security — every query visible, access controlled.</li>
              </ul>
            </div>
            <div className="rr-benefit-card">
              <div className="rr-benefit-icon">⚖️</div>
              <h3>For Legal Teams</h3>
              <ul>
                <li>Query contracts and policies in plain English.</li>
                <li>Receive answers with source links — no more scanning 200-page PDFs.</li>
                <li>Audit-ready logs — every question and answer stored for compliance.</li>
              </ul>
            </div>
            <div className="rr-benefit-card">
              <div className="rr-benefit-icon">🧑‍💼</div>
              <h3>For Team Leads</h3>
              <ul>
                <li>Reduce repetitive questions — onboard new hires faster.</li>
                <li>Measure knowledge gaps — see what's asked most often.</li>
                <li>Save hours weekly — your team stops searching and starts doing.</li>
              </ul>
            </div>
            <div className="rr-benefit-card">
              <div className="rr-benefit-icon">🏢</div>
              <h3>For Companies</h3>
              <ul>
                <li>Unify knowledge across silos — GitHub, Drive, Confluence in one layer.</li>
                <li>Deploy to existing chat tools — Slack &amp; Teams are where work happens.</li>
                <li>Scale without hiring — one platform serves hundreds with no extra engineering.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Use Cases ────────────────────────────────────────────────────── */}
      <section className="rr-section rr-section-alt" id="use-cases">
        <div className="rr-container">
          <p className="rr-section-eyebrow">Real-world use cases</p>
          <h2 className="rr-section-title">Works for every team</h2>
          <div className="rr-table-wrap">
            <table className="rr-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>How RapidRAG helps</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Engineering</strong></td>
                  <td>&ldquo;How does the payment service handle idempotency?&rdquo; → bot pulls from GitHub README + internal design doc.</td>
                </tr>
                <tr>
                  <td><strong>Customer Support</strong></td>
                  <td>Agents ask &ldquo;What&apos;s the refund policy for EU customers?&rdquo; → answer in seconds from the knowledge base.</td>
                </tr>
                <tr>
                  <td><strong>Legal</strong></td>
                  <td>&ldquo;Show NDAs from Q1 with a non-compete clause&rdquo; → retrieved from Google Drive folder.</td>
                </tr>
                <tr>
                  <td><strong>HR Onboarding</strong></td>
                  <td>New hire asks &ldquo;How do I set up my dev environment?&rdquo; → bot answers from internal wiki + GitHub guide.</td>
                </tr>
                <tr>
                  <td><strong>Sales</strong></td>
                  <td>&ldquo;What are our API rate limits?&rdquo; → answer from public docs + internal Slack policy.</td>
                </tr>
                <tr>
                  <td><strong>Freelancers &amp; Consultants</strong></td>
                  <td>Use your own Notion + Drive. Create a personal Telegram bot. Ask from your phone while on the go.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Why RapidRAG ─────────────────────────────────────────────────── */}
      <section className="rr-section" id="why">
        <div className="rr-container">
          <p className="rr-section-eyebrow">Why RapidRAG</p>
          <h2 className="rr-section-title">vs. the alternatives</h2>
          <div className="rr-table-wrap">
            <table className="rr-table rr-compare-table">
              <thead>
                <tr>
                  <th>Competitor / Approach</th>
                  <th>Problem</th>
                  <th>RapidRAG Advantage</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Building with LangChain + Pinecone</td>
                  <td>100+ hours, constant maintenance</td>
                  <td className="rr-td-good">Ready in 5 minutes</td>
                </tr>
                <tr>
                  <td>OpenAI Assistants API</td>
                  <td>No document sync, no multi-source connectors</td>
                  <td className="rr-td-good">Auto-sync from GitHub / Drive</td>
                </tr>
                <tr>
                  <td>Slack GPT / Claude bots</td>
                  <td>No RAG — limited context window</td>
                  <td className="rr-td-good">Full RAG with source citations</td>
                </tr>
                <tr>
                  <td>Traditional search (Algolia, Elastic)</td>
                  <td>Returns links, not answers</td>
                  <td className="rr-td-good">Answers directly in chat</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Security ─────────────────────────────────────────────────────── */}
      <section className="rr-section rr-section-alt">
        <div className="rr-container">
          <p className="rr-section-eyebrow">Security &amp; Compliance</p>
          <h2 className="rr-section-title">Built for business</h2>
          <div className="rr-security-grid">
            <div className="rr-security-item">🔒 Encryption at rest and in transit</div>
            <div className="rr-security-item">👥 Role-based access control</div>
            <div className="rr-security-item">📋 Audit logs for every query and answer</div>
            <div className="rr-security-item">🏠 Self-hosted option for enterprise</div>
            <div className="rr-security-item">🔑 HashiCorp Vault for secrets management</div>
            <div className="rr-security-item">🛡️ SOC 2 Type II (in progress)</div>
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="rr-section rr-section-dark rr-cta-section">
        <div className="rr-container rr-cta-inner">
          <h2 className="rr-title-light">Ready to stop searching and start answering?</h2>
          <p className="rr-cta-sub">Connect your first source in under 3 minutes. No credit card required.</p>
          <Link href="/dashboard" className="rr-btn-primary rr-btn-large">
            🚀 Get started free
          </Link>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="rr-footer">
        <div className="rr-footer-inner">
          <span className="rr-logo">
            <span className="rr-logo-mark">R</span>RapidRAG
          </span>
          <p>End-to-end RAG platform. Connect your docs. Deploy chatbots. Get answers instantly.</p>
          <p className="rr-footer-copy">© {new Date().getFullYear()} RapidRAG. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
