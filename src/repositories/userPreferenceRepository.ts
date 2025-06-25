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
      const query = sql<UserPreference>`
        SELECT * FROM user_preferences 
        WHERE "userId" = ${userId}
      `;

      const result = await query.execute(database);
      return result.rows[0] || null;
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
      const query = sql<UserPreference>`
        INSERT INTO user_preferences (
          id,
          "userId",
          "temperatureUnit",
          "weatherFormat",
          "includeUvIndex",
          "includeVisibility",
          "customFormat",
          "createdAt",
          "updatedAt"
        ) VALUES (
          gen_random_uuid(),
          ${preferenceData.userId},
          ${preferenceData.temperatureUnit},
          ${preferenceData.weatherFormat},
          ${preferenceData.includeUvIndex},
          ${preferenceData.includeVisibility},
          ${preferenceData.customFormat},
          ${new Date()},
          ${new Date()}
        )
        RETURNING *
      `;

      const result = await query.execute(database);
      const preference = result.rows[0];

      if (!preference) {
        throw new Error("Failed to create user preference");
      }

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
      const query = sql<UserPreference>`
        INSERT INTO user_preferences (
          id,
          "userId",
          "temperatureUnit",
          "weatherFormat",
          "includeUvIndex",
          "includeVisibility",
          "customFormat",
          "createdAt",
          "updatedAt"
        ) VALUES (
          gen_random_uuid(),
          ${preferenceData.userId},
          ${preferenceData.temperatureUnit},
          ${preferenceData.weatherFormat},
          ${preferenceData.includeUvIndex},
          ${preferenceData.includeVisibility},
          ${preferenceData.customFormat},
          ${new Date()},
          ${new Date()}
        )
        ON CONFLICT ("userId") 
        DO UPDATE SET
          "temperatureUnit" = EXCLUDED."temperatureUnit",
          "weatherFormat" = EXCLUDED."weatherFormat",
          "includeUvIndex" = EXCLUDED."includeUvIndex",
          "includeVisibility" = EXCLUDED."includeVisibility",
          "customFormat" = EXCLUDED."customFormat",
          "updatedAt" = ${new Date()}
        RETURNING *
      `;

      const result = await query.execute(database);
      const preference = result.rows[0];

      if (!preference) {
        throw new Error("Failed to upsert user preference");
      }

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
      const query = sql`
        DELETE FROM user_preferences 
        WHERE "userId" = ${userId}
      `;

      const result = await query.execute(database);

      if (result.numAffectedRows === 0n) {
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
