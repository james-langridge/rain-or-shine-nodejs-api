import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import { StravaApiService, type StravaActivity } from "../stravaApi";
import { config } from "../../config/environment";
import { factories } from "../../test/setup";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock config
vi.mock("../../config/environment", () => ({
  config: {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    api: {
      strava: {
        tokenUrl: "https://www.strava.com/oauth/token",
      },
    },
  },
}));

// Mock logger
vi.mock("../../utils/logger", () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
  createServiceLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock metrics service to avoid database imports
vi.mock("../metricsService", () => ({
  metricsService: {
    recordApiCall: vi.fn(),
    recordWebhookProcessing: vi.fn(),
    recordTokenRefresh: vi.fn(),
  },
}));

// Mock Bottleneck to avoid rate limiting delays in tests
vi.mock("bottleneck", () => {
  const MockBottleneck = vi.fn().mockImplementation(() => ({
    schedule: vi.fn((fn) => fn()),
    on: vi.fn(),
  }));
  return { default: MockBottleneck };
});

describe("StravaApiService", () => {
  let stravaApiService: StravaApiService;

  // Test data fixtures
  const mockTokenRefreshResponse = {
    access_token: "new-access-token-12345",
    refresh_token: "new-refresh-token-67890",
    expires_at: 1705400000, // Future timestamp
    expires_in: 21600, // 6 hours
    token_type: "Bearer",
  };

  const mockActivity: StravaActivity = factories.activity({
    id: 123456,
    name: "Morning Run",
    description: "Great run in the park!",
  });

  // Helper to create properly structured mock responses
  const createMockResponse = ({
    ok = true,
    status = 200,
    json = () => Promise.resolve({}),
    text = () => Promise.resolve(""),
    headers = new Map(),
  } = {}) => {
    // Create headers object with get method
    const headersObj = {
      get: (key: string) =>
        headers instanceof Map ? headers.get(key) : headers[key] || null,
    };

    return {
      ok,
      status,
      json,
      text,
      headers: headersObj,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Set a fixed current time
    const mockDate = new Date("2024-01-15T12:00:00Z");
    vi.setSystemTime(mockDate);

    stravaApiService = new StravaApiService();

    // Default successful fetch response
    mockFetch.mockResolvedValue(
      createMockResponse({
        json: () => Promise.resolve(mockTokenRefreshResponse),
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("refreshAccessToken", () => {
    it("should successfully refresh access token", async () => {
      const refreshToken = "current-refresh-token";

      const result = await stravaApiService.refreshAccessToken(refreshToken);

      expect(result).toEqual({
        access_token: "new-access-token-12345",
        refresh_token: "new-refresh-token-67890",
        expires_at: 1705400000,
      });

      // Verify API call
      expect(mockFetch).toHaveBeenCalledWith(config.api.strava.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.STRAVA_CLIENT_ID,
          client_secret: config.STRAVA_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
    });

    it("should handle token refresh API errors", async () => {
      const errorResponse = createMockResponse({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid refresh token"),
      });
      mockFetch.mockResolvedValue(errorResponse);

      await expect(
        stravaApiService.refreshAccessToken("invalid-token"),
      ).rejects.toThrow("Token refresh failed (400): Invalid refresh token");
    });

    it("should handle unauthorized refresh attempts", async () => {
      const unauthorizedResponse = createMockResponse({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      mockFetch.mockResolvedValue(unauthorizedResponse);

      await expect(
        stravaApiService.refreshAccessToken("expired-refresh-token"),
      ).rejects.toThrow("Token refresh failed (401): Unauthorized");
    });

    it("should handle network errors during token refresh", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(
        stravaApiService.refreshAccessToken("valid-token"),
      ).rejects.toThrow("Network error");
    });

    it("should handle malformed response from token endpoint", async () => {
      const malformedResponse = createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("Invalid JSON")),
        text: () => Promise.resolve("Not JSON"),
      });
      mockFetch.mockResolvedValue(malformedResponse);

      await expect(
        stravaApiService.refreshAccessToken("valid-token"),
      ).rejects.toThrow("Invalid JSON");
    });
  });

  describe("ensureValidToken", () => {
    describe("token validation logic", () => {
      it("should return existing token when not expiring soon", async () => {
        const accessToken = "current-access-token";
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T18:00:00Z"); // 6 hours from now

        const result = await stravaApiService.ensureValidToken(
          accessToken,
          refreshToken,
          expiresAt,
        );

        expect(result).toEqual({
          accessToken,
          refreshToken,
          expiresAt,
          wasRefreshed: false,
        });

        // Should not make any API calls
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it("should refresh token when expiring within buffer time", async () => {
        const accessToken = "current-access-token";
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T12:04:00Z"); // 4 minutes from now (within 5min buffer)

        const result = await stravaApiService.ensureValidToken(
          accessToken,
          refreshToken,
          expiresAt,
        );

        expect(result).toEqual({
          accessToken: "new-access-token-12345",
          refreshToken: "new-refresh-token-67890",
          expiresAt: new Date(1705400000 * 1000),
          wasRefreshed: true,
        });

        // Should make token refresh API call
        expect(mockFetch).toHaveBeenCalledWith(
          config.api.strava.tokenUrl,
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining(refreshToken),
          }),
        );
      });

      it("should refresh token when already expired", async () => {
        const accessToken = "expired-access-token";
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T11:00:00Z"); // 1 hour ago

        const result = await stravaApiService.ensureValidToken(
          accessToken,
          refreshToken,
          expiresAt,
        );

        expect(result).toEqual({
          accessToken: "new-access-token-12345",
          refreshToken: "new-refresh-token-67890",
          expiresAt: new Date(1705400000 * 1000),
          wasRefreshed: true,
        });

        expect(mockFetch).toHaveBeenCalled();
      });

      it("should handle exact buffer time boundary", async () => {
        const accessToken = "current-access-token";
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T12:05:00Z"); // Exactly 5 minutes from now

        const result = await stravaApiService.ensureValidToken(
          accessToken,
          refreshToken,
          expiresAt,
        );

        // Should refresh because it's at the boundary
        expect(result.wasRefreshed).toBe(true);
        expect(mockFetch).toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      it("should propagate token refresh errors", async () => {
        const accessToken = "expired-access-token";
        const refreshToken = "invalid-refresh-token";
        const expiresAt = new Date("2024-01-15T11:00:00Z"); // Expired

        const errorResponse = createMockResponse({
          ok: false,
          status: 400,
          text: () => Promise.resolve("Bad Request"),
        });
        mockFetch.mockResolvedValue(errorResponse);

        await expect(
          stravaApiService.ensureValidToken(
            accessToken,
            refreshToken,
            expiresAt,
          ),
        ).rejects.toThrow("Token refresh failed (400): Bad Request");
      });

      it("should handle network failures during token refresh", async () => {
        const accessToken = "expired-access-token";
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T11:00:00Z"); // Expired

        mockFetch.mockRejectedValue(new Error("Connection timeout"));

        await expect(
          stravaApiService.ensureValidToken(
            accessToken,
            refreshToken,
            expiresAt,
          ),
        ).rejects.toThrow("Connection timeout");
      });
    });

    describe("timestamp handling", () => {
      it("should correctly convert Unix timestamp to Date", async () => {
        const refreshToken = "current-refresh-token";
        const expiresAt = new Date("2024-01-15T11:00:00Z"); // Expired

        const customTokenResponse = {
          ...mockTokenRefreshResponse,
          expires_at: 1609459200, // Jan 1, 2021 00:00:00 UTC
        };

        mockFetch.mockResolvedValue(
          createMockResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve(customTokenResponse),
            text: () => Promise.resolve(""),
          }),
        );

        const result = await stravaApiService.ensureValidToken(
          "expired-token",
          refreshToken,
          expiresAt,
        );

        expect(result.expiresAt).toEqual(new Date("2021-01-01T00:00:00.000Z"));
      });
    });
  });

  describe("getActivity", () => {
    it("should successfully fetch activity", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockActivity),
          text: () => Promise.resolve(""),
        }),
      );

      const result = await stravaApiService.getActivity(
        "123456",
        "valid-token",
      );

      expect(result).toEqual(mockActivity);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://www.strava.com/api/v3/activities/123456",
        {
          headers: {
            Authorization: "Bearer valid-token",
            "Content-Type": "application/json",
          },
        },
      );
    });

    it("should handle activity not found", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not found"),
        }),
      );

      await expect(
        stravaApiService.getActivity("999999", "valid-token"),
      ).rejects.toThrow("Resource not found or not accessible");
    });

    it("should handle unauthorized access", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 401,
          text: () => Promise.resolve("Unauthorized"),
        }),
      );

      await expect(
        stravaApiService.getActivity("123456", "invalid-token"),
      ).rejects.toThrow("Strava access token expired or invalid");
    });

    it("should handle rate limiting", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 429,
          text: () => Promise.resolve("Rate limit exceeded"),
        }),
      );

      await expect(
        stravaApiService.getActivity("123456", "valid-token"),
      ).rejects.toThrow("Rate limit exceeded");
    });
  });

  describe("updateActivity", () => {
    const updateData = {
      description: "Updated description with weather info",
    };

    it("should successfully update activity", async () => {
      const updatedActivity = {
        ...mockActivity,
        description: updateData.description,
      };

      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve(updatedActivity),
          text: () => Promise.resolve(""),
        }),
      );

      const result = await stravaApiService.updateActivity(
        "123456",
        "valid-token",
        updateData,
      );

      expect(result).toEqual(updatedActivity);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://www.strava.com/api/v3/activities/123456",
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer valid-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateData),
        },
      );
    });

    it("should handle update permission errors", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 403,
          text: () => Promise.resolve("Forbidden"),
        }),
      );

      await expect(
        stravaApiService.updateActivity("123456", "valid-token", updateData),
      ).rejects.toThrow("Not authorized to perform this action");
    });

    it("should handle malformed update data", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 400,
          text: () => Promise.resolve("Bad request"),
        }),
      );

      await expect(
        stravaApiService.updateActivity("123456", "valid-token", updateData),
      ).rejects.toThrow("Strava API error (400): Bad request");
    });
  });

  describe("revokeToken", () => {
    it("should successfully revoke token", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          text: () => Promise.resolve(""),
        }),
      );

      await expect(
        stravaApiService.revokeToken("valid-token"),
      ).resolves.not.toThrow();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://www.strava.com/oauth/deauthorize",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid-token",
            "Content-Type": "application/json",
          },
        },
      );
    });

    it("should handle revocation errors gracefully", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 400,
          text: () => Promise.resolve("Bad request"),
        }),
      );

      // Should not throw - revocation failures are logged but not critical
      await expect(
        stravaApiService.revokeToken("invalid-token"),
      ).resolves.not.toThrow();
    });

    it("should handle network errors during revocation gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      // Should not throw - revocation failures are logged but not critical
      await expect(
        stravaApiService.revokeToken("valid-token"),
      ).resolves.not.toThrow();
    });
  });

  describe("error handling edge cases", () => {
    it("should handle empty error responses", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 500,
          text: () => Promise.resolve(""),
        }),
      );

      await expect(
        stravaApiService.getActivity("123456", "valid-token"),
      ).rejects.toThrow("Strava API error (500):");
    });

    it("should handle non-JSON error responses", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 502,
          text: () => Promise.resolve("<html>Bad Gateway</html>"),
        }),
      );

      await expect(
        stravaApiService.getActivity("123456", "valid-token"),
      ).rejects.toThrow("Strava API error (502): <html>Bad Gateway</html>");
    });

    it("should handle fetch exceptions", async () => {
      mockFetch.mockRejectedValue(new Error("DNS resolution failed"));

      await expect(
        stravaApiService.getActivity("123456", "valid-token"),
      ).rejects.toThrow("DNS resolution failed");
    });
  });

  describe("integration scenarios", () => {
    it("should handle complete token refresh flow", async () => {
      // Setup: token is expiring
      const accessToken = "expiring-token";
      const refreshToken = "valid-refresh-token";
      const expiresAt = new Date("2024-01-15T12:03:00Z"); // 3 minutes from now

      // First call: ensure valid token (should refresh)
      const tokenResult = await stravaApiService.ensureValidToken(
        accessToken,
        refreshToken,
        expiresAt,
      );

      expect(tokenResult.wasRefreshed).toBe(true);
      expect(tokenResult.accessToken).toBe("new-access-token-12345");

      // Reset fetch mock for activity call
      vi.clearAllMocks();
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockActivity),
          text: () => Promise.resolve(""),
        }),
      );

      // Second call: use new token to fetch activity
      const activity = await stravaApiService.getActivity(
        "123456",
        tokenResult.accessToken,
      );

      expect(activity).toEqual(mockActivity);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer new-access-token-12345",
          }),
        }),
      );
    });
  });
});
