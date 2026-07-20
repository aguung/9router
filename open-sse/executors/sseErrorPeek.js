import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, resolveRetryEntry } from "../config/runtimeConfig.js";

// Some Responses-API upstreams (Codex, Grok CLI) return HTTP 200 and then emit the
// real failure as an `event: error` INSIDE the SSE body. Once that stream is handed
// to the client it is reported as success, so account/combo fallback never triggers.
// Peeking the first bytes lets us reclassify those in-stream errors into a real HTTP
// error status the fallback loop can act on, while re-assembling the untouched stream
// when no error is present.

const RESPONSES_SSE_PEEK_BYTES = 256 * 1024;

// SSE markers that prove real streaming has started — stop peeking, it is not an
// error. Reasoning deltas count: capacity/overload errors are emitted upfront, so any
// reasoning output means generation already began (and avoids buffering reasoning).
export const RESPONSES_API_OUTPUT_PATTERNS = [
  "event: response.output_text.delta",
  "event: response.function_call_arguments.delta",
  "event: response.reasoning_summary_text.delta",
  "event: response.reasoning_text.delta",
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
  '"type":"response.reasoning_summary_text.delta"',
  '"type":"response.reasoning_text.delta"',
];

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractSseErrorMessage(text, fallback = null, exactPattern = null) {
  if (exactPattern) {
    const exact = text?.match(exactPattern)?.[0];
    if (exact) return exact;
  }
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }
  return fallback;
}

export function sseErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Peek the first bytes of an SSE body to detect upstream transient errors.
 * Returns { matched, message, accountFallback, replacementBody }.
 * When no error matches, the caller MUST swap in replacementBody — the original
 * body has already been partially read.
 */
export async function peekSseTransientError(response, {
  accountFallbackPatterns = [],
  retryPatterns = [],
  userOutputPatterns = RESPONSES_API_OUTPUT_PATTERNS,
  peekBytes = RESPONSES_SSE_PEEK_BYTES,
  exactMessagePattern = null,
} = {}) {
  if (!response || !response.ok || !response.body) {
    return { matched: null, message: null, accountFallback: false, replacementBody: null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let matched = null;
  let accountFallback = false;
  try {
    while (text.length < peekBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += decoder.decode(value, { stream: true });
      const lowerText = text.toLowerCase();
      const accountHit = accountFallbackPatterns.find(p => lowerText.includes(p));
      if (accountHit) { matched = accountHit; accountFallback = true; break; }
      const retryHit = retryPatterns.find(p => lowerText.includes(p));
      if (retryHit) { matched = retryHit; break; }
      if (userOutputPatterns.some(p => lowerText.includes(p))) break;
    }
  } catch {
    // Peek is best-effort; on read failure fall through to re-assembly.
  }

  if (matched) {
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
    return { matched, message: extractSseErrorMessage(text, matched, exactMessagePattern), accountFallback, replacementBody: null };
  }

  reader.releaseLock();

  const upstream = response.body;
  let upstreamReader = null;
  const replacementBody = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      upstreamReader = upstream.getReader();
    },
    async pull(controller) {
      try {
        const { done, value } = await upstreamReader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel(reason) {
      try { upstreamReader?.cancel(reason); } catch { /* noop */ }
    },
  });
  return { matched: null, message: null, accountFallback: false, replacementBody };
}

/**
 * Wrap an executor call: run it, peek the SSE body, and either retry the same
 * account (transient), rotate to the next account (capacity — returns a 503 the
 * fallback loop acts on), or pass the re-assembled stream through untouched.
 * @param {() => Promise<{response: Response}>} runOnce - executes one upstream call
 */
export async function peekRetryRotate(runOnce, {
  accountFallbackPatterns = [],
  retryPatterns = [],
  userOutputPatterns = RESPONSES_API_OUTPUT_PATTERNS,
  peekBytes = RESPONSES_SSE_PEEK_BYTES,
  exactMessagePattern = null,
  retryOverride = null,
  log = null,
  tag = "SSE",
} = {}) {
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...(retryOverride || {}) };
  const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
  let attempt = 0;
  while (true) {
    const result = await runOnce();
    const peek = await peekSseTransientError(result.response, {
      accountFallbackPatterns, retryPatterns, userOutputPatterns, peekBytes, exactMessagePattern,
    });
    if (!peek.matched) {
      if (peek.replacementBody) {
        result.response = new Response(peek.replacementBody, {
          status: result.response.status,
          statusText: result.response.statusText,
          headers: result.response.headers,
        });
      }
      return result;
    }
    if (peek.accountFallback) {
      log?.warn?.("RETRY", `${tag} | SSE account fallback "${peek.message}"`);
      result.response = sseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
      return result;
    }
    if (attempt >= attempts) {
      log?.warn?.("RETRY", `${tag} | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
      result.response = sseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
      return result;
    }
    attempt++;
    log?.debug?.("RETRY", `${tag} | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
    await new Promise(r => setTimeout(r, delayMs));
  }
}
