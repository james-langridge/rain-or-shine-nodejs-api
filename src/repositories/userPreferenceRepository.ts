import { sql } from "kysely";
import { database } from "../lib/database";
import type {
  UserPreference,
  UserPreferenceInsert,
  UserPreferenceUpdate,
} from "../types/database";
import { parseDatabaseError } from "../types/database";
import { createServiceLogger } from "../utils/logger";

const logger = createServiceLogger("userPreferenceRepository");

export class UserPreferenceRepository {
  async findByUserId(userId: string): Promise<UserPreference | null> {
    try {
      const preference = await database
        .selectFrom("user_preferences")
        .selectAll()
        .where("userId", "=", userId)
        .executeTakeFirst();

      return preference || null;
    } catch (error) {
      logger.error("Failed to find user preference by user ID", {
        userId,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async create(preferenceData: UserPreferenceInsert): Promise<UserPreference> {
    try {
      const preference = await database
        .insertInto("user_preferences")
        .values({
          id: sql`gen_random_uuid()`,
          ...preferenceData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      logger.info("User preference created", {
        preferenceId: preference.id,
        userId: preferenceData.userId,
      });
      return preference;
    } catch (error) {
      logger.error("Failed to create user preference", {
        preferenceData,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async upsert(preferenceData: UserPreferenceInsert): Promise<UserPreference> {
    try {
      const preference = await database
        .insertInto("user_preferences")
        .values({
          id: sql`gen_random_uuid()`,
          ...preferenceData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflict((oc) =>
          oc.column("userId").doUpdateSet({
            temperatureUnit: preferenceData.temperatureUnit,
            weatherFormat: preferenceData.weatherFormat,
            includeUvIndex: preferenceData.includeUvIndex,
            includeVisibility: preferenceData.includeVisibility,
            customFormat: preferenceData.customFormat,
            updatedAt: new Date(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      logger.info("User preference upserted", {
        preferenceId: preference.id,
        userId: preferenceData.userId,
      });
      return preference;
    } catch (error) {
      logger.error("Failed to upsert user preference", {
        preferenceData,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async update(
    userId: string,
    preferenceData: UserPreferenceUpdate,
  ): Promise<UserPreference> {
    try {
      const preference = await database
        .updateTable("user_preferences")
        .set({
          ...preferenceData,
          updatedAt: new Date(),
        })
        .where("userId", "=", userId)
        .returningAll()
        .executeTakeFirst();

      if (!preference) {
        throw new (require("../types/database").NotFoundError)(
          "UserPreference",
        );
      }

      logger.info("User preference updated", { userId });
      return preference;
    } catch (error) {
      logger.error("Failed to update user preference", {
        userId,
        preferenceData,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async delete(userId: string): Promise<void> {
    try {
      const result = await database
        .deleteFrom("user_preferences")
        .where("userId", "=", userId)
        .executeTakeFirst();

      if (result.numDeletedRows === 0n) {
        throw new (require("../types/database").NotFoundError)(
          "UserPreference",
        );
      }

      logger.info("User preference deleted", { userId });
    } catch (error) {
      logger.error("Failed to delete user preference", { userId, error });
      throw parseDatabaseError(error);
    }
  }
}

// Export singleton instance
export const userPreferenceRepository = new UserPreferenceRepository();
