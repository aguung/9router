import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

// Shared prologue for both /v1/images/generations and /v1/images/edits:
// parse JSON, enforce API key, validate model/prompt. Returns { error } on
// failure, otherwise the parsed request fields.
async function parseImageRequest(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    const valid = await isValidApiKey(apiKey);
    if (!valid) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
  }

  if (!modelStr) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model") };
  if (!body.prompt) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt") };

  return { body, modelStr, settings, wantsStream, binaryOutput, preferredConnectionId };
}

// Combo expansion (model may be a combo name → fallback/round-robin across
// models) or a direct single-model dispatch — shared by generation and edit.
async function dispatchImageRequest(body, modelStr, settings, opts, logPrefix = "IMAGE") {
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info(logPrefix, `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, opts),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, opts);
}

/**
 * Handle image generation request (POST /v1/images/generations)
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
  const parsed = await parseImageRequest(request);
  if (parsed.error) return parsed.error;
  const { body, modelStr, settings, ...opts } = parsed;
  return dispatchImageRequest(body, modelStr, settings, opts);
}

/**
 * Handle image edit request (POST /v1/images/edits) — same pipeline as
 * generation, plus the OpenAI-shaped requirement that a source image is
 * present. Provider adapters that accept input_image content alongside the
 * prompt (grok-cli, codex, gemini, ...) already handle image/images via
 * their own buildBody — this route only adds the dedicated path + the
 * image-required validation the real edits endpoint has.
 * @param {Request} request
 */
export async function handleImageEdit(request) {
  const parsed = await parseImageRequest(request);
  if (parsed.error) return parsed.error;
  const { body, modelStr, settings, ...opts } = parsed;

  const hasImage = body.image != null || (Array.isArray(body.images) ? body.images.length > 0 : body.images != null);
  if (!hasImage) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image (or images)");

  return dispatchImageRequest(body, modelStr, settings, opts, "IMAGE_EDIT");
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
