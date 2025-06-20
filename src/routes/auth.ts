import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config/environment";
import {
  generateJWT,
  setAuthCookie,
  clearAuthCookie,
  authenticateUser,
  verifyJWT,
} from "../services/auth";
import { prisma } from "../lib";
import { ensureWebhooksInitialized } from "../utils/initWebhooks";
import { stravaApiService } from "../services/stravaApi";
import { encryptionService } from "../services/encryption";
import { logger } from "../utils/logger";
import { asyncHandler } from "../middleware/errorHandler";
import crypto from "crypto";

/**
 * Authentication router
 *
 * Handles OAuth flow with Strava, session management, and user authentication.
 * All tokens are encrypted at rest and transmitted via secure HTTP-only cookies.
 */
const authRouter = Router();

/**
 * Strava OAuth scopes required for the application
 */
const STRAVA_OAUTH_SCOPES = [
  "activity:read_all",
  "activity:write",
  "profile:read_all",
];

/**
 * OAuth error codes and their user-friendly messages
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Authorization was denied. Please try again.",
  no_code: "Authorization code was not received from Strava.",
  token_exchange_failed:
    "Failed to exchange authorization code for access token.",
  no_athlete_data: "Unable to retrieve athlete information from Strava.",
  database_error:
    "An error occurred while saving your information. Please try again.",
};

/**
 * Initiate Strava OAuth flow
 *
 * GET /api/auth/strava
 *
 * Redirects the user to Strava's OAuth authorization page with appropriate
 * scopes and CSRF protection via state parameter.
 */
authRouter.get("/strava", (req: Request, res: Response) => {
  // Generate cryptographically secure state parameter for CSRF protection
  const state = crypto.randomBytes(32).toString("hex");

  logger.info("Initiating Strava OAuth flow", {
    scopes: STRAVA_OAUTH_SCOPES,
    redirectUri: `${config.APP_URL}/api/auth/strava/callback`,
    requestId: (req as any).requestId,
  });

  // TODO: Store state in session/cache for verification on callback
  // For production, implement proper state storage and verification

  const authUrl = new URL(config.api.strava.authUrl);
  authUrl.searchParams.set("client_id", config.STRAVA_CLIENT_ID);
  authUrl.searchParams.set(
    "redirect_uri",
    `${config.APP_URL}/api/auth/strava/callback`,
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("approval_prompt", "force");
  authUrl.searchParams.set("scope", STRAVA_OAUTH_SCOPES.join(","));
  authUrl.searchParams.set("state", state);

  logger.debug("Redirecting to Strava OAuth", {
    authUrl: authUrl.toString().replace(/client_id=\w+/, "client_id=***"),
  });

  res.redirect(authUrl.toString());
});

/**
 * Handle Strava OAuth callback
 *
 * GET /api/auth/strava/callback
 *
 * Processes the OAuth callback from Strava:
 * 1. Exchanges authorization code for access tokens
 * 2. Creates or updates user in database with encrypted tokens
 * 3. Generates JWT session and sets secure cookie
 * 4. Ensures webhook subscription is active
 *
 * @query code - Authorization code from Strava
 * @query state - CSRF protection state parameter
 * @query error - OAuth error if authorization was denied
 */
authRouter.get(
  "/strava/callback",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { code, state, error } = req.query;
    const requestId = (req as any).requestId;

    logger.info("OAuth callback received", {
      hasCode: !!code,
      hasState: !!state,
      error: error as string,
      requestId,
    });

    // Handle OAuth errors
    if (error) {
      logger.warn("OAuth authorization denied", { error, requestId });
      const errorMessage =
        OAUTH_ERROR_MESSAGES[error as string] || "Authorization failed";
      return res.redirect(
        `${config.APP_URL}/auth/error?error=${encodeURIComponent(errorMessage)}`,
      );
    }

    if (!code || typeof code !== "string") {
      logger.warn("OAuth callback missing authorization code", { requestId });
      const errorMsg =
        OAUTH_ERROR_MESSAGES.no_code || "Authorization code was not received";
      return res.redirect(
        `${config.APP_URL}/auth/error?error=${encodeURIComponent(errorMsg)}`,
      );
    }

    // TODO: Verify state parameter matches stored value for CSRF protection

    // Exchange authorization code for tokens
    logger.info("Exchanging authorization code for access token", {
      requestId,
    });

    const tokenResponse = await fetch(config.api.strava.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error("Token exchange failed", {
        status: tokenResponse.status,
        error: errorText,
        requestId,
      });
      const errorMsg =
        OAUTH_ERROR_MESSAGES.token_exchange_failed || "Token exchange failed";
      return res.redirect(
        `${config.APP_URL}/auth/error?error=${encodeURIComponent(errorMsg)}`,
      );
    }

    const tokenData = await tokenResponse.json();
    const athlete = tokenData.athlete;

    if (!athlete) {
      logger.error("Token response missing athlete data", { requestId });
      const errorMsg =
        OAUTH_ERROR_MESSAGES.no_athlete_data ||
        "Unable to retrieve athlete data";
      return res.redirect(
        `${config.APP_URL}/auth/error?error=${encodeURIComponent(errorMsg)}`,
      );
    }

    logger.info("Token exchange successful", {
      athleteId: athlete.id,
      expiresAt: new Date(tokenData.expires_at * 1000).toISOString(),
      requestId,
    });

    try {
      // Encrypt sensitive tokens before storage
      const encryptedAccessToken = encryptionService.encrypt(
        tokenData.access_token,
      );
      const encryptedRefreshToken = encryptionService.encrypt(
        tokenData.refresh_token,
      );

      // Upsert user with athlete information
      const user = await prisma.user.upsert({
        where: { stravaAthleteId: athlete.id.toString() },
        update: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt: new Date(tokenData.expires_at * 1000),
          firstName: athlete.firstname || "",
          lastName: athlete.lastname || "",
          profileImageUrl: athlete.profile_medium || athlete.profile,
          city: athlete.city,
          state: athlete.state,
          country: athlete.country,
          weatherEnabled: true,
          updatedAt: new Date(),
        },
        create: {
          stravaAthleteId: athlete.id.toString(),
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt: new Date(tokenData.expires_at * 1000),
          firstName: athlete.firstname || "",
          lastName: athlete.lastname || "",
          profileImageUrl: athlete.profile_medium || athlete.profile,
          city: athlete.city,
          state: athlete.state,
          country: athlete.country,
          weatherEnabled: true,
        },
      });

      logger.info("User account created/updated", {
        userId: user.id,
        stravaAthleteId: user.stravaAthleteId,
        isNewUser: user.createdAt.getTime() === user.updatedAt.getTime(),
        requestId,
      });

      // Ensure webhook subscription exists
      await ensureWebhooksInitialized();

      // Generate JWT session and set secure cookie
      const token = generateJWT(user.id, user.stravaAthleteId);
      setAuthCookie(res, token);

      logger.info("Authentication successful", {
        userId: user.id,
        requestId,
      });

      // Redirect to success page
      res.redirect(`${config.APP_URL}/auth/success`);
    } catch (dbError) {
      logger.error("Database error during OAuth flow", {
        error: dbError,
        athleteId: athlete.id,
        requestId,
      });
      const errorMsg =
        OAUTH_ERROR_MESSAGES.database_error || "Database error occurred";
      return res.redirect(
        `${config.APP_URL}/auth/error?error=${encodeURIComponent(errorMsg)}`,
      );
    }
  }),
);

/**
 * Logout user
 *
 * POST /api/auth/logout
 *
 * Clears the authentication cookie to end the user's session.
 * Does not revoke Strava access tokens.
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  const userId = (req as any).user?.id;

  logger.info("User logout", {
    userId,
    requestId: (req as any).requestId,
  });

  clearAuthCookie(res);

  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

/**
 * Check authentication status
 *
 * GET /api/auth/check
 *
 * Verifies if the current session is valid by checking the JWT cookie
 * and ensuring the user still exists in the database.
 * Used by the frontend to determine authentication state.
 *
 * @returns Authentication status and user info if authenticated
 */
authRouter.get(
  "/check",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const token = req.cookies?.[config.auth.sessionCookieName];

    if (!token) {
      logger.debug("Authentication check: no token found", {
        requestId: (req as any).requestId,
      });

      res.json({
        success: true,
        data: {
          authenticated: false,
        },
      });
      return;
    }

    try {
      const decoded = verifyJWT(token);

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          stravaAthleteId: true,
        },
      });

      if (!user) {
        logger.warn("Authentication check: user not found in database", {
          userId: decoded.userId,
          requestId: (req as any).requestId,
        });

        // Clear the invalid cookie
        clearAuthCookie(res);

        res.json({
          success: true,
          data: {
            authenticated: false,
          },
        });
        return;
      }

      logger.debug("Authentication check: valid token and user exists", {
        userId: decoded.userId,
        requestId: (req as any).requestId,
      });

      res.json({
        success: true,
        data: {
          authenticated: true,
          user: {
            id: user.id,
            stravaAthleteId: user.stravaAthleteId,
          },
        },
      });
    } catch (error) {
      logger.debug("Authentication check: invalid token", {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId: (req as any).requestId,
      });

      // Clear invalid cookie
      clearAuthCookie(res);

      res.json({
        success: true,
        data: {
          authenticated: false,
        },
      });
    }
  }),
);

/**
 * Revoke Strava access and delete account
 *
 * DELETE /api/auth/revoke
 *
 * Completely disconnects the user's Strava account by:
 * 1. Revoking the access token with Strava
 * 2. Deleting the user from our database
 * 3. Clearing the session cookie
 *
 * Requires authentication.
 */
authRouter.delete(
  "/revoke",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = req.user!;

    logger.info("Revoking Strava access", {
      userId: user.id,
      stravaAthleteId: user.stravaAthleteId,
      requestId: (req as any).requestId,
    });

    try {
      // Decrypt and revoke the access token
      const decryptedAccessToken = encryptionService.decrypt(user.accessToken);
      await stravaApiService.revokeToken(decryptedAccessToken);

      logger.info("Strava token revoked successfully", {
        userId: user.id,
      });
    } catch (error) {
      // Log but don't fail if revocation fails - user may have already revoked via Strava
      logger.warn("Failed to revoke Strava token", {
        userId: user.id,
        error,
      });
    }

    // Delete user data
    await prisma.user.delete({
      where: { id: user.id },
    });

    logger.info("User account deleted", {
      userId: user.id,
      requestId: (req as any).requestId,
    });

    // Clear session
    clearAuthCookie(res);

    res.json({
      success: true,
      message: "Strava access revoked and account deleted successfully",
    });
  }),
);

export { authRouter };
