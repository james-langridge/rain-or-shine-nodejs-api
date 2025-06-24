import { sql } from "kysely";
import { database } from "../lib/database";
import type {
  User,
  UserInsert,
  UserUpdate,
  UserWithPreferences,
} from "../types/database";
import { parseDatabaseError } from "../types/database";
import { createServiceLogger } from "../utils/logger";

const logger = createServiceLogger("userRepository");

export class UserRepository {
  async findById(id: string): Promise<User | null> {
    try {
      const user = await database
        .selectFrom("users")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return user || null;
    } catch (error) {
      logger.error("Failed to find user by ID", { id, error });
      throw parseDatabaseError(error);
    }
  }

  async findByStravaAthleteId(stravaAthleteId: string): Promise<User | null> {
    try {
      const user = await database
        .selectFrom("users")
        .selectAll()
        .where("stravaAthleteId", "=", stravaAthleteId)
        .executeTakeFirst();

      return user || null;
    } catch (error) {
      logger.error("Failed to find user by Strava athlete ID", {
        stravaAthleteId,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async findWithPreferences(id: string): Promise<UserWithPreferences | null> {
    try {
      const result = await database
        .selectFrom("users")
        .leftJoin("user_preferences", "users.id", "user_preferences.userId")
        .selectAll("users")
        .select([
          "user_preferences.id as pref_id",
          "user_preferences.userId as pref_userId",
          "user_preferences.temperatureUnit as pref_temperatureUnit",
          "user_preferences.weatherFormat as pref_weatherFormat",
          "user_preferences.includeUvIndex as pref_includeUvIndex",
          "user_preferences.includeVisibility as pref_includeVisibility",
          "user_preferences.customFormat as pref_customFormat",
          "user_preferences.createdAt as pref_createdAt",
          "user_preferences.updatedAt as pref_updatedAt",
        ])
        .where("users.id", "=", id)
        .executeTakeFirst();

      if (!result) return null;

      // Build the user with preferences
      const user: User = {
        id: result.id,
        stravaAthleteId: result.stravaAthleteId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenExpiresAt: result.tokenExpiresAt,
        weatherEnabled: result.weatherEnabled,
        firstName: result.firstName,
        lastName: result.lastName,
        profileImageUrl: result.profileImageUrl,
        city: result.city,
        state: result.state,
        country: result.country,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };

      const preferences = result.pref_id
        ? {
            id: result.pref_id,
            userId: result.pref_userId!,
            temperatureUnit: result.pref_temperatureUnit!,
            weatherFormat: result.pref_weatherFormat!,
            includeUvIndex: result.pref_includeUvIndex!,
            includeVisibility: result.pref_includeVisibility!,
            customFormat: result.pref_customFormat,
            createdAt: result.pref_createdAt!,
            updatedAt: result.pref_updatedAt!,
          }
        : null;

      return { ...user, preferences };
    } catch (error) {
      logger.error("Failed to find user with preferences", { id, error });
      throw parseDatabaseError(error);
    }
  }

  async findMany(
    options: {
      limit?: number;
      offset?: number;
      orderBy?: "createdAt" | "updatedAt";
      orderDirection?: "asc" | "desc";
    } = {},
  ): Promise<User[]> {
    const {
      limit = 50,
      offset = 0,
      orderBy = "createdAt",
      orderDirection = "desc",
    } = options;

    try {
      const users = await database
        .selectFrom("users")
        .selectAll()
        .orderBy(orderBy, orderDirection)
        .limit(limit)
        .offset(offset)
        .execute();

      return users;
    } catch (error) {
      logger.error("Failed to find users", { options, error });
      throw parseDatabaseError(error);
    }
  }

  async create(userData: UserInsert): Promise<User> {
    try {
      const user = await database
        .insertInto("users")
        .values({
          id: sql`gen_random_uuid()`,
          ...userData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      logger.info("User created", { userId: user.id });
      return user;
    } catch (error) {
      logger.error("Failed to create user", {
        userData: { ...userData, accessToken: "***", refreshToken: "***" },
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async upsert(userData: UserInsert): Promise<User> {
    try {
      const user = await database
        .insertInto("users")
        .values({
          id: sql`gen_random_uuid()`,
          ...userData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflict((oc) =>
          oc.column("stravaAthleteId").doUpdateSet({
            accessToken: userData.accessToken,
            refreshToken: userData.refreshToken,
            tokenExpiresAt: userData.tokenExpiresAt,
            weatherEnabled: userData.weatherEnabled,
            firstName: userData.firstName,
            lastName: userData.lastName,
            profileImageUrl: userData.profileImageUrl,
            city: userData.city,
            state: userData.state,
            country: userData.country,
            updatedAt: new Date(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      logger.info("User upserted", { userId: user.id });
      return user;
    } catch (error) {
      logger.error("Failed to upsert user", {
        userData: { ...userData, accessToken: "***", refreshToken: "***" },
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async update(id: string, userData: UserUpdate): Promise<User> {
    try {
      const user = await database
        .updateTable("users")
        .set({
          ...userData,
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

      if (!user) {
        throw new (require("../types/database").NotFoundError)("User");
      }

      logger.info("User updated", { userId: id });
      return user;
    } catch (error) {
      logger.error("Failed to update user", {
        id,
        userData: {
          ...userData,
          accessToken: userData.accessToken ? "***" : undefined,
          refreshToken: userData.refreshToken ? "***" : undefined,
        },
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const result = await database
        .deleteFrom("users")
        .where("id", "=", id)
        .executeTakeFirst();

      if (result.numDeletedRows === 0n) {
        throw new (require("../types/database").NotFoundError)("User");
      }

      logger.info("User deleted", { userId: id });
    } catch (error) {
      logger.error("Failed to delete user", { id, error });
      throw parseDatabaseError(error);
    }
  }

  async deleteByStravaAthleteId(stravaAthleteId: string): Promise<void> {
    try {
      const result = await database
        .deleteFrom("users")
        .where("stravaAthleteId", "=", stravaAthleteId)
        .executeTakeFirst();

      if (result.numDeletedRows === 0n) {
        throw new (require("../types/database").NotFoundError)("User");
      }

      logger.info("User deleted by Strava athlete ID", { stravaAthleteId });
    } catch (error) {
      logger.error("Failed to delete user by Strava athlete ID", {
        stravaAthleteId,
        error,
      });
      throw parseDatabaseError(error);
    }
  }

  async count(): Promise<number> {
    try {
      const result = await database
        .selectFrom("users")
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();

      return result.count;
    } catch (error) {
      logger.error("Failed to count users", { error });
      throw parseDatabaseError(error);
    }
  }
}

// Export singleton instance
export const userRepository = new UserRepository();
