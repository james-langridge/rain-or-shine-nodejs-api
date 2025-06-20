import { Router } from "express";
import { config } from "../config/environment";
import { prisma } from "../lib";
import type { Request, Response, NextFunction } from "express";

const healthRouter = Router();

interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  services: {
    database: ServiceStatus;
    strava_api: ServiceStatus;
    weather_api: ServiceStatus;
  };
  performance: {
    memory: NodeJS.MemoryUsage;
    cpu: number;
  };
}

interface ServiceStatus {
  status: "healthy" | "unhealthy" | "unknown";
  responseTime?: number;
  error?: string;
  lastChecked: string;
}

/**
 * GET /api/health - Basic health check
 * Fast endpoint for load balancer health checks
 */
healthRouter.get("/", async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Quick database check
    await prisma.$queryRaw`SELECT 1`;

    const responseTime = Date.now() - startTime;

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      environment: config.NODE_ENV,
    });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error("Health check failed:", error);

    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      environment: config.NODE_ENV,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/health/detailed - Comprehensive health check
 * Detailed status of all services and dependencies
 */
healthRouter.get(
  "/detailed",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const healthStatus: HealthStatus = {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: "1.0.0",
        environment: config.NODE_ENV,
        services: {
          database: await checkDatabase(),
          strava_api: await checkStravaAPI(),
          weather_api: await checkWeatherAPI(),
        },
        performance: {
          memory: process.memoryUsage(),
          cpu: process.cpuUsage().user / 1000000, // Convert to seconds
        },
      };

      // Determine overall status based on service health
      const serviceStatuses = Object.values(healthStatus.services);
      const unhealthyServices = serviceStatuses.filter(
        (s) => s.status === "unhealthy",
      );
      const unknownServices = serviceStatuses.filter(
        (s) => s.status === "unknown",
      );

      if (unhealthyServices.length > 0) {
        healthStatus.status = "unhealthy";
      } else if (unknownServices.length > 0) {
        healthStatus.status = "degraded";
      }

      const statusCode =
        healthStatus.status === "healthy"
          ? 200
          : healthStatus.status === "degraded"
            ? 200
            : 503;

      res.status(statusCode).json(healthStatus);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1 as status`;

    return {
      status: "healthy",
      responseTime: Date.now() - startTime,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "unhealthy",
      responseTime: Date.now() - startTime,
      error:
        error instanceof Error ? error.message : "Database connection failed",
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Check Strava API accessibility
 */
async function checkStravaAPI(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    // Simple request to Strava API to check if it's accessible
    const response = await fetch(`${config.api.strava.baseUrl}/athlete`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    // We expect 401 (unauthorized) which means API is accessible
    const isAccessible = response.status === 401 || response.status === 200;

    return {
      status: isAccessible ? "healthy" : "unhealthy",
      responseTime: Date.now() - startTime,
      lastChecked: new Date().toISOString(),
      error: !isAccessible ? `Unexpected status: ${response.status}` : "",
    };
  } catch (error) {
    return {
      status: "unhealthy",
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Strava API unreachable",
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Check Weather API accessibility
 */
async function checkWeatherAPI(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    // Test request to One Call API with test coordinates
    const testUrl = `${config.api.openWeatherMap.oneCallUrl}?lat=0&lon=0&appid=${config.OPENWEATHERMAP_API_KEY}&exclude=minutely,hourly,daily,alerts`;
    const response = await fetch(testUrl);

    // One Call API returns 400 for invalid coordinates (0,0) which is acceptable
    // 200 would mean valid coordinates
    // 401 would mean invalid API key
    const isAccessible = response.status === 200 || response.status === 400;

    return {
      status: isAccessible ? "healthy" : "unhealthy",
      responseTime: Date.now() - startTime,
      lastChecked: new Date().toISOString(),
      error: !isAccessible ? `Unexpected status: ${response.status}` : "",
    };
  } catch (error) {
    return {
      status: "unhealthy",
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Weather API unreachable",
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * GET /api/health/ready - Readiness probe
 * For Kubernetes-style readiness checks
 */
healthRouter.get("/ready", async (req: Request, res: Response) => {
  try {
    // Check critical dependencies only
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: "ready",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "not_ready",
      timestamp: new Date().toISOString(),
      error:
        error instanceof Error ? error.message : "Critical dependency failure",
    });
  }
});

/**
 * GET /api/health/live - Liveness probe
 * For Kubernetes-style liveness checks
 */
healthRouter.get("/live", (req: Request, res: Response) => {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * GET /api/health/migrations - Check database migration status
 */
healthRouter.get(
  "/migrations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const migrationStatus = await checkMigrationStatus();

      res.status(migrationStatus.isHealthy ? 200 : 503).json({
        status: migrationStatus.isHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        migrations: migrationStatus,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Check if database migrations have been applied
 */
async function checkMigrationStatus(): Promise<{
  isHealthy: boolean;
  hasTables: boolean;
  tableCount: number;
  error?: string;
}> {
  try {
    // Check if essential tables exist
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            AND table_name IN ('users', 'user_preferences', '_prisma_migrations')
        `;

    const tableNames = tables.map((t) => t.table_name);
    const hasUserTable = tableNames.includes("users");
    const hasPreferencesTable = tableNames.includes("user_preferences");
    const hasMigrationsTable = tableNames.includes("_prisma_migrations");

    // Check migration status
    if (hasMigrationsTable) {
      const pendingMigrations = await prisma.$queryRaw<
        Array<{ count: number }>
      >`
                SELECT COUNT(*) as count 
                FROM _prisma_migrations 
                WHERE finished_at IS NULL
            `;

      const pendingCount = Number(pendingMigrations[0]?.count || 0);

      return {
        isHealthy: hasUserTable && hasPreferencesTable && pendingCount === 0,
        hasTables: hasUserTable && hasPreferencesTable,
        tableCount: tableNames.length,
        error:
          pendingCount > 0 ? `${pendingCount} pending migrations` : undefined,
      };
    }

    return {
      isHealthy: false,
      hasTables: false,
      tableCount: 0,
      error: "No migrations table found - database not initialized",
    };
  } catch (error) {
    return {
      isHealthy: false,
      hasTables: false,
      tableCount: 0,
      error:
        error instanceof Error
          ? error.message
          : "Failed to check migration status",
    };
  }
}

export { healthRouter };
