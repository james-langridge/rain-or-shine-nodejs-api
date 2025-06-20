import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import type { WeatherData } from "../../../src/services/weatherService";
import type { StravaActivity } from "../../../src/services/stravaApi";

vi.mock("../../../src/lib", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../../../src/services/weatherService", () => ({
  weatherService: {
    getWeatherForActivity: vi.fn(),
  },
}));

vi.mock("../../../src/services/stravaApi", () => ({
  stravaApiService: {
    ensureValidToken: vi.fn(),
    getActivity: vi.fn(),
    updateActivity: vi.fn(),
    refreshAccessToken: vi.fn(),
    revokeToken: vi.fn(),
  },
}));

vi.mock("../../../src/services/encryption", () => ({
  encryptionService: {
    encrypt: vi.fn((value: string) => `encrypted-${value}`),
    decrypt: vi.fn((value: string) => value.replace("encrypted-", "")),
    isEncrypted: vi.fn((value: string) => value.startsWith("encrypted-")),
    safeEncrypt: vi.fn((value: string) => value),
    safeDecrypt: vi.fn((value: string) => value),
  },
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
  createServiceLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { ActivityProcessor } from "../../../src/services/activityProcessor";
import { weatherService } from "../../../src/services/weatherService";
import { stravaApiService } from "../../../src/services/stravaApi";
import { prisma } from "../../../src/lib";

describe("ActivityProcessor Service", () => {
  let activityProcessor: ActivityProcessor;

  // Test data fixtures
  const mockUser = {
    id: "user-123",
    accessToken: "encrypted-access-token",
    refreshToken: "encrypted-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 3600000), // 1 hour from now
    weatherEnabled: true,
    firstName: "John",
    lastName: "Doe",
  };

  const mockActivity: StravaActivity = {
    id: 123456,
    name: "Morning Run",
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 50,
    type: "Run",
    start_date: "2024-01-15T07:30:00Z",
    start_date_local: "2024-01-15T08:30:00+01:00",
    timezone: "Europe/Berlin",
    start_latlng: [52.52, 13.405], // Berlin coordinates
    end_latlng: [52.525, 13.41],
    achievement_count: 2,
    kudos_count: 5,
    comment_count: 1,
    athlete_count: 1,
    photo_count: 0,
    private: false,
    visibility: "everyone",
    description: "Great morning run!",
  };

  const mockWeatherData: WeatherData = {
    temperature: 15,
    temperatureFeel: 13,
    humidity: 65,
    pressure: 1013,
    windSpeed: 3.5,
    windDirection: 225,
    cloudCover: 40,
    visibility: 10,
    condition: "Partly cloudy",
    description: "partly cloudy",
    icon: "02d",
    uvIndex: 3,
    timestamp: "2024-01-15T07:30:00Z",
  };

  const mockTokenData = {
    accessToken: "new-encrypted-token",
    refreshToken: "new-encrypted-refresh",
    expiresAt: new Date(Date.now() + 7200000),
    wasRefreshed: false,
  };

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Create fresh instance
    activityProcessor = new ActivityProcessor();

    // Setup default mock implementations
    (prisma.user.findUnique as MockedFunction<any>).mockResolvedValue(mockUser);
    (prisma.user.update as MockedFunction<any>).mockResolvedValue(mockUser);
    (
      stravaApiService.ensureValidToken as MockedFunction<any>
    ).mockResolvedValue(mockTokenData);
    (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
      mockActivity,
    );
    (stravaApiService.updateActivity as MockedFunction<any>).mockResolvedValue(
      mockActivity,
    );
    (
      weatherService.getWeatherForActivity as MockedFunction<any>
    ).mockResolvedValue(mockWeatherData);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("processActivity", () => {
    describe("successful processing", () => {
      it("should successfully process an activity with weather data", async () => {
        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: true,
          activityId: "123456",
          weatherData: mockWeatherData,
        });

        // Verify service calls
        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: "user-123" },
          select: {
            accessToken: true,
            refreshToken: true,
            tokenExpiresAt: true,
            weatherEnabled: true,
            firstName: true,
            lastName: true,
          },
        });

        expect(stravaApiService.getActivity).toHaveBeenCalledWith(
          "123456",
          mockTokenData.accessToken,
        );
        expect(weatherService.getWeatherForActivity).toHaveBeenCalledWith(
          52.52,
          13.405,
          new Date("2024-01-15T07:30:00Z"),
          "123456",
        );
        expect(stravaApiService.updateActivity).toHaveBeenCalledWith(
          "123456",
          mockTokenData.accessToken,
          expect.objectContaining({
            description: expect.stringContaining("Partly cloudy, 15°C"),
          }),
        );
      });

      it("should handle token refresh when needed", async () => {
        const expiredTokenData = {
          ...mockTokenData,
          wasRefreshed: true,
          accessToken: "refreshed-encrypted-token",
          refreshToken: "refreshed-encrypted-refresh",
        };

        (
          stravaApiService.ensureValidToken as MockedFunction<any>
        ).mockResolvedValue(expiredTokenData);

        await activityProcessor.processActivity("123456", "user-123");

        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: "user-123" },
          data: {
            accessToken: expiredTokenData.accessToken,
            refreshToken: expiredTokenData.refreshToken,
            tokenExpiresAt: expiredTokenData.expiresAt,
            updatedAt: expect.any(Date),
          },
        });
      });

      it("should preserve original description when adding weather", async () => {
        const originalDescription =
          "Amazing run with friends! #running #fitness";
        const activityWithDesc = {
          ...mockActivity,
          description: originalDescription,
        };

        (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
          activityWithDesc,
        );

        await activityProcessor.processActivity("123456", "user-123");

        expect(stravaApiService.updateActivity).toHaveBeenCalledWith(
          "123456",
          mockTokenData.accessToken,
          {
            description: expect.stringMatching(
              new RegExp(`^${originalDescription}\\n\\n`),
            ),
          },
        );
      });
    });

    describe("skip scenarios", () => {
      it("should skip when weather updates are disabled", async () => {
        const disabledUser = { ...mockUser, weatherEnabled: false };
        (prisma.user.findUnique as MockedFunction<any>).mockResolvedValue(
          disabledUser,
        );

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          skipped: true,
          reason: "Weather updates disabled",
        });

        expect(stravaApiService.getActivity).not.toHaveBeenCalled();
        expect(weatherService.getWeatherForActivity).not.toHaveBeenCalled();
      });

      it("should skip when activity has no GPS coordinates", async () => {
        const noGpsActivity = { ...mockActivity, start_latlng: null };
        (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
          noGpsActivity,
        );

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          skipped: true,
          reason: "No GPS coordinates",
        });

        expect(weatherService.getWeatherForActivity).not.toHaveBeenCalled();
      });

      it("should skip when GPS coordinates are invalid", async () => {
        const invalidGpsActivity = {
          ...mockActivity,
          start_latlng: [52.52] as any,
        };
        (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
          invalidGpsActivity,
        );

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          skipped: true,
          reason: "No GPS coordinates",
        });
      });
    });

    describe("error handling", () => {
      it("should handle user not found", async () => {
        (prisma.user.findUnique as MockedFunction<any>).mockResolvedValue(null);

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          error: "User not found",
        });
      });

      it("should handle activity not found on Strava", async () => {
        (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
          null,
        );

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          error: "Activity not found on Strava",
        });
      });

      it("should handle weather service errors", async () => {
        const weatherError = new Error("Weather API rate limit exceeded");
        (
          weatherService.getWeatherForActivity as MockedFunction<any>
        ).mockRejectedValue(weatherError);

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          error: "Weather API rate limit exceeded",
        });
      });

      it("should handle Strava update errors", async () => {
        const updateError = new Error("Strava API: 401 Unauthorized");
        (
          stravaApiService.updateActivity as MockedFunction<any>
        ).mockRejectedValue(updateError);

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          error: "Strava API: 401 Unauthorized",
        });
      });

      it("should handle database errors during token update", async () => {
        const dbError = new Error("Database connection lost");
        const refreshedToken = { ...mockTokenData, wasRefreshed: true };

        (
          stravaApiService.ensureValidToken as MockedFunction<any>
        ).mockResolvedValue(refreshedToken);
        (prisma.user.update as MockedFunction<any>).mockRejectedValue(dbError);

        const result = await activityProcessor.processActivity(
          "123456",
          "user-123",
        );

        expect(result).toEqual({
          success: false,
          activityId: "123456",
          error: "Database connection lost",
        });
      });
    });
  });

  describe("hasWeatherData", () => {
    const testCases = [
      { description: "Clear sky, 20°C, Feels like 18°C", expected: true },
      { description: "Sunny, 72°F, Humidity 45%", expected: true },
      {
        description: "Rain, 15°C, Feels like 13°C, Wind 5m/s from NW",
        expected: true,
      },
      { description: "🌤️ Weather: Partly cloudy", expected: true },
      { description: "Weather: Cloudy with chance of rain", expected: true },
      { description: "Just a regular run description", expected: false },
      { description: "Temperature was perfect today!", expected: false },
      { description: "", expected: false },
      { description: undefined, expected: false },
    ];

    testCases.forEach(({ description, expected }) => {
      it(`should ${expected ? "detect" : "not detect"} weather in: "${description}"`, () => {
        const result = (activityProcessor as any).hasWeatherData(description);
        expect(result).toBe(expected);
      });
    });
  });

  describe("createWeatherDescription", () => {
    it("should create properly formatted weather description", () => {
      const result = (activityProcessor as any).createWeatherDescription(
        mockActivity,
        mockWeatherData,
      );

      expect(result).toBe(
        "Great morning run!\n\nPartly cloudy, 15°C, Feels like 13°C, Humidity 65%, Wind 3.5m/s from SW",
      );
    });

    it("should handle missing original description", () => {
      const activityNoDesc = { ...mockActivity, description: undefined };
      const result = (activityProcessor as any).createWeatherDescription(
        activityNoDesc,
        mockWeatherData,
      );

      expect(result).toBe(
        "Partly cloudy, 15°C, Feels like 13°C, Humidity 65%, Wind 3.5m/s from SW",
      );
    });
  });

  describe("getWindDirectionString", () => {
    const windDirectionTests = [
      { degrees: 0, expected: "N" },
      { degrees: 22.5, expected: "NNE" },
      { degrees: 45, expected: "NE" },
      { degrees: 67.5, expected: "ENE" },
      { degrees: 90, expected: "E" },
      { degrees: 112.5, expected: "ESE" },
      { degrees: 135, expected: "SE" },
      { degrees: 157.5, expected: "SSE" },
      { degrees: 180, expected: "S" },
      { degrees: 202.5, expected: "SSW" },
      { degrees: 225, expected: "SW" },
      { degrees: 247.5, expected: "WSW" },
      { degrees: 270, expected: "W" },
      { degrees: 292.5, expected: "WNW" },
      { degrees: 315, expected: "NW" },
      { degrees: 337.5, expected: "NNW" },
      { degrees: 360, expected: "N" },
      { degrees: 361, expected: "N" }, // Wrap around
      { degrees: -45, expected: "NW" }, // Negative degrees
    ];

    windDirectionTests.forEach(({ degrees, expected }) => {
      it(`should convert ${degrees}° to ${expected}`, () => {
        const result = (activityProcessor as any).getWindDirectionString(
          degrees,
        );
        expect(result).toBe(expected);
      });
    });
  });

  describe("formatWeatherLine", () => {
    it("should format weather data with all fields", () => {
      const result = (activityProcessor as any).formatWeatherLine(
        "Clear sky",
        mockWeatherData,
      );

      expect(result).toBe(
        "Clear sky, 15°C, Feels like 13°C, Humidity 65%, Wind 3.5m/s from SW",
      );
    });

    it("should handle wind gust data when present", () => {
      const weatherWithGust = { ...mockWeatherData, windGust: 5.2 };
      const result = (activityProcessor as any).formatWeatherLine(
        "Windy",
        weatherWithGust,
      );

      expect(result).toContain("Wind 3.5m/s from SW");
      // Note: Current implementation doesn't include gust, but this test documents that
    });
  });

  describe("capitalizeFirst", () => {
    const testCases = [
      { input: "clear sky", expected: "Clear sky" },
      { input: "HEAVY RAIN", expected: "HEAVY RAIN" },
      { input: "a", expected: "A" },
      { input: "", expected: "" },
      { input: "123 test", expected: "123 test" },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should capitalize "${input}" to "${expected}"`, () => {
        const result = (activityProcessor as any).capitalizeFirst(input);
        expect(result).toBe(expected);
      });
    });
  });

  describe("edge cases and race conditions", () => {
    it("should handle concurrent processing of same activity", async () => {
      const promises = [
        activityProcessor.processActivity("123456", "user-123"),
        activityProcessor.processActivity("123456", "user-123"),
      ];

      const results = await Promise.all(promises);

      // Both should succeed (implementation doesn't have locking, but this documents behavior)
      expect(results.every((r) => r.success)).toBe(true);
      expect(stravaApiService.updateActivity).toHaveBeenCalledTimes(2);
    });

    it("should handle very long descriptions", async () => {
      const longDescription = "A".repeat(5000); // 5000 characters
      const longActivity = { ...mockActivity, description: longDescription };

      (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
        longActivity,
      );

      const result = await activityProcessor.processActivity(
        "123456",
        "user-123",
      );

      expect(result.success).toBe(true);
      expect(stravaApiService.updateActivity).toHaveBeenCalledWith(
        "123456",
        mockTokenData.accessToken,
        {
          description: expect.stringContaining(longDescription),
        },
      );
    });

    it("should handle special characters in weather description", () => {
      const specialWeather: WeatherData = {
        ...mockWeatherData,
        description: "thunderstorm with heavy rain ⛈️",
        condition: "Thunderstorm",
      };

      const result = (activityProcessor as any).createWeatherDescription(
        mockActivity,
        specialWeather,
      );

      expect(result).toContain("Thunderstorm");
      expect(result).toContain("⛈️");
    });

    it("should handle timezone differences in activity time", async () => {
      const timezoneActivity = {
        ...mockActivity,
        start_date: "2024-01-15T23:30:00Z", // Late UTC
        start_date_local: "2024-01-16T08:30:00+09:00", // Next day in Tokyo
        timezone: "Asia/Tokyo",
      };

      (stravaApiService.getActivity as MockedFunction<any>).mockResolvedValue(
        timezoneActivity,
      );

      await activityProcessor.processActivity("123456", "user-123");

      // Should use UTC time for weather
      expect(weatherService.getWeatherForActivity).toHaveBeenCalledWith(
        52.52,
        13.405,
        new Date("2024-01-15T23:30:00Z"),
        "123456",
      );
    });
  });

  describe("performance considerations", () => {
    it("should not make unnecessary API calls when skipping", async () => {
      const disabledUser = { ...mockUser, weatherEnabled: false };
      (prisma.user.findUnique as MockedFunction<any>).mockResolvedValue(
        disabledUser,
      );

      await activityProcessor.processActivity("123456", "user-123");

      // Should only call user lookup
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(stravaApiService.ensureValidToken).not.toHaveBeenCalled();
      expect(stravaApiService.getActivity).not.toHaveBeenCalled();
      expect(weatherService.getWeatherForActivity).not.toHaveBeenCalled();
      expect(stravaApiService.updateActivity).not.toHaveBeenCalled();
    });

    it("should handle network timeouts gracefully", async () => {
      const timeoutError = new Error("Network timeout");
      timeoutError.name = "AbortError";

      (
        weatherService.getWeatherForActivity as MockedFunction<any>
      ).mockRejectedValue(timeoutError);

      const result = await activityProcessor.processActivity(
        "123456",
        "user-123",
      );

      expect(result).toEqual({
        success: false,
        activityId: "123456",
        error: "Network timeout",
      });
    });
  });
});
