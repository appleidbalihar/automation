# Automation Platform Requirement Document (Codex Ready SRS - Enterprise Edition)

## 1. Executive Summary
The platform is a microservices-based enterprise-grade automation system designed for large-scale organizations. It supports GUI and API-driven workflow execution with a no-code user experience.

The platform shall provide:
- Enterprise-grade UI/UX
- Secure and scalable architecture
- Configurable workflows without coding
- AI-powered operational assistance (RAG + Chat)

---

## 2. Enterprise UI/UX Requirement

The platform UI shall be **enterprise-grade, production-ready, and customer-facing**.

### Requirements:
- Clean, modern, responsive design
- Two-panel layout:
  - Left: Navigation
  - Right: Dynamic workspace
- High usability for operations teams
- Dark/Light mode support (recommended)
- Accessibility compliance (WCAG recommended)
- Real-time status indicators
- Visual workflow builder (no-code)

### Goal:
The UI must be suitable for **selling to large enterprises** and used by:
- Network engineers
- Operations teams
- Admin users

---

## 3. Core Concepts

- Workflow
- Node
- Config Type (Slice, DNN, etc.)
- Step
- Order

---

## 4. Execution Logic

For each Node:
- Check config existence
- Skip already configured
- Execute only missing configs
- Handle failure with Retry / Continue / Rollback

---

## 5. Step Model

Each step includes:
- Step Name
- Execution Type (REST, SSH, NETCONF, Script)
- Command Reference
- Input Variables
- Success Criteria
- Retry Policy
- Rollback Action

---

## 6. Order Execution Flow

1. Input → Authentication  
2. Create Parent Task  
3. Process Nodes sequentially  
4. Per node:
   - Config check
   - Approval (if needed)
   - Execute steps
   - Failure handling  
5. Final status:
   - Success
   - Partial
   - Failed  

---

## 7. Failure Handling

- Retry: Re-run step or node  
- Continue: Mark failed and proceed  
- Rollback: Reverse executed steps  

---

## 8. Logging

- Step-level logs  
- Payload + response  
- Error source (SBI / internal)  
- Timestamp and duration  

---

## 9. API Examples

- POST /workflow  
- POST /order/execute  
- POST /order/retry  
- POST /order/rollback  
- GET /logs  

---

## 10. Microservices Architecture

- Workflow Service  
- Order Service  
- Execution Engine  
- Integration Service  
- Logging Service  
- RAG Service (NEW)  
- Chat Service (NEW)  

---

## 11. RAG + Chat Interface (NEW FEATURE)

### Purpose:
Provide **AI-powered operational assistance** for users.

### Capabilities:
- Users can ask questions about:
  - How to use workflows
  - Platform operations
  - Order status interpretation
  - Troubleshooting guidance

### Restrictions:
- ❌ No code-level or backend implementation details exposed
- ✅ Only operational and usage-level responses

### Architecture:
- RAG (Retrieval-Augmented Generation) service
- Knowledge sources:
  - Workflow metadata
  - Logs
  - Documentation
  - User guides

### Chat UI:
- Integrated in dashboard
- Context-aware (order/workflow level)
- Supports:
  - Query history
  - Suggestions
  - Smart recommendations

---

## 12. Security

- RBAC  
- OAuth2 / API Key  
- Secure credential storage  
- Data masking for logs  

---

## 13. Documentation Strategy (VERY IMPORTANT)

For each feature/module, the system shall generate:

### 1. Developer Documentation
Location:
```
/docs/developer/
```

Includes:
- Architecture
- APIs
- Data models
- Internal logic

---

### 2. Operational Documentation
Location:
```
/docs/operations/
```

Includes:
- How to use feature
- UI guidance
- Troubleshooting
- No code-level details

---

### Rule:
Every feature must have:
- One developer MD file
- One operations MD file

---

## 14. Final Status

- Success: All nodes success  
- Partial: Mixed  
- Failed: All failed  

---

## 15. Future Enhancements (Recommended)

- Multi-tenant support  
- Workflow versioning  
- Audit trails  
- Notification system  
- SLA monitoring  

