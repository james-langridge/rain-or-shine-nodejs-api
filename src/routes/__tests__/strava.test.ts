import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  MockedFunction,
} from "vitest";
import request from "supertest";
import express from "express";
import { stravaRouter } from "../strava";
import { config } from "../../config/environment";
import { userRepository } from "../../lib";
import { activityProcessor } from "../../services/activityProcessor";
import { factories } from "../../test/setup";

// Mock dependencies
vi.mock("../../lib", () => ({
  userRepository: {
    findByStravaAthleteId: vi.fn(),
    deleteByStravaAthleteId: vi.fn(),
  },
}));

vi.mock("../../services/activityProcessor", () => ({
  activityProcessor: {
    processActivity: vi.fn(),
  },
}));

vi.mock("../../config/environment", () => ({
  config: {
    STRAVA_WEBHOOK_VERIFY_TOKEN: "test-webhook-token",
    APP_URL: "http://localhost:3000",
  },
}));

vi.mock("../../utils/logger", () => ({
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
}));

describe("Strava Webhook Router", () => {
  let app: express.Application;

  // Test data fixtures
  const mockUser = factories.user({
    id: "user-123",
    stravaAthleteId: "12345",
    weatherEnabled: true,
    firstName: "John",
    lastName: "Doe",
  });

  const validWebhookEvent = {
    object_type: "activity",
    object_id: 123456,
    aspect_type: "create",
    owner_id: 12345,
    subscription_id: 98765,
    event_time: 1705311000,
  };

  const successProcessingResult = {
    success: true,
    activityId: "123456",
    weatherData: factories.weatherData(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create Express app with the router
    app = express();
    app.use(express.json());

    // Add request ID middleware (similar to actual app)
    app.use((req, _res, next) => {
      (req as any).requestId = "test-request-id";
      next();
    });

    app.use("/api/strava", stravaRouter);

    // Default successful user lookup
    (
      userRepository.findByStravaAthleteId as MockedFunction<any>
    ).mockResolvedValue(mockUser);

    // Default successful activity processing
    (
      activityProcessor.processActivity as MockedFunction<any>
    ).mockResolvedValue(successProcessingResult);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("GET /api/strava/webhook (webhook verification)", () => {
    it("should verify webhook with correct token and challenge", async () => {
      const response = await request(app).get("/api/strava/webhook").query({
        "hub.mode": "subscribe",
        "hub.verify_token": "test-webhook-token",
        "hub.challenge": "test-challenge-123",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        "hub.challenge": "test-challenge-123",
      });
    });

    it("should reject verification with incorrect token", async () => {
      const response = await request(app).get("/api/strava/webhook").query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "test-challenge-123",
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "Verification failed",
      });
    });

    it("should reject verification with incorrect mode", async () => {
      const response = await request(app).get("/api/strava/webhook").query({
        "hub.mode": "unsubscribe",
        "hub.verify_token": "test-webhook-token",
        "hub.challenge": "test-challenge-123",
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "Verification failed",
      });
    });

    it("should reject verification with missing parameters", async () => {
      const response = await request(app).get("/api/strava/webhook").query({
        "hub.mode": "subscribe",
        // Missing verify_token and challenge
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "Verification failed",
      });
    });
  });

  describe("POST /api/strava/webhook (event processing)", () => {
    describe("successful processing", () => {
      it("should process valid activity create webhook", async () => {
        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          message: "Webhook processed",
          activityId: "123456",
          attempts: 0,
          processingTimeMs: expect.any(Number),
          success: true,
          skipped: false,
        });

        // Verify user lookup
        expect(userRepository.findByStravaAthleteId).toHaveBeenCalledWith(
          "12345",
        );

        // Verify activity processing
        expect(activityProcessor.processActivity).toHaveBeenCalledWith(
          "123456",
          "user-123",
          0,
        );
      });

      it("should handle skipped activity processing", async () => {
        const skippedResult = {
          success: false,
          activityId: "123456",
          skipped: true,
          reason: "No GPS coordinates",
        };

        (
          activityProcessor.processActivity as MockedFunction<any>
        ).mockResolvedValue(skippedResult);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          message: "Webhook processed",
          activityId: "123456",
          attempts: 0,
          processingTimeMs: expect.any(Number),
          success: false,
          skipped: true,
        });
      });
    });

    describe("retry logic", () => {
      it("should not retry on non-retryable errors", async () => {
        const authError = {
          success: false,
          activityId: "123456",
          error: "Strava access token expired",
        };

        (
          activityProcessor.processActivity as MockedFunction<any>
        ).mockResolvedValue(authError);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.attempts).toBe(0); // No retries
        expect(activityProcessor.processActivity).toHaveBeenCalledTimes(1);
      });
    });

    describe("athlete deauthorization", () => {
      const deauthorizeEvent = {
        object_type: "athlete",
        object_id: 12345,
        aspect_type: "deauthorize",
        owner_id: 12345,
        subscription_id: 98765,
        event_time: 1705311000,
      };

      it("should handle athlete deauthorization successfully", async () => {
        const deletedUser = {
          id: "user-123",
          firstName: "John",
          lastName: "Doe",
          stravaAthleteId: "12345",
        };

        (
          userRepository.deleteByStravaAthleteId as MockedFunction<any>
        ).mockResolvedValue(undefined);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(deauthorizeEvent);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          message: "Deauthorization processed",
          userId: "user-123",
        });

        expect(userRepository.deleteByStravaAthleteId).toHaveBeenCalledWith(
          "12345",
        );

        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
      });

      it("should handle deauthorization for non-existent user", async () => {
        const notFoundError = new Error("Record to delete does not exist");
        (
          userRepository.deleteByStravaAthleteId as MockedFunction<any>
        ).mockRejectedValue(notFoundError);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(deauthorizeEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Deauthorization acknowledged");

        expect(userRepository.deleteByStravaAthleteId).toHaveBeenCalledWith(
          "12345",
        );
      });

      it("should handle unexpected errors during deauthorization", async () => {
        const unexpectedError = new Error("Database connection failed");
        (
          userRepository.deleteByStravaAthleteId as MockedFunction<any>
        ).mockRejectedValue(unexpectedError);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(deauthorizeEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Deauthorization acknowledged");

        expect(userRepository.deleteByStravaAthleteId).toHaveBeenCalledWith(
          "12345",
        );
      });
    });

    describe("edge cases and filtering", () => {
      it("should ignore non-activity-create events", async () => {
        const athleteEvent = {
          ...validWebhookEvent,
          object_type: "athlete",
          aspect_type: "update", // Not deauthorize, so should be ignored
        };

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(athleteEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
        expect(userRepository.deleteByStravaAthleteId).not.toHaveBeenCalled();
      });

      it("should ignore activity non-create events", async () => {
        const updateEvent = {
          ...validWebhookEvent,
          aspect_type: "update",
        };

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(updateEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
        expect(userRepository.deleteByStravaAthleteId).not.toHaveBeenCalled();
      });

      it("should handle unknown user gracefully", async () => {
        (
          userRepository.findByStravaAthleteId as MockedFunction<any>
        ).mockResolvedValue(null);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
      });

      it("should handle user with weather disabled", async () => {
        const disabledUser = { ...mockUser, weatherEnabled: false };
        (
          userRepository.findByStravaAthleteId as MockedFunction<any>
        ).mockResolvedValue(disabledUser);

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
      });

      it("should handle invalid webhook event format", async () => {
        const invalidEvent = {
          object_type: "invalid",
          // Missing required fields
        };

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(invalidEvent);

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Invalid event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
      });

      it("should handle empty request body", async () => {
        const response = await request(app)
          .post("/api/strava/webhook")
          .send({});

        expect(response.status).toBe(200);
        expect(response.body.message).toBe("Invalid event acknowledged");
        expect(activityProcessor.processActivity).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      it("should handle general processing errors", async () => {
        (
          activityProcessor.processActivity as MockedFunction<any>
        ).mockResolvedValue({
          success: false,
          activityId: "123456",
          error: "Failed to update activity",
        });

        const response = await request(app)
          .post("/api/strava/webhook")
          .send(validWebhookEvent);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.attempts).toBe(0);
      });
    });
  });

  describe("GET /api/strava/webhook/status", () => {
    it("should return webhook status information", async () => {
      const response = await request(app).get("/api/strava/webhook/status");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "Webhook endpoint is active",
        data: {
          configured: true,
          endpoint: "http://localhost:3000/api/strava/webhook",
          verifyTokenSet: true,
          timestamp: expect.any(String),
        },
      });
    });

    it("should indicate missing configuration", async () => {
      // Temporarily modify config
      const originalToken = config.STRAVA_WEBHOOK_VERIFY_TOKEN;
      (config as any).STRAVA_WEBHOOK_VERIFY_TOKEN = "";

      const response = await request(app).get("/api/strava/webhook/status");

      expect(response.status).toBe(200);
      expect(response.body.data.configured).toBe(false);
      expect(response.body.data.verifyTokenSet).toBe(false);

      // Restore config
      (config as any).STRAVA_WEBHOOK_VERIFY_TOKEN = originalToken;
    });
  });
});
