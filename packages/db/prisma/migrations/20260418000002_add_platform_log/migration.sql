CREATE TABLE "PlatformLog" (
    "id"            TEXT         NOT NULL,
    "severity"      TEXT         NOT NULL,
    "source"        TEXT         NOT NULL,
    "message"       TEXT         NOT NULL,
    "maskedPayload" JSONB,
    "correlationId" TEXT,
    "durationMs"    INTEGER,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformLog_source_createdAt_idx" ON "PlatformLog"("source", "createdAt");
CREATE INDEX "PlatformLog_correlationId_idx" ON "PlatformLog"("correlationId");
CREATE INDEX "PlatformLog_severity_createdAt_idx" ON "PlatformLog"("severity", "createdAt");
