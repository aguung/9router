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
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5-thinking", name: "GPT-5 Thinking" },
    { id: "gpt-4.1", name: "GPT-4.1" },
    { id: "o3", name: "o3" },
    { id: "o4-mini", name: "o4-mini" },
    { id: "gemini-3.0-pro", name: "Gemini 3.0 Pro" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
    { id: "deepseek-v3", name: "DeepSeek V3" },
    { id: "glm-4.6", name: "GLM-4.6" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "auto-chat", name: "Auto (Router)" },
  ],
  // codebuddy.ai exposes no public /models endpoint; this list was verified by live
  // probing the gateway. Passthrough lets callers use any other id the gateway accepts.
  passthroughModels: true,
};
