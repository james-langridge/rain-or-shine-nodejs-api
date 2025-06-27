import { Router } from "express";
import { z } from "zod";
import { userRepository, userPreferenceRepository } from "../lib";
import { authenticateUser } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { logger } from "../utils/logger";
import type { Request, Response } from "express";

/**
 * Users router
 *
 * Manages user profiles, preferences, and account operations.
 * All endpoints require authentication via JWT cookie.
 */
const usersRouter = Router();

/**
 * Validation schemas
 */
const userUpdateSchema = z.object({
  weatherEnabled: z.boolean(),
});

const preferencesUpdateSchema = z
  .object({
    temperatureUnit: z.enum(["fahrenheit", "celsius"]).optional(),
    weatherFormat: z.enum(["detailed", "simple"]).optional(),
    includeUvIndex: z.boolean().optional(),
    includeVisibility: z.boolean().optional(),
    customFormat: z.string().max(500).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one preference field must be provided",
  });

/**
 * GET /api/users/me
 *
 * Get current user profile including Strava data, weather preferences,
 * and account metadata. Returns comprehensive user information for
 * authenticated users.
 */
usersRouter.get(
  "/me",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = (req as any).requestId;

    logger.info("Fetching user profile", {
      userId: user.id,
      requestId,
    });

    const userProfile = await userRepository.findWithPreferences(user.id);

    if (!userProfile) {
      logger.error("User profile not found in database", {
        userId: user.id,
        requestId,
      });
      throw new AppError("User profile not found", 404);
    }

    // Format location string
    const locationParts = [
      userProfile.city,
      userProfile.state,
      userProfile.country,
    ].filter(Boolean);
    const location = locationParts.length > 0 ? locationParts.join(", ") : null;

    // Format display name
    const nameParts = [userProfile.firstName, userProfile.lastName].filter(
      Boolean,
    );
    const displayName =
      nameParts.length > 0 ? nameParts.join(" ") : "Strava User";

    logger.debug("User profile retrieved successfully", {
      userId: user.id,
      hasPreferences: !!userProfile.preferences,
      requestId,
    });

    res.json({
      success: true,
      data: {
        id: userProfile.id,
        stravaAthleteId: userProfile.stravaAthleteId,
        firstName: userProfile.firstName,
        lastName: userProfile.lastName,
        displayName,
        profileImageUrl: userProfile.profileImageUrl,
        location,
        weatherEnabled: userProfile.weatherEnabled,
        preferences: userProfile.preferences || {
          temperatureUnit: "fahrenheit",
          weatherFormat: "detailed",
          includeUvIndex: true,
          includeVisibility: true,
          customFormat: null,
        },
        memberSince: userProfile.createdAt,
        lastUpdated: userProfile.updatedAt,
      },
    });
  }),
);

/**
 * PATCH /api/users/me
 *
 * Update user settings like enabling/disabling weather data on activities.
 * Currently only supports toggling the weatherEnabled flag.
 */
usersRouter.patch(
  "/me",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = (req as any).requestId;

    // Validate request body
    const validation = userUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      logger.warn("Invalid user update request", {
        userId: user.id,
        errors: validation.error.errors,
        requestId,
      });
      throw new AppError(
        "Invalid request data: " + validation.error.errors[0]?.message,
        400,
      );
    }

    const updateData = validation.data;

    logger.info("Updating user settings", {
      userId: user.id,
      updates: updateData,
      requestId,
    });

    // Update user
    const updatedUser = await userRepository.update(user.id, updateData);

    logger.info("User settings updated successfully", {
      userId: user.id,
      weatherEnabled: updatedUser.weatherEnabled,
      requestId,
    });

    res.json({
      success: true,
      data: {
        id: updatedUser.id,
        weatherEnabled: updatedUser.weatherEnabled,
        updatedAt: updatedUser.updatedAt,
      },
      message: "User settings updated successfully",
    });
  }),
);

/**
 * PATCH /api/users/me/preferences
 *
 * Update weather display preferences including temperature units (celsius/fahrenheit),
 * display format (detailed/simple), and which data points to include (UV index, visibility).
 * Also supports custom format strings for weather display.
 */
usersRouter.patch(
  "/me/preferences",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = (req as any).requestId;

    const validation = preferencesUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      logger.warn("Invalid preferences update request", {
        userId: user.id,
        errors: validation.error.errors,
        requestId,
      });
      throw new AppError(
        "Invalid preferences data: " + validation.error.errors[0]?.message,
        400,
      );
    }

    // Filter out undefined values
    const preferencesData = Object.entries(validation.data).reduce(
      (acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, any>,
    );

    logger.info("Updating weather preferences", {
      userId: user.id,
      updates: Object.keys(preferencesData),
      requestId,
    });

    const updatedPreferences = await userPreferenceRepository.upsert({
      userId: user.id,
      temperatureUnit: "fahrenheit",
      weatherFormat: "detailed",
      includeUvIndex: true,
      includeVisibility: true,
      customFormat: null,
      ...preferencesData,
    });

    logger.info("Weather preferences updated successfully", {
      userId: user.id,
      preferences: updatedPreferences,
      requestId,
    });

    res.json({
      success: true,
      data: updatedPreferences,
      message: "Weather preferences updated successfully",
    });
  }),
);

/**
 * DELETE /api/users/me
 *
 * Permanently delete the user account and all associated data including
 * preferences, activities data, and Strava integration. This action cannot be undone.
 */
usersRouter.delete(
  "/me",
  authenticateUser,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = (req as any).requestId;

    logger.warn("User account deletion requested", {
      userId: user.id,
      stravaAthleteId: user.stravaAthleteId,
      requestId,
    });

    try {
      // Delete user and all related data (cascading delete)
      await userRepository.delete(user.id);

      logger.info("User account deleted successfully", {
        userId: user.id,
        requestId,
      });

      res.json({
        success: true,
        message: "Your account has been deleted successfully",
      });
    } catch (error) {
      logger.error("Failed to delete user account", {
        userId: user.id,
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
      });

      throw new AppError("Failed to delete account. Please try again.", 500);
    }
  }),
);

export { usersRouter };
