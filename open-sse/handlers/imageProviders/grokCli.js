// Grok CLI (Grok Build) image generation/editing via chat Responses API
// image_generation tool. Free-tier accounts — reuses the same OAuth
// connection/executor as grok-cli chat (cli-chat-proxy.grok.com). Unlike
// Codex, this endpoint returns the finished image_generation_call in a
// plain (non-SSE) JSON response, so no stream parsing needed.
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { GROK_CLI_CLIENT_IDENTIFIER, GROK_CLI_USER_AGENT, GROK_CLI_VERSION } from "../../config/grokCli.js";

const GROK_CLI_RESPONSES_URL = PROVIDERS["grok-cli"].baseUrl;
const GROK_CLI_MODEL_SUFFIX = "-image";

function stripImageSuffix(model) {
  return model.endsWith(GROK_CLI_MODEL_SUFFIX) ? model.slice(0, -GROK_CLI_MODEL_SUFFIX.length) : model;
}

// Normalize one image reference into whatever cli-chat-proxy.grok.com accepts
// as input_image.image_url: a data: URL as-is, an http(s) URL passed through
// unchanged (confirmed the upstream fetches it server-side — same behavior
// as codex.js), or bare base64 wrapped into a data: URL.
function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

// Accept the same input shapes as codex.js: body.image (single) and/or
// body.images (array), each either a string or {url}/{b64_json}/{base64}/{data}.
function extractRawImageValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.url || value.image_url || value.b64_json || value.base64 || value.data || null;
  }
  return null;
}

function collectImageRefs(body, maxRefs = 3) {
  const raws = [];
  if (Array.isArray(body.images)) raws.push(...body.images);
  else if (body.images != null) raws.push(body.images);
  if (body.image != null) raws.push(body.image);

  const refs = [];
  for (const raw of raws) {
    const url = toDataUrl(extractRawImageValue(raw));
    if (url) refs.push(url);
    if (refs.length >= maxRefs) break;
  }
  return refs;
}

// cli-chat-proxy mirrors OpenAI Responses API shape: output[] item with
// type "image_generation_call"; the base64 payload key has been observed under
// a few different names, so check the common candidates defensively.
function findImageB64(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findImageB64(item);
      if (found) return found;
    }
    return null;
  }
  if (node.type === "image_generation_call") {
    for (const key of ["result", "image", "b64_json", "base64", "data"]) {
      const val = node[key];
      if (typeof val === "string" && val.length > 100) return val;
    }
  }
  for (const key of ["output", "response", "content", "results"]) {
    const found = findImageB64(node[key]);
    if (found) return found;
  }
  return null;
}

export default {
  buildUrl: () => GROK_CLI_RESPONSES_URL,
  buildHeaders: (creds) => {
    const psd = creds?.providerSpecificData || {};
    // CLI uses the same id for conv + session on a turn (see executors/grok-cli.js)
    const sessionId = randomUUID();
    const headers = {
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "user-agent": GROK_CLI_USER_AGENT,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-authenticateresponse": "authenticate-response",
      "x-grok-session-id": sessionId,
      "x-grok-conv-id": sessionId,
      "x-grok-req-id": randomUUID(),
      "x-grok-turn-idx": "1",
    };
    const email = psd.email || creds?.email;
    const userId = psd.userId || creds?.userId;
    if (email) headers["x-email"] = email;
    if (userId) headers["x-userid"] = userId;
    return headers;
  },
  buildBody: (model, body) => {
    const refs = collectImageRefs(body);
    const instruction = refs.length
      ? `Edit this image: ${body.prompt}. Use the image_generation tool.`
      : `Generate an image: ${body.prompt}. Use the image_generation tool.`;
    const content = refs.map((url) => ({ type: "input_image", image_url: url }));
    content.push({ type: "input_text", text: instruction });

    return {
      model: stripImageSuffix(model),
      input: [{ role: "user", content }],
      tools: [{ type: "image_generation" }],
      stream: false,
      store: false,
      reasoning: {
        effort: body.reasoning_effort || "high",
        summary: "concise",
      },
    };
  },
  // Plain JSON response (no SSE) — extract + validate here so a missing image
  // surfaces as a clean BAD_GATEWAY via imageGenerationCore's try/catch.
  async parseResponse(response) {
    const parsed = await response.json();
    const b64 = findImageB64(parsed);
    if (!b64) {
      throw new Error("Grok CLI did not return an image_generation_call — account may lack image access.");
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
