-- Phase 80 — Workflow engine.
--
-- A trigger → condition → action engine for cross-module orchestration.
-- Goal: stop hard-coding chains like "on hire → notify manager → assign
-- training → enroll in 401k" inside route handlers. Each WorkflowDefinition
-- declares (trigger event, optional conditions JSON, ordered list of
-- actions). When a trigger event fires, every active matching definition
-- spawns a WorkflowRun with one WorkflowStep per action; steps execute in
-- order and persist their state.

CREATE TYPE "WorkflowTrigger" AS ENUM (
  'ASSOCIATE_HIRED',
  'ASSOCIATE_TERMINATED',
  'TIME_OFF_REQUESTED',
  'TIME_OFF_APPROVED',
  'TIME_OFF_DENIED',
  'POSITION_OPENED',
  'POSITION_FILLED',
  'PAYROLL_FINALIZED',
  'ONBOARDING_COMPLETED',
  'COMPLIANCE_EXPIRING'
);

CREATE TYPE "WorkflowActionKind" AS ENUM (
  'SEND_NOTIFICATION',  -- channel + recipient role + body template
  'SET_FIELD',          -- update a field on the entity (e.g. status)
  'ASSIGN_TASK',        -- create an onboarding-style task
  'CREATE_AUDIT_LOG',   -- append an audit entry
  'WEBHOOK'             -- POST to a configured URL (future: signed)
);

CREATE TYPE "WorkflowRunStatus" AS ENUM (
  'PENDING',     -- waiting for execution
  'RUNNING',     -- mid-step
  'COMPLETED',   -- all steps finished successfully
  'FAILED',      -- a step errored and didn't recover
  'CANCELLED'    -- HR aborted
);

CREATE TYPE "WorkflowStepStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "WorkflowDefinition" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID,    -- NULL = applies across all clients (Alto-internal)
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "trigger"     "WorkflowTrigger" NOT NULL,
  -- JSONPath / mustache-style condition evaluator. Empty {} means
  -- "always run." Format: { "and": [{ "field": "associate.state",
  -- "op": "eq", "value": "CA" }, ...] }. v1 supports eq/neq/in/nin.
  "conditions"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Ordered list of action definitions:
  -- [{ "kind": "SEND_NOTIFICATION", "params": { ... } }, ...]
  "actions"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "WorkflowDefinition_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "WorkflowDefinition_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "WorkflowDefinition_trigger_isActive_idx"
  ON "WorkflowDefinition" ("trigger", "isActive")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "WorkflowDefinition_clientId_idx" ON "WorkflowDefinition" ("clientId");

CREATE TABLE "WorkflowRun" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "definitionId"  UUID NOT NULL,
  -- Captured at trigger time so the run can survive definition edits.
  "trigger"       "WorkflowTrigger" NOT NULL,
  -- Reference to the entity that triggered this run. EntityType is the
  -- Prisma model name ("Associate", "TimeOffRequest", etc.); entityId is
  -- the UUID PK. Useful for "show me every workflow run for associate X".
  "entityType"    TEXT NOT NULL,
  "entityId"      TEXT NOT NULL,
  -- Snapshot of the input event payload — drives mustache substitution
  -- inside actions and is also what conditions evaluate against.
  "context"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"        "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt"     TIMESTAMPTZ(6),
  "completedAt"   TIMESTAMPTZ(6),
  "failureReason" TEXT,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WorkflowRun_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE
);
CREATE INDEX "WorkflowRun_definitionId_status_idx" ON "WorkflowRun" ("definitionId", "status");
CREATE INDEX "WorkflowRun_entityType_entityId_idx" ON "WorkflowRun" ("entityType", "entityId");
CREATE INDEX "WorkflowRun_status_createdAt_idx" ON "WorkflowRun" ("status", "createdAt" DESC);

CREATE TABLE "WorkflowStep" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "runId"         UUID NOT NULL,
  -- 0-indexed position in the action list.
  "ordinal"       INTEGER NOT NULL,
  "kind"          "WorkflowActionKind" NOT NULL,
  -- Snapshot of the action's params at trigger time.
  "params"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"        "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
  -- Execution output (notification id, audit-log id, webhook response, etc.)
  "result"        JSONB,
  "failureReason" TEXT,
  "startedAt"     TIMESTAMPTZ(6),
  "completedAt"   TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WorkflowStep_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE,
  CONSTRAINT "WorkflowStep_ordinal_unique"
    UNIQUE ("runId", "ordinal")
);
CREATE INDEX "WorkflowStep_runId_idx" ON "WorkflowStep" ("runId");
CREATE INDEX "WorkflowStep_status_idx" ON "WorkflowStep" ("status");
