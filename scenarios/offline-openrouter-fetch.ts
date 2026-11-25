export function isLiveDemoRequested(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--live") || env["AGBOSS_LIVE_DEMO"] === "true";
}

export function requireLiveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env["OPENROUTER_API_KEY"] ?? env["OPEN_ROUTER_KEY"] ?? "").trim();
  if (!key || key === "offline-test-openrouter-api-key") {
    throw new Error(
      "Live demo mode (--live or AGBOSS_LIVE_DEMO=true) requires OPENROUTER_API_KEY.",
    );
  }
  return key;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : JSON.stringify(part),
      )
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

export function createOfflineOpenRouterFetch(): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.endsWith("/models")) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: "openai/gpt-4o-mini",
              supported_parameters: ["temperature", "max_tokens", "reasoning"],
              pricing: { prompt: "0.00000015", completion: "0.0000006" },
            },
          ],
        }),
      );
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
      messages?: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
    };
    const messages = parsed.messages ?? [];
    const tools = parsed.tools ?? [];
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => textOfContent(m.content))
      .join("\n");

    const releaseId = /"releaseId"\s*:\s*"([^"]+)"/u.exec(userText)?.[1] ?? "rel-2026.10.0";
    const version = /"version"\s*:\s*"([^"]+)"/u.exec(userText)?.[1] ?? "2.4.0";
    const attemptMatch = /"failedAttemptNumber"\s*:\s*(\d+)/u.exec(userText);
    const failedAttemptNumber = attemptMatch ? Number(attemptMatch[1]) : 1;

    const inspectTool = tools.find((t) => t.function.name === "inspect-failed-attempt-tool");
    const answerTool = tools.find((t) => t.function.name.startsWith("answer"));
    const toolResultMsg = [...messages].reverse().find((m) => m.role === "tool");

    if (inspectTool !== undefined && toolResultMsg === undefined) {
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-recovery-inspect-1",
          object: "chat.completion",
          created: 1_700_000_010,
          model: parsed.model ?? "openai/gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-inspect-failed-attempt-1",
                    type: "function",
                    function: {
                      name: inspectTool.function.name,
                      arguments: JSON.stringify({ releaseId, failedAttemptNumber }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 72, completion_tokens: 24, total_tokens: 96, cost: 0.00002 },
        }),
      );
    }

    const inspection =
      toolResultMsg !== undefined
        ? (JSON.parse(textOfContent(toolResultMsg.content)) as {
            compensatedArtifactCount?: number;
            ledgerDiagnostic?: string;
          })
        : undefined;

    const plan = {
      releaseId,
      version,
      nextAttemptNumber: failedAttemptNumber + 1,
      rootCauseAnalysis:
        `Ledger verified ${String(inspection?.compensatedArtifactCount ?? 3)} artifacts compensated. ` +
        `Diagnostic: ${inspection?.ledgerDiagnostic ?? "payment-engine requires --abi-compat=v2"}.`,
      correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
      enableLeaseTakeoverDrill: true,
    };

    const message =
      answerTool !== undefined
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-answer-recovery-plan-1",
                type: "function",
                function: { name: answerTool.function.name, arguments: JSON.stringify(plan) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(plan) };

    return Promise.resolve(
      Response.json({
        id: "chatcmpl-recovery-plan-2",
        object: "chat.completion",
        created: 1_700_000_011,
        model: parsed.model ?? "openai/gpt-4o-mini",
        choices: [
          {
            index: 0,
            message,
            finish_reason: answerTool !== undefined ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 110, completion_tokens: 48, total_tokens: 158, cost: 0.00004 },
      }),
    );
  };
}

/**
 * OpenRouter on loopback (`OPENROUTER_BASE_URL`): the provider's own base URL field points at this
 * server, so an offline run goes through the real driver, retry policy and cost accounting — only the
 * model's answers are scripted. Returns the URL to give the provider and the server to close.
 */
export async function startOfflineOpenRouterServer(): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const stub = createOfflineOpenRouterFetch();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      stub(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method ?? "GET", body })
        .then(async (answer) => {
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(await answer.text());
        })
        .catch((error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        });
    });
  });
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the offline OpenRouter stub has no port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/api/v1`,
    close: () => new Promise<void>((resolveClosed) => server.close(() => resolveClosed())),
  };
}
