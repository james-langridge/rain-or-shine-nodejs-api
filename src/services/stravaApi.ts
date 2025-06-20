import { config } from "../config/environment";
import { encryptionService } from "./encryption";
import { logger } from "../utils/logger";

/**
 * Strava activity interface
 *
 * Represents a complete activity object from the Strava API
 */
export interface StravaActivity {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  type: string;
  start_date: string;
  start_date_local: string;
  timezone: string;
  start_latlng: [number, number] | null;
  end_latlng: [number, number] | null;
  location_city?: string;
  location_state?: string;
  location_country?: string;
  achievement_count: number;
  kudos_count: number;
  comment_count: number;
  athlete_count: number;
  photo_count: number;
  description?: string;
  private: boolean;
  visibility: string;
}

/**
 * Activity update data interface
 *
 * Fields that can be updated on a Strava activity
 */
export interface StravaUpdateData {
  name?: string;
  type?: string;
  description?: string;
  gear_id?: string;
  trainer?: boolean;
  commute?: boolean;
}

/**
 * Token refresh response interface
 */
interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
}

/**
 * Strava API service
 *
 * Handles all interactions with the Strava API including:
 * - Activity retrieval and updates
 * - Token management and refresh
 * - Secure token encryption/decryption
 *
 * All tokens are stored and passed encrypted, with decryption
 * happening only when needed for API calls.
 */
export class StravaApiService {
  private readonly baseUrl = "https://www.strava.com/api/v3";
  private readonly tokenRefreshBuffer = 5 * 60 * 1000; // 5 minutes in ms
  private readonly serviceLogger = logger.child({ service: "StravaAPI" });

  /**
   * Retrieve a specific activity from Strava
   *
   * @param activityId - Strava activity ID
   * @param encryptedAccessToken - Encrypted access token
   * @returns Complete activity data
   * @throws Error for invalid tokens, missing activities, or API errors
   */
  async getActivity(
    activityId: string,
    encryptedAccessToken: string,
  ): Promise<StravaActivity> {
    const logContext = { activityId };

    this.serviceLogger.debug("Fetching activity from Strava", logContext);

    try {
      // Decrypt the access token for API use
      const accessToken = encryptionService.decrypt(encryptedAccessToken);

      const response = await fetch(`${this.baseUrl}/activities/${activityId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        await this.handleApiError(response, "getActivity", logContext);
      }

      const activity: StravaActivity = await response.json();

      this.serviceLogger.info("Activity retrieved successfully", {
        ...logContext,
        activityName: activity.name,
        activityType: activity.type,
        distance: activity.distance,
        duration: activity.moving_time,
      });

      return activity;
    } catch (error) {
      this.serviceLogger.error("Failed to fetch activity", {
        ...logContext,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Update an activity on Strava
   *
   * @param activityId - Strava activity ID to update
   * @param encryptedAccessToken - Encrypted access token
   * @param updateData - Fields to update
   * @returns Updated activity data
   * @throws Error for authorization failures or API errors
   */
  async updateActivity(
    activityId: string,
    encryptedAccessToken: string,
    updateData: StravaUpdateData,
  ): Promise<StravaActivity> {
    const logContext = {
      activityId,
      updateFields: Object.keys(updateData),
    };

    this.serviceLogger.debug("Updating activity on Strava", logContext);

    try {
      // Decrypt the access token for API use
      const accessToken = encryptionService.decrypt(encryptedAccessToken);

      const response = await fetch(`${this.baseUrl}/activities/${activityId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateData),
      });

      if (!response.ok) {
        await this.handleApiError(response, "updateActivity", logContext);
      }

      const updatedActivity: StravaActivity = await response.json();

      this.serviceLogger.info("Activity updated successfully", {
        ...logContext,
        activityName: updatedActivity.name,
      });

      return updatedActivity;
    } catch (error) {
      this.serviceLogger.error("Failed to update activity", {
        ...logContext,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Refresh an expired access token
   *
   * Exchanges a refresh token for new access and refresh tokens.
   *
   * @param encryptedRefreshToken - Encrypted refresh token
   * @returns New token data with expiration
   * @throws Error if refresh fails
   */
  async refreshAccessToken(encryptedRefreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: number;
  }> {
    this.serviceLogger.debug("Refreshing Strava access token");

    try {
      // Decrypt the refresh token for API use
      const refreshToken = encryptionService.decrypt(encryptedRefreshToken);

      const requestBody = {
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      };

      const response = await fetch(config.api.strava.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.serviceLogger.error("Token refresh failed", {
          status: response.status,
          error: errorText,
        });
        throw new Error(
          `Token refresh failed (${response.status}): ${errorText}`,
        );
      }

      const tokenData: TokenRefreshResponse = await response.json();

      this.serviceLogger.info("Access token refreshed successfully", {
        expiresAt: new Date(tokenData.expires_at * 1000).toISOString(),
        expiresIn: tokenData.expires_in,
      });

      return {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
      };
    } catch (error) {
      this.serviceLogger.error("Failed to refresh access token", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Ensure access token is valid, refreshing if necessary
   *
   * Checks token expiration and refreshes if it expires within 5 minutes.
   * Returns encrypted tokens for secure storage.
   *
   * @param encryptedAccessToken - Current encrypted access token
   * @param encryptedRefreshToken - Current encrypted refresh token
   * @param expiresAt - Token expiration date
   * @returns Token data (encrypted) with refresh status
   */
  async ensureValidToken(
    encryptedAccessToken: string,
    encryptedRefreshToken: string,
    expiresAt: Date,
  ): Promise<{
    accessToken: string; // Encrypted
    refreshToken: string; // Encrypted
    expiresAt: Date;
    wasRefreshed: boolean;
  }> {
    const now = new Date();
    const bufferTime = new Date(now.getTime() + this.tokenRefreshBuffer);

    // Check if token needs refresh
    if (expiresAt <= bufferTime) {
      const timeUntilExpiry = expiresAt.getTime() - now.getTime();

      this.serviceLogger.info("Access token expiring soon, refreshing", {
        expiresAt: expiresAt.toISOString(),
        timeUntilExpiryMs: timeUntilExpiry,
      });

      const tokenData = await this.refreshAccessToken(encryptedRefreshToken);

      // Encrypt new tokens before returning
      return {
        accessToken: encryptionService.encrypt(tokenData.access_token),
        refreshToken: encryptionService.encrypt(tokenData.refresh_token),
        expiresAt: new Date(tokenData.expires_at * 1000),
        wasRefreshed: true,
      };
    }

    this.serviceLogger.debug("Access token still valid", {
      expiresAt: expiresAt.toISOString(),
      timeUntilExpiryMs: expiresAt.getTime() - now.getTime(),
    });

    return {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiresAt,
      wasRefreshed: false,
    };
  }

  /**
   * Revoke access token (deauthorize)
   *
   * Revokes the access token with Strava, effectively logging out.
   * Failures are logged but not thrown to prevent logout issues.
   *
   * @param encryptedAccessToken - Encrypted access token to revoke
   */
  async revokeToken(encryptedAccessToken: string): Promise<void> {
    this.serviceLogger.debug("Revoking Strava access token");

    try {
      // Decrypt the access token for API use
      const accessToken = encryptionService.decrypt(encryptedAccessToken);

      const response = await fetch("https://www.strava.com/oauth/deauthorize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        this.serviceLogger.warn("Token revocation returned non-OK status", {
          status: response.status,
          statusText: response.statusText,
        });
      } else {
        this.serviceLogger.info("Access token revoked successfully");
      }
    } catch (error) {
      // Don't throw - revocation failure shouldn't prevent logout
      this.serviceLogger.warn("Failed to revoke access token", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Handle API error responses
   *
   * @param response - Fetch response object
   * @param operation - Operation that failed
   * @param context - Additional context for logging
   * @throws Error with appropriate message based on status code
   */
  private async handleApiError(
    response: Response,
    operation: string,
    context: Record<string, any>,
  ): Promise<never> {
    const errorText = await response.text();
    let errorMessage = `Strava API error (${response.status})`;

    switch (response.status) {
      case 401:
        errorMessage = "Strava access token expired or invalid";
        break;
      case 403:
        errorMessage = "Not authorized to perform this action";
        break;
      case 404:
        errorMessage = "Resource not found or not accessible";
        break;
      case 429:
        errorMessage = "Rate limit exceeded";
        break;
      default:
        errorMessage = `${errorMessage}: ${errorText}`;
    }

    this.serviceLogger.error(`${operation} failed`, {
      ...context,
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });

    throw new Error(errorMessage);
  }
}

// Export singleton instance
export const stravaApiService = new StravaApiService();
