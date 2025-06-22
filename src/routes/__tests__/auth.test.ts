import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import { Request, Response } from "express";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter } from "../auth";
import { config } from "../../config/environment";
import { prisma } from "../../lib";
import * as authService from "../../services/auth";
import { stravaApiService } from "../../services/stravaApi";
import { encryptionService } from "../../services/encryption";

// Create Express app for testing
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

// Mock dependencies
vi.mock("../../config/environment", () => ({
  config: {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    APP_URL: "http://localhost:3000",
    api: {
      strava: {
        authUrl: "https://www.strava.com/oauth/authorize",
        tokenUrl: "https://www.strava.com/oauth/token",
      },
    },
    auth: {
      sessionCookieName: "strava-weather-session",
    },
    JWT_SECRET: "test-jwt-secret",
  },
}));

vi.mock("../../lib", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../../services/encryption", () => ({
  encryptionService: {
    encrypt: vi.fn((value: string) => `encrypted-${value}`),
    decrypt: vi.fn((value: string) => value.replace("encrypted-", "")),
  },
}));

vi.mock("../../services/stravaApi", () => ({
  stravaApiService: {
    revokeToken: vi.fn(),
  },
}));

vi.mock("../../services/auth", () => ({
  generateJWT: vi.fn(() => "test-jwt-token"),
  verifyJWT: vi.fn(),
  setAuthCookie: vi.fn(),
  clearAuthCookie: vi.fn(),
  authenticateUser: vi.fn(),
}));

vi.mock("../../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock crypto for state generation
vi.mock("crypto", () => ({
  default: {
    randomBytes: vi.fn(() => ({
      toString: vi.fn(() => "test-state-token"),
    })),
  },
}));

describe("OAuth Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  describe("GET /api/auth/strava - OAuth Initiation", () => {
    it("should redirect to Strava OAuth with correct parameters", async () => {
      // Act
      const response = await request(app).get("/api/auth/strava");

      // Assert
      expect(response.status).toBe(302); // Redirect status
      expect(response.headers.location).toBeDefined();

      // Parse the redirect URL
      const redirectUrl = new URL(response.headers.location);

      expect(redirectUrl.origin).toBe("https://www.strava.com");
      expect(redirectUrl.pathname).toBe("/oauth/authorize");

      // Check query parameters
      const params = redirectUrl.searchParams;
      expect(params.get("client_id")).toBe("test-client-id");
      expect(params.get("redirect_uri")).toBe(
        "http://localhost:3000/api/auth/strava/callback",
      );
      expect(params.get("response_type")).toBe("code");
      expect(params.get("approval_prompt")).toBe("force");
      expect(params.get("scope")).toBe(
        "activity:read_all,activity:write,profile:read_all",
      );
      expect(params.get("state")).toBe("test-state-token");
    });

    it("should include all required OAuth scopes", async () => {
      // Act
      const response = await request(app).get("/api/auth/strava");

      // Assert
      const redirectUrl = new URL(response.headers.location);
      const scopes = redirectUrl.searchParams.get("scope")?.split(",") || [];

      expect(scopes).toContain("activity:read_all");
      expect(scopes).toContain("activity:write");
      expect(scopes).toContain("profile:read_all");
      expect(scopes).toHaveLength(3);
    });

    it("should generate a unique state parameter for CSRF protection", async () => {
      // Arrange - Mock crypto to return different values
      let callCount = 0;
      vi.mocked(crypto.randomBytes).mockImplementation(
        () =>
          ({
            toString: () => `state-${++callCount}`,
          }) as any,
      );

      // Act
      const response1 = await request(app).get("/api/auth/strava");
      const response2 = await request(app).get("/api/auth/strava");

      // Assert
      const state1 = new URL(response1.headers.location).searchParams.get(
        "state",
      );
      const state2 = new URL(response2.headers.location).searchParams.get(
        "state",
      );

      expect(state1).toBe("state-1");
      expect(state2).toBe("state-2");
      expect(state1).not.toBe(state2);
    });
  });

  describe("GET /api/auth/strava/callback - OAuth Callback", () => {
    const mockTokenResponse = {
      access_token: "strava-access-token",
      refresh_token: "strava-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 21600, // 6 hours from now
      athlete: {
        id: 123456,
        firstname: "John",
        lastname: "Doe",
        profile_medium: "https://example.com/profile.jpg",
        profile: "https://example.com/profile-small.jpg",
        city: "San Francisco",
        state: "California",
        country: "USA",
      },
    };

    beforeEach(() => {
      // Mock fetch for token exchange
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should handle successful OAuth callback with new user", async () => {
      // Arrange
      const authCode = "valid-auth-code";
      const mockUser = {
        id: "user-123",
        stravaAthleteId: "123456",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as any);

      vi.mocked(prisma.user.upsert).mockResolvedValueOnce(mockUser);

      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ code: authCode, state: "test-state" });

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:5173/auth/success",
      );

      // Verify token exchange
      expect(global.fetch).toHaveBeenCalledWith(
        "https://www.strava.com/oauth/token",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: "test-client-id",
            client_secret: "test-client-secret",
            code: authCode,
            grant_type: "authorization_code",
          }),
        }),
      );

      // Verify user upsert with encrypted tokens
      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { stravaAthleteId: "123456" },
        update: expect.objectContaining({
          accessToken: "encrypted-strava-access-token",
          refreshToken: "encrypted-strava-refresh-token",
          tokenExpiresAt: expect.any(Date),
          firstName: "John",
          lastName: "Doe",
          profileImageUrl: "https://example.com/profile.jpg",
          city: "San Francisco",
          state: "California",
          country: "USA",
          weatherEnabled: true,
        }),
        create: expect.objectContaining({
          stravaAthleteId: "123456",
          accessToken: "encrypted-strava-access-token",
          refreshToken: "encrypted-strava-refresh-token",
        }),
      });

      // Verify JWT generation and cookie setting
      expect(authService.generateJWT).toHaveBeenCalledWith(
        "user-123",
        "123456",
      );
      expect(authService.setAuthCookie).toHaveBeenCalled();
    });

    it("should handle OAuth error parameter", async () => {
      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ error: "access_denied" });

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:5173/auth/error?error=Authorization%20was%20denied.%20Please%20try%20again.",
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should handle missing authorization code", async () => {
      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ state: "test-state" }); // No code parameter

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:5173/auth/error?error=Authorization%20code%20was%20not%20received%20from%20Strava.",
      );
    });

    it("should handle token exchange failure", async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Invalid authorization code",
      } as any);

      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ code: "invalid-code", state: "test-state" });

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:5173/auth/error?error=Failed%20to%20exchange%20authorization%20code%20for%20access%20token.",
      );
    });

    it("should handle missing athlete data in token response", async () => {
      // Arrange
      const invalidTokenResponse = {
        access_token: "token",
        refresh_token: "refresh",
        expires_at: 123456789,
        // Missing athlete data
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => invalidTokenResponse,
      } as any);

      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state" });

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:5173/auth/error?error=Unable%20to%20retrieve%20athlete%20information%20from%20Strava.",
      );
    });

    it("should handle database errors during user creation", async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as any);

      vi.mocked(prisma.user.upsert).mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      // Act
      const response = await request(app)
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state" });

      // Assert
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        process.env.FRONTEND_URL +
          "/auth/error?error=An%20error%20occurred%20while%20saving%20your%20information.%20Please%20try%20again.",
      );
    });

    it("should properly encrypt sensitive tokens before storage", async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as any);

      // Act
      await request(app)
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state" });

      // Assert
      expect(encryptionService.encrypt).toHaveBeenCalledWith(
        "strava-access-token",
      );
      expect(encryptionService.encrypt).toHaveBeenCalledWith(
        "strava-refresh-token",
      );
      expect(encryptionService.encrypt).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /api/auth/logout - Logout", () => {
    it("should clear auth cookie and return success", async () => {
      // Arrange
      const mockReq = { user: { id: "user-123" } };

      // Act
      const response = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", "strava-weather-session=test-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Logged out successfully",
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should handle logout when no user is authenticated", async () => {
      // Act
      const response = await request(app).post("/api/auth/logout");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Logged out successfully",
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });
  });

  describe("GET /api/auth/check - Authentication Check", () => {
    it("should return authenticated=false when no token provided", async () => {
      // Act
      const response = await request(app).get("/api/auth/check");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: false,
        },
      });

      expect(authService.verifyJWT).not.toHaveBeenCalled();
    });

    it("should return authenticated=true with valid token and existing user", async () => {
      // Arrange
      const mockDecodedToken = {
        userId: "user-123",
        stravaAthleteId: "456789",
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 3600,
      };

      const mockUser = {
        id: "user-123",
        stravaAthleteId: "456789",
      };

      vi.mocked(authService.verifyJWT).mockReturnValueOnce(mockDecodedToken);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser);

      // Act
      const response = await request(app)
        .get("/api/auth/check")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: true,
          user: {
            id: "user-123",
            stravaAthleteId: "456789",
          },
        },
      });

      expect(authService.verifyJWT).toHaveBeenCalledWith("valid-jwt-token");
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        select: {
          id: true,
          stravaAthleteId: true,
        },
      });
    });

    it("should return authenticated=false when token is invalid", async () => {
      // Arrange
      vi.mocked(authService.verifyJWT).mockImplementationOnce(() => {
        throw new Error("Invalid token");
      });

      // Act
      const response = await request(app)
        .get("/api/auth/check")
        .set("Cookie", "strava-weather-session=invalid-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: false,
        },
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should return authenticated=false when user not found in database", async () => {
      // Arrange
      const mockDecodedToken = {
        userId: "user-123",
        stravaAthleteId: "456789",
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 3600,
      };

      vi.mocked(authService.verifyJWT).mockReturnValueOnce(mockDecodedToken);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

      // Act
      const response = await request(app)
        .get("/api/auth/check")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: false,
        },
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      // Arrange
      const mockDecodedToken = {
        userId: "user-123",
        stravaAthleteId: "456789",
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 3600,
      };

      vi.mocked(authService.verifyJWT).mockReturnValueOnce(mockDecodedToken);
      vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
        new Error("Database error"),
      );

      // Act
      const response = await request(app)
        .get("/api/auth/check")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: false,
        },
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/auth/revoke - Revoke Strava Access", () => {
    // Mock authenticateUser middleware to add user to request
    beforeEach(() => {
      vi.mocked(authService.authenticateUser).mockImplementation(
        async (req: any, res: any, next: any) => {
          req.user = {
            id: "user-123",
            stravaAthleteId: "456789",
            accessToken: "encrypted-access-token",
            weatherEnabled: true,
            firstName: "John",
            lastName: "Doe",
          };
          next();
        },
      );
    });

    it("should successfully revoke Strava access and delete user", async () => {
      // Arrange
      vi.mocked(stravaApiService.revokeToken).mockResolvedValueOnce(undefined);
      vi.mocked(prisma.user.delete).mockResolvedValueOnce({
        id: "user-123",
        stravaAthleteId: "456789",
      } as any);

      // Act
      const response = await request(app)
        .delete("/api/auth/revoke")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Strava access revoked and account deleted successfully",
      });

      // Verify token was decrypted and revoked
      expect(encryptionService.decrypt).toHaveBeenCalledWith(
        "encrypted-access-token",
      );
      expect(stravaApiService.revokeToken).toHaveBeenCalledWith("access-token");

      // Verify user was deleted
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });

      // Verify session was cleared
      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should delete user even if Strava token revocation fails", async () => {
      // Arrange
      vi.mocked(stravaApiService.revokeToken).mockRejectedValueOnce(
        new Error("Strava API error"),
      );
      vi.mocked(prisma.user.delete).mockResolvedValueOnce({
        id: "user-123",
        stravaAthleteId: "456789",
      } as any);

      // Act
      const response = await request(app)
        .delete("/api/auth/revoke")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Strava access revoked and account deleted successfully",
      });

      // Verify revocation was attempted
      expect(stravaApiService.revokeToken).toHaveBeenCalled();

      // Verify user was still deleted despite revocation failure
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });

      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should handle database deletion errors", async () => {
      // Arrange
      vi.mocked(stravaApiService.revokeToken).mockResolvedValueOnce(undefined);
      vi.mocked(prisma.user.delete).mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      // Act
      const response = await request(app)
        .delete("/api/auth/revoke")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(500);
      expect(response.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: "Failed to delete account. Please try again.",
            statusCode: 500,
          }),
        }),
      );

      // Verify token revocation was still attempted
      expect(stravaApiService.revokeToken).toHaveBeenCalled();

      // Verify session was cleared even on error
      expect(authService.clearAuthCookie).toHaveBeenCalled();
    });

    it("should require authentication", async () => {
      // Arrange - Override the mock to simulate unauthenticated request
      vi.mocked(authService.authenticateUser).mockImplementationOnce(
        async (req: any, res: any, next: any) => {
          res.status(401).json({
            success: false,
            error: "Authentication required",
          });
        },
      );

      // Act
      const response = await request(app).delete("/api/auth/revoke");

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: "Authentication required",
      });

      // Verify no operations were performed
      expect(stravaApiService.revokeToken).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it("should handle case where access token decryption fails", async () => {
      // Arrange
      vi.mocked(encryptionService.decrypt).mockImplementationOnce(() => {
        throw new Error("Decryption failed");
      });

      // Act
      const response = await request(app)
        .delete("/api/auth/revoke")
        .set("Cookie", "strava-weather-session=valid-jwt-token");

      // Assert
      expect(response.status).toBe(200); // Still succeeds as we don't fail on revocation errors
      expect(response.body).toEqual({
        success: true,
        message: "Strava access revoked and account deleted successfully",
      });

      // User should still be deleted
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });
    });
  });
});
