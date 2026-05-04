# RAG Knowledge Base — Document Management Guide

## The Core Problem: Why RAG Gives Wrong Answers

RAG (Retrieval-Augmented Generation) works by:
1. Breaking every document into small **chunks** (typically 200–500 words each)
2. Converting each chunk into a **vector embedding** (a list of numbers representing semantic meaning)
3. When a user asks a question, finding the chunks whose embeddings are most **similar** to the question
4. Sending those top-N chunks to the LLM to generate an answer

**The problem**: If a chunk contains ambiguous or misleading text, the embedding similarity search finds the wrong chunk, and the LLM answers from the wrong context.

**Example**: A question about "containers" retrieved a chunk from the postgres section describing "Database: automation, Key tables: PlatformLog..." because both "containers" and "database tables" involve data structures. The LLM then described database tables as "containers in the platform".

---

## Solution 1: Companion Index Documents (for PDFs and External Docs)

When you add an external PDF or document that **you cannot modify**, create a companion `.md` file in the same source folder. This companion doc acts as a **search-friendly index** that guides the RAG retriever to the right PDF and section.

### Companion Document Template

Create a file named `<pdf-name>-index.md` alongside your PDF:

```markdown
# Index: [Document Title]

## Document Reference
- **File**: [filename.pdf]
- **Source**: [e.g. GitHub repo path, or "uploaded manually"]
- **Version**: [version or date]
- **Purpose**: [one-sentence description of what this document covers]

## Topics Covered in This Document

This document answers questions about:
- [Topic 1 — e.g. "installation steps for Product X"]
- [Topic 2 — e.g. "configuration options for the API"]
- [Topic 3 — e.g. "troubleshooting network connectivity"]
- [Topic 4 — e.g. "user roles and access permissions in Product X"]

## Section Summary

### [Section/Chapter Name from the PDF]
Keywords: [comma-separated key terms]
Summary: [2-3 sentence description of what this section covers]
Page range: [e.g. pages 5-12]

### [Another Section]
Keywords: [comma-separated key terms]
Summary: [2-3 sentence description]
Page range: [e.g. pages 13-20]

## Key Terms and Definitions

| Term | Definition |
|------|-----------|
| [Term from PDF] | [Definition — even just paraphrased from the PDF] |
| [Another term] | [Its meaning in context] |

## Common Questions This Document Answers

- What is [product/topic]?
- How do I [main task]?
- What are the [components/steps/requirements]?
- How does [feature] work?
```

### Real Example

If your knowledge base has `vendor-api-manual.pdf`, create `vendor-api-manual-index.md`:

```markdown
# Index: Vendor API Manual

## Document Reference
- **File**: vendor-api-manual.pdf
- **Version**: v3.2, January 2025
- **Purpose**: Complete API reference for the Vendor XYZ integration platform

## Topics Covered in This Document

This document answers questions about:
- Authentication methods (OAuth 2.0, API keys, JWT)
- Available API endpoints and their parameters
- Rate limiting and error codes
- Webhook configuration and event types
- SDK installation and usage examples

## Section Summary

### Authentication (Pages 5-15)
Keywords: OAuth, API key, Bearer token, authentication, login, credentials
Summary: Covers all authentication methods. OAuth 2.0 is the primary method. API keys are supported for server-to-server. Tokens expire after 1 hour.

### API Endpoints Reference (Pages 16-45)
Keywords: endpoints, REST, GET, POST, PUT, DELETE, parameters, response, JSON
Summary: Full list of 47 REST endpoints. Each endpoint shows HTTP method, URL, required parameters, and example response.

### Webhooks (Pages 46-55)
Keywords: webhooks, events, callbacks, notifications, real-time
Summary: How to configure webhook URLs to receive real-time event notifications. Lists 12 event types.

## Key Terms and Definitions

| Term | Definition |
|------|-----------|
| API Key | A static credential string used for server-to-server auth |
| Webhook | An HTTP callback sent by the vendor when an event occurs |
| Rate limit | 1000 requests per minute per API key |

## Common Questions This Document Answers

- How do I authenticate with the Vendor API?
- What endpoints are available?
- What is the rate limit?
- How do I set up webhooks?
```

---

## Solution 2: Improved Chunking via Custom Segmentation

When uploading a PDF directly to Dify (not via n8n sync), use **custom segmentation rules** instead of automatic:

- Set **separator** to `\n\n` (double newline) or `---`
- Set **max chunk length** to `1000` tokens (larger = more context per chunk)
- Set **chunk overlap** to `100` tokens (helps with boundary questions)

This gives the LLM more context per retrieved chunk.

---

## Solution 3: Structured Dify System Prompt (Already Applied)

The Dify app system prompt has been updated to:
1. Cite which document each answer comes from
2. Distinguish Docker containers from database tables
3. Extract facts even from imperfectly structured PDF chunks
4. Tell the user when more source paths need to be synced

---

## Solution 4: Multiple Source Paths

If a PDF-heavy knowledge base is returning wrong answers, add the folder containing both the PDF and its companion index to the KB's `sourcePaths`. The companion `.md` will be indexed alongside the PDF, dramatically improving retrieval accuracy.

---

## RAG Writing Best Practices (for documents you control)

When you create or maintain documentation:

| Practice | Why It Helps RAG |
|----------|-----------------|
| Use descriptive headings (`## How RAG Chat Works`) | Heading becomes part of chunk context |
| Add a summary table at the top of each reference doc | Summary is the highest-scored chunk for overview queries |
| Use explicit labels (`These are database tables, not Docker containers`) | Prevents semantic confusion between similar-sounding concepts |
| Write section intros (`This section explains X and covers Y, Z`) | Self-contained chunk = better retrieval |
| Avoid vague headings (`## Overview`, `## Details`) | Generic headings give embedding models no signal |
| One concept per section | Avoids multi-topic chunks that retrieve for wrong queries |
| Use consistent terminology | Synonyms in different chunks cause missed retrievals |

---

## Monitoring RAG Quality

Check retrieval accuracy by looking at **retriever_resources** in Dify responses:
- **Score > 0.7**: Good retrieval — the right chunk was found
- **Score 0.5–0.7**: Marginal — may need companion doc or better source formatting
- **Score < 0.5**: Poor retrieval — the chunk is unlikely to contain the right answer

The Dify admin console (port 3002) shows hit count per document. A document with **0 hits** is never being retrieved and likely needs a companion index document.
