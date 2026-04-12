import { readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { X509Certificate } from "node:crypto";
import { Agent } from "undici";

export interface TlsRuntimeConfig {
  serviceName: string;
  enabled: boolean;
  certPath: string;
  keyPath: string;
  caPath: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  verifyPeer?: boolean;
  serverName?: string;
  reloadDebounceMs?: number;
  diagnosticsToken?: string;
}

type TlsMaterial = {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  fingerprint: string;
  subjectAltName: string;
  validFrom: string;
  validTo: string;
};

type ReloadListener = (error?: Error) => void;

export type TlsStatus = {
  enabled: boolean;
  serviceName: string;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprint?: string;
  subjectAltName?: string;
  validFrom?: string;
  validTo?: string;
  reloadFailures: number;
  lastReloadAt?: string;
};

function loadMaterial(config: TlsRuntimeConfig): TlsMaterial {
  const cert = readFileSync(config.certPath);
  const key = readFileSync(config.keyPath);
  const ca = readFileSync(config.caPath);
  const x509 = new X509Certificate(cert);
  return {
    cert,
    key,
    ca,
    fingerprint: x509.fingerprint256,
    subjectAltName: x509.subjectAltName ?? "",
    validFrom: x509.validFrom,
    validTo: x509.validTo
  };
}

export class TlsRuntime {
  private material?: TlsMaterial;
  private clientAgent?: Agent;
  private watchers: Array<ReturnType<typeof watch>> = [];
  private listeners: ReloadListener[] = [];
  private reloadTimer?: NodeJS.Timeout;
  private reloadFailures = 0;
  private lastReloadAt?: string;

  constructor(private readonly config: TlsRuntimeConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get diagnosticsToken(): string | undefined {
    return this.config.diagnosticsToken;
  }

  initOrThrow(): void {
    if (!this.config.enabled) return;
    this.material = loadMaterial(this.config);
    this.rebuildClientAgent();
  }

  startWatching(): void {
    if (!this.config.enabled) return;
    const paths = new Set([
      dirname(this.config.certPath),
      dirname(this.config.keyPath),
      dirname(this.config.caPath)
    ]);
    for (const path of paths) {
      const watcher = watch(path, () => {
        this.scheduleReload();
      });
      this.watchers.push(watcher);
    }
  }

  onReload(listener: ReloadListener): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    await this.clientAgent?.close().catch(() => undefined);
  }

  getStatus(): TlsStatus {
    if (!this.config.enabled) {
      return {
        enabled: false,
        serviceName: this.config.serviceName,
        reloadFailures: this.reloadFailures
      };
    }
    return {
      enabled: true,
      serviceName: this.config.serviceName,
      certPath: this.config.certPath,
      keyPath: this.config.keyPath,
      caPath: this.config.caPath,
      fingerprint: this.material?.fingerprint,
      subjectAltName: this.material?.subjectAltName,
      validFrom: this.material?.validFrom,
      validTo: this.material?.validTo,
      reloadFailures: this.reloadFailures,
      lastReloadAt: this.lastReloadAt
    };
  }

  getServerOptions(): { key: Buffer; cert: Buffer; ca: Buffer; requestCert: boolean; rejectUnauthorized: boolean; minVersion: "TLSv1.2" } | undefined {
    if (!this.config.enabled || !this.material) return undefined;
    return {
      key: this.material.key,
      cert: this.material.cert,
      ca: this.material.ca,
      requestCert: this.config.requestCert ?? true,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      minVersion: "TLSv1.2"
    };
  }

  applyServerSecureContext(server: unknown): void {
    if (!this.config.enabled || !this.material) return;
    if (!server || typeof (server as { setSecureContext?: unknown }).setSecureContext !== "function") return;
    (server as { setSecureContext: (options: { key: Buffer; cert: Buffer; ca: Buffer }) => void }).setSecureContext({
      key: this.material.key,
      cert: this.material.cert,
      ca: this.material.ca
    });
  }

  getClientDispatcher(): Agent | undefined {
    if (!this.config.enabled) return undefined;
    return this.clientAgent;
  }

  getAmqpTlsOptions(): {
    cert?: Buffer;
    key?: Buffer;
    ca?: Buffer[];
    rejectUnauthorized: boolean;
    servername?: string;
  } {
    if (!this.config.enabled || !this.material) {
      return { rejectUnauthorized: this.config.verifyPeer !== false };
    }
    return {
      cert: this.material.cert,
      key: this.material.key,
      ca: [this.material.ca],
      rejectUnauthorized: this.config.verifyPeer !== false,
      servername: this.config.serverName
    };
  }

  private scheduleReload(): void {
    const waitMs = this.config.reloadDebounceMs ?? 1000;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reloadNow();
    }, waitMs);
  }

  private reloadNow(): void {
    try {
      this.material = loadMaterial(this.config);
      this.rebuildClientAgent();
      this.lastReloadAt = new Date().toISOString();
      for (const listener of this.listeners) listener(undefined);
    } catch (error) {
      this.reloadFailures += 1;
      const err = error instanceof Error ? error : new Error(String(error));
      for (const listener of this.listeners) listener(err);
    }
  }

  private rebuildClientAgent(): void {
    const previous = this.clientAgent;
    if (!this.material) return;
    this.clientAgent = new Agent({
      connect: {
        cert: this.material.cert,
        key: this.material.key,
        ca: this.material.ca,
        rejectUnauthorized: this.config.verifyPeer !== false,
        servername: this.config.serverName
      }
    });
    if (previous) {
      previous.close().catch(() => undefined);
    }
  }
}

export function createTlsRuntime(config: TlsRuntimeConfig): TlsRuntime {
  const runtime = new TlsRuntime(config);
  runtime.initOrThrow();
  return runtime;
}

export async function tlsFetch(runtime: TlsRuntime, input: string | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = runtime.getClientDispatcher();
  if (!dispatcher) {
    return fetch(input, init);
  }
  return fetch(input, { ...(init ?? {}), dispatcher } as RequestInit & { dispatcher: Agent });
}

export async function connectAmqp(
  runtime: TlsRuntime,
  connectFn: (
    url: string,
    options?: {
      cert?: Buffer;
      key?: Buffer;
      ca?: Buffer[];
      rejectUnauthorized?: boolean;
      servername?: string;
    }
  ) => Promise<unknown>,
  url: string
): Promise<unknown> {
  if (!/^amqps:\/\//i.test(url)) {
    return connectFn(url);
  }
  return connectFn(url, runtime.getAmqpTlsOptions());
}
