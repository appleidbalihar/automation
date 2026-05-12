# RAG AI Agent Tuning — Operations Guide

This document explains every tunable parameter in the RapidRAG AI Agent. For each parameter it covers: what it does, the default value, the symptoms you will see when it is set too low or too high, how to change it, and a concrete example.

---

## 1. Score Threshold

### What it does

When a user asks a question, RapidRAG searches the knowledge base using vector similarity. Every retrieved chunk gets a similarity score between 0.0 (no match) and 1.0 (perfect match). The score threshold is the **minimum score a chunk must reach before it is sent to the AI model**.

Chunks that score below the threshold are discarded. If no chunks pass the threshold, the AI model receives no context and responds with the configured fallback message instead of inventing an answer.

### Default

`0.4` (40% minimum similarity)

### Where to change it

Knowledge Connector → open a KB → Fine-tune options → **Retrieval Settings → Score Threshold**

Range: `0.10` – `0.90`, step `0.05`. Changes apply immediately to Dify without re-provisioning.

### Symptoms: threshold too LOW

| Symptom | What is happening |
|---|---|
| AI answers a question about Topic A with content from Topic B | A weakly-related chunk from Topic B scored above the low threshold and was used |
| Answer contains generic steps not from your documents (e.g. generic nginx commands when asked about your product) | The model received an off-topic chunk and used its training knowledge to fill gaps |
| `[Source: None]` or fabricated document names in the answer | No real chunk matched well but the threshold was low enough to pass noisy chunks |

**Example:** User asks "backup procedure for UIV". With threshold `0.1`, a chunk about certificate installation scores `0.18` and passes. The AI sees certificate content and answers about certificates instead.

**Fix:** Raise threshold to `0.5` or `0.6`.

### Symptoms: threshold too HIGH

| Symptom | What is happening |
|---|---|
| "The knowledge base does not contain information for this question" on questions that should be answered | Valid chunks exist but score below the high threshold |
| Works for simple/common questions but fails on technical details | Short or fragmented chunks score lower than longer narrative chunks |
| Answers for older document versions work but new docs do not | New documents may use different terminology, reducing similarity scores |

**Example:** A chunk describes "NCS on-demand backup" but the user asks "trigger NCS backup manually". With threshold `0.8`, the chunk scores `0.72` and is rejected. The AI answers with the fallback even though the right information exists.

**Fix:** Lower threshold to `0.35` – `0.45`.

### Tuning guidance

Start at `0.4`. After one week of production use, review the logs for:
- Questions that returned fallback but should have been answered → lower the threshold
- Questions that returned wrong-topic answers → raise the threshold

A well-tuned KB typically settles between `0.40` and `0.60` depending on how consistently the documents are written.

---

## 2. Chunks Retrieved (top_k)

### What it does

After filtering by score threshold, Dify returns the **top N highest-scoring chunks** to the AI model. `top_k` controls how many chunks are included. More chunks give the model more context but also increase the chance of including loosely-related content.

### Default

`4` chunks

### Where to change it

Knowledge Connector → open a KB → Fine-tune options → **Retrieval Settings → Chunks Retrieved**

Range: `1` – `20`, step `1`. Changes apply immediately.

### Symptoms: top_k too LOW

| Symptom | What is happening |
|---|---|
| Answer is correct but incomplete — missing steps or follow-up details | The answer spans multiple chunks but only the first N were retrieved |
| Multi-part procedures are truncated | Step 1–3 lands in one chunk, steps 4–6 in another. With `top_k=2`, only the first chunk is seen |
| Works for short questions but fails for broad questions like "explain the full backup architecture" | A broad question needs many chunks from different sections |

**Example:** User asks "full MOP for UIV database migration". The procedure spans 6 chunks. With `top_k=3`, the AI sees only the first 3 chunks and produces an incomplete answer that stops mid-procedure.

**Fix:** Raise to `6` – `8` for KBs with long procedures.

### Symptoms: top_k too HIGH

| Symptom | What is happening |
|---|---|
| Answer mixes information from two unrelated procedures | Too many chunks retrieved; a distantly-related chunk was included |
| Response time is noticeably slow | More chunks = larger prompt = longer LLM processing time |
| Answer is very long but not focused on the question | The model tries to incorporate all retrieved chunks even the marginally relevant ones |

**Example:** User asks "backup command for UIV". With `top_k=15`, the model retrieves backup chunks plus restore chunks plus monitoring chunks. The answer lists every related command instead of the one backup command the user needed.

**Fix:** Lower to `3` – `5` for KBs with focused, well-structured documents.

### Recommended values by KB type

| KB content type | Recommended top_k |
|---|---|
| Command references (short, precise docs) | 3 – 4 |
| MOPs / runbooks (multi-step procedures) | 5 – 8 |
| Architecture documents (broad context needed) | 6 – 10 |
| Mixed (MOPs + reference + architecture) | 5 – 6 |

---

## 3. Search Method (Hybrid Search)

### What it does

RapidRAG uses **hybrid search**: a combination of vector (semantic) search and BM25 keyword search run in parallel. The results are merged and re-scored before applying the score threshold.

- **Vector search** finds chunks that are semantically similar to the question even if they use different words. Good for natural-language questions.
- **BM25 keyword search** finds chunks that contain the exact words from the question. Good for exact technical terms like command names, IDs, version strings, and product names.

Hybrid search is enabled globally for all KBs. It is not configurable per KB.

### Why this matters

Without hybrid search (vector only), a query like `ncs app backup --id doc-uiv-uiv-neo4j-cbur` would fail to match a chunk that contains `./ncs app backup --id doc-uiv-uiv-neo4j-cbur` because the command string has low semantic similarity. With BM25 enabled, the exact command string is matched directly.

### Symptom: hybrid search is not helping

If retrieval quality is still poor after enabling hybrid search, the likely cause is the score threshold being set incorrectly, not the search method. Check the threshold first.

---

## 4. Conversation Thread Lifetime

### What it does

Each user's Slack conversation is tracked as a **thread**. The thread stores the Dify `conversation_id` which gives the AI model memory of previous messages in the same session. When a thread expires, the next message starts a completely fresh AI session with no memory of prior questions.

### Default

`30 minutes` of inactivity

### Why it exists

Dify sends the AI model the full history of previous turns including every retrieved document chunk from all prior questions. If a user asks about Topic A, then Topic B, then Topic A again — the model still has Topic B's document chunks in its context window. This causes the model to blend content from different topics.

A 30-minute inactivity timeout ensures that a user returning after a break starts fresh instead of carrying stale context from a session hours earlier.

### Symptoms: lifetime causes problems

| Symptom | Cause |
|---|---|
| Follow-up question ("explain step 2") works within a session but not after a break | The thread expired; the model no longer has the previous answer in context |
| Returning user gets a fresh answer on a follow-up they expected to be continued | Correct behaviour — thread expired after 30 min of inactivity |

### How to change it (code change required)

The lifetime is defined in `apps/workflow-service/src/main.ts`:

```typescript
expiresAt: new Date(now.getTime() + 30 * 60 * 1000)
```

Change `30` to the desired number of minutes, rebuild, and restart `workflow-service`.

---

## 5. Conversation Topic Detection

### What it does

Before every Dify call, RapidRAG automatically decides whether the current message is a **follow-up** to the previous question or a **new independent topic**.

- **Follow-up detected** → reuse the existing `conversation_id` so the AI has context of the previous answer
- **New topic detected** → use `null` as `conversation_id`, forcing a completely fresh Dify session with no prior context

This prevents the most common wrong-answer scenario: asking about backup, then certificates, then backup again — and getting the certificate answer for the third question because the model still had certificate chunks in context.

### How topic detection works

The classifier runs three checks in order:

**1. Explicit phrases** — if the message starts with a known follow-up phrase, it is classified as a follow-up:

```
"what about", "also", "similarly", "following up", "continuing with",
"regarding that", "and the", "tell me more", "elaborate", "clarify",
"what does that mean", "show me more", "going back"
```

**2. Back-references** — if the message contains words that refer to something already said, it is a follow-up:

```
"step 2", "point 3", "number 1", "the above", "as mentioned",
"previously", "same command", "same step"
```

**3. Keyword overlap** — if 35% or more of the meaningful words in the new question appear in the previous question, it is a follow-up. Stop words (`what`, `how`, `the`, `for`, etc.) are excluded from this comparison.

If none of the three checks match, the question is classified as a **new topic** and the conversation is reset automatically.

### Examples

| Previous question | New question | Classification | Reason |
|---|---|---|---|
| "backup procedure for UIV" | "install certificate in UIV" | New topic | No overlap, no back-reference |
| "backup procedure for UIV" | "what does the expected output look like?" | New topic | No shared keywords, no back-reference (use `/kb reset` or rephrase as "what is the backup expected output?") |
| "backup procedure for UIV" | "what about the rollback steps?" | Follow-up | Starts with "what about" |
| "NCS backup command" | "similarly for the restore command?" | Follow-up | Starts with "similarly" |
| "backup procedure for UIV" | "backup procedure for NorC" | Follow-up | "backup" and "procedure" overlap > 35% — *note: this is a known edge case; use `/kb reset` if needed* |

### Known limitation

Questions that are conceptually follow-ups but share no keywords and use no explicit phrases will be classified as new topics. For example: "What does the expected output look like?" after a backup question. In these cases, users can:

1. Use `/kb reset` first and rephrase: "What is the expected output of the UIV backup command?"
2. Or include a back-reference: "What is the expected output of step 2 above?"

---

## 6. Explicit Conversation Reset — `/kb reset`

### What it does

`/kb reset` is a Slack slash command that immediately clears the conversation history for the current user. The next question starts with a completely fresh AI session regardless of how recently the last question was asked.

### When to use it

- You asked about Topic A, then Topic B, and now want to go back to Topic A without any Topic B contamination — type `/kb reset` first
- The AI is giving answers that seem to mix content from two previous topics
- You are starting a completely different investigation and want a clean context

### Usage

```
/kb reset
```

Response: `Conversation reset. Your next question will start a fresh context.`

### All /kb commands

| Command | Description |
|---|---|
| `/kb list` | List all knowledge bases mapped to this bot |
| `/kb use <name-or-number>` | Switch to a specific knowledge base |
| `/kb all` | Activate all mapped knowledge bases |
| `/kb status` | Show which knowledge bases are currently active |
| `/kb reset` | Clear conversation history and start fresh |
| `/kb <question>` | Ask a question directly |

---

## Quick Diagnostic Reference

Use this table when a user reports wrong or missing answers:

| User complaint | First check | Likely fix |
|---|---|---|
| "It answered with content from a completely different topic" | Score threshold too low | Raise threshold from 0.4 → 0.5 or 0.6 |
| "It gave me generic steps not from our documents" | Score threshold too low, no relevant chunks passed | Raise threshold; ensure docs are indexed |
| "It says the information doesn't exist but I know it's in the docs" | Score threshold too high | Lower threshold from 0.4 → 0.3 or 0.35 |
| "The answer is correct but cuts off halfway through the procedure" | top_k too low | Raise top_k from 4 → 6 or 8 |
| "The answer mixes two procedures together" | top_k too high or threshold too low | Lower top_k; raise threshold |
| "Second time I asked the same question I got the previous question's answer" | Conversation context contamination | User should send `/kb reset`; long-term: raise threshold so off-topic chunks are rejected |
| "It doesn't find exact command strings like `ncs app backup --id`" | Hybrid search | Already enabled globally; check if KB was re-provisioned after the change |
| "Follow-up question lost context after a break" | Thread expired (30 min inactivity) | Expected behaviour; user should re-ask with full context |
