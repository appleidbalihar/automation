console.log("Keycloak realm import is configured via infra/keycloak/realm-export.json");
console.log("The realm import is bootstrap-only; users persist in the keycloak_data Docker volume.");
console.log("Ensure the platform admin user with: ENVIRONMENT=dev bash scripts/seed-keycloak-platform-admin.sh");
console.log("Credentials are Vault-backed. Read them with: ENVIRONMENT=dev SHOW_VALUES=true PATH_FILTER=infra/keycloak bash scripts/list-secrets.sh");
