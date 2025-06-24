import { Request, Response, NextFunction } from "express";
import { userRepository } from "../lib";
import { logger } from "../utils/logger";

/**
 * Extended request interface with authenticated user
 */
export interface AuthenticatedUser {
  id: string;
  stravaAthleteId: string;
  firstName: string;
  lastName: string;
  weatherEnabled: boolean;
  accessToken: string;
  refreshToken?: string;
}

declare global {
  namespace Express {
    interface User {
      id: string;
      stravaAthleteId: string;
    }

    interface Request {
      user?: User;
    }
  }
}

/**
 * Authentication middleware
 */
export async function authenticateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestId = (req as any).requestId;

  if (!req.isAuthenticated() || !req.user) {
    logger.debug("Authentication failed: no session", { requestId });

    res.status(401).json({
      success: false,
      error: "Authentication required",
      message: "Please log in to continue",
    });
    return;
  }

  try {
    const user = await userRepository.findById(req.user.id);

    if (!user) {
      logger.warn("Session user not found in database", {
        userId: req.user.id,
        requestId,
      });

      // Clear invalid session
      req.logout(() => {});

      res.status(401).json({
        success: false,
        error: "Authentication failed",
        message: "User account not found",
      });
      return;
    }

    // Attach full user data to request
    (req as any).user = user;

    logger.debug("User authenticated successfully", {
      userId: user.id,
      requestId,
    });

    next();
  } catch (error) {
    logger.error("Authentication error", {
      error: error instanceof Error ? error.message : "Unknown error",
      requestId,
    });

    res.status(500).json({
      success: false,
      error: "Authentication error",
      message: "An error occurred during authentication",
    });
  }
}

/**
 * Optional authentication middleware
 *
 * Same as authenticateUser but doesn't require authentication
 * Useful for endpoints that have different behavior for logged-in users
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.isAuthenticated() && req.user) {
    try {
      const user = await userRepository.findById(req.user.id);

      if (user) {
        (req as any).user = user;
      }
    } catch (error) {
      // Log but don't fail - this is optional
      logger.debug("Optional auth lookup failed", { error });
    }
  }

  next();
}
