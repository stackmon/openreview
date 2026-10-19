import { App } from "octokit";
import type { Octokit } from "octokit";

import type { Tenant } from "@/lib/tenants";

const apps = new Map<string, App>();

const getGitHubApp = (tenant: Tenant): App => {
  let app = apps.get(tenant.key);

  if (!app) {
    app = new App({
      appId: tenant.appId,
      privateKey: tenant.privateKey,
      webhooks: {
        secret: tenant.webhookSecret,
      },
    });

    apps.set(tenant.key, app);
  }

  return app;
};

export const getInstallationOctokit = (tenant: Tenant): Promise<Octokit> =>
  getGitHubApp(tenant).getInstallationOctokit(tenant.installationId);

export interface AppInfo {
  botUserId: number;
  slug: string;
}

const appInfos = new Map<string, Promise<AppInfo>>();

export const getAppInfo = (tenant: Tenant): Promise<AppInfo> => {
  let info = appInfos.get(tenant.key);

  if (!info) {
    info = loadAppInfo(tenant).catch((error: unknown) => {
      // A failed lookup should not be cached: the next webhook may retry.
      appInfos.delete(tenant.key);
      throw error;
    });

    appInfos.set(tenant.key, info);
  }

  return info;
};

const loadAppInfo = async (tenant: Tenant): Promise<AppInfo> => {
  let { slug } = tenant;

  if (!slug) {
    // The registry should carry the slug; the app can still ask GitHub for it
    // with its own JWT when the registry entry omits it.
    const { data } = (await getGitHubApp(tenant).octokit.request("GET /app")) as {
      data: { slug: string };
    };

    slug = data.slug;
  }

  const octokit = await getInstallationOctokit(tenant);
  const { data: botUser } = await octokit.request("GET /users/{username}", {
    username: `${slug}[bot]`,
  });

  return { botUserId: Number(botUser.id), slug };
};
