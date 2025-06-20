import { weatherService, type WeatherData } from "./weatherService";
import { stravaApiService } from "./stravaApi";
import { prisma } from "../lib";
import { createServiceLogger } from "../utils/logger";

/**
 * Activity processing result interface
 */
export interface ProcessingResult {
  success: boolean;
  activityId: string;
  weatherData?: WeatherData;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * Strava activity data interface
 */
export interface ActivityData {
  id: string | number;
  name: string;
  start_date: string;
  start_latlng: [number, number] | null;
  location_city?: string;
  location_state?: string;
  location_country?: string;
  description?: string;
  type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
}

const logger = createServiceLogger("ActivityProcessor");

/**
 * Weather data patterns for detection
 */
const WEATHER_PATTERNS = [
  /°C/,
  /°F/,
  /Feels like/,
  /Humidity/,
  /m\/s from/,
  /🌤️ Weather:/,
  /Weather:/,
];

/**
 * Wind direction compass points
 */
const WIND_DIRECTIONS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

/**
 * Activity processor service
 *
 * Handles the processing of Strava activities to enrich them with weather data.
 * Manages token refresh, activity retrieval, weather fetching, and description updates.
 */
export class ActivityProcessor {
  /**
   * Process a single activity and add weather data
   *
   * @param activityId - Strava activity ID to process
   * @param userId - Internal user ID for token access
   * @returns Processing result with success status and any weather data
   */
  async processActivity(
    activityId: string,
    userId: string,
  ): Promise<ProcessingResult> {
    try {
      logger.info(`Processing activity ${activityId} for user ${userId}`);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          accessToken: true,
          refreshToken: true,
          tokenExpiresAt: true,
          weatherEnabled: true,
          firstName: true,
          lastName: true,
        },
      });

      if (!user) {
        logger.error(`User ${userId} not found`);
        return {
          success: false,
          activityId,
          error: "User not found",
        };
      }

      if (!user.weatherEnabled) {
        logger.info(`Weather updates disabled for user ${userId}`);
        return {
          success: false,
          activityId,
          skipped: true,
          reason: "Weather updates disabled",
        };
      }

      // Ensure valid Strava token
      const tokenData = await stravaApiService.ensureValidToken(
        user.accessToken,
        user.refreshToken,
        user.tokenExpiresAt,
      );

      // Update tokens if refreshed
      if (tokenData.wasRefreshed) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            tokenExpiresAt: tokenData.expiresAt,
            updatedAt: new Date(),
          },
        });
      }

      // Get activity details from Strava
      const activity = await stravaApiService.getActivity(
        activityId,
        tokenData.accessToken,
      );

      if (!activity) {
        logger.error(`Activity ${activityId} not found on Strava`);
        return {
          success: false,
          activityId,
          error: "Activity not found on Strava",
        };
      }

      // Check if activity already has weather data
      if (this.hasWeatherData(activity.description)) {
        logger.info(`Activity ${activityId} already has weather data`);
        return {
          success: true,
          activityId,
          skipped: true,
          reason: "Already has weather data",
        };
      }

      // Check if activity has GPS coordinates
      if (!activity.start_latlng || activity.start_latlng.length !== 2) {
        logger.warn(`Activity ${activityId} has no GPS coordinates`);
        return {
          success: false,
          activityId,
          skipped: true,
          reason: "No GPS coordinates",
        };
      }

      const [lat, lon] = activity.start_latlng;

      // Get weather data
      const weatherData = await weatherService.getWeatherForActivity(
        lat,
        lon,
        new Date(activity.start_date),
        activityId,
      );

      // Create updated description with weather
      const updatedDescription = this.createWeatherDescription(
        activity,
        weatherData,
      );

      // Update activity on Strava
      await stravaApiService.updateActivity(activityId, tokenData.accessToken, {
        description: updatedDescription,
      });

      logger.info(`Activity ${activityId} updated with weather data`);

      return {
        success: true,
        activityId,
        weatherData,
      };
    } catch (error) {
      logger.error(`Error processing activity ${activityId}:`, error);
      return {
        success: false,
        activityId,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check if activity description already contains weather data
   *
   * @param description - Activity description to check
   * @returns True if weather data is detected
   */
  private hasWeatherData(description?: string): boolean {
    if (!description) return false;

    return WEATHER_PATTERNS.some((pattern) => pattern.test(description));
  }

  /**
   * Create weather-enhanced description for activity
   *
   * @param activity - Original activity data
   * @param weatherData - Weather data to append
   * @returns Updated description with weather information
   */
  private createWeatherDescription(
    activity: ActivityData,
    weatherData: WeatherData,
  ): string {
    const originalDescription = activity.description || "";

    // Format weather conditions
    const condition = this.capitalizeFirst(weatherData.description);

    // Build weather line
    const weatherLine = this.formatWeatherLine(condition, weatherData);

    if (originalDescription) {
      return `${originalDescription}\n\n${weatherLine}`;
    }

    return weatherLine;
  }

  /**
   * Format weather data into a single line
   *
   * @param condition - Weather condition description
   * @param weatherData - Weather data object
   * @returns Formatted weather line
   */
  private formatWeatherLine(
    condition: string,
    weatherData: WeatherData,
  ): string {
    const parts = [
      condition,
      `${weatherData.temperature}°C`,
      `Feels like ${weatherData.temperatureFeel}°C`,
      `Humidity ${weatherData.humidity}%`,
      `Wind ${weatherData.windSpeed}m/s from ${this.getWindDirectionString(weatherData.windDirection)}`,
    ];

    return parts.join(", ");
  }

  /**
   * Convert wind direction degrees to compass direction
   *
   * @param degrees - Wind direction in degrees (0-360)
   * @returns Compass direction string (e.g., "NE", "SW")
   */
  private getWindDirectionString(degrees: number): string {
    // Normalize degrees to 0-360 range to handle negative values
    degrees = ((degrees % 360) + 360) % 360;
    const index = Math.round(degrees / 22.5) % 16;
    return WIND_DIRECTIONS[index] || "N";
  }

  /**
   * Capitalize first letter of string
   *
   * @param str - String to capitalize
   * @returns Capitalized string
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// Export singleton instance
export const activityProcessor = new ActivityProcessor();
