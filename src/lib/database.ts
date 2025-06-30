import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createServiceLogger } from "../utils/logger";

const logger = createServiceLogger("database");

// Database table interfaces for Kysely
export interface UserTable {
  id: string;
  stravaAthleteId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  weatherEnabled: boolean;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPreferenceTable {
  id: string;
  userId: string;
  temperatureUnit: "fahrenheit" | "celsius";
  weatherFormat: "detailed" | "simple";
  includeUvIndex: boolean;
  includeVisibility: boolean;
  customFormat: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MetricsTable {
  id?: number; // Optional for inserts (auto-generated)
  metric_type: "webhook_processing" | "api_call" | "token_refresh";
  metric_name: string;
  value: number;
  metadata: string | null;
  created_at: Date;
}

export interface Database {
  users: UserTable;
  user_preferences: UserPreferenceTable;
  metrics: MetricsTable;
}

// Create the database connection
const createDatabase = () => {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const pool = new Pool({
    connectionString,
    max: parseInt(process.env.DB_POOL_MAX || "20", 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
    connectionTimeoutMillis: parseInt(
      process.env.DB_CONNECTION_TIMEOUT || "10000",
      10,
    ),
    ssl: false, // SSL disabled - PostgreSQL and app are on same isolated Docker network
  });

  logger.info("Database connection configuration", {
    ssl: false,
    environment: process.env.NODE_ENV,
  });

  // Enhanced logging for queries
  const dialect = new PostgresDialect({
    pool: pool,
  });

  const kysely = new Kysely<Database>({
    dialect,
    log: (event) => {
      if (event.level === "query") {
        const duration = Date.now() - event.queryDurationMillis;
        logger.debug("Query executed", {
          sql:
            event.query.sql.substring(0, 100) +
            (event.query.sql.length > 100 ? "..." : ""),
          duration: `${event.queryDurationMillis}ms`,
          parameters: event.query.parameters.length,
        });
      }
      if (event.level === "error") {
        logger.error("Query error", {
          error:
            event.error instanceof Error
              ? event.error.message
              : String(event.error),
          sql:
            event.query.sql.substring(0, 100) +
            (event.query.sql.length > 100 ? "..." : ""),
        });
      }
    },
  });

  // Setup event handlers for the pool
  pool.on("connect", () => {
    logger.debug("New database client connected");
  });

  pool.on("error", (err) => {
    logger.error("Database pool error", { error: err.message });
  });

  pool.on("remove", () => {
    logger.debug("Database client removed from pool");
  });

  return { kysely, pool };
};

// Global database instance
const globalForDatabase = globalThis as unknown as {
  database: { kysely: Kysely<Database>; pool: Pool } | undefined;
};

export const { kysely: db, pool } =
  globalForDatabase.database ?? createDatabase();

// In development, store the database instance in global to avoid creating multiple instances
if (process.env.NODE_ENV !== "production") {
  globalForDatabase.database = { kysely: db, pool };
}

// Health check function
export const healthCheck = async (): Promise<{
  healthy: boolean;
  details: Record<string, unknown>;
}> => {
  try {
    const start = Date.now();
    await sql`SELECT 1 as health_check`.execute(db);
    const duration = Date.now() - start;

    const poolStatus = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };

    return {
      healthy: true,
      details: {
        connected: true,
        queryDuration: `${duration}ms`,
        pool: poolStatus,
      },
    };
  } catch (error) {
    logger.error("Database health check failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      healthy: false,
      details: {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
        },
      },
    };
  }
};

// Graceful shutdown
export const disconnect = async (): Promise<void> => {
  try {
    await db.destroy();
    logger.info("Database connections closed");
  } catch (error) {
    logger.error("Error closing database connections", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

// Graceful shutdown handlers
const gracefulShutdown = async (): Promise<void> => {
  logger.info("🔄 Disconnecting database...");
  await disconnect();
  logger.info("✅ Database disconnected");
};

// Handle process termination
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("beforeExit", gracefulShutdown);

// Export the main database instance
export { db as database };
