import type { Octokit } from "octokit";

import { getAppInfo, getInstallationOctokit } from "@/lib/github";
import type { Tenant } from "@/lib/tenants";

export type ReviewDecision = "approve" | "comment" | "request_changes";

export interface SubmitResult {
  duplicate?: boolean;
  reason: string;
  submitted: boolean;
}

const REVIEW_EVENT: Record<
  ReviewDecision,
  "APPROVE" | "COMMENT" | "REQUEST_CHANGES"
> = {
  approve: "APPROVE",
  comment: "COMMENT",
  request_changes: "REQUEST_CHANGES",
};

const REVIEW_STATE: Record<
  ReviewDecision,
  "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
> = {
  approve: "APPROVED",
  comment: "COMMENTED",
  request_changes: "CHANGES_REQUESTED",
};

const botReviews = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  botLogin: string
) => {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });

  return reviews.filter((review) => review.user?.login === botLogin);
};

/**
 * Submits the single review that carries the agent's findings.
 *
 * GitHub moves the commit a review points at forward when the branch gets new
 * commits, so verdicts are recognised by submission time rather than by commit:
 * a change request made during this run means the agent already blocked the pull
 * request outside the tool, and a previous approval is not repeated.
 */
export const submitReview = async (
  tenant: Tenant,
  repoFullName: string,
  prNumber: number,
  decision: ReviewDecision,
  body: string,
  runStartedAt: Date
): Promise<SubmitResult> => {
  const [owner, repo] = repoFullName.split("/");
  const octokit = await getInstallationOctokit(tenant);
  const { slug } = await getAppInfo(tenant);
  const botLogin = `${slug}[bot]`;

  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    pull_number: prNumber,
    repo,
  });

  if (pull.state !== "open") {
    return { reason: `Pull request is ${pull.state}`, submitted: false };
  }

  if (pull.draft) {
    return { reason: "Pull request is a draft", submitted: false };
  }

  const previous = (
    await botReviews(octokit, owner, repo, prNumber, botLogin)
  ).filter((review) =>
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
  );

  const requestedChangesDuringRun = previous.some(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      review.submitted_at !== undefined &&
      new Date(review.submitted_at) >= runStartedAt
  );

  if (requestedChangesDuringRun) {
    return {
      reason: "A change request was already submitted during this run",
      submitted: false,
    };
  }

  const latest = previous.at(-1);

  // Two triggers for the same pull request can produce the same review; posting
  // it twice would only add noise.
  if (
    latest?.state === REVIEW_STATE[decision] &&
    (latest.body ?? "").trim() === body.trim()
  ) {
    return {
      duplicate: true,
      reason: "An identical review is already on the pull request",
      submitted: false,
    };
  }

  if (decision === "approve" && latest?.state === "APPROVED") {
    return { reason: "Already approved", submitted: false };
  }

  await octokit.rest.pulls.createReview({
    body: body.length > 0 ? body : undefined,
    event: REVIEW_EVENT[decision],
    owner,
    pull_number: prNumber,
    repo,
  });

  return {
    reason: `${decision} on ${pull.head.sha.slice(0, 7)}`,
    submitted: true,
  };
};
