export default {
  id: "codebuddy-ai",
  // "cbai" = CodeBuddy international (codebuddy.ai). Sibling of codebuddy-cn ("cbcn").
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 89,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      apiKeyUrl: "https://www.codebuddy.ai/profile/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasOAuth: false,
  transport: {
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy is a unified OpenAI-compatible gateway: every model takes reasoning via
    // OpenAI-style reasoning_effort, not its vendor-native thinking shape.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/1.0.7 CodeBuddy/1.0.7",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": "1.0.7",
      "X-Agent-Intent": "craft",
      "X-Requested-With": "XMLHttpRequest",
      "X-CodeBuddy-Request": "1",
    },
    // Gateway reads either header; the official CLI sends both on API-key auth.
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: ["codebuddyApiKey"],
    },
  },
  models: [
    { id: "claude-4.0", name: "Claude 4.0" },
    { id: "claude-3.7", name: "Claude 3.7" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "gpt-5-nano", name: "GPT-5 Nano" },
    { id: "o4-mini", name: "o4-mini" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "auto-chat", name: "Auto (Router)" },
  ],
  // codebuddy.ai exposes no public /models endpoint; the seeded list is the visible
  // default, and passthrough lets callers use any current model id the gateway accepts.
  passthroughModels: true,
};
