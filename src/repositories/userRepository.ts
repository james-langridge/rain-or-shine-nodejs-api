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
      const query = sql<User>`
        SELECT * FROM users 
        WHERE id = ${id}
      `;

      const result = await query.execute(database);
      return result.rows[0] || null;
    } catch (error) {
      logger.error("Failed to find user by ID", { id, error });
      throw parseDatabaseError(error);
    }
  }

  async findByStravaAthleteId(stravaAthleteId: string): Promise<User | null> {
    try {
      const query = sql<User>`
        SELECT * FROM users 
        WHERE "stravaAthleteId" = ${stravaAthleteId}
      `;

      const result = await query.execute(database);
      return result.rows[0] || null;
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
      type UserWithPrefsRow = User & {
        pref_id: string | null;
        pref_userId: string | null;
        pref_temperatureUnit: string | null;
        pref_weatherFormat: string | null;
        pref_includeUvIndex: boolean | null;
        pref_includeVisibility: boolean | null;
        pref_customFormat: string | null;
        pref_createdAt: Date | null;
        pref_updatedAt: Date | null;
      };

      const query = sql<UserWithPrefsRow>`
        SELECT 
          u.*,
          p.id as pref_id,
          p."userId" as pref_userId,
          p."temperatureUnit" as pref_temperatureUnit,
          p."weatherFormat" as pref_weatherFormat,
          p."includeUvIndex" as pref_includeUvIndex,
          p."includeVisibility" as pref_includeVisibility,
          p."customFormat" as pref_customFormat,
          p."createdAt" as pref_createdAt,
          p."updatedAt" as pref_updatedAt
        FROM users u
        LEFT JOIN user_preferences p ON u.id = p."userId"
        WHERE u.id = ${id}
      `;

      const { rows } = await query.execute(database);
      const result = rows[0];

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
            temperatureUnit: result.pref_temperatureUnit! as
              | "fahrenheit"
              | "celsius",
            weatherFormat: result.pref_weatherFormat! as "detailed" | "simple",
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
      const query = sql<User>`
        SELECT * FROM users
        ORDER BY ${sql.raw(`"${orderBy}"`)} ${sql.raw(orderDirection.toUpperCase())}
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const result = await query.execute(database);
      return result.rows;
    } catch (error) {
      logger.error("Failed to find users", { options, error });
      throw parseDatabaseError(error);
    }
  }

  async create(userData: UserInsert): Promise<User> {
    try {
      const query = sql<User>`
        INSERT INTO users (
          id,
          "stravaAthleteId",
          "accessToken",
          "refreshToken",
          "tokenExpiresAt",
          "weatherEnabled",
          "firstName",
          "lastName",
          "profileImageUrl",
          city,
          state,
          country,
          "createdAt",
          "updatedAt"
        ) VALUES (
          gen_random_uuid(),
          ${userData.stravaAthleteId},
          ${userData.accessToken},
          ${userData.refreshToken},
          ${userData.tokenExpiresAt},
          ${userData.weatherEnabled},
          ${userData.firstName},
          ${userData.lastName},
          ${userData.profileImageUrl},
          ${userData.city},
          ${userData.state},
          ${userData.country},
          ${new Date()},
          ${new Date()}
        )
        RETURNING *
      `;

      const result = await query.execute(database);
      const user = result.rows[0];

      if (!user) {
        throw new Error("Failed to create user");
      }

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
      const query = sql<User>`
        INSERT INTO users (
          id,
          "stravaAthleteId",
          "accessToken",
          "refreshToken",
          "tokenExpiresAt",
          "weatherEnabled",
          "firstName",
          "lastName",
          "profileImageUrl",
          city,
          state,
          country,
          "createdAt",
          "updatedAt"
        ) VALUES (
          gen_random_uuid(),
          ${userData.stravaAthleteId},
          ${userData.accessToken},
          ${userData.refreshToken},
          ${userData.tokenExpiresAt},
          ${userData.weatherEnabled},
          ${userData.firstName},
          ${userData.lastName},
          ${userData.profileImageUrl},
          ${userData.city},
          ${userData.state},
          ${userData.country},
          ${new Date()},
          ${new Date()}
        )
        ON CONFLICT ("stravaAthleteId") 
        DO UPDATE SET
          "accessToken" = EXCLUDED."accessToken",
          "refreshToken" = EXCLUDED."refreshToken",
          "tokenExpiresAt" = EXCLUDED."tokenExpiresAt",
          "weatherEnabled" = EXCLUDED."weatherEnabled",
          "firstName" = EXCLUDED."firstName",
          "lastName" = EXCLUDED."lastName",
          "profileImageUrl" = EXCLUDED."profileImageUrl",
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          country = EXCLUDED.country,
          "updatedAt" = ${new Date()}
        RETURNING *
      `;

      const result = await query.execute(database);
      const user = result.rows[0];

      if (!user) {
        throw new Error("Failed to upsert user");
      }

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
      const query = sql`
        DELETE FROM users 
        WHERE id = ${id}
      `;

      const result = await query.execute(database);

      if (result.numAffectedRows === 0n) {
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
      const query = sql`
        DELETE FROM users 
        WHERE "stravaAthleteId" = ${stravaAthleteId}
      `;

      const result = await query.execute(database);

      if (result.numAffectedRows === 0n) {
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
      const query = sql<{ count: number }>`
        SELECT COUNT(*) as count 
        FROM users
      `;

      const result = await query.execute(database);
      const row = result.rows[0];
      return row ? Number(row.count) : 0;
    } catch (error) {
      logger.error("Failed to count users", { error });
      throw parseDatabaseError(error);
    }
  }
}

// Export singleton instance
export const userRepository = new UserRepository();
