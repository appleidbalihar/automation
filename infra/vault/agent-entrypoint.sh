#!/usr/bin/env sh
set -eu

SERVICE_NAME="${SERVICE_NAME:?SERVICE_NAME is required}"
VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
ROLE_DIR="${ROLE_DIR:-/vault/file/approle/${SERVICE_NAME}}"
TLS_OUTPUT_DIR="${TLS_OUTPUT_DIR:-/tls}"
COMMON_NAME="${CERT_COMMON_NAME:-${SERVICE_NAME}}"
ALT_NAMES="${CERT_ALT_NAMES:-${SERVICE_NAME},localhost}"
IP_SANS="${CERT_IP_SANS:-}"
TTL="${CERT_TTL:-8760h}"
AGENT_LISTEN_ADDR="${VAULT_AGENT_LISTEN_ADDR:-0.0.0.0:8200}"

mkdir -p "${TLS_OUTPUT_DIR}"

cat >/tmp/vault-agent.hcl <<EOF
pid_file = "/tmp/vault-agent.pid"

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path = "${ROLE_DIR}/role_id"
      secret_id_file_path = "${ROLE_DIR}/secret_id"
      remove_secret_id_file_after_reading = "false"
    }
  }

  sink "file" {
    config = {
      path = "/tmp/vault-agent-token"
    }
  }
}

listener "tcp" {
  address = "${AGENT_LISTEN_ADDR}"
  tls_disable = true
}

cache {
  use_auto_auth_token = true
}

template {
  destination = "${TLS_OUTPUT_DIR}/cert.pem"
  perms = "0644"
  contents = "{{ with secret \"pki_int/issue/${SERVICE_NAME}\" \"common_name=${COMMON_NAME}\" \"alt_names=${ALT_NAMES}\" \"ip_sans=${IP_SANS}\" \"ttl=${TTL}\" \"private_key_format=pkcs8\" }}{{ .Data.certificate }}\n{{ .Data.issuing_ca }}\n{{ end }}"
}

template {
  destination = "${TLS_OUTPUT_DIR}/key.pem"
  perms = "0644"
  contents = "{{- with secret \"pki_int/issue/${SERVICE_NAME}\" \"common_name=${COMMON_NAME}\" \"alt_names=${ALT_NAMES}\" \"ip_sans=${IP_SANS}\" \"ttl=${TTL}\" \"private_key_format=pkcs8\" -}}{{ .Data.private_key }}{{ end }}"
}

template {
  destination = "${TLS_OUTPUT_DIR}/ca.pem"
  perms = "0644"
  contents = "{{ with secret \"pki_int/cert/ca\" }}{{ .Data.certificate }}\n{{ end }}{{ with secret \"pki/cert/ca\" }}{{ .Data.certificate }}\n{{ end }}"
}

vault {
  address = "${VAULT_ADDR}"
}
EOF

exec vault agent -config=/tmp/vault-agent.hcl
