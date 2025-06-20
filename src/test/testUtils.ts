import { vi, Mock } from "vitest";
import { Response } from "express";

/**
 * Advanced testing utilities demonstrating senior-level testing patterns
 */

/**
 * Create a mock that tracks call order across multiple mocks
 * Useful for testing complex async flows
 */
export class CallOrderTracker {
  private callOrder: Array<{ name: string; timestamp: number; args: any[] }> =
    [];

  track(name: string, fn: Mock) {
    return vi.fn((...args) => {
      this.callOrder.push({
        name,
        timestamp: Date.now(),
        args,
      });
      return fn(...args);
    });
  }

  getCallOrder(): string[] {
    return this.callOrder
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((call) => call.name);
  }

  getCallsForFunction(name: string) {
    return this.callOrder.filter((call) => call.name === name);
  }

  reset() {
    this.callOrder = [];
  }
}

/**
 * Create a mock that fails N times before succeeding
 * Useful for testing retry logic
 */
export function createFlakeyMock<T>(
  successValue: T,
  failureCount: number,
  errorFactory: () => Error = () => new Error("Mock failure"),
): Mock {
  let attempts = 0;

  return vi.fn(() => {
    attempts++;
    if (attempts <= failureCount) {
      throw errorFactory();
    }
    return successValue;
  });
}

/**
 * Create a mock that simulates rate limiting
 */
export function createRateLimitedMock<T>(
  successValue: T,
  requestsPerWindow: number,
  windowMs: number = 1000,
): Mock {
  const requests: number[] = [];

  return vi.fn(() => {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Remove old requests outside the window
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }

    if (requests.length >= requestsPerWindow) {
      const error = new Error("Rate limit exceeded");
      (error as any).status = 429;
      (error as any).retryAfter = Math.ceil(
        (requests[0] + windowMs - now) / 1000,
      );
      throw error;
    }

    requests.push(now);
    return successValue;
  });
}

/**
 * Create a mock that simulates network latency
 */
export function createDelayedMock<T>(
  value: T | (() => T),
  delayMs: number,
  jitterMs: number = 0,
): Mock {
  return vi.fn(async () => {
    const jitter = jitterMs ? Math.random() * jitterMs * 2 - jitterMs : 0;
    const totalDelay = Math.max(0, delayMs + jitter);

    await new Promise((resolve) => setTimeout(resolve, totalDelay));

    return typeof value === "function" ? value() : value;
  });
}

/**
 * Mock Express Response object with chainable methods
 */
export function createMockResponse(): Response & {
  _getStatusCode: () => number;
  _getJson: () => any;
  _getHeaders: () => Record<string, string>;
} {
  let statusCode = 200;
  let jsonData: any;
  const headers: Record<string, string> = {};

  const res = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((data: any) => {
      jsonData = data;
      return res;
    }),
    send: vi.fn(() => res),
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    cookie: vi.fn(() => res),
    clearCookie: vi.fn(() => res),
    redirect: vi.fn(() => res),
    _getStatusCode: () => statusCode,
    _getJson: () => jsonData,
    _getHeaders: () => headers,
  } as any;

  return res;
}

/**
 * Wait for a condition to be true with timeout
 * Useful for testing async state changes
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {},
): Promise<void> {
  const {
    timeout = 5000,
    interval = 50,
    message = "Condition not met",
  } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await condition();
    if (result) return;

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition: ${message}`);
}

/**
 * Create a mock that records all calls with timestamps
 * Useful for debugging async test failures
 */
export function createDebugMock<T extends (...args: any[]) => any>(
  implementation?: T,
): Mock & { getCallLog: () => string } {
  const calls: Array<{
    timestamp: number;
    args: any[];
    result?: any;
    error?: any;
  }> = [];

  const mock = vi.fn((...args) => {
    const callRecord = {
      timestamp: Date.now(),
      args,
      result: undefined as any,
      error: undefined as any,
    };

    calls.push(callRecord);

    try {
      const result = implementation?.(...args);
      callRecord.result = result;
      return result;
    } catch (error) {
      callRecord.error = error;
      throw error;
    }
  }) as Mock & { getCallLog: () => string };

  mock.getCallLog = () => {
    return calls
      .map((call, index) => {
        const time = new Date(call.timestamp).toISOString();
        const args = JSON.stringify(call.args);
        const status = call.error ? "❌ ERROR" : "✅ SUCCESS";
        const result = call.error
          ? call.error.message
          : JSON.stringify(call.result);

        return `[${index}] ${time} ${status}\n  Args: ${args}\n  Result: ${result}`;
      })
      .join("\n\n");
  };

  return mock;
}

/**
 * Test helper for verifying error handling
 */
export async function expectErrorAsync(
  fn: () => Promise<any>,
  errorMatcher: string | RegExp | ((error: Error) => boolean),
): Promise<Error> {
  let error: Error | null = null;

  try {
    await fn();
  } catch (e) {
    error = e as Error;
  }

  if (!error) {
    throw new Error("Expected function to throw an error, but it did not");
  }

  if (typeof errorMatcher === "string") {
    expect(error.message).toContain(errorMatcher);
  } else if (errorMatcher instanceof RegExp) {
    expect(error.message).toMatch(errorMatcher);
  } else if (typeof errorMatcher === "function") {
    expect(errorMatcher(error)).toBe(true);
  }

  return error;
}

/**
 * Create a mock that simulates progressive backoff
 */
export function createBackoffMock<T>(
  successValue: T,
  maxAttempts: number = 3,
  baseDelayMs: number = 100,
): Mock {
  let attempts = 0;
  const attemptTimestamps: number[] = [];

  return vi.fn(async () => {
    attempts++;
    attemptTimestamps.push(Date.now());

    if (attempts < maxAttempts) {
      // Verify backoff timing
      if (attemptTimestamps.length > 1) {
        const lastDelay =
          attemptTimestamps[attemptTimestamps.length - 1] -
          attemptTimestamps[attemptTimestamps.length - 2];
        const expectedMinDelay = baseDelayMs * Math.pow(2, attempts - 2);

        if (lastDelay < expectedMinDelay * 0.9) {
          throw new Error(
            `Backoff too fast: ${lastDelay}ms < ${expectedMinDelay}ms`,
          );
        }
      }

      throw new Error(`Attempt ${attempts} failed`);
    }

    return successValue;
  });
}

/**
 * Memory leak detector for tests
 */
export class MemoryLeakDetector {
  private initialMemory: number;
  private samples: number[] = [];

  start() {
    if (global.gc) {
      global.gc();
    }
    this.initialMemory = process.memoryUsage().heapUsed;
    this.samples = [this.initialMemory];
  }

  sample() {
    if (global.gc) {
      global.gc();
    }
    this.samples.push(process.memoryUsage().heapUsed);
  }

  async detectLeak(
    fn: () => Promise<void>,
    iterations: number = 100,
    threshold: number = 10 * 1024 * 1024, // 10MB
  ): Promise<boolean> {
    this.start();

    for (let i = 0; i < iterations; i++) {
      await fn();
      if (i % 10 === 0) {
        this.sample();
      }
    }

    this.sample();

    // Calculate memory growth
    const finalMemory = this.samples[this.samples.length - 1];
    const growth = finalMemory - this.initialMemory;

    return growth > threshold;
  }

  getReport() {
    const growth = this.samples[this.samples.length - 1] - this.initialMemory;
    const growthMB = (growth / 1024 / 1024).toFixed(2);

    return {
      initialMemory: this.initialMemory,
      finalMemory: this.samples[this.samples.length - 1],
      growth,
      growthMB: `${growthMB} MB`,
      samples: this.samples,
    };
  }
}
