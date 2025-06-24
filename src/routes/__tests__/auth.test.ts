import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import session from "express-session";
import passport from "passport";

process.env.FRONTEND_URL = "http://localhost:3000";

// Mock environment config to prevent validation errors in CI
vi.mock("../../config/environment", () => ({
  config: {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    SESSION_SECRET: "test-session-secret",
    DATABASE_URL: "postgresql://test",
    OPENWEATHERMAP_API_KEY: "test-weather-key",
    STRAVA_WEBHOOK_VERIFY_TOKEN: "test-webhook-token",
    APP_URL: "http://localhost:3000",
    LOG_LEVEL: "info",
    isProduction: false,
    isDevelopment: true,
    isTest: true,
  },
}));

// Mock database to prevent connection attempts
vi.mock("../../lib", () => ({
  userRepository: {
    findById: vi.fn(),
    findByStravaAthleteId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteByStravaAthleteId: vi.fn(),
    upsert: vi.fn(),
  },
}));

// Mock logger to prevent imports that trigger environment validation
vi.mock("../../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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

import { authRouter } from "../auth";
import { userRepository } from "../../lib";
import { stravaApiService } from "../../services/stravaApi";

// Mock crypto before any imports that might use it
vi.mock("crypto", () => ({
  default: {
    randomBytes: vi.fn(() => ({
      toString: vi.fn(() => "test-state-token"),
    })),
  },
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => "test-state-token"),
  })),
}));

// Create Express app for testing with full session/passport setup
function createTestApp() {
  const app = express();

  // Essential middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session middleware (required for Passport)
  app.use(
    session({
      secret: "test-session-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }, // Allow HTTP in tests
    }),
  );

  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Auth routes
  app.use("/api/auth", authRouter);

  // Add basic error handler for testing
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      console.error("Test error:", err);
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        error: {
          message: err.message || "Internal server error",
          statusCode,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );

  return app;
}

// Mock dependencies
vi.mock("../../config/environment", () => ({
  config: {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    APP_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret",
  },
}));

vi.mock("../../repositories", () => ({
  userRepository: {
    findById: vi.fn(),
    findByStravaAthleteId: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../services/stravaApi", () => ({
  stravaApiService: {
    revokeToken: vi.fn(),
  },
}));

// Mock the global fetch for token exchange
vi.stubGlobal("fetch", vi.fn());

describe("Session-based Auth Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/auth/strava - OAuth Initiation", () => {
    it("should redirect to Strava OAuth with correct parameters", async () => {
      const response = await request(app).get("/api/auth/strava");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBeDefined();

      const redirectUrl = new URL(response.headers.location);
      expect(redirectUrl.hostname).toBe("www.strava.com");
      expect(redirectUrl.pathname).toBe("/oauth/authorize");
      expect(redirectUrl.searchParams.get("client_id")).toBe("test-client-id");
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("scope")).toBe(
        "activity:read_all,activity:write,profile:read_all",
      );
    });

    it("should store CSRF state in session", async () => {
      const agent = request.agent(app);

      const response = await agent.get("/api/auth/strava");

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(state).toBe("test-state-token");
    });
  });

  describe("GET /api/auth/strava/callback - OAuth Callback", () => {
    const mockTokenResponse = {
      access_token: "strava-access-token",
      refresh_token: "strava-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete: {
        id: 123456,
        firstname: "John",
        lastname: "Doe",
        profile_medium: "https://example.com/avatar.jpg",
        city: "Test City",
        state: "Test State",
        country: "Test Country",
      },
    };

    it("should handle successful OAuth callback with new user", async () => {
      const agent = request.agent(app);

      // First, get a session with state
      await agent.get("/api/auth/strava");

      // Mock successful token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as any);

      // Mock user creation
      const mockUser = {
        id: "user-123",
        stravaAthleteId: "123456",
        accessToken: "strava-access-token",
        refreshToken: "strava-refresh-token",
        tokenExpiresAt: new Date(mockTokenResponse.expires_at * 1000),
        firstName: "John",
        lastName: "Doe",
        profileImageUrl: "https://example.com/avatar.jpg",
        city: "Test City",
        state: "Test State",
        country: "Test Country",
        weatherEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (userRepository.upsert as any).mockResolvedValue(mockUser);

      const response = await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state-token" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/auth/success",
      );

      // Verify user was created/updated
      expect(userRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          stravaAthleteId: "123456",
          accessToken: "strava-access-token",
          refreshToken: "strava-refresh-token",
          firstName: "John",
          lastName: "Doe",
          weatherEnabled: true,
        }),
      );
    });

    it("should handle OAuth error parameter", async () => {
      const agent = request.agent(app);

      // First, get a session with state
      await agent.get("/api/auth/strava");

      const response = await agent
        .get("/api/auth/strava/callback")
        .query({ error: "access_denied", state: "test-state-token" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain("/auth/error");
    });

    it("should handle state mismatch (CSRF protection)", async () => {
      const agent = request.agent(app);

      // First, get a session with state
      await agent.get("/api/auth/strava");

      const response = await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "wrong-state" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain("Invalid%20state");
    });

    it("should handle missing authorization code", async () => {
      const agent = request.agent(app);

      // First, get a session with state
      await agent.get("/api/auth/strava");

      const response = await agent
        .get("/api/auth/strava/callback")
        .query({ state: "test-state-token" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain("/auth/error");
    });

    it("should handle token exchange failure", async () => {
      const agent = request.agent(app);

      // First, get a session with state
      await agent.get("/api/auth/strava");

      // Mock failed token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        text: async () => "Token exchange failed",
      } as any);

      const response = await agent
        .get("/api/auth/strava/callback")
        .query({ code: "invalid-code", state: "test-state-token" });

      // Passport error handling causes a 500 error to be thrown
      // In production, this would be caught by error middleware
      expect(response.status).toBe(500);
      expect(response.body.error.message).toContain("Token exchange failed");
    });
  });

  describe("GET /api/auth/check - Authentication Check", () => {
    it("should return authenticated=false when no session", async () => {
      const response = await request(app).get("/api/auth/check");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: false,
        },
      });
    });

    it("should return authenticated=true with valid session", async () => {
      const agent = request.agent(app);

      // Mock a successful login first by simulating the full OAuth flow
      await agent.get("/api/auth/strava");

      // Mock successful token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "strava-access-token",
          refresh_token: "strava-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          athlete: {
            id: 123456,
            firstname: "John",
            lastname: "Doe",
          },
        }),
      } as any);

      const mockUser = {
        id: "user-123",
        stravaAthleteId: "123456",
        firstName: "John",
        lastName: "Doe",
      };

      (userRepository.upsert as any).mockResolvedValue(mockUser);
      (userRepository.findById as any).mockResolvedValue(mockUser);

      // Complete OAuth flow
      await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state-token" });

      // Now check auth status
      const response = await agent.get("/api/auth/check");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          authenticated: true,
          user: {
            id: "user-123",
            stravaAthleteId: "123456",
          },
        },
      });
    });
  });

  describe("POST /api/auth/logout - Logout", () => {
    it("should successfully logout and destroy session", async () => {
      const agent = request.agent(app);

      // First login
      await agent.get("/api/auth/strava");

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "strava-access-token",
          refresh_token: "strava-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          athlete: {
            id: 123456,
            firstname: "John",
            lastname: "Doe",
          },
        }),
      } as any);

      (userRepository.upsert as any).mockResolvedValue({
        id: "user-123",
        stravaAthleteId: "123456",
      });

      await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state-token" });

      // Now logout
      const response = await agent.post("/api/auth/logout");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Logged out successfully",
      });

      // Verify session was destroyed by checking auth status
      const checkResponse = await agent.get("/api/auth/check");
      expect(checkResponse.body.data.authenticated).toBe(false);
    });

    it("should handle logout when no user is authenticated", async () => {
      const response = await request(app).post("/api/auth/logout");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Logged out successfully",
      });
    });
  });

  describe("DELETE /api/auth/revoke - Revoke Strava Access", () => {
    it("should successfully revoke Strava access and delete user", async () => {
      const agent = request.agent(app);

      // First login
      await agent.get("/api/auth/strava");

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "strava-access-token",
          refresh_token: "strava-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          athlete: {
            id: 123456,
            firstname: "John",
            lastname: "Doe",
          },
        }),
      } as any);

      const mockUser = {
        id: "user-123",
        stravaAthleteId: "123456",
        accessToken: "strava-access-token",
      };

      (userRepository.upsert as any).mockResolvedValue(mockUser);
      (userRepository.findById as any).mockResolvedValue(mockUser);

      await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state-token" });

      // Mock successful revocation and deletion
      (stravaApiService.revokeToken as any).mockResolvedValue(undefined);
      (userRepository.delete as any).mockResolvedValue(undefined);

      const response = await agent.delete("/api/auth/revoke");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Account deleted successfully",
      });

      // Verify token was revoked
      expect(stravaApiService.revokeToken).toHaveBeenCalledWith(
        "strava-access-token",
      );

      // Verify user was deleted
      expect(userRepository.delete).toHaveBeenCalledWith("user-123");
    });

    it("should require authentication", async () => {
      const response = await request(app).delete("/api/auth/revoke");

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: "Not authenticated",
      });
    });

    it("should delete user even if Strava token revocation fails", async () => {
      const agent = request.agent(app);

      // First login
      await agent.get("/api/auth/strava");

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "strava-access-token",
          refresh_token: "strava-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          athlete: {
            id: 123456,
            firstname: "John",
            lastname: "Doe",
          },
        }),
      } as any);

      const mockUser = {
        id: "user-123",
        stravaAthleteId: "123456",
        accessToken: "strava-access-token",
      };

      (userRepository.upsert as any).mockResolvedValue(mockUser);
      (userRepository.findById as any).mockResolvedValue(mockUser);

      await agent
        .get("/api/auth/strava/callback")
        .query({ code: "valid-code", state: "test-state-token" });

      // Mock failed revocation but successful deletion
      (stravaApiService.revokeToken as any).mockRejectedValue(
        new Error("Revocation failed"),
      );
      (userRepository.delete as any).mockResolvedValue(undefined);

      const response = await agent.delete("/api/auth/revoke");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Account deleted successfully",
      });

      // Still should have tried to revoke
      expect(stravaApiService.revokeToken).toHaveBeenCalledWith(
        "strava-access-token",
      );

      // User should still be deleted
      expect(userRepository.delete).toHaveBeenCalledWith("user-123");
    });
  });
});
