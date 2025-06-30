import { Router, Request, Response, NextFunction } from "express";
import passport from "../config/passport";
import { getStravaAuthUrl } from "../config/passport";
import { logger } from "../utils/logger";
import { asyncHandler } from "../middleware/errorHandler";
import crypto from "crypto";
import { stravaApiService } from "../services/stravaApi";
import { userRepository } from "../lib";

const authRouter = Router();

/**
 * GET /api/auth/strava
 *
 * Initiate Strava OAuth flow - redirects user to Strava authorization page.
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
 * GET /api/auth/strava/callback
 *
 * Handle Strava OAuth callback - processes OAuth response and creates user session.
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
 * POST /api/auth/logout
 *
 * Logout user - destroys session and clears authentication cookies.
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;

  req.logout((err) => {
    if (err) {
      logger.error("Logout error", err);
      res.status(500).json({
        success: false,
        error: "Logout failed",
      });
      return;
    }

    req.session.destroy((sessionErr) => {
      if (sessionErr) {
        logger.error("Session destruction error", sessionErr);
      }

      res.clearCookie("rain-or-shine-session");

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
  return;
});

/**
 * GET /api/auth/check
 *
 * Check authentication status - returns whether user is authenticated and basic user info.
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

    return res.json({
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
 * DELETE /api/auth/revoke
 *
 * Revoke Strava access and delete account - permanently deletes user account and all data.
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
      const user = await userRepository.findById(userId);

      if (user?.accessToken) {
        // Revoke token with Strava
        await stravaApiService.revokeToken(user.accessToken);
      }
    } catch (error) {
      logger.warn("Failed to revoke Strava token", { userId, error });
    }

    await userRepository.delete(userId);

    // Logout
    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie("rain-or-shine-session");

        return res.json({
          success: true,
          message: "Account deleted successfully",
        });
      });
    });
    return;
  }),
);

export { authRouter };
