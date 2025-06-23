import { config } from "../config/environment";
import { logger } from "../utils/logger";

/**
 * Strava API service
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

export interface StravaUpdateData {
  name?: string;
  type?: string;
  description?: string;
  gear_id?: string;
  trainer?: boolean;
  commute?: boolean;
}

interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
}

export class StravaApiService {
  private readonly baseUrl = "https://www.strava.com/api/v3";
  private readonly tokenRefreshBuffer = 5 * 60 * 1000; // 5 minutes
  private readonly serviceLogger = logger.child({ service: "StravaAPI" });

  /**
   * Get activity from Strava
   */
  async getActivity(
    activityId: string,
    accessToken: string,
  ): Promise<StravaActivity> {
    this.serviceLogger.debug("Fetching activity from Strava", { activityId });

    try {
      const response = await fetch(`${this.baseUrl}/activities/${activityId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        await this.handleApiError(response, "getActivity", { activityId });
      }

      const activity: StravaActivity = await response.json();

      this.serviceLogger.info("Activity retrieved successfully", {
        activityId,
        activityName: activity.name,
        activityType: activity.type,
      });

      return activity;
    } catch (error) {
      this.serviceLogger.error("Failed to fetch activity", {
        activityId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Update activity on Strava
   */
  async updateActivity(
    activityId: string,
    accessToken: string, // No longer encrypted!
    updateData: StravaUpdateData,
  ): Promise<StravaActivity> {
    this.serviceLogger.debug("Updating activity on Strava", {
      activityId,
      updateFields: Object.keys(updateData),
    });

    try {
      const response = await fetch(`${this.baseUrl}/activities/${activityId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateData),
      });

      if (!response.ok) {
        await this.handleApiError(response, "updateActivity", { activityId });
      }

      const updatedActivity: StravaActivity = await response.json();

      this.serviceLogger.info("Activity updated successfully", {
        activityId,
        activityName: updatedActivity.name,
      });

      return updatedActivity;
    } catch (error) {
      this.serviceLogger.error("Failed to update activity", {
        activityId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: number;
  }> {
    this.serviceLogger.debug("Refreshing Strava access token");

    try {
      const response = await fetch(config.api.strava.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.STRAVA_CLIENT_ID,
          client_secret: config.STRAVA_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Token refresh failed (${response.status}): ${errorText}`,
        );
      }

      const tokenData: TokenRefreshResponse = await response.json();

      this.serviceLogger.info("Access token refreshed successfully", {
        expiresAt: new Date(tokenData.expires_at * 1000).toISOString(),
      });

      return {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
      };
    } catch (error) {
      this.serviceLogger.error("Failed to refresh access token", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Ensure token is valid, refresh if needed
   */
  async ensureValidToken(
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    wasRefreshed: boolean;
  }> {
    const now = new Date();
    const bufferTime = new Date(now.getTime() + this.tokenRefreshBuffer);

    if (expiresAt <= bufferTime) {
      this.serviceLogger.info("Access token expiring soon, refreshing", {
        expiresAt: expiresAt.toISOString(),
      });

      const tokenData = await this.refreshAccessToken(refreshToken);

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expires_at * 1000),
        wasRefreshed: true,
      };
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
      wasRefreshed: false,
    };
  }

  /**
   * Revoke access token
   */
  async revokeToken(accessToken: string): Promise<void> {
    this.serviceLogger.debug("Revoking Strava access token");

    try {
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
        });
      } else {
        this.serviceLogger.info("Access token revoked successfully");
      }
    } catch (error) {
      this.serviceLogger.warn("Failed to revoke access token", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Handle API errors
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
      error: errorText,
    });

    throw new Error(errorMessage);
  }
}

// Export singleton instance
export const stravaApiService = new StravaApiService();
