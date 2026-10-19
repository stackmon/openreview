import { getBot } from "@/lib/bot";
import type { Tenant } from "@/lib/tenants";

export const addPRComment = async (
  tenant: Tenant,
  threadId: string,
  body: string
): Promise<void> => {
  const bot = await getBot(tenant);
  const adapter = bot.getAdapter("github");
  await adapter.postMessage(threadId, { markdown: body });
};
