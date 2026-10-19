import { z } from "zod";

import { env } from "@/lib/env";
import { parseError } from "@/lib/error";

/**
 * Registry entry for one GitHub App installation. The registry itself is not
 * secret and lives in the deployment configuration repository; the private key
 * and webhook secret are read from the environment variables named here, which
 * come from the Kubernetes Secret rendered out of Vault.
 */
const registryEntrySchema = z.object({
  appId: z.string().min(1),
  installationId: z.coerce.number().int().positive(),
  key: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "must contain only lowercase letters, digits and dashes"
    ),
  org: z.string().min(1),
  privateKeyEnv: z.string().min(1),
  slug: z.string().min(1).optional(),
  webhookSecretEnv: z.string().min(1),
});

const registrySchema = z.array(registryEntrySchema).min(1);

export interface Tenant {
  appId: string;
  installationId: number;
  key: string;
  org: string;
  privateKey: string;
  slug?: string;
  webhookSecret: string;
}

const resolveSecret = (tenantKey: string, variable: string): string => {
  const value = process.env[variable];

  if (!value) {
    throw new Error(
      `Tenant "${tenantKey}" refers to missing environment variable ${variable}`
    );
  }

  return value;
};

const tenantsFromRegistry = (): Tenant[] => {
  const raw = process.env.TENANTS_JSON;

  if (!raw) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`TENANTS_JSON is not valid JSON: ${parseError(error)}`);
  }

  const result = registrySchema.safeParse(parsed);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid TENANTS_JSON:\n${details}`);
  }

  return result.data.map((entry) => ({
    appId: entry.appId,
    installationId: entry.installationId,
    key: entry.key,
    org: entry.org,
    privateKey: resolveSecret(entry.key, entry.privateKeyEnv).replaceAll(
      "\\n",
      "\n"
    ),
    slug: entry.slug,
    webhookSecret: resolveSecret(entry.key, entry.webhookSecretEnv),
  }));
};

/**
 * Backwards compatibility for single-tenant deployments that still use the
 * GITHUB_APP_* variables instead of a registry.
 */
const tenantsFromLegacyEnv = (): Tenant[] => {
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_INSTALLATION_ID: installationId,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
  } = env;

  if (!appId || !installationId || !privateKey || !webhookSecret) {
    return [];
  }

  return [
    {
      appId,
      installationId,
      key: "default",
      org: env.GITHUB_ORG ?? "",
      privateKey: privateKey.replaceAll("\\n", "\n"),
      webhookSecret,
    },
  ];
};

const loadTenants = (): Tenant[] => {
  const registry = tenantsFromRegistry();
  const tenants = registry.length > 0 ? registry : tenantsFromLegacyEnv();

  if (tenants.length === 0) {
    throw new Error(
      "No tenants configured: set TENANTS_JSON or the GITHUB_APP_* variables"
    );
  }

  const seen = new Set<string>();

  for (const tenant of tenants) {
    if (seen.has(tenant.key)) {
      throw new Error(`Duplicate tenant key "${tenant.key}" in the registry`);
    }

    seen.add(tenant.key);
  }

  return tenants;
};

/** Registry order matters: the first tenant owns the legacy `/webhook` route. */
export const tenants: Tenant[] = loadTenants();

const byKey = new Map(tenants.map((tenant) => [tenant.key, tenant]));

export const getDefaultTenant = (): Tenant => tenants[0];

export const getTenant = (key: string): Tenant | undefined => byKey.get(key);

export const getTenantOrThrow = (key: string): Tenant => {
  const tenant = byKey.get(key);

  if (!tenant) {
    throw new Error(`Unknown tenant "${key}"`);
  }

  return tenant;
};

/**
 * The bot only acts inside the organization that installed its app. A webhook
 * delivered to the wrong route is ignored instead of being processed with
 * another tenant's credentials. An empty org disables the check (legacy env).
 */
export const tenantOwnsRepository = (
  tenant: Tenant,
  repoFullName: string
): boolean => {
  if (!tenant.org) {
    return true;
  }

  const [owner] = repoFullName.split("/");

  return owner?.toLowerCase() === tenant.org.toLowerCase();
};
