import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { authenticateUser } from "../auth";
import { prisma } from "../../lib";

vi.mock("../../lib", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

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

    (prisma.user.findUnique as any).mockResolvedValue(mockUser);

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
