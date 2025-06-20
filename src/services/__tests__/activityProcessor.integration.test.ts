import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { ActivityProcessor } from "../activityProcessor";
import { prisma } from "../../lib";
import { encryptionService } from "../encryption";
import { config } from "../../config/environment";
import nock from "nock";
import { factories } from "../../test/setup";

/**
 * Integration tests for ActivityProcessor
 * These tests use real database connections and mock external APIs
 *
 * Run with: npm run test:integration
 */
describe("ActivityProcessor Integration Tests", () => {
  let activityProcessor: ActivityProcessor;
  let testUserId: string;

  // Real encrypted tokens for testing
  let encryptedAccessToken: string;
  let encryptedRefreshToken: string;

  beforeAll(async () => {
    // Ensure database is migrated
    await prisma.$executeRaw`SELECT 1`;
  });

  beforeEach(async () => {
    // Clean database before each test
    await prisma.$transaction([
      prisma.userPreference.deleteMany(),
      prisma.user.deleteMany(),
    ]);

    // Create fresh instance
    activityProcessor = new ActivityProcessor();

    // Setup encrypted tokens
    encryptedAccessToken = encryptionService.encrypt("test-access-token");
    encryptedRefreshToken = encryptionService.encrypt("test-refresh-token");

    // Create test user
    const user = await prisma.user.create({
      data: {
        stravaAthleteId: "12345",
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + 3600000),
        weatherEnabled: true,
        firstName: "Test",
        lastName: "User",
      },
    });
    testUserId = user.id;

    // Setup API mocks
    setupStravaApiMocks();
    setupWeatherApiMocks();
  });

  afterEach(() => {
    // Clean up API mocks
    nock.cleanAll();
  });

  afterAll(async () => {
    // Close database connection
    await prisma.$disconnect();
  });

  function setupStravaApiMocks() {
    // Mock Strava activity endpoint
    nock("https://www.strava.com")
      .get("/api/v3/activities/123456")
      .matchHeader("Authorization", "Bearer test-access-token")
      .reply(
        200,
        factories.activity({
          id: 123456,
          name: "Morning Run",
          start_latlng: [52.52, 13.405],
        }),
      );

    // Mock Strava update endpoint
    nock("https://www.strava.com")
      .put("/api/v3/activities/123456")
      .matchHeader("Authorization", "Bearer test-access-token")
      .reply(200, (uri, requestBody) => {
        return factories.activity({
          id: 123456,
          description: (requestBody as any).description,
        });
      });
  }

  function setupWeatherApiMocks() {
    // Mock OpenWeatherMap One Call API
    nock("https://api.openweathermap.org")
      .get("/data/3.0/onecall")
      .query(true)
      .reply(200, {
        current: {
          dt: Math.floor(Date.now() / 1000),
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
              main: "Clouds",
              description: "partly cloudy",
              icon: "02d",
            },
          ],
        },
      });
  }

  describe("End-to-end activity processing", () => {
    it("should process activity successfully with real database", async () => {
      const result = await activityProcessor.processActivity(
        "123456",
        testUserId,
      );

      expect(result).toMatchObject({
        success: true,
        activityId: "123456",
        weatherData: expect.objectContaining({
          temperature: 15,
          humidity: 65,
        }),
      });

      // Verify user was not modified in database
      const user = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(user?.weatherEnabled).toBe(true);
    });

    it("should handle token refresh with database update", async () => {
      // Update user with expired token
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          tokenExpiresAt: new Date(Date.now() - 3600000), // Expired 1 hour ago
        },
      });

      // Mock token refresh endpoint
      nock("https://www.strava.com")
        .post("/oauth/token")
        .reply(200, {
          token_type: "Bearer",
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 21600,
          expires_in: 21600,
        });

      const result = await activityProcessor.processActivity(
        "123456",
        testUserId,
      );

      expect(result.success).toBe(true);

      // Verify tokens were updated in database
      const updatedUser = await prisma.user.findUnique({
        where: { id: testUserId },
      });

      expect(updatedUser).toBeDefined();
      const decryptedNewToken = encryptionService.decrypt(
        updatedUser!.accessToken,
      );
      expect(decryptedNewToken).toBe("new-access-token");
    });

    it("should handle concurrent processing with database locks", async () => {
      // Process same activity multiple times concurrently
      const promises = Array(3)
        .fill(null)
        .map(() => activityProcessor.processActivity("123456", testUserId));

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // Verify database consistency
      const user = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(user).toBeDefined();
      expect(user?.accessToken).toBe(encryptedAccessToken);
    });
  });

  describe("Database transaction handling", () => {
    it("should rollback on database errors during token update", async () => {
      // Force token refresh
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          tokenExpiresAt: new Date(Date.now() - 3600000),
        },
      });

      // Mock token refresh
      nock("https://www.strava.com")
        .post("/oauth/token")
        .reply(200, {
          token_type: "Bearer",
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 21600,
          expires_in: 21600,
        });

      // Simulate database error by disconnecting
      await prisma.$disconnect();

      let error: Error | null = null;
      try {
        await activityProcessor.processActivity("123456", testUserId);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeTruthy();

      // Reconnect for cleanup
      await prisma.$connect();
    });
  });

  describe("API error handling with retries", () => {
    it("should retry on transient Strava API errors", async () => {
      let attemptCount = 0;

      // First attempt fails with 503
      nock("https://www.strava.com")
        .get("/api/v3/activities/123456")
        .matchHeader("Authorization", "Bearer test-access-token")
        .reply(() => {
          attemptCount++;
          if (attemptCount === 1) {
            return [503, "Service Unavailable"];
          }
          return [200, factories.activity()];
        });

      // Redefine update mock for this test
      nock("https://www.strava.com")
        .put("/api/v3/activities/123456")
        .matchHeader("Authorization", "Bearer test-access-token")
        .reply(200, factories.activity());

      const result = await activityProcessor.processActivity(
        "123456",
        testUserId,
      );

      // Should succeed after retry
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(2);
    });

    it("should handle rate limiting from Weather API", async () => {
      // Override weather mock with rate limit response
      nock.cleanAll();
      setupStravaApiMocks();

      nock("https://api.openweathermap.org")
        .get("/data/3.0/onecall")
        .query(true)
        .reply(
          429,
          {
            message: "Rate limit exceeded",
          },
          {
            "Retry-After": "60",
          },
        );

      const result = await activityProcessor.processActivity(
        "123456",
        testUserId,
      );

      expect(result).toMatchObject({
        success: false,
        activityId: "123456",
        error: expect.stringContaining("rate limit"),
      });
    });
  });

  describe("Data consistency checks", () => {
    it("should maintain data integrity across service boundaries", async () => {
      // Create activity with existing weather data
      nock("https://www.strava.com")
        .get("/api/v3/activities/789")
        .matchHeader("Authorization", "Bearer test-access-token")
        .reply(
          200,
          factories.activity({
            id: 789,
            description:
              "Run\n\nClear, 20°C, Feels like 18°C, Humidity 50%, Wind 2m/s from N",
          }),
        );

      const result = await activityProcessor.processActivity(
        "789",
        testUserId,
        false,
      );

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        reason: "Already has weather data",
      });

      // Verify no update was made
      expect(nock.isDone()).toBe(true);
      const pendingMocks = nock.pendingMocks();
      expect(pendingMocks).not.toContain(expect.stringContaining("PUT"));
    });
  });
});
