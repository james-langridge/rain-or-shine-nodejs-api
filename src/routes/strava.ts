import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "../config/environment";
import { prisma } from "../lib";
import {
  activityProcessor,
  type ProcessingResult,
} from "../services/activityProcessor";
import { logger } from "../utils/logger";
import { asyncHandler } from "../middleware/errorHandler";

/**
 * Strava webhook router
 *
 * Handles webhook verification and event processing for Strava integration.
 * Implements retry logic for handling race conditions when activities are
 * created but not immediately available via the Strava API.
 */
const stravaRouter = Router();

/**
 * Webhook event type definitions
 */
const stravaWebhookEventSchema = z.object({
  object_type: z.enum(["activity", "athlete"]),
  object_id: z.number(),
  aspect_type: z.enum(["create", "update", "delete"]),
  updates: z.record(z.any()).optional(),
  owner_id: z.number(),
  subscription_id: z.number(),
  event_time: z.number(),
});

type StravaWebhookEvent = z.infer<typeof stravaWebhookEventSchema>;

/**
 * Webhook processing configuration
 */
const WEBHOOK_CONFIG = {
  MAX_PROCESSING_TIME_MS: 8000, // 8 seconds max to avoid timeout
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAYS_MS: [1500, 3000], // Progressive delays between retries
} as const;

/**
 * Webhook verification endpoint
 *
 * GET /api/strava/webhook
 *
 * Handles Strava's webhook verification challenge during subscription setup.
 * Must respond with the challenge value to confirm endpoint ownership.
 *
 * @query hub.mode - Should be "subscribe" for verification
 * @query hub.verify_token - Token that must match our configured token
 * @query hub.challenge - Challenge string to echo back
 */
stravaRouter.get("/webhook", (req: Request, res: Response): void => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  logger.info("Webhook verification request received", {
    mode,
    hasToken: !!token,
    hasChallenge: !!challenge,
    requestId: (req as any).requestId,
  });

  if (mode === "subscribe" && token === config.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    logger.info("Webhook verification successful");
    res.json({ "hub.challenge": challenge });
  } else {
    logger.warn("Webhook verification failed", {
      modeValid: mode === "subscribe",
      tokenValid: token === config.STRAVA_WEBHOOK_VERIFY_TOKEN,
    });
    res.status(403).json({ error: "Verification failed" });
  }
});

/**
 * Webhook event handler
 *
 * POST /api/strava/webhook
 *
 * Processes incoming Strava webhook events. Currently handles:
 * - New activity creation (activity.create)
 *
 * Implements retry logic to handle race conditions where activities
 * may not be immediately available after creation notification.
 *
 * Always returns 200 OK to prevent Strava from retrying.
 */
stravaRouter.post(
  "/webhook",
  asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const startTime = Date.now();
      const requestId = (req as any).requestId;

      // Validate webhook event
      const eventValidation = stravaWebhookEventSchema.safeParse(req.body);
      if (!eventValidation.success) {
        logger.warn("Invalid webhook event received", {
          error: eventValidation.error.errors,
          body: req.body,
          requestId,
        });
        res.status(200).json({ message: "Invalid event acknowledged" });
        return;
      }

      const event = eventValidation.data;

      logger.info("Webhook event received", {
        objectType: event.object_type,
        objectId: event.object_id,
        aspectType: event.aspect_type,
        ownerId: event.owner_id,
        subscriptionId: event.subscription_id,
        eventTime: new Date(event.event_time * 1000).toISOString(),
        requestId,
      });

      // Only process new activity creations
      if (event.object_type !== "activity" || event.aspect_type !== "create") {
        logger.debug("Ignoring non-activity-create event", {
          objectType: event.object_type,
          aspectType: event.aspect_type,
          requestId,
        });
        res.status(200).json({ message: "Event acknowledged" });
        return;
      }

      const activityId = event.object_id.toString();
      const stravaAthleteId = event.owner_id.toString();

      // Check if user exists and has weather enabled
      const user = await prisma.user.findUnique({
        where: { stravaAthleteId },
        select: {
          id: true,
          weatherEnabled: true,
          firstName: true,
          lastName: true,
        },
      });

      if (!user) {
        logger.info("Activity webhook for unknown user", {
          stravaAthleteId,
          activityId,
          requestId,
        });
        res.status(200).json({ message: "Event acknowledged" });
        return;
      }

      if (!user.weatherEnabled) {
        logger.info("Weather updates disabled for user", {
          userId: user.id,
          activityId,
          requestId,
        });
        res.status(200).json({ message: "Event acknowledged" });
        return;
      }

      logger.info("Processing activity for user", {
        userId: user.id,
        userName: `${user.firstName} ${user.lastName}`,
        activityId,
        requestId,
      });

      // Process with retry logic
      let attempts = 0;
      let result: ProcessingResult | null = null;
      const errors: Array<{ attempt: number; error: string }> = [];

      while (
        attempts < WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS &&
        Date.now() - startTime < WEBHOOK_CONFIG.MAX_PROCESSING_TIME_MS
      ) {
        try {
          // Wait between retries (progressive backoff)
          if (attempts > 0) {
            const delayIndex = Math.min(
              attempts - 1,
              WEBHOOK_CONFIG.RETRY_DELAYS_MS.length - 1,
            );
            const delay = WEBHOOK_CONFIG.RETRY_DELAYS_MS[delayIndex];

            logger.info("Retrying activity processing", {
              attempt: attempts + 1,
              delayMs: delay,
              activityId,
              requestId,
            });

            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          result = await activityProcessor.processActivity(activityId, user.id);

          // Success or non-retryable failure
          if (result.success || result.skipped) {
            break;
          }

          // Check if it's a "not found" error (retryable)
          const errorLower = result.error?.toLowerCase() || "";
          if (errorLower.includes("not found") || errorLower.includes("404")) {
            errors.push({
              attempt: attempts + 1,
              error: result.error || "Not found",
            });
            attempts++;
            continue;
          }

          // Other errors are not retryable
          break;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          errors.push({ attempt: attempts + 1, error: errorMessage });

          logger.error("Activity processing attempt failed", {
            attempt: attempts + 1,
            error: errorMessage,
            activityId,
            userId: user.id,
            requestId,
          });

          attempts++;
        }
      }

      // Log final processing result
      const processingTime = Date.now() - startTime;
      const logData = {
        activityId,
        userId: user.id,
        attempts,
        processingTimeMs: processingTime,
        success: result?.success || false,
        skipped: result?.skipped || false,
        skipReason: result?.reason,
        errors: errors.length > 0 ? errors : undefined,
        requestId,
      };

      if (result?.success && !result?.skipped) {
        logger.info("Activity processed successfully", logData);
      } else if (result?.skipped) {
        logger.info("Activity processing skipped", logData);
      } else {
        logger.warn("Activity processing failed", {
          ...logData,
          finalError: result?.error || "Unknown error",
        });
      }

      // Always respond 200 to prevent Strava retries
      res.status(200).json({
        message: "Webhook processed",
        activityId,
        attempts,
        processingTimeMs: processingTime,
        success: result?.success || false,
        skipped: result?.skipped || false,
      });
    },
  ),
);

/**
 * Webhook status endpoint
 *
 * GET /api/strava/webhook/status
 *
 * Health check endpoint to verify webhook configuration and readiness.
 * Useful for monitoring and debugging webhook setup.
 */
stravaRouter.get("/webhook/status", (req: Request, res: Response): void => {
  const status = {
    configured: !!config.STRAVA_WEBHOOK_VERIFY_TOKEN,
    endpoint: `${config.APP_URL}/api/strava/webhook`,
    verifyTokenSet: !!config.STRAVA_WEBHOOK_VERIFY_TOKEN,
  };

  logger.info("Webhook status check", {
    ...status,
    requestId: (req as any).requestId,
  });

  res.json({
    success: true,
    message: "Webhook endpoint is active",
    data: {
      ...status,
      timestamp: new Date().toISOString(),
    },
  });
});

export { stravaRouter };
