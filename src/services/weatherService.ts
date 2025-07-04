import axios, { AxiosError } from "axios";
import { config } from "../config/environment";
import { createServiceLogger } from "../utils/logger";
import { metricsService } from "./metricsService";

/**
 * Weather data interface
 *
 * Represents weather conditions at a specific time and location
 */
export interface WeatherData {
  temperature: number; // Temperature in Celsius
  temperatureFeel: number; // Feels like temperature in Celsius
  humidity: number; // Humidity percentage (0-100)
  pressure: number; // Atmospheric pressure in hPa
  windSpeed: number; // Wind speed in m/s
  windDirection: number; // Wind direction in degrees (0-360)
  windGust?: number; // Wind gust speed in m/s (optional)
  cloudCover: number; // Cloud coverage percentage (0-100)
  visibility: number; // Visibility in kilometers
  condition: string; // Main weather condition (Rain, Clear, etc.)
  description: string; // Detailed weather description
  icon: string; // Weather icon code
  uvIndex?: number; // UV index (0-11+, optional)
  timestamp: string; // ISO timestamp of the weather data
}

/**
 * OpenWeatherMap API response interfaces
 */
interface OneCallCurrentResponse {
  current: {
    dt: number;
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
    wind_speed: number;
    wind_deg: number;
    wind_gust?: number;
    clouds: number;
    visibility: number;
    uvi?: number;
    weather: Array<{
      main: string;
      description: string;
      icon: string;
    }>;
  };
}

interface TimeMachineResponse {
  data: Array<{
    dt: number;
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
    wind_speed: number;
    wind_deg: number;
    wind_gust?: number;
    clouds: number;
    visibility?: number;
    uvi?: number;
    weather: Array<{
      main: string;
      description: string;
      icon: string;
    }>;
  }>;
}

const logger = createServiceLogger("WeatherService");

/**
 * Weather service configuration
 */
const WEATHER_CONFIG = {
  HISTORICAL_LIMIT_HOURS: 120, // 5 days (Time Machine limit)
  RECENT_ACTIVITY_THRESHOLD_HOURS: 1, // Use current data if < 1 hour old
  API_TIMEOUT_MS: 5000, // 5 seconds
  DEFAULT_VISIBILITY_M: 10000, // 10km default visibility
} as const;

/**
 * Weather service using OpenWeatherMap One Call API 3.0
 *
 * Provides weather data for Strava activities with automatic
 * selection between current and historical data based on activity age.
 *
 * Features:
 * - Historical data for activities up to 5 days old
 * - Current data for recent activities
 * - Automatic API selection based on activity age
 */
export class WeatherService {
  constructor() {
    logger.info("Weather service initialized");
  }

  /**
   * Get weather data for a specific activity
   *
   * Automatically selects the appropriate data source based on activity age:
   * - < 1 hour old: Current weather data
   * - 1 hour to 5 days: Historical weather data (Time Machine)
   * - > 5 days: Current weather as fallback
   *
   * @param lat - Latitude of activity location
   * @param lon - Longitude of activity location
   * @param activityTime - Activity start time
   * @param activityId - Unique activity identifier for logging
   * @returns {Promise<WeatherData>} Weather data for the specified time and location
   * @throws Error if weather data cannot be retrieved
   */
  async getWeatherForActivity(
    lat: number,
    lon: number,
    activityTime: Date,
    activityId: string,
  ): Promise<WeatherData> {
    const logContext = {
      activityId,
      coordinates: { lat, lon },
      activityTime: activityTime.toISOString(),
    };

    logger.info("Fetching weather data for activity", logContext);

    try {
      const now = new Date();
      const hoursSinceActivity =
        (now.getTime() - activityTime.getTime()) / (1000 * 60 * 60);

      let weatherData: WeatherData;
      let dataSource: string;

      if (
        hoursSinceActivity > WEATHER_CONFIG.RECENT_ACTIVITY_THRESHOLD_HOURS &&
        hoursSinceActivity <= WEATHER_CONFIG.HISTORICAL_LIMIT_HOURS
      ) {
        // Use Time Machine for historical data
        dataSource = "historical";
        weatherData = await this.getHistoricalWeather(lat, lon, activityTime);
      } else if (
        hoursSinceActivity <= WEATHER_CONFIG.RECENT_ACTIVITY_THRESHOLD_HOURS
      ) {
        // Use current data for very recent activities
        dataSource = "current";
        weatherData = await this.getCurrentWeatherFromOneCall(lat, lon);
      } else {
        // Activity too old for Time Machine, use current as fallback
        dataSource = "current-fallback";
        logger.warn(
          "Activity outside Time Machine range, using current weather",
          {
            ...logContext,
            hoursSinceActivity,
            maxHistoricalHours: WEATHER_CONFIG.HISTORICAL_LIMIT_HOURS,
          },
        );
        weatherData = await this.getCurrentWeatherFromOneCall(lat, lon);
      }

      logger.info("Weather data retrieved successfully", {
        ...logContext,
        dataSource,
        hoursSinceActivity: hoursSinceActivity.toFixed(1),
        temperature: weatherData.temperature,
        condition: weatherData.condition,
      });

      return weatherData;
    } catch (error) {
      logger.error("Failed to fetch weather data", {
        ...logContext,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw new Error(
        `Failed to fetch weather data: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get current weather using One Call API
   *
   * @param lat - Latitude
   * @param lon - Longitude
   * @returns {Promise<WeatherData>} Current weather data
   * @throws Error if API request fails
   */
  private async getCurrentWeatherFromOneCall(
    lat: number,
    lon: number,
  ): Promise<WeatherData> {
    const url = config.api.openWeatherMap.oneCallUrl;
    const params = {
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      appid: config.OPENWEATHERMAP_API_KEY,
      units: "metric",
      exclude: "minutely,hourly,daily,alerts", // Only need current data
    };

    logger.debug("Requesting current weather from One Call API", {
      coordinates: { lat, lon },
    });

    const startTime = Date.now();
    try {
      const response = await axios.get<OneCallCurrentResponse>(url, {
        params,
        timeout: WEATHER_CONFIG.API_TIMEOUT_MS,
      });

      const duration = Date.now() - startTime;
      await metricsService.recordApiCall(
        "weather_api",
        "GET /onecall",
        duration,
        response.status,
      );

      const current = response.data.current;

      return this.formatWeatherData(current);
    } catch (error) {
      const duration = Date.now() - startTime;
      await metricsService.recordApiCall(
        "weather_api",
        "GET /onecall",
        duration,
        undefined,
        error instanceof Error ? error.message : "Unknown error",
      );
      this.handleApiError(error, "One Call API");
    }
  }

  /**
   * Get historical weather using One Call Time Machine
   *
   * @param lat - Latitude
   * @param lon - Longitude
   * @param time - Historical timestamp
   * @returns {Promise<WeatherData>} Historical weather data
   * @throws Error if API request fails
   */
  private async getHistoricalWeather(
    lat: number,
    lon: number,
    time: Date,
  ): Promise<WeatherData> {
    const url = `${config.api.openWeatherMap.oneCallUrl}/timemachine`;
    const dt = Math.floor(time.getTime() / 1000);

    const params = {
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      dt: dt.toString(),
      appid: config.OPENWEATHERMAP_API_KEY,
      units: "metric",
    };

    logger.debug("Requesting historical weather from Time Machine", {
      coordinates: { lat, lon },
      targetTime: time.toISOString(),
      unixTime: dt,
    });

    const startTime = Date.now();
    try {
      const response = await axios.get<TimeMachineResponse>(url, {
        params,
        timeout: WEATHER_CONFIG.API_TIMEOUT_MS,
      });

      const duration = Date.now() - startTime;
      await metricsService.recordApiCall(
        "weather_api",
        "GET /timemachine",
        duration,
        response.status,
      );

      const data = response.data.data[0]; // Time Machine returns array with single item

      return this.formatWeatherData(data);
    } catch (error) {
      const duration = Date.now() - startTime;
      await metricsService.recordApiCall(
        "weather_api",
        "GET /timemachine",
        duration,
        undefined,
        error instanceof Error ? error.message : "Unknown error",
      );
      this.handleApiError(error, "Time Machine API");
    }
  }

  /**
   * Format raw API data into WeatherData interface
   *
   * @param data - Raw weather data from API
   * @returns Formatted weather data
   */
  private formatWeatherData(data: any): WeatherData {
    return {
      temperature: Math.round(data.temp),
      temperatureFeel: Math.round(data.feels_like),
      humidity: data.humidity,
      pressure: data.pressure,
      windSpeed: Math.round(data.wind_speed * 10) / 10, // 1 decimal place
      windDirection: data.wind_deg,
      windGust: data.wind_gust
        ? Math.round(data.wind_gust * 10) / 10
        : undefined,
      cloudCover: data.clouds,
      visibility: Math.round(
        (data.visibility || WEATHER_CONFIG.DEFAULT_VISIBILITY_M) / 1000,
      ), // Convert to km
      condition: data.weather[0].main,
      description: data.weather[0].description,
      icon: data.weather[0].icon,
      uvIndex: data.uvi || 0,
      timestamp: new Date(data.dt * 1000).toISOString(),
    };
  }

  /**
   * Handle API errors with appropriate logging and messages
   *
   * @param error - Axios error or generic error
   * @param apiName - Name of the API for logging
   * @throws Error with user-friendly message
   */
  private handleApiError(error: unknown, apiName: string): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      logger.error(`${apiName} request failed`, {
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        message: axiosError.message,
        data: axiosError.response?.data,
      });

      if (axiosError.response?.status === 401) {
        throw new Error("Weather API authentication failed");
      } else if (axiosError.response?.status === 429) {
        throw new Error("Weather API rate limit exceeded");
      } else if (axiosError.code === "ECONNABORTED") {
        throw new Error("Weather API request timeout");
      }
    }

    throw new Error(
      `Weather API error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  /**
   * Cleanup method for graceful shutdown
   */
  destroy(): void {
    logger.info("Weather service destroyed");
  }
}

// Export singleton instance
export const weatherService = new WeatherService();
