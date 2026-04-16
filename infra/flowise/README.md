# Flowise Technical Engineer RAG

This folder seeds a Flowise chatflow that:

- loads platform documentation from GitHub
- builds an in-memory RAG index
- answers in a technical support / engineer style
- supports OpenAI-compatible endpoints through the `BasePath` field

## Seed the flow

Run:

```bash
node infra/flowise/seed-flowise.js
```

Optional environment variables:

```bash
FLOWISE_CONTAINER_NAME=09_automationplatform-flowise-1
FLOWISE_TECH_ENGINEER_REPO_LINK=https://github.com/appleidbalihar/automation
FLOWISE_TECH_ENGINEER_REPO_BRANCH=master
FLOWISE_OPENAI_CHAT_MODEL=gpt-4o-mini
FLOWISE_OPENAI_EMBEDDING_MODEL=text-embedding-3-small
FLOWISE_OPENAI_BASEPATH=https://api.fuelix.ai/v1/
```

## In Flowise UI

After seeding:

1. Open the `technical-engineer-rag` chatflow.
2. Connect an `OpenAI API` credential to both the `ChatOpenAI` and `OpenAI Embeddings` nodes.
3. If your provider is OpenAI-compatible, set the `FLOWISE_OPENAI_BASEPATH` variable in Flowise Variables or edit the node `BasePath`.
4. Use the built-in Flowise chat panel to test questions such as:

```text
How do we register a user?
Where can I see the logs?
How is authentication configured?
Which service handles workflow execution?
```
