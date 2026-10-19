import { env } from "@/lib/env";
import { parseError } from "@/lib/error";
import { getInstallationOctokit } from "@/lib/github";
import { getTenantOrThrow } from "@/lib/tenants";
import type { Workspace } from "@/lib/workspace";
import { createWorkspace, removeWorkspace } from "@/lib/workspace";

import { addPRComment } from "./add-pr-comment";
import { buildReviewBody, createReviewContext } from "./context";
import { getGitHubToken } from "./get-github-token";
import { runAgent } from "./run-agent";
import { submitReview } from "./submit-review";
import type { ReviewDecision } from "./submit-review";

export interface ThreadMessage {
  content: string;
  role: "assistant" | "user";
}

export interface ReviewParams {
  headSha: string;
  messages: ThreadMessage[];
  prBranch: string;
  prNumber: number;
  repoFullName: string;
  /** Registry key of the tenant whose GitHub App owns this repository. */
  tenantKey: string;
  threadId: string;
  trigger: "auto" | "mention";
}

export const AUTO_REVIEW_INSTRUCTION = `Review the changes in this pull request and submit your review with the submitReview tool.

Read the code; this environment cannot run builds or tests. Report findings by severity and set the verdict: request_changes for anything that must be fixed before merging, approve otherwise.`;

const runReview = async (params: ReviewParams): Promise<void> => {
  const {
    messages,
    prBranch,
    prNumber,
    repoFullName,
    tenantKey,
    threadId,
  } = params;

  const tenant = getTenantOrThrow(tenantKey);
  const token = await getGitHubToken(tenant);
  const octokit = await getInstallationOctokit(tenant);
  const [owner, repo] = repoFullName.split("/");

  // The pull request may have been closed while this review was queued: a
  // closed or merged one is history, so nothing is read and nothing is posted.
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    pull_number: prNumber,
    repo,
  });

  if (pull.state !== "open") {
    console.log(
      `[review] skipped ${repoFullName}#${prNumber}: pull request is ${pull.state}`
    );

    return;
  }

  // Only verdicts produced after this point belong to this run.
  const runStartedAt = new Date();
  const context = createReviewContext();

  // One signal bounds the whole run: the checkout and the agent both stop.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("review timed out")),
    env.RUN_TIMEOUT_MS
  );

  let workspace: Workspace | null = null;

  try {
    workspace = await createWorkspace(
      repoFullName,
      token,
      prBranch,
      controller.signal
    );

    const agentResult = await runAgent(
      workspace,
      context,
      { octokit, owner, prNumber, repo },
      messages,
      controller.signal
    );

    if (!agentResult.success) {
      throw new Error(agentResult.errorMessage ?? "Agent failed to run");
    }

    const body = buildReviewBody(context);

    // A review with no text means the agent reported nothing, which is not a
    // reason to approve.
    if (body.length === 0) {
      console.log(
        `[review] skipped review for ${repoFullName}#${prNumber}: the agent produced no findings`
      );
      return;
    }

    // A recovered review (the model answered with text instead of the
    // submitReview call) has no verdict, so its intent is unknown: publish it
    // as a comment rather than auto-approving.
    const decision: ReviewDecision = context.verdict === "request_changes"
      ? "request_changes"
      : context.verdict === "approve"
        ? env.AUTO_APPROVE
          ? "approve"
          : "comment"
        : "comment";

    const result = await submitReview(
      tenant,
      repoFullName,
      prNumber,
      decision,
      body,
      runStartedAt
    );

    console.log(
      `[review] ${result.submitted ? "submitted" : "skipped"} review for ${repoFullName}#${prNumber}: ${result.reason}`
    );

    // The review is the only output channel, so a review that could not be
    // submitted as a verdict is still published as a review body rather than a
    // separate comment — unless it is already on the pull request.
    if (!(result.submitted || result.duplicate || decision === "comment")) {
      const retry = await submitReview(
        tenant,
        repoFullName,
        prNumber,
        "comment",
        body,
        runStartedAt
      );

      console.log(
        `[review] ${retry.submitted ? "submitted" : "dropped"} the findings for ${repoFullName}#${prNumber}: ${retry.reason}`
      );
    }
  } catch (error) {
    try {
      await addPRComment(
        tenant,
        threadId,
        `## Error

An error occurred while processing your request:

\`\`\`
${parseError(error)}
\`\`\``
      );
    } catch {
      // Ignore comment failure
    }

    throw error;
  } finally {
    clearTimeout(timeout);

    if (workspace) {
      await removeWorkspace(workspace.dir);
    }
  }
};

let queue: Promise<void> = Promise.resolve();
let queued = 0;
const scheduled = new Map<string, string>();

/**
 * Reviews are serialised: one checkout and one agent run at a time keeps the
 * host within its CPU, memory and API rate limits.
 *
 * The same revision is only reviewed once: a comment that mentions the bot also
 * raises a `pull_request` event, and a review that is already queued for that
 * commit wins. A different commit still gets its own review.
 */
export const enqueueReview = (params: ReviewParams): Promise<void> => {
  const key = `${params.repoFullName}#${params.prNumber}`;
  const revision = params.headSha || "";
  const revisionLabel = revision ? ` @ ${revision.slice(0, 7)}` : "";

  // Without a commit there is nothing to key on, so the trigger is honoured.
  if (revision && scheduled.get(key) === revision) {
    console.log(
      `[review] dropping the ${params.trigger} trigger for ${key}${revisionLabel}: that revision is already queued`
    );

    return Promise.resolve();
  }

  if (revision) {
    scheduled.set(key, revision);
  }

  queued += 1;
  console.log(
    `[review] queued ${key}${revisionLabel} (${params.trigger}), ${queued} pending`
  );

  const run = queue.then(async () => {
    queued -= 1;
    const startedAt = Date.now();

    try {
      await runReview(params);
      console.log(
        `[review] finished ${key} in ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
    } catch (error) {
      console.error(`[review] failed ${key}: ${parseError(error)}`);
    } finally {
      if (revision && scheduled.get(key) === revision) {
        scheduled.delete(key);
      }
    }
  });

  queue = run;

  return run;
};
