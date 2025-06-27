import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { activityProcessor } from "../services/activityProcessor";
import { authenticateUser } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { logger } from "../utils/logger";

/**
 * Activities router
 *
 * Handles manual activity processing requests, allowing users to
 * trigger weather data updates for specific Strava activities.
 */
const activitiesRouter = Router();

/**
 * Request validation schema
 */
const processActivityParamsSchema = z.object({
  activityId: z.string().regex(/^\d+$/, "Activity ID must be numeric"),
});

/**
 * POST /api/activities/process/:id
 * @summary Process a specific activity
 * @description Manually triggers weather data processing for a specific activity. Useful for processing activities that don't have weather data yet, reprocessing failed activities, or testing weather integration
 * @tags Activities
 * @security SessionAuth
 * @param {string} id.path.required - Strava activity ID (numeric string)
 * @returns {object} 200 - Activity processed successfully
 * @returns {object} 400 - Invalid activity ID format
 * @returns {object} 401 - Not authenticated
 * @returns {object} 404 - Activity not found or not accessible
 * @returns {object} 503 - Weather service unavailable
 * @example response - 200 - Success response
 * {
 *   "success": true,
 *   "message": "Activity processed successfully with weather data",
 *   "data": {
 *     "activityId": "1234567890",
 *     "weatherData": {
 *       "temperature": 72,
 *       "humidity": 65,
 *       "description": "Partly cloudy"
 *     },
 *     "skipped": false,
 *     "reason": null,
 *     "processingTime": 1250
 *   }
 * }
 * @example response - 200 - Already processed
 * {
 *   "success": true,
 *   "message": "Activity already contains weather data",
 *   "data": {
 *     "activityId": "1234567890",
 *     "weatherData": null,
 *     "skipped": true,
 *     "reason": "Already has weather data",
 *     "processingTime": 125
 *   }
 * }
 * @example response - 404 - Activity not found
 * {
 *   "success": false,
 *   "message": "Failed to process activity",
 *   "error": {
 *     "message": "Activity not found",
 *     "code": "ACTIVITY_NOT_FOUND"
 *   },
 *   "data": {
 *     "activityId": "1234567890",
 *     "skipped": false,
 *     "reason": null
 *   }
 * }
 */
activitiesRouter.post(
  "/process/:activityId",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    // Validate request parameters
    const paramsValidation = processActivityParamsSchema.safeParse(req.params);
    if (!paramsValidation.success) {
      const errorMessage =
        paramsValidation.error.errors[0]?.message ||
        "Invalid request parameters";
      throw new AppError(errorMessage, 400);
    }

    const { activityId } = paramsValidation.data;
    const user = req.user;

    if (!user) {
      throw new AppError("User authentication required", 401);
    }

    // Log processing request
    logger.info("Manual activity processing requested", {
      activityId,
      userId: user.id,
      requestId: (req as any).requestId,
    });

    // Process the activity
    const startTime = Date.now();
    const result = await activityProcessor.processActivity(activityId, user.id);
    const processingTime = Date.now() - startTime;

    // Log processing result
    const logData = {
      activityId,
      userId: user.id,
      success: result.success,
      skipped: result.skipped,
      reason: result.reason,
      processingTime,
      requestId: (req as any).requestId,
    };

    if (result.success) {
      logger.info("Activity processing completed", logData);

      res.json({
        success: true,
        message: getSuccessMessage(result),
        data: {
          activityId: result.activityId,
          weatherData: result.weatherData,
          skipped: result.skipped,
          reason: result.reason,
          processingTime,
        },
      });
    } else {
      logger.warn("Activity processing failed", {
        ...logData,
        error: result.error,
      });

      // Determine appropriate status code based on error
      const statusCode = getErrorStatusCode(result.error);

      res.status(statusCode).json({
        success: false,
        message: "Failed to process activity",
        error: {
          message: result.error || "Unknown error occurred",
          code: getErrorCode(result.error),
        },
        data: {
          activityId: result.activityId,
          skipped: result.skipped,
          reason: result.reason,
        },
      });
    }
  }),
);

/**
 * Get appropriate success message based on processing result
 */
function getSuccessMessage(result: any): string {
  if (result.skipped) {
    switch (result.reason) {
      case "Already has weather data":
        return "Activity already contains weather data";
      case "Weather updates disabled":
        return "Weather updates are currently disabled for your account";
      case "No GPS coordinates":
        return "Activity processed but no weather added (missing GPS data)";
      default:
        return `Activity was skipped: ${result.reason}`;
    }
  }
  return "Activity processed successfully with weather data";
}

/**
 * Determine HTTP status code based on error message
 */
function getErrorStatusCode(error?: string): number {
  if (!error) return 400;

  const errorLower = error.toLowerCase();

  if (errorLower.includes("not found") || errorLower.includes("404")) {
    return 404;
  }
  if (errorLower.includes("unauthorized") || errorLower.includes("401")) {
    return 401;
  }
  if (errorLower.includes("rate limit") || errorLower.includes("429")) {
    return 429;
  }
  if (errorLower.includes("unavailable") || errorLower.includes("503")) {
    return 503;
  }

  return 400; // Default to bad request
}

/**
 * Extract error code from error message for client handling
 */
function getErrorCode(error?: string): string {
  if (!error) return "UNKNOWN_ERROR";

  const errorLower = error.toLowerCase();

  if (errorLower.includes("not found")) return "ACTIVITY_NOT_FOUND";
  if (errorLower.includes("unauthorized")) return "UNAUTHORIZED";
  if (errorLower.includes("rate limit")) return "RATE_LIMITED";
  if (errorLower.includes("weather") && errorLower.includes("unavailable")) {
    return "WEATHER_SERVICE_UNAVAILABLE";
  }
  if (errorLower.includes("strava") && errorLower.includes("unavailable")) {
    return "STRAVA_SERVICE_UNAVAILABLE";
  }

  return "PROCESSING_ERROR";
}

export { activitiesRouter };
