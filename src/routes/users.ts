import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib";
import { authenticateUser, clearAuthCookie } from "../services/auth";
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
 * Get current user profile
 *
 * GET /api/users/me
 *
 * Returns the authenticated user's profile information including
 * Strava data, weather preferences, and account metadata.
 *
 * @returns Complete user profile with formatted display fields
 * @throws 401 - User not authenticated
 * @throws 404 - User profile not found (data integrity issue)
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

    const userProfile = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        stravaAthleteId: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
        city: true,
        state: true,
        country: true,
        weatherEnabled: true,
        createdAt: true,
        updatedAt: true,
        preferences: {
          select: {
            temperatureUnit: true,
            weatherFormat: true,
            includeUvIndex: true,
            includeVisibility: true,
            customFormat: true,
            updatedAt: true,
          },
        },
      },
    });

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
 * Update user settings
 *
 * PATCH /api/users/me
 *
 * Updates basic user settings. Currently only supports toggling
 * weather updates on/off.
 *
 * @body weatherEnabled - Enable/disable weather data on activities
 * @returns Updated user settings
 * @throws 400 - Invalid request data
 * @throws 401 - User not authenticated
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
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
      select: {
        id: true,
        weatherEnabled: true,
        updatedAt: true,
      },
    });

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
 * Update weather preferences
 *
 * PATCH /api/users/me/preferences
 *
 * Updates user's weather display preferences including units,
 * format, and which data points to include.
 *
 * @body temperatureUnit - 'fahrenheit' or 'celsius'
 * @body weatherFormat - 'detailed' or 'simple'
 * @body includeUvIndex - Include UV index in weather data
 * @body includeVisibility - Include visibility in weather data
 * @body customFormat - Custom format string for weather display
 * @returns Updated preferences
 * @throws 400 - Invalid preferences data or no fields provided
 * @throws 401 - User not authenticated
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

    const updatedPreferences = await prisma.userPreference.upsert({
      where: { userId: user.id },
      update: preferencesData,
      create: {
        userId: user.id,
        temperatureUnit: "fahrenheit",
        weatherFormat: "detailed",
        includeUvIndex: true,
        includeVisibility: true,
        ...preferencesData,
      },
      select: {
        temperatureUnit: true,
        weatherFormat: true,
        includeUvIndex: true,
        includeVisibility: true,
        customFormat: true,
        updatedAt: true,
      },
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
 * Delete user account
 *
 * DELETE /api/users/me
 *
 * Permanently deletes the user account and all associated data.
 * This action cannot be undone. The user will need to re-authenticate
 * with Strava to use the service again.
 *
 * @returns Success message
 * @throws 401 - User not authenticated
 * @throws 500 - Database error during deletion
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
      await prisma.user.delete({
        where: { id: user.id },
      });

      logger.info("User account deleted successfully", {
        userId: user.id,
        requestId,
      });

      // Clear the auth cookie since the account no longer exists
      clearAuthCookie(res);

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
