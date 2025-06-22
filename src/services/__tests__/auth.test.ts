import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import {
  generateJWT,
  verifyJWT,
  setAuthCookie,
  clearAuthCookie,
  authenticateUser,
} from "../auth";
import { config } from "../../config/environment";
import { prisma } from "../../lib";

// Mock the config module
vi.mock("../../config/environment", () => ({
  config: {
    JWT_SECRET: "test-secret-key-for-testing-purposes-only",
    auth: {
      sessionCookieName: "strava-weather-session",
    },
  },
}));

// Mock logger to avoid console noise
vi.mock("../../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock prisma
vi.mock("../../lib", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// Helper to create mock response
function createMockResponse(): Response & {
  _cookies: Record<string, any>;
  _json: any;
  _status: number;
} {
  const cookies: Record<string, any> = {};
  let statusCode = 200;
  let jsonData: any;

  const res = {
    _cookies: cookies,
    _status: statusCode,
    _json: jsonData,
    cookie: vi.fn((name: string, value: string, options: any) => {
      cookies[name] = { value, options };
      return res;
    }),
    clearCookie: vi.fn((name: string, options: any) => {
      delete cookies[name];
      return res;
    }),
    status: vi.fn((code: number) => {
      res._status = code;
      return res;
    }),
    json: vi.fn((data: any) => {
      res._json = data;
      return res;
    }),
  } as any;

  return res;
}

// Helper to create mock request
function createMockRequest(
  options: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    requestId?: string;
  } = {},
): Request {
  return {
    cookies: options.cookies || {},
    headers: options.headers || {},
    requestId: options.requestId || "test-request-id",
  } as any;
}

// Helper to create mock next function
function createMockNext(): NextFunction {
  return vi.fn() as any;
}

// Mock the config module
vi.mock("../../config/environment", () => ({
  config: {
    JWT_SECRET: "test-secret-key-for-testing-purposes-only",
    auth: {
      sessionCookieName: "strava-weather-session",
    },
  },
}));

// Mock logger to avoid console noise
vi.mock("../../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Authentication Service", () => {
  describe("generateJWT", () => {
    it("should generate a valid JWT token with correct claims", () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";

      // Act
      const token = generateJWT(userId, stravaAthleteId);

      // Assert
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT has 3 parts

      // Decode and verify the token
      const decoded = jwt.verify(token, config.JWT_SECRET) as any;

      expect(decoded.userId).toBe(userId);
      expect(decoded.stravaAthleteId).toBe(stravaAthleteId);
      expect(decoded.iss).toBe("strava-weather-api");
      expect(decoded.aud).toBe("strava-weather-client");
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();

      // Verify expiration is 30 days from now (with 5 second tolerance)
      const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
      const expectedExpiration = decoded.iat + thirtyDaysInSeconds;
      expect(decoded.exp).toBeGreaterThanOrEqual(expectedExpiration - 5);
      expect(decoded.exp).toBeLessThanOrEqual(expectedExpiration + 5);
    });

    it("should handle stravaAthleteId as number type", () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = 456789; // number type

      // Act
      const token = generateJWT(userId, stravaAthleteId);

      // Assert
      const decoded = jwt.verify(token, config.JWT_SECRET) as any;
      expect(decoded.stravaAthleteId).toBe("456789"); // Should be converted to string
      expect(typeof decoded.stravaAthleteId).toBe("string");
    });

    it("should handle stravaAthleteId as bigint type", () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = BigInt(456789); // bigint type

      // Act
      const token = generateJWT(userId, stravaAthleteId);

      // Assert
      const decoded = jwt.verify(token, config.JWT_SECRET) as any;
      expect(decoded.stravaAthleteId).toBe("456789"); // Should be converted to string
      expect(typeof decoded.stravaAthleteId).toBe("string");
    });
  });

  describe("verifyJWT", () => {
    it("should successfully verify a valid token", () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      // Act
      const decoded = verifyJWT(token);

      // Assert
      expect(decoded).toBeDefined();
      expect(decoded.userId).toBe(userId);
      expect(decoded.stravaAthleteId).toBe(stravaAthleteId);
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
    });

    it("should throw error for expired token", () => {
      // Arrange - Create token that expired 1 hour ago
      const payload = {
        userId: "user-123",
        stravaAthleteId: "456789",
      };
      const token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: "-1h", // Expired 1 hour ago
        issuer: "strava-weather-api",
        audience: "strava-weather-client",
      });

      // Act & Assert
      expect(() => verifyJWT(token)).toThrow("Token expired");
    });

    it("should throw error for invalid token signature", () => {
      // Arrange - Create token with wrong secret
      const payload = {
        userId: "user-123",
        stravaAthleteId: "456789",
      };
      const token = jwt.sign(payload, "wrong-secret-key", {
        expiresIn: "30d",
        issuer: "strava-weather-api",
        audience: "strava-weather-client",
      });

      // Act & Assert
      expect(() => verifyJWT(token)).toThrow("Invalid token");
    });

    it("should throw error for token with wrong issuer", () => {
      // Arrange
      const payload = {
        userId: "user-123",
        stravaAthleteId: "456789",
      };
      const token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: "30d",
        issuer: "wrong-issuer", // Wrong issuer
        audience: "strava-weather-client",
      });

      // Act & Assert
      expect(() => verifyJWT(token)).toThrow("Invalid token");
    });

    it("should throw error for token with wrong audience", () => {
      // Arrange
      const payload = {
        userId: "user-123",
        stravaAthleteId: "456789",
      };
      const token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: "30d",
        issuer: "strava-weather-api",
        audience: "wrong-audience", // Wrong audience
      });

      // Act & Assert
      expect(() => verifyJWT(token)).toThrow("Invalid token");
    });

    it("should throw error for malformed token", () => {
      // Arrange
      const malformedToken = "not.a.valid.jwt.token";

      // Act & Assert
      expect(() => verifyJWT(malformedToken)).toThrow("Invalid token");
    });
  });

  describe("setAuthCookie", () => {
    it("should set cookie with correct name and security options", () => {
      // Arrange
      const res = createMockResponse();
      const token = "test-jwt-token";

      // Act
      setAuthCookie(res, token);

      // Assert
      expect(res.cookie).toHaveBeenCalledTimes(1);
      expect(res.cookie).toHaveBeenCalledWith("strava-weather-session", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
        path: "/",
      });

      // Verify cookie was set in mock
      expect(res._cookies["strava-weather-session"]).toEqual({
        value: token,
        options: {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: "/",
        },
      });
    });
  });

  describe("clearAuthCookie", () => {
    it("should clear cookie with matching options", () => {
      // Arrange
      const res = createMockResponse();
      // First set a cookie
      res._cookies["strava-weather-session"] = {
        value: "some-token",
        options: {},
      };

      // Act
      clearAuthCookie(res);

      // Assert
      expect(res.clearCookie).toHaveBeenCalledTimes(1);
      expect(res.clearCookie).toHaveBeenCalledWith("strava-weather-session", {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });

      // Verify cookie was cleared in mock
      expect(res._cookies["strava-weather-session"]).toBeUndefined();
    });
  });

  describe("authenticateUser middleware", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should authenticate user with valid token from cookie", async () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      const req = createMockRequest({
        cookies: { "strava-weather-session": token },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const mockUser = {
        id: userId,
        stravaAthleteId,
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: "John",
        lastName: "Doe",
      };

      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValueOnce(
        mockUser,
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: {
          id: true,
          stravaAthleteId: true,
          accessToken: true,
          weatherEnabled: true,
          firstName: true,
          lastName: true,
        },
      });

      expect((req as any).user).toEqual({
        id: userId,
        stravaAthleteId,
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: "John",
        lastName: "Doe",
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("should authenticate user with valid token from Authorization header", async () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      const req = createMockRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const mockUser = {
        id: userId,
        stravaAthleteId,
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: "Jane",
        lastName: "Smith",
      };

      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValueOnce(
        mockUser,
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect((req as any).user).toBeDefined();
      expect((req as any).user.id).toBe(userId);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("should reject request with no token", async () => {
      // Arrange
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Authentication required",
        message: "No authentication token provided",
      });
      expect(next).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("should reject request with expired token", async () => {
      // Arrange
      const expiredToken = jwt.sign(
        { userId: "user-123", stravaAthleteId: "456789" },
        config.JWT_SECRET,
        {
          expiresIn: "-1h",
          issuer: "strava-weather-api",
          audience: "strava-weather-client",
        },
      );

      const req = createMockRequest({
        cookies: { "strava-weather-session": expiredToken },
      });
      const res = createMockResponse();
      const next = createMockNext();

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Authentication failed",
        message: "Token expired",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should reject request when user not found in database", async () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      const req = createMockRequest({
        cookies: { "strava-weather-session": token },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValueOnce(
        null,
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Authentication failed",
        message: "User account not found",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should reject request when stravaAthleteId mismatch", async () => {
      // Arrange
      const userId = "user-123";
      const token = generateJWT(userId, "456789");

      const req = createMockRequest({
        cookies: { "strava-weather-session": token },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const mockUser = {
        id: userId,
        stravaAthleteId: "999999", // Different ID
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: "John",
        lastName: "Doe",
      };

      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValueOnce(
        mockUser,
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Authentication failed",
        message: "Invalid token",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      const req = createMockRequest({
        cookies: { "strava-weather-session": token },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (prisma.user.findUnique as MockedFunction<any>).mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Authentication failed",
        message: "Database connection failed",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should handle users with null firstName and lastName", async () => {
      // Arrange
      const userId = "user-123";
      const stravaAthleteId = "456789";
      const token = generateJWT(userId, stravaAthleteId);

      const req = createMockRequest({
        cookies: { "strava-weather-session": token },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const mockUser = {
        id: userId,
        stravaAthleteId,
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: null,
        lastName: null,
      };

      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValueOnce(
        mockUser,
      );

      // Act
      await authenticateUser(req, res, next);

      // Assert
      expect((req as any).user).toEqual({
        id: userId,
        stravaAthleteId,
        accessToken: "encrypted-token",
        weatherEnabled: true,
        firstName: "",
        lastName: "",
      });
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
