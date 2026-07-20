import { describe, expect, it } from "vitest";
import { peekSseTransientError, peekRetryRotate } from "../../open-sse/executors/sseErrorPeek.js";
import {
  GROK_SSE_ACCOUNT_FALLBACK_PATTERNS,
  GROK_SSE_RETRY_PATTERNS,
} from "../../open-sse/executors/grok-cli.js";

const XAI_CAPACITY_MESSAGE =
  "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing";

function streamResponse(text, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

const GROK_PEEK_OPTIONS = {
  accountFallbackPatterns: GROK_SSE_ACCOUNT_FALLBACK_PATTERNS,
  retryPatterns: GROK_SSE_RETRY_PATTERNS,
};

describe("Grok CLI in-stream capacity handling", () => {
  it("classifies 200-SSE xAI capacity as account fallback", async () => {
    const response = streamResponse([
      "event: error",
      `data: {"type":"error","message":${JSON.stringify(XAI_CAPACITY_MESSAGE)}}`,
      "",
    ].join("\n"));

    const peek = await peekSseTransientError(response, GROK_PEEK_OPTIONS);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe(XAI_CAPACITY_MESSAGE);
  });

  it("converts the 200-OK capacity stream into a 503 so fallback can rotate", async () => {
    const runOnce = () => Promise.resolve({
      response: streamResponse([
        "event: error",
        `data: {"type":"error","message":${JSON.stringify(XAI_CAPACITY_MESSAGE)}}`,
        "",
      ].join("\n")),
    });

    const { response } = await peekRetryRotate(runOnce, GROK_PEEK_OPTIONS);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toBe(XAI_CAPACITY_MESSAGE);
  });

  it("reassembles a normal SSE stream untouched", async () => {
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");

    const { response } = await peekRetryRotate(
      () => Promise.resolve({ response: streamResponse(text) }),
      GROK_PEEK_OPTIONS
    );
    expect(response.status).toBe(200);
    await expect(new Response(response.body).text()).resolves.toBe(text);
  });

  it("passes a reasoning-first stream through without buffering to the end", async () => {
    const text = [
      "event: response.reasoning_summary_text.delta",
      'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}',
      "",
    ].join("\n");

    const { response } = await peekRetryRotate(
      () => Promise.resolve({ response: streamResponse(text) }),
      GROK_PEEK_OPTIONS
    );
    expect(response.status).toBe(200);
    await expect(new Response(response.body).text()).resolves.toBe(text);
  });
});
