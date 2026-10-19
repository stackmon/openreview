import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getBot, handlePullRequestEvent } from "@/lib/bot";
import { env } from "@/lib/env";
import { parseError } from "@/lib/error";
import { removeStaleWorkspaces } from "@/lib/workspace";

const WEBHOOK_PATH = "/webhook";

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const verifySignature = (body: string, signature: string | undefined): boolean => {
  if (!signature) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", env.GITHUB_APP_WEBHOOK_SECRET)
    .update(body)
    .digest("hex")}`;

  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);

  return (
    received.length === computed.length && timingSafeEqual(received, computed)
  );
};

const toHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
};

const respond = (
  response: ServerResponse,
  status: number,
  body: string
): void => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const handleWebhook = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const body = await readBody(request);

  if (!verifySignature(body, request.headers["x-hub-signature-256"] as string)) {
    respond(response, 401, "Invalid signature");
    return;
  }

  const event = request.headers["x-github-event"] as string | undefined;

  if (event === "pull_request") {
    let payload: Parameters<typeof handlePullRequestEvent>[0];

    try {
      payload = JSON.parse(body);
    } catch {
      respond(response, 400, "Invalid JSON");
      return;
    }

    respond(response, 202, "accepted");

    handlePullRequestEvent(payload).catch((error: unknown) => {
      console.error(`[webhook] pull_request failed: ${parseError(error)}`);
    });

    return;
  }

  const bot = await getBot();
  const handler = bot.webhooks.github;

  if (!handler) {
    respond(response, 404, "GitHub adapter not configured");
    return;
  }

  const url = `http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`;
  const webhookRequest = new Request(url, {
    body,
    headers: toHeaders(request),
    method: "POST",
  });

  const webhookResponse = await handler(webhookRequest, {
    waitUntil: (task) => {
      task.catch((error: unknown) => {
        console.error(`[webhook] handler failed: ${parseError(error)}`);
      });
    },
  });

  respond(response, webhookResponse.status, await webhookResponse.text());
};

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];

  const route = async (): Promise<void> => {
    if (request.method === "GET" && (path === "/healthz" || path === "/")) {
      respond(response, 200, "ok");
      return;
    }

    if (request.method === "POST" && path === WEBHOOK_PATH) {
      await handleWebhook(request, response);
      return;
    }

    respond(response, 404, "not found");
  };

  route().catch((error: unknown) => {
    console.error(`[server] request failed: ${parseError(error)}`);

    if (!response.headersSent) {
      respond(response, 500, "internal error");
    }
  });
});

const start = async (): Promise<void> => {
  await removeStaleWorkspaces();

  server.listen(env.PORT, env.HOST, () => {
    console.log(
      `[server] openreview listening on http://${env.HOST}:${env.PORT}`
    );
  });
};

start().catch((error: unknown) => {
  console.error(`[server] failed to start: ${parseError(error)}`);
  process.exit(1);
});
