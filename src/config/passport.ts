import passport from "passport";
import { Strategy as CustomStrategy } from "passport-custom";
import { Request } from "express";
import { userRepository } from "../lib";
import { config } from "./environment";
import { logger } from "../utils/logger";

interface PassportUser {
  id: string;
  stravaAthleteId: string;
}

/**
 * Passport configuration using custom strategy for Strava OAuth
 *
 * We use passport-custom instead of passport-strava because:
 * 1. passport-strava is outdated and doesn't support refresh tokens properly
 * 2. We need fine control over the OAuth flow for Strava's specific requirements
 * 3. We already have working OAuth code that we can reuse
 */

// Configure Passport serialization
passport.serializeUser((user: PassportUser, done) => {
  // Only store user ID in session
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await userRepository.findById(id);

    if (!user) {
      return done(null, false);
    }

    done(null, { id: user.id, stravaAthleteId: user.stravaAthleteId });
  } catch (error) {
    done(error);
  }
});

// Strava OAuth URLs
const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

async function exchangeCodeForTokens(code: string) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.STRAVA_CLIENT_ID,
      client_secret: config.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

// Custom strategy for Strava OAuth callback
passport.use(
  "strava-callback",
  new CustomStrategy(async (req: Request, done) => {
    try {
      const { code, error } = req.query;

      if (error) {
        logger.warn("OAuth authorization denied", { error });
        return done(null, false);
      }

      if (!code || typeof code !== "string") {
        logger.warn("OAuth callback missing code");
        return done(null, false);
      }

      logger.info("Exchanging authorization code for tokens");
      const tokenData = await exchangeCodeForTokens(code);
      const athlete = tokenData.athlete;

      if (!athlete) {
        logger.error("Token response missing athlete data");
        return done(null, false);
      }

      const user = await userRepository.upsert({
        stravaAthleteId: athlete.id.toString(),
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: new Date(tokenData.expires_at * 1000),
        firstName: athlete.firstname || "",
        lastName: athlete.lastname || "",
        profileImageUrl: athlete.profile_medium || athlete.profile,
        city: athlete.city,
        state: athlete.state,
        country: athlete.country,
        weatherEnabled: true,
      });

      logger.info("User authenticated successfully", {
        userId: user.id,
        stravaAthleteId: user.stravaAthleteId,
      });

      done(null, { id: user.id, stravaAthleteId: user.stravaAthleteId });
    } catch (error) {
      logger.error("OAuth callback error", error);
      done(error);
    }
  }),
);

export function getStravaAuthUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: config.STRAVA_CLIENT_ID,
    redirect_uri: `${config.APP_URL}/api/auth/strava/callback`,
    response_type: "code",
    approval_prompt: "force",
    scope: "activity:read_all,activity:write,profile:read_all",
    ...(state && { state }),
  });

  return `${STRAVA_AUTH_URL}?${params}`;
}

export default passport;
