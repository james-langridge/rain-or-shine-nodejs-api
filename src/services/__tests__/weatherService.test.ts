import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import axios from "axios";
import { WeatherService, type WeatherData } from "../weatherService";
import { config } from "../../config/environment";
import { factories } from "../../test/setup";

// Mock axios
vi.mock("axios");
const mockedAxios = vi.mocked(axios);

// Mock axios.isAxiosError
vi.mocked(axios.isAxiosError).mockImplementation((error: any) => {
  return error && typeof error === "object" && error.isAxiosError === true;
});

// Mock logger
vi.mock("../../utils/logger", () => ({
  createServiceLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock config
vi.mock("../../config/environment", () => ({
  config: {
    OPENWEATHERMAP_API_KEY: "test-api-key",
    api: {
      openWeatherMap: {
        oneCallUrl: "https://api.openweathermap.org/data/3.0/onecall",
      },
    },
  },
}));

// Mock metrics service to avoid database imports
vi.mock("../metricsService", () => ({
  metricsService: {
    recordApiCall: vi.fn(),
    recordWebhookProcessing: vi.fn(),
    recordTokenRefresh: vi.fn(),
  },
}));

describe("WeatherService", () => {
  let weatherService: WeatherService;

  // Test data fixtures
  const mockCurrentWeatherResponse = {
    data: {
      current: {
        dt: 1705311000, // 2024-01-15T07:30:00Z
        temp: 15,
        feels_like: 13,
        humidity: 65,
        pressure: 1013,
        wind_speed: 3.5,
        wind_deg: 225,
        clouds: 40,
        visibility: 10000,
        uvi: 3,
        weather: [
          {
            main: "Clear",
            description: "clear sky",
            icon: "01d",
          },
        ],
      },
    },
  };

  const mockHistoricalWeatherResponse = {
    data: {
      data: [
        {
          dt: 1705311000,
          temp: 12,
          feels_like: 10,
          humidity: 70,
          pressure: 1015,
          wind_speed: 2.8,
          wind_deg: 180,
          wind_gust: 4.2,
          clouds: 20,
          visibility: 8000,
          uvi: 2,
          weather: [
            {
              main: "Partly cloudy",
              description: "few clouds",
              icon: "02d",
            },
          ],
        },
      ],
    },
  };

  const expectedCurrentWeather: WeatherData = {
    temperature: 15,
    temperatureFeel: 13,
    humidity: 65,
    pressure: 1013,
    windSpeed: 3.5,
    windDirection: 225,
    windGust: undefined,
    cloudCover: 40,
    visibility: 10,
    condition: "Clear",
    description: "clear sky",
    icon: "01d",
    uvIndex: 3,
    timestamp: "2024-01-15T09:30:00.000Z", // Matches the actual timestamp from the response
  };

  const expectedHistoricalWeather: WeatherData = {
    temperature: 12,
    temperatureFeel: 10,
    humidity: 70,
    pressure: 1015,
    windSpeed: 2.8,
    windDirection: 180,
    windGust: 4.2,
    cloudCover: 20,
    visibility: 8,
    condition: "Partly cloudy",
    description: "few clouds",
    icon: "02d",
    uvIndex: 2,
    timestamp: "2024-01-15T09:30:00.000Z", // Matches the actual timestamp from the response
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Set a fixed current time for consistent testing
    const mockDate = new Date("2024-01-15T12:00:00Z");
    vi.setSystemTime(mockDate);

    weatherService = new WeatherService();

    // Default axios mock - success response
    mockedAxios.get.mockResolvedValue(mockCurrentWeatherResponse);
  });

  afterEach(() => {
    vi.useRealTimers();
    weatherService.destroy();
  });

  describe("getWeatherForActivity", () => {
    describe("current weather path", () => {
      it("should fetch current weather for recent activities", async () => {
        const activityTime = new Date("2024-01-15T11:30:00Z"); // 30 minutes ago
        const lat = 52.52;
        const lon = 13.405;
        const activityId = "123456";

        const result = await weatherService.getWeatherForActivity(
          lat,
          lon,
          activityTime,
          activityId,
        );

        expect(result).toEqual(expectedCurrentWeather);

        // Verify API call
        expect(mockedAxios.get).toHaveBeenCalledWith(
          config.api.openWeatherMap.oneCallUrl,
          {
            params: {
              lat: "52.520000",
              lon: "13.405000",
              appid: config.OPENWEATHERMAP_API_KEY,
              units: "metric",
              exclude: "minutely,hourly,daily,alerts",
            },
            timeout: 5000,
          },
        );
      });

      it("should fetch weather data on each call", async () => {
        const activityTime = new Date("2024-01-15T11:30:00Z");
        const lat = 52.52;
        const lon = 13.405;
        const activityId = "123456";

        // First call
        const result1 = await weatherService.getWeatherForActivity(
          lat,
          lon,
          activityTime,
          activityId,
        );

        // Second call
        const result2 = await weatherService.getWeatherForActivity(
          lat,
          lon,
          activityTime,
          activityId,
        );

        expect(result1).toEqual(result2);
        expect(mockedAxios.get).toHaveBeenCalledTimes(2); // Called twice now
      });
    });

    describe("historical weather path", () => {
      it("should fetch historical weather for older activities", async () => {
        const activityTime = new Date("2024-01-15T07:30:00Z"); // 4.5 hours ago
        const lat = 52.52;
        const lon = 13.405;
        const activityId = "123456";

        mockedAxios.get.mockResolvedValue(mockHistoricalWeatherResponse);

        const result = await weatherService.getWeatherForActivity(
          lat,
          lon,
          activityTime,
          activityId,
        );

        expect(result).toEqual(expectedHistoricalWeather);

        // Verify Time Machine API call
        expect(mockedAxios.get).toHaveBeenCalledWith(
          `${config.api.openWeatherMap.oneCallUrl}/timemachine`,
          {
            params: {
              lat: "52.520000",
              lon: "13.405000",
              dt: "1705303800", // Unix timestamp for "2024-01-15T07:30:00Z"
              appid: config.OPENWEATHERMAP_API_KEY,
              units: "metric",
            },
            timeout: 5000,
          },
        );
      });

      it("should use current weather as fallback for very old activities", async () => {
        const activityTime = new Date("2024-01-08T07:30:00Z"); // 7 days ago
        const lat = 52.52;
        const lon = 13.405;
        const activityId = "123456";

        const result = await weatherService.getWeatherForActivity(
          lat,
          lon,
          activityTime,
          activityId,
        );

        expect(result).toEqual(expectedCurrentWeather);

        // Should call current weather API, not historical
        expect(mockedAxios.get).toHaveBeenCalledWith(
          config.api.openWeatherMap.oneCallUrl,
          expect.objectContaining({
            params: expect.objectContaining({
              exclude: "minutely,hourly,daily,alerts",
            }),
          }),
        );
      });
    });

    describe("error handling", () => {
      it("should handle API authentication errors", async () => {
        const authError = {
          response: {
            status: 401,
            statusText: "Unauthorized",
            data: "Invalid API key",
          },
          message: "Request failed with status code 401",
          isAxiosError: true,
        };
        mockedAxios.get.mockRejectedValue(authError);

        const activityTime = new Date("2024-01-15T11:30:00Z");

        await expect(
          weatherService.getWeatherForActivity(
            52.52,
            13.405,
            activityTime,
            "123456",
          ),
        ).rejects.toThrow(
          "Failed to fetch weather data: Weather API authentication failed",
        );
      });

      it("should handle API rate limit errors", async () => {
        const rateLimitError = {
          response: {
            status: 429,
            statusText: "Too Many Requests",
            data: "Rate limit exceeded",
          },
          message: "Request failed with status code 429",
          isAxiosError: true,
        };
        mockedAxios.get.mockRejectedValue(rateLimitError);

        const activityTime = new Date("2024-01-15T11:30:00Z");

        await expect(
          weatherService.getWeatherForActivity(
            52.52,
            13.405,
            activityTime,
            "123456",
          ),
        ).rejects.toThrow(
          "Failed to fetch weather data: Weather API rate limit exceeded",
        );
      });

      it("should handle network timeout errors", async () => {
        const timeoutError = {
          code: "ECONNABORTED",
          message: "timeout of 5000ms exceeded",
          isAxiosError: true,
        };
        mockedAxios.get.mockRejectedValue(timeoutError);

        const activityTime = new Date("2024-01-15T11:30:00Z");

        await expect(
          weatherService.getWeatherForActivity(
            52.52,
            13.405,
            activityTime,
            "123456",
          ),
        ).rejects.toThrow(
          "Failed to fetch weather data: Weather API request timeout",
        );
      });

      it("should handle generic API errors", async () => {
        const genericError = {
          response: {
            status: 500,
            statusText: "Internal Server Error",
            data: "Server error",
          },
          message: "Request failed with status code 500",
        };
        mockedAxios.get.mockRejectedValue(genericError);

        const activityTime = new Date("2024-01-15T11:30:00Z");

        await expect(
          weatherService.getWeatherForActivity(
            52.52,
            13.405,
            activityTime,
            "123456",
          ),
        ).rejects.toThrow("Failed to fetch weather data: Weather API error");
      });

      it("should handle missing visibility data gracefully", async () => {
        const responseWithoutVisibility = {
          data: {
            current: {
              ...mockCurrentWeatherResponse.data.current,
              visibility: undefined,
            },
          },
        };
        mockedAxios.get.mockResolvedValue(responseWithoutVisibility);

        const activityTime = new Date("2024-01-15T11:30:00Z");
        const result = await weatherService.getWeatherForActivity(
          52.52,
          13.405,
          activityTime,
          "123456",
        );

        expect(result.visibility).toBe(10); // Default 10km visibility
      });

      it("should handle missing wind gust data gracefully", async () => {
        const responseWithoutGust = {
          data: {
            current: {
              ...mockCurrentWeatherResponse.data.current,
              wind_gust: undefined,
            },
          },
        };
        mockedAxios.get.mockResolvedValue(responseWithoutGust);

        const activityTime = new Date("2024-01-15T11:30:00Z");
        const result = await weatherService.getWeatherForActivity(
          52.52,
          13.405,
          activityTime,
          "123456",
        );

        expect(result.windGust).toBeUndefined();
      });
    });

    describe("data formatting", () => {
      it("should properly format temperature values", async () => {
        const responseWithDecimals = {
          data: {
            current: {
              ...mockCurrentWeatherResponse.data.current,
              temp: 15.7,
              feels_like: 13.2,
            },
          },
        };
        mockedAxios.get.mockResolvedValue(responseWithDecimals);

        const activityTime = new Date("2024-01-15T11:30:00Z");
        const result = await weatherService.getWeatherForActivity(
          52.52,
          13.405,
          activityTime,
          "123456",
        );

        expect(result.temperature).toBe(16); // Rounded
        expect(result.temperatureFeel).toBe(13); // Rounded
      });

      it("should format wind speed to one decimal place", async () => {
        const responseWithWindDecimals = {
          data: {
            current: {
              ...mockCurrentWeatherResponse.data.current,
              wind_speed: 3.567,
              wind_gust: 5.234,
            },
          },
        };
        mockedAxios.get.mockResolvedValue(responseWithWindDecimals);

        const activityTime = new Date("2024-01-15T11:30:00Z");
        const result = await weatherService.getWeatherForActivity(
          52.52,
          13.405,
          activityTime,
          "123456",
        );

        expect(result.windSpeed).toBe(3.6);
        expect(result.windGust).toBe(5.2);
      });

      it("should convert visibility from meters to kilometers", async () => {
        const responseWithVisibility = {
          data: {
            current: {
              ...mockCurrentWeatherResponse.data.current,
              visibility: 15500, // 15.5km in meters
            },
          },
        };
        mockedAxios.get.mockResolvedValue(responseWithVisibility);

        const activityTime = new Date("2024-01-15T11:30:00Z");
        const result = await weatherService.getWeatherForActivity(
          52.52,
          13.405,
          activityTime,
          "123456",
        );

        expect(result.visibility).toBe(16); // Rounded to nearest km
      });
    });
  });

  describe("service lifecycle", () => {
    it("should destroy service cleanly", () => {
      expect(() => weatherService.destroy()).not.toThrow();
    });
  });
});
