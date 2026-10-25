import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";
const AGENT_WRITE_WITHOUT_RUN_CONTEXT_ACTIVITY = "issue.agent_write_without_run_context";

/**
 * Operator switch for the run-context requirement on agent issue writes.
 *
 * `required` (default): every agent comment, issue update, and interaction
 * card must carry a persisted heartbeat run bound to the agent and company,
 * so the per-run cross-issue cap can be counted (SPEC §9.3).
 *
 * `optional`: an agent that authenticates with its long-lived agent key from
 * outside a Paperclip-triggered run (a remote daemon, a manual CLI session,
 * an operator-driven chat) may still write. There is no run to charge, so the
 * write is audited as `issue.agent_write_without_run_context` instead of
 * counted. Requests that *do* present a run id are validated and capped
 * exactly as before, so a bogus header never buys more than no header.
 */
export const AGENT_ISSUE_WRITE_RUN_CONTEXT_ENV_KEY = "PAPERCLIP_AGENT_ISSUE_WRITE_RUN_CONTEXT";

export type AgentIssueWriteRunContextPolicy = "required" | "optional";

export function agentIssueWriteRunContextPolicy(
  env: Record<string, string | undefined> = process.env,
): AgentIssueWriteRunContextPolicy {
  const raw = env[AGENT_ISSUE_WRITE_RUN_CONTEXT_ENV_KEY]?.trim().toLowerCase();
  return raw === "optional" ? "optional" : "required";
}

export function agentIssueWriteRunContextOptional(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return agentIssueWriteRunContextPolicy(env) === "optional";
}

/**
 * Every kind shares one per-run counter. `interaction_resolution` covers the
 * issue-thread accept/reject/respond/verdict routes: an open `anyone` resolver
 * audience is not a licence to resolve, wake, and spawn suggested tasks across
 * the whole company from one run.
 */
export type CrossIssueInfluenceKind = "comment" | "update" | "interaction_resolution";

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
};

export function crossIssueInfluenceRunContextError() {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required");
  return forbidden(body.error, body.details);
}

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= CROSS_ISSUE_INFLUENCE_LIMIT,
    mode,
    count: nextCount,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
  };
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    now?: Date;
    /** Defaults to the process-wide `PAPERCLIP_AGENT_ISSUE_WRITE_RUN_CONTEXT` policy. */
    runContextPolicy?: AgentIssueWriteRunContextPolicy;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  const runContextPolicy = input.runContextPolicy ?? agentIssueWriteRunContextPolicy();
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  return db.transaction(async (tx) => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      throw crossIssueInfluenceRunContextError();
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) {
      // A real run of this agent with no issue in its context (manual wake,
      // routine, chat) has nothing to contain against. Under the optional
      // policy that is an uncounted write, not a refusal.
      if (runContextPolicy === "optional") {
        logger.info(
          {
            event: "cross_issue_influence_cap",
            companyId: input.companyId,
            runId: input.runId,
            agentId: input.agentId,
            targetIssueId: input.targetIssueId,
            kind: input.kind,
            policy: runContextPolicy,
          },
          "agent issue write from a run without a source issue allowed by optional run-context policy",
        );
        return null;
      }
      throw crossIssueInfluenceRunContextError();
    }
    if (
      sourceIssueId === input.targetIssueId ||
      (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
    ) {
      return null;
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
      action: decision.allowed
        ? CROSS_ISSUE_INFLUENCE_ACTIVITY
        : CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        count: decision.count,
        cap: decision.cap,
        mode: decision.mode,
        enforceAt: decision.enforceAt,
        allowed: decision.allowed,
      },
    });

    const logContext = {
      event: "cross_issue_influence_cap",
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      sourceIssueId,
      targetIssueId: input.targetIssueId,
      kind: input.kind,
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
      allowed: decision.allowed,
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    return decision;
  });
}

/**
 * Audits an agent issue write that arrived with no heartbeat run at all while
 * the run-context policy is `optional`. Callers must check the policy first;
 * this never decides, it only records so the activity stream still names who
 * wrote to which issue from outside a run.
 */
export async function recordAgentIssueWriteWithoutRunContext(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
  },
): Promise<void> {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    agentId: input.agentId,
    runId: null,
    responsibleUserId: input.responsibleUserId ?? null,
    action: AGENT_WRITE_WITHOUT_RUN_CONTEXT_ACTIVITY,
    entityType: "issue",
    entityId: input.targetIssueId,
    details: {
      kind: input.kind,
      targetIssueId: input.targetIssueId,
      targetIssueIdentifier: input.targetIssueIdentifier ?? null,
      policy: "optional" satisfies AgentIssueWriteRunContextPolicy,
      envKey: AGENT_ISSUE_WRITE_RUN_CONTEXT_ENV_KEY,
    },
  });
  logger.info(
    {
      event: "agent_issue_write_without_run_context",
      companyId: input.companyId,
      agentId: input.agentId,
      targetIssueId: input.targetIssueId,
      kind: input.kind,
      policy: "optional",
    },
    "agent issue write without heartbeat run allowed by optional run-context policy",
  );
}

export function crossIssueInfluenceLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null; assigneeLabel?: string | null; issueIdentifier?: string | null } = {},
) {
  // The cap is a rate backstop, not a permission decision — the shared copy
  // contract says so explicitly, and names the next run as the way forward.
  const { body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
    ...context,
    cap: decision.cap,
    count: decision.count,
    enforceAt: decision.enforceAt,
  });
  return {
    error: body.error,
    details: {
      ...body.details,
      cap: decision.cap,
      count: decision.count,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
    },
  };
}
