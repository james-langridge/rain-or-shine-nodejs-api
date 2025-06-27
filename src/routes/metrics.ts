import { Router } from "express";
import { metricsService } from "../services/metricsService";
import { createServiceLogger } from "../utils/logger";

const router = Router();
const logger = createServiceLogger("metrics");

/**
 * @swagger
 * /api/metrics:
 *   get:
 *     summary: Get performance metrics
 *     description: Get performance metrics for the API including webhook processing, API response times, and token refresh statistics
 *     tags:
 *       - Metrics
 *     parameters:
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for metrics period (defaults to last 7 days)
 *     responses:
 *       200:
 *         description: Performance metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period:
 *                   type: string
 *                 webhook_processing:
 *                   type: object
 *                   properties:
 *                     total_processed:
 *                       type: number
 *                     success_rate:
 *                       type: string
 *                     avg_duration:
 *                       type: string
 *                     p95_duration:
 *                       type: string
 *                     avg_retries:
 *                       type: string
 *                 api_performance:
 *                   type: object
 *                   properties:
 *                     strava:
 *                       type: object
 *                     weather:
 *                       type: object
 *                 token_refresh:
 *                   type: object
 *                   properties:
 *                     success_rate:
 *                       type: string
 *                     avg_duration:
 *                       type: string
 *       500:
 *         description: Failed to fetch metrics
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
