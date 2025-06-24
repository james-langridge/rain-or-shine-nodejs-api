import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response, NextFunction } from "express";

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

vi.mock("../../lib", () => ({
  userRepository: {
    findById: vi.fn(),
  },
}));

import { authenticateUser } from "../auth";
import { userRepository } from "../../lib";

describe("Session Auth Middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      isAuthenticated: vi.fn(),
      user: undefined,
      logout: vi.fn((cb) => cb()),
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    next = vi.fn();
  });

  it("should allow authenticated users", async () => {
    // Setup
    req.isAuthenticated = vi.fn(() => true);
    req.user = { id: "user-123", stravaAthleteId: "456789" };

    const mockUser = {
      id: "user-123",
      stravaAthleteId: "456789",
      accessToken: "plain-token",
      refreshToken: "plain-refresh",
      weatherEnabled: true,
      firstName: "John",
      lastName: "Doe",
    };

    (userRepository.findById as any).mockResolvedValue(mockUser);

    // Act
    await authenticateUser(req as Request, res as Response, next);

    // Assert
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(mockUser);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject unauthenticated users", async () => {
    // Setup
    req.isAuthenticated = vi.fn(() => false);

    // Act
    await authenticateUser(req as Request, res as Response, next);

    // Assert
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Authentication required",
      message: "Please log in to continue",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
