# Project Rules

1. **Context First:** Always verify via `project_context.json` and existing modules in `packages/`.
2. **API-First Development:** Design API -> swagger -> implement -> test.
3. **UI/UX Responsive:** Mobile/Tablet/Desktop support using centralized themes (found in `packages/ui-kit` and web). No hardcoded styles!
4. **Security:** JWT authentication enforced. No unencrypted secrets logged or saved.
5. **Code Size:** Keep new files strictly under 500 lines. Focus on modularity within apps/packages structure.
6. **Documentation:** Real-time updates to Swagger/Postman with parallel documentation in `docs/developer` and `docs/operations`.
