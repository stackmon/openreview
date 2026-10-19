import type { GitHubRawMessage } from "@chat-adapter/github";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, emoji } from "chat";
import type { Message, Thread } from "chat";

import { env } from "@/lib/env";
import { getAppInfo, getInstallationOctokit } from "@/lib/github";
import type { Tenant } from "@/lib/tenants";
import { getDefaultTenant, tenantOwnsRepository } from "@/lib/tenants";
import { AUTO_REVIEW_INSTRUCTION, enqueueReview } from "@/review";
import type { ThreadMessage } from "@/review";

interface PullRequestEventPayload {
  action: string;
  installation?: { id: number };
  pull_request: {
    author_association?: string;
    base: { ref: string };
    draft?: boolean;
    head: { ref: string; repo?: { full_name: string } | null; sha: string };
    number: number;
    user?: { login: string } | null;
  };
  repository: { full_name: string };
  sender?: { login: string };
}

const REVIEW_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

const isTrustedAssociation = (association: string | undefined): boolean =>
  association !== undefined &&
  env.TRUSTED_ASSOCIATIONS.includes(association.toUpperCase());

const isTrustedPullRequestAuthor = (
  login: string | undefined,
  association: string | undefined
): boolean =>
  isTrustedAssociation(association) ||
  (login !== undefined &&
    env.AUTO_REVIEW_BOTS.includes(login.toLowerCase()));

const collectMessages = async (
  thread: Thread<unknown, unknown>
): Promise<ThreadMessage[]> => {
  const messages: ThreadMessage[] = [];

  for await (const msg of thread.allMessages) {
    messages.push({
      content: msg.text,
      role: msg.author.isMe ? "assistant" : "user",
    });
  }

  return messages;
};

const handleMention = async (
  tenant: Tenant,
  thread: Thread,
  message: Message
) => {
  const raw = message.raw as GitHubRawMessage;

  // Each route is bound to one organization; a webhook that arrives on the
  // wrong route is ignored instead of being processed with these credentials.
  if (!tenantOwnsRepository(tenant, raw.repository.full_name)) {
    console.log(
      `[bot] ignored mention on ${raw.repository.full_name}#${raw.prNumber}: repository is not in ${tenant.org}`
    );
    return;
  }

  const { author_association: association } = raw.comment as {
    author_association?: string;
  };

  // Reviews cost money: only members of the organization that owns the
  // repository may ask for one, everyone else is ignored.
  if (!isTrustedAssociation(association)) {
    console.log(
      `[bot] ignored mention from ${message.author.userName} (${association ?? "unknown"}) on ${raw.repository.full_name}#${raw.prNumber}`
    );
    return;
  }

  const repoFullName = raw.repository.full_name;
  const { prNumber } = raw;

  const octokit = await getInstallationOctokit(tenant);
  const [owner, repo] = repoFullName.split("/");

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    pull_number: prNumber,
    repo,
  });

  // A closed or merged pull request is history: nothing is read, nothing is
  // posted, and not even a reaction is added.
  if (pr.state !== "open") {
    console.log(
      `[bot] ignored mention on ${repoFullName}#${prNumber}: pull request is ${pr.state}`
    );

    return;
  }

  console.log(
    `[bot] mention accepted: ${repoFullName}#${prNumber} by ${message.author.userName}`
  );

  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);

  const messages = await collectMessages(thread);

  await enqueueReview({
    headSha: pr.head.sha,
    messages,
    prBranch: pr.head.ref,
    prNumber,
    repoFullName,
    tenantKey: tenant.key,
    threadId: thread.id,
    trigger: "mention",
  });
};

const bots = new Map<string, Promise<Chat>>();

export const getBot = (tenant?: Tenant): Promise<Chat> => {
  const target = tenant ?? getDefaultTenant();
  let bot = bots.get(target.key);

  if (!bot) {
    bot = initBot(target).catch((error: unknown) => {
      // A failed init should not be cached: the next webhook may retry.
      bots.delete(target.key);
      throw error;
    });

    bots.set(target.key, bot);
  }

  return bot;
};

const initBot = async (tenant: Tenant): Promise<Chat> => {
  const appInfo = await getAppInfo(tenant);

  const botInstance = new Chat({
    adapters: {
      github: createGitHubAdapter({
        appId: tenant.appId,
        botUserId: appInfo.botUserId,
        installationId: tenant.installationId,
        privateKey: tenant.privateKey,
        userName: appInfo.slug,
        webhookSecret: tenant.webhookSecret,
      }),
    },
    logger: env.LOG_LEVEL,
    state: createMemoryState(),
    userName: appInfo.slug,
  });

  botInstance.onNewMention((thread, message) =>
    handleMention(tenant, thread, message)
  );

  botInstance.onSubscribedMessage(async (thread, message) => {
    if (!message.isMention) {
      return;
    }

    await handleMention(tenant, thread, message);
  });

  return botInstance;
};

/**
 * Reviews pull requests automatically when they are opened or updated.
 *
 * The GitHub adapter only listens for comments, so `pull_request` deliveries
 * are handled here. Events sent by the app itself are ignored to keep the
 * commit the agent pushed from starting another review.
 */
export const handlePullRequestEvent = async (
  tenant: Tenant,
  payload: PullRequestEventPayload
): Promise<void> => {
  const { action, installation, pull_request: pull, repository, sender } = payload;

  if (!REVIEW_ACTIONS.has(action)) {
    return;
  }

  if (installation?.id && installation.id !== tenant.installationId) {
    return;
  }

  const repoFullName = repository.full_name;

  if (!tenantOwnsRepository(tenant, repoFullName)) {
    console.log(
      `[bot] ignored ${action} for ${repoFullName}#${pull.number}: repository is not in ${tenant.org}`
    );
    return;
  }

  const { slug } = await getAppInfo(tenant);
  const botLogin = `${slug}[bot]`;

  if (sender?.login === botLogin || pull.user?.login === botLogin) {
    return;
  }

  if (pull.draft && action !== "ready_for_review") {
    return;
  }

  const headRepo = pull.head.repo?.full_name;

  // A fork can only be pushed to by its owner, who has no access here, so it is
  // skipped unless fork reviews are explicitly enabled.
  if (!env.REVIEW_FORK_PRS && headRepo !== repoFullName) {
    console.log(
      `[bot] ignored ${action} for ${repoFullName}#${pull.number} from fork ${headRepo ?? "unknown"}`
    );
    return;
  }

  // Automatic reviews are for members of the repository-owning organization.
  // A member can still request a review of somebody else's pull request with a
  // mention; that path has its own association check.
  if (
    !isTrustedPullRequestAuthor(pull.user?.login, pull.author_association)
  ) {
    console.log(
      `[bot] ignored ${action} for ${repoFullName}#${pull.number}: author ${pull.user?.login ?? "unknown"} (${pull.author_association ?? "unknown"}) is not an organization member`
    );
    return;
  }

  await enqueueReview({
    headSha: pull.head.sha,
    messages: [{ content: AUTO_REVIEW_INSTRUCTION, role: "user" }],
    prBranch: pull.head.ref,
    prNumber: pull.number,
    repoFullName,
    tenantKey: tenant.key,
    threadId: `github:${repoFullName}:${pull.number}`,
    trigger: "auto",
  });
};
