import { Router } from "express";
import { metricsService } from "../services/metricsService";
import { createServiceLogger } from "../utils/logger";

const router = Router();
const logger = createServiceLogger("metrics");

/**
 * GET /api/metrics
 *
 * Get performance metrics - API performance including webhook processing and response times.
 */
router.get("/", async (req, res) => {
  try {
    const since = req.query.since
      ? new Date(req.query.since as string)
      : undefined;

    const stats = await metricsService.getStats(since);

    res.json({
      period: since ? `Since ${since.toISOString()}` : "Last 7 days",
      webhook_processing: {
        total_processed: stats.webhook_processing.count,
        success_rate: `${(stats.webhook_processing.success_rate * 100).toFixed(1)}%`,
        avg_duration: `${stats.webhook_processing.avg_duration_ms.toFixed(0)}ms`,
        p95_duration: `${stats.webhook_processing.p95_duration_ms.toFixed(0)}ms`,
        avg_retries: stats.webhook_processing.avg_retry_count.toFixed(1),
      },
      api_performance: {
        strava: {
          avg_response_time: `${stats.api_performance.strava.avg_duration_ms.toFixed(0)}ms`,
          success_rate: `${(stats.api_performance.strava.success_rate * 100).toFixed(1)}%`,
        },
        weather: {
          avg_response_time: `${stats.api_performance.weather.avg_duration_ms.toFixed(0)}ms`,
          success_rate: `${(stats.api_performance.weather.success_rate * 100).toFixed(1)}%`,
        },
      },
      token_refresh: {
        success_rate: `${(stats.token_refresh.success_rate * 100).toFixed(1)}%`,
        avg_duration: `${stats.token_refresh.avg_duration_ms.toFixed(0)}ms`,
      },
    });
  } catch (error) {
    logger.error("Failed to fetch metrics", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

export default router;
