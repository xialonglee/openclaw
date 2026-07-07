// Provider operation retry tests cover retry timing, abort behavior,
// and transient error classification.
import { describe, expect, it, vi } from "vitest";
import {
  executeProviderOperationWithRetry,
  isTransientProviderOperationError,
  resolveTransientProviderAttempts,
} from "./operation-retry.js";

describe("resolveTransientProviderAttempts", () => {
  it("does not round malformed attempt counts", () => {
    expect(resolveTransientProviderAttempts({ attempts: 1.5 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.NaN })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.POSITIVE_INFINITY })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.MAX_SAFE_INTEGER + 1 })).toBe(1);
  });

  it("keeps valid attempt counts as integers", () => {
    expect(resolveTransientProviderAttempts({ attempts: 0 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: 3 })).toBe(3);
  });
});

describe("executeProviderOperationWithRetry", () => {
  it("does not turn fractional attempts into an extra execution", async () => {
    const operation = vi.fn(async () => {
      const error = new Error("HTTP 503");
      Object.assign(error, { status: 503 });
      throw error;
    });

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: {
          attempts: 1.5,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      }),
    ).rejects.toThrow("HTTP 503");

    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientProviderOperationError", () => {
  function makeError(code: string) {
    const error = new Error("fetch failed");
    Object.assign(error, { cause: Object.assign(new Error("connect error"), { code }) });
    return error;
  }

  it("classifies transient network error codes as retryable", () => {
    const transientCodes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
    ];
    for (const code of transientCodes) {
      expect(
        isTransientProviderOperationError(makeError(code), "fetch failed"),
        `${code} should be transient`,
      ).toBe(true);
    }
  });

  it("treats 4xx status as non-retryable", () => {
    const error = Object.assign(new Error("Bad Request"), { status: 400 });
    expect(isTransientProviderOperationError(error, "Bad Request")).toBe(false);
  });

  it("treats 5xx status as retryable", () => {
    const error = Object.assign(new Error("Server Error"), { status: 503 });
    expect(isTransientProviderOperationError(error, "Server Error")).toBe(true);
  });

  it("treats transient codes in the top-level error message as retryable", () => {
    const error = new Error("connect ECONNRESET 127.0.0.1:443");
    expect(isTransientProviderOperationError(error, error.message)).toBe(true);
  });

  it("treats non-transient codes as non-retryable", () => {
    const error = new Error("ENOENT: no such file or directory");
    expect(isTransientProviderOperationError(error, error.message)).toBe(false);
  });
});
