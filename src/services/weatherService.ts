import axios, { AxiosError } from "axios";
import { config } from "../config/environment";
import { createServiceLogger } from "../utils/logger";

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
  CACHE_EXPIRY_MS: 30 * 60 * 1000, // 30 minutes
  CACHE_CLEANUP_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
  COORDINATE_PRECISION: 4, // Decimal places (~11m accuracy)
  TIME_ROUND_MINUTES: 15, // Round to nearest 15 minutes
  HISTORICAL_LIMIT_HOURS: 120, // 5 days (Time Machine limit)
  RECENT_ACTIVITY_THRESHOLD_HOURS: 1, // Use current data if < 1 hour old
  API_TIMEOUT_MS: 5000, // 5 seconds
  DEFAULT_VISIBILITY_M: 10000, // 10km default visibility
} as const;

/**
 * Weather service using OpenWeatherMap One Call API 3.0
 *
 * Provides weather data for Strava activities with intelligent caching
 * and automatic selection between current and historical data based on
 * activity age.
 *
 * Features:
 * - In-memory caching with automatic cleanup
 * - Historical data for activities up to 5 days old
 * - Current data for recent activities
 * - High-precision coordinate handling
 */
export class WeatherService {
  private weatherCache: Map<string, WeatherData>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.weatherCache = new Map();

    // Setup automatic cache cleanup
    this.cleanupInterval = setInterval(
      () => this.cleanupCache(),
      WEATHER_CONFIG.CACHE_CLEANUP_INTERVAL_MS,
    );

    logger.info("Weather service initialized", {
      cacheExpiryMinutes: WEATHER_CONFIG.CACHE_EXPIRY_MS / 60000,
      cleanupIntervalMinutes: WEATHER_CONFIG.CACHE_CLEANUP_INTERVAL_MS / 60000,
    });
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
   * @param activityId - Unique activity identifier for caching
   * @returns Weather data for the specified time and location
   * @throws Error if weather data cannot be retrieved
   */
  async getWeatherForActivity(
    lat: number,
    lon: number,
    activityTime: Date,
    activityId: string,
  ): Promise<WeatherData> {
    const cacheKey = this.getCacheKey(lat, lon, activityTime, activityId);
    const cached = this.weatherCache.get(cacheKey);

    if (cached) {
      logger.debug("Weather cache hit", {
        activityId,
        cacheKey,
        cachedTimestamp: cached.timestamp,
      });
      return cached;
    }

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

      // Cache the result
      this.weatherCache.set(cacheKey, weatherData);

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
   * @returns Current weather data
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

    try {
      const response = await axios.get<OneCallCurrentResponse>(url, {
        params,
        timeout: WEATHER_CONFIG.API_TIMEOUT_MS,
      });

      const current = response.data.current;

      return this.formatWeatherData(current);
    } catch (error) {
      this.handleApiError(error, "One Call API");
    }
  }

  /**
   * Get historical weather using One Call Time Machine
   *
   * @param lat - Latitude
   * @param lon - Longitude
   * @param time - Historical timestamp
   * @returns Historical weather data
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

    try {
      const response = await axios.get<TimeMachineResponse>(url, {
        params,
        timeout: WEATHER_CONFIG.API_TIMEOUT_MS,
      });

      const data = response.data.data[0]; // Time Machine returns array with single item

      return this.formatWeatherData(data);
    } catch (error) {
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
   * Generate cache key with high precision
   *
   * @param lat - Latitude
   * @param lon - Longitude
   * @param time - Activity time
   * @param activityId - Activity ID
   * @returns Cache key string
   */
  private getCacheKey(
    lat: number,
    lon: number,
    time: Date,
    activityId: string,
  ): string {
    // Round coordinates to configured precision
    const factor = Math.pow(10, WEATHER_CONFIG.COORDINATE_PRECISION);
    const roundedLat = Math.round(lat * factor) / factor;
    const roundedLon = Math.round(lon * factor) / factor;

    // Round time to nearest configured interval
    const roundedTime = new Date(time);
    const minutes =
      Math.floor(roundedTime.getMinutes() / WEATHER_CONFIG.TIME_ROUND_MINUTES) *
      WEATHER_CONFIG.TIME_ROUND_MINUTES;
    roundedTime.setMinutes(minutes, 0, 0);

    return `weather:${roundedLat}:${roundedLon}:${roundedTime.getTime()}:${activityId}`;
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    const initialSize = this.weatherCache.size;
    let cleaned = 0;

    for (const [key, value] of this.weatherCache.entries()) {
      const cacheTime = new Date(value.timestamp).getTime();
      if (now - cacheTime > WEATHER_CONFIG.CACHE_EXPIRY_MS) {
        this.weatherCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info("Weather cache cleanup completed", {
        entriesRemoved: cleaned,
        entriesRemaining: this.weatherCache.size,
        initialSize,
      });
    }
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
   * Clear the cache (useful for testing)
   */
  clearCache(): void {
    const size = this.weatherCache.size;
    this.weatherCache.clear();

    logger.info("Weather cache cleared", {
      entriesCleared: size,
    });
  }

  /**
   * Cleanup method for graceful shutdown
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.clearCache();
    logger.info("Weather service destroyed");
  }
}

// Export singleton instance
export const weatherService = new WeatherService();
