import { App } from "octokit";
import type { Octokit } from "octokit";

import { env } from "@/lib/env";

let app: App | null = null;

const getGitHubApp = (): App => {
  if (!app) {
    if (
      !env.GITHUB_APP_ID ||
      !env.GITHUB_APP_PRIVATE_KEY ||
      !env.GITHUB_APP_WEBHOOK_SECRET
    ) {
      throw new Error("Missing required GitHub App environment variables");
    }

    app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
      webhooks: {
        secret: env.GITHUB_APP_WEBHOOK_SECRET,
      },
    });
  }
  return app;
};

export const getInstallationOctokit = (): Promise<Octokit> => {
  if (!env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error("Missing GITHUB_APP_INSTALLATION_ID environment variable");
  }

  const githubApp = getGitHubApp();
  return githubApp.getInstallationOctokit(env.GITHUB_APP_INSTALLATION_ID);
};

let appInfo: Promise<{ botUserId: number; slug: string }> | null = null;

export const getAppInfo = async (): Promise<{
  botUserId: number;
  slug: string;
}> => {
  if (!appInfo) {
    appInfo = loadAppInfo();
  }

  return appInfo;
};

const loadAppInfo = async (): Promise<{
  botUserId: number;
  slug: string;
}> => {
  const octokit = await getInstallationOctokit();
  const { data: appData } = (await octokit.request("GET /app")) as {
    data: { slug: string };
  };
  const { data: botUser } = await octokit.request("GET /users/{username}", {
    username: `${appData.slug}[bot]`,
  });

  return { botUserId: Number(botUser.id), slug: appData.slug };
};
