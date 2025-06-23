import { Router, Request, Response, NextFunction } from "express";
import passport from "../config/passport";
import { getStravaAuthUrl } from "../config/passport";
import { logger } from "../utils/logger";
import { asyncHandler } from "../middleware/errorHandler";
import crypto from "crypto";
import { stravaApiService } from "../services/stravaApi";
import { prisma } from "../lib";

const authRouter = Router();

/**
 * Initiate Strava OAuth flow
 * GET /api/auth/strava
 */
authRouter.get("/strava", (req: Request, res: Response) => {
  // Generate CSRF state token
  const state = crypto.randomBytes(16).toString("hex");

  // Store state in session for verification
  req.session.oauthState = state;

  logger.info("Initiating Strava OAuth flow", {
    requestId: (req as any).requestId,
  });

  const authUrl = getStravaAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * Handle Strava OAuth callback
 * GET /api/auth/strava/callback
 */
authRouter.get(
  "/strava/callback",
  (req: Request, res: Response, next: NextFunction) => {
    // Verify CSRF state
    const { state } = req.query;
    if (state !== req.session.oauthState) {
      logger.warn("OAuth state mismatch - possible CSRF", {
        requestId: (req as any).requestId,
      });
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/error?error=Invalid state`,
      );
    }

    // Clear state from session
    delete req.session.oauthState;

    // Continue to Passport authentication
    next();
  },
  passport.authenticate("strava-callback", {
    failureRedirect: `${process.env.FRONTEND_URL}/auth/error`,
  }),
  (req: Request, res: Response) => {
    // Success! User is now in req.user and session is created
    logger.info("OAuth callback successful", {
      userId: (req.user as any)?.id,
      requestId: (req as any).requestId,
    });

    res.redirect(`${process.env.FRONTEND_URL}/auth/success`);
  },
);

/**
 * Logout user
 * POST /api/auth/logout
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;

  req.logout((err) => {
    if (err) {
      logger.error("Logout error", err);
      return res.status(500).json({
        success: false,
        error: "Logout failed",
      });
    }

    req.session.destroy((err) => {
      if (err) {
        logger.error("Session destruction error", err);
      }

      // Clear the session cookie
      res.clearCookie("strava-weather-session");

      logger.info("User logged out", {
        userId,
        requestId: (req as any).requestId,
      });

      res.json({
        success: true,
        message: "Logged out successfully",
      });
    });
  });
});

/**
 * Check authentication status
 * GET /api/auth/check
 */
authRouter.get(
  "/check",
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.json({
        success: true,
        data: {
          authenticated: false,
        },
      });
    }

    res.json({
      success: true,
      data: {
        authenticated: true,
        user: {
          id: (req.user as any).id,
          stravaAthleteId: (req.user as any).stravaAthleteId,
        },
      },
    });
  }),
);

/**
 * Revoke Strava access and delete account
 * DELETE /api/auth/revoke
 *
 * Note: Simplified - no token decryption needed!
 */
authRouter.delete(
  "/revoke",
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated",
      });
    }

    const userId = (req.user as any).id;

    logger.info("Revoking Strava access", {
      userId,
      requestId: (req as any).requestId,
    });

    try {
      // Get user with tokens
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accessToken: true },
      });

      if (user?.accessToken) {
        // Revoke token with Strava (no decryption needed!)
        await stravaApiService.revokeToken(user.accessToken);
      }
    } catch (error) {
      logger.warn("Failed to revoke Strava token", { userId, error });
    }

    // Delete user data
    await prisma.user.delete({
      where: { id: userId },
    });

    // Logout
    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie("strava-weather-session");

        res.json({
          success: true,
          message: "Account deleted successfully",
        });
      });
    });
  }),
);

export { authRouter };
