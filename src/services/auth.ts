import jwt from "jsonwebtoken";
import { config } from "../config/environment";
import { prisma } from "../lib";
import { logger } from "../utils/logger";
import type { NextFunction, Request, Response } from "express";

/**
 * JWT payload structure
 */
export interface JwtPayload {
  userId: string;
  stravaAthleteId: string;
  iat: number;
  exp: number;
}

/**
 * Authenticated user interface
 */
export interface AuthenticatedUser {
  id: string;
  stravaAthleteId: string;
  firstName: string;
  lastName: string;
  weatherEnabled: boolean;
  accessToken: string; // Encrypted
  refreshToken?: string; // Optional, encrypted when present
}

/**
 * Extended request interface with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * JWT configuration constants
 */
const JWT_CONFIG = {
  expiresIn: "30d",
  issuer: "strava-weather-api",
  audience: "strava-weather-client",
} as const;

/**
 * Cookie configuration for auth tokens
 */
const AUTH_COOKIE_CONFIG = {
  httpOnly: true,
  secure: true, // Always true for security
  sameSite: "lax" as const,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
  path: "/",
} as const;

/**
 * Generate JWT token for user authentication
 *
 * Creates a signed JWT containing user identification data with a 30-day expiration.
 *
 * @param userId - Internal user ID from database
 * @param stravaAthleteId - Strava athlete ID (can be string, number, or bigint)
 * @returns Signed JWT token
 */
export function generateJWT(
  userId: string,
  stravaAthleteId: string | number | bigint,
): string {
  const athleteIdStr =
    typeof stravaAthleteId !== "string"
      ? stravaAthleteId.toString()
      : stravaAthleteId;

  const payload = {
    userId,
    stravaAthleteId: athleteIdStr,
  };

  logger.debug("Generating JWT token", {
    userId,
    stravaAthleteId: athleteIdStr,
    expiresIn: JWT_CONFIG.expiresIn,
  });

  return jwt.sign(payload, config.JWT_SECRET, JWT_CONFIG);
}

/**
 * Verify and decode JWT token
 *
 * Validates token signature, expiration, issuer, and audience.
 *
 * @param token - JWT token to verify
 * @returns Decoded JWT payload
 * @throws Error with specific message for different failure scenarios
 */
export function verifyJWT(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: JWT_CONFIG.issuer,
      audience: JWT_CONFIG.audience,
    }) as JwtPayload;

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug("JWT token expired", { error: error.message });
      throw new Error("Token expired");
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.debug("Invalid JWT token", { error: error.message });
      throw new Error("Invalid token");
    } else {
      logger.error("JWT verification failed", { error });
      throw new Error("Token verification failed");
    }
  }
}

/**
 * Extract authentication token from request
 *
 * Checks for token in the following order:
 * 1. HTTP-only cookie (most secure, preferred)
 * 2. Authorization header with Bearer scheme (for API compatibility)
 *
 * @param req - Express request object
 * @returns JWT token or null if not found
 */
function extractTokenFromRequest(req: Request): string | null {
  // Check HTTP-only cookie first (most secure)
  const cookieToken = req.cookies?.[config.auth.sessionCookieName];
  if (cookieToken) {
    logger.debug("Token found in cookie", {
      cookieName: config.auth.sessionCookieName,
      requestId: (req as any).requestId,
    });
    return cookieToken;
  }

  // Fallback to Authorization header for API compatibility
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    logger.debug("Token found in Authorization header", {
      requestId: (req as any).requestId,
    });
    return authHeader.substring(7);
  }

  logger.debug("No authentication token found", {
    hasCookies: !!req.cookies,
    hasAuthHeader: !!authHeader,
    requestId: (req as any).requestId,
  });

  return null;
}

/**
 * Set secure HTTP-only cookie with JWT token
 *
 * Creates a secure, HTTP-only cookie with appropriate security settings.
 * Cookie is set with SameSite=lax to prevent CSRF while allowing navigation.
 *
 * @param res - Express response object
 * @param token - JWT token to store in cookie
 */
export function setAuthCookie(res: Response, token: string): void {
  res.cookie(config.auth.sessionCookieName, token, AUTH_COOKIE_CONFIG);

  logger.info("Authentication cookie set", {
    cookieName: config.auth.sessionCookieName,
    secure: AUTH_COOKIE_CONFIG.secure,
    sameSite: AUTH_COOKIE_CONFIG.sameSite,
    maxAge: AUTH_COOKIE_CONFIG.maxAge,
  });
}

/**
 * Clear authentication cookie
 *
 * Removes the authentication cookie by setting it with an expired date.
 * Cookie options must match those used when setting the cookie.
 *
 * @param res - Express response object
 */
export function clearAuthCookie(res: Response): void {
  res.clearCookie(config.auth.sessionCookieName, {
    httpOnly: AUTH_COOKIE_CONFIG.httpOnly,
    secure: AUTH_COOKIE_CONFIG.secure,
    sameSite: AUTH_COOKIE_CONFIG.sameSite,
    path: AUTH_COOKIE_CONFIG.path,
  });

  logger.info("Authentication cookie cleared", {
    cookieName: config.auth.sessionCookieName,
  });
}

/**
 * Express middleware for request authentication
 *
 * Validates JWT tokens and attaches user information to the request object.
 * Tokens in the database are stored encrypted - this middleware does not
 * decrypt them as that's handled by services that need the actual tokens.
 *
 * Usage:
 * ```typescript
 * router.get('/protected', authenticateUser, (req, res) => {
 *   const user = req.user; // Authenticated user data
 * });
 * ```
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function authenticateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestId = (req as any).requestId;

  try {
    const token = extractTokenFromRequest(req);

    if (!token) {
      logger.debug("Authentication failed: no token provided", { requestId });
      res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "No authentication token provided",
      });
      return;
    }

    // Verify JWT token
    const decoded = verifyJWT(token);

    logger.debug("JWT token verified", {
      userId: decoded.userId,
      stravaAthleteId: decoded.stravaAthleteId,
      requestId,
    });

    // Retrieve user from database
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        stravaAthleteId: true,
        accessToken: true, // Encrypted
        weatherEnabled: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!user) {
      logger.warn("Authentication failed: user not found", {
        userId: decoded.userId,
        requestId,
      });
      res.status(401).json({
        success: false,
        error: "Authentication failed",
        message: "User account not found",
      });
      return;
    }

    // Verify Strava athlete ID matches
    if (user.stravaAthleteId !== decoded.stravaAthleteId) {
      logger.warn("Authentication failed: athlete ID mismatch", {
        userId: user.id,
        tokenAthleteId: decoded.stravaAthleteId,
        dbAthleteId: user.stravaAthleteId,
        requestId,
      });
      res.status(401).json({
        success: false,
        error: "Authentication failed",
        message: "Invalid token",
      });
      return;
    }

    // Attach user to request object
    // Note: accessToken remains encrypted - services will decrypt as needed
    (req as AuthenticatedRequest).user = {
      id: user.id,
      stravaAthleteId: user.stravaAthleteId,
      accessToken: user.accessToken, // Encrypted
      weatherEnabled: user.weatherEnabled,
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
    };

    logger.debug("User authenticated successfully", {
      userId: user.id,
      requestId,
    });

    next();
  } catch (error) {
    logger.error("Authentication error", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    });

    const message =
      error instanceof Error ? error.message : "Authentication failed";

    res.status(401).json({
      success: false,
      error: "Authentication failed",
      message,
    });
  }
}
