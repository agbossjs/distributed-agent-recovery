import { env, secret } from "@agboss/core";
import { CircuitBreakerPolicy, ModelCost, ModelProvider, OpenRouterDriver } from "@agboss/core/models";
import { minutes, seconds } from "@agboss/core/units";

@ModelProvider({
  name: "openrouter-model-provider",
  description:
    "OpenRouter for the release recovery planner; offline runs and tests point OPENROUTER_BASE_URL at a loopback stub",
  driver: OpenRouterDriver({
    apiKey: secret("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", { default: "https://openrouter.ai/api/v1" }),
  }),
  timeout: seconds(60),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
})
export class OpenRouterModelProvider {}
