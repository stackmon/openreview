import { parseError } from "@/lib/error";
import { getInstallationOctokit } from "@/lib/github";
import type { Tenant } from "@/lib/tenants";

export const getGitHubToken = async (tenant: Tenant): Promise<string> => {
  const octokit = await getInstallationOctokit(tenant).catch(
    (error: unknown) => {
      throw new Error(
        `[getGitHubToken] Failed to get GitHub client: ${parseError(error)}`
      );
    }
  );

  const auth = await (
    octokit.auth({ type: "installation" }) as Promise<{ token: string }>
  ).catch((error: unknown) => {
    throw new Error(`Failed to get GitHub token: ${parseError(error)}`);
  });

  return auth.token;
};
