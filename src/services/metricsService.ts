import { database as db } from "../lib";
import { createServiceLogger } from "../utils/logger";
import { sql } from "kysely";

const logger = createServiceLogger("MetricsService");

export type MetricType = "webhook_processing" | "api_call" | "token_refresh";

interface MetricData {
  metric_type: MetricType;
  metric_name: string;
  value: number;
  metadata?: Record<string, any>;
}

/**
 * Simple metrics service for tracking API performance
 * Provides just enough observability for portfolio metrics
 */
export class MetricsService {
  /**
   * Record a metric value
   */
  async record(data: MetricData): Promise<void> {
    try {
      await db
        .insertInto("metrics")
        .values({
          metric_type: data.metric_type,
          metric_name: data.metric_name,
          value: data.value,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          created_at: new Date(),
        })
        .execute();
    } catch (error) {
      // Don't let metrics failures break the app
      logger.error("Failed to record metric", { error, data });
    }
  }

  /**
   * Record webhook processing performance
   */
  async recordWebhookProcessing(
    activityId: string,
    durationMs: number,
    success: boolean,
    retryCount: number = 0,
  ): Promise<void> {
    await this.record({
      metric_type: "webhook_processing",
      metric_name: "strava_webhook",
      value: durationMs,
      metadata: {
        activity_id: activityId,
        success,
        retry_count: retryCount,
      },
    });
  }

  /**
   * Record API call performance
   */
  async recordApiCall(
    apiName: string,
    endpoint: string,
    durationMs: number,
    statusCode?: number,
    error?: string,
  ): Promise<void> {
    await this.record({
      metric_type: "api_call",
      metric_name: apiName,
      value: durationMs,
      metadata: {
        endpoint,
        status_code: statusCode,
        success: statusCode ? statusCode < 400 : false,
        error,
      },
    });
  }

  /**
   * Record token refresh attempt
   */
  async recordTokenRefresh(
    userId: number,
    success: boolean,
    durationMs: number,
  ): Promise<void> {
    await this.record({
      metric_type: "token_refresh",
      metric_name: "oauth_token",
      value: durationMs,
      metadata: {
        user_id: userId,
        success,
      },
    });
  }

  /**
   * Get performance statistics for portfolio
   */
  async getStats(since?: Date): Promise<{
    webhook_processing: {
      count: number;
      success_rate: number;
      avg_duration_ms: number;
      p95_duration_ms: number;
      avg_retry_count: number;
    };
    api_performance: {
      strava: { avg_duration_ms: number; success_rate: number };
      weather: { avg_duration_ms: number; success_rate: number };
    };
    token_refresh: {
      success_rate: number;
      avg_duration_ms: number;
    };
  }> {
    const sinceDate = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

    // Get webhook stats
    const webhookStats = await db
      .selectFrom("metrics")
      .select([
        db.fn.count<number>("id").as("count"),
        db.fn.avg<number>("value").as("avg_duration"),
        db.fn
          .sum<number>(
            sql`CASE WHEN (metadata->>'success')::boolean = true THEN 1 ELSE 0 END`,
          )
          .as("success_count"),
        db.fn
          .avg<number>(sql`(metadata->>'retry_count')::numeric`)
          .as("avg_retry"),
      ])
      .where("metric_type", "=", "webhook_processing")
      .where("created_at", ">=", sinceDate)
      .executeTakeFirst();

    // Get P95 for webhooks
    const webhookP95 = await db
      .selectFrom("metrics")
      .select("value")
      .where("metric_type", "=", "webhook_processing")
      .where("created_at", ">=", sinceDate)
      .orderBy("value", "desc")
      .limit(1)
      .offset(Math.floor((webhookStats?.count || 0) * 0.05))
      .executeTakeFirst();

    // Get API stats
    const apiStats = await db
      .selectFrom("metrics")
      .select([
        "metric_name",
        db.fn.avg<number>("value").as("avg_duration"),
        db.fn
          .sum<number>(
            sql`CASE WHEN (metadata->>'success')::boolean = true THEN 1 ELSE 0 END`,
          )
          .as("success_count"),
        db.fn.count<number>("id").as("total_count"),
      ])
      .where("metric_type", "=", "api_call")
      .where("created_at", ">=", sinceDate)
      .groupBy("metric_name")
      .execute();

    // Get token refresh stats
    const tokenStats = await db
      .selectFrom("metrics")
      .select([
        db.fn.avg<number>("value").as("avg_duration"),
        db.fn
          .sum<number>(
            sql`CASE WHEN (metadata->>'success')::boolean = true THEN 1 ELSE 0 END`,
          )
          .as("success_count"),
        db.fn.count<number>("id").as("total_count"),
      ])
      .where("metric_type", "=", "token_refresh")
      .where("created_at", ">=", sinceDate)
      .executeTakeFirst();

    // Format the results
    const stravaApi = apiStats.find((s: any) => s.metric_name === "strava_api");
    const weatherApi = apiStats.find(
      (s: any) => s.metric_name === "weather_api",
    );

    return {
      webhook_processing: {
        count: Number(webhookStats?.count || 0),
        success_rate:
          Number(webhookStats?.count || 0) > 0
            ? Number(webhookStats?.success_count || 0) /
              Number(webhookStats?.count || 0)
            : 0,
        avg_duration_ms: Number(webhookStats?.avg_duration || 0),
        p95_duration_ms: Number(webhookP95?.value || 0),
        avg_retry_count: Number(webhookStats?.avg_retry || 0),
      },
      api_performance: {
        strava: {
          avg_duration_ms: Number(stravaApi?.avg_duration || 0),
          success_rate:
            Number(stravaApi?.total_count || 0) > 0
              ? Number(stravaApi?.success_count || 0) /
                Number(stravaApi?.total_count || 0)
              : 0,
        },
        weather: {
          avg_duration_ms: Number(weatherApi?.avg_duration || 0),
          success_rate:
            Number(weatherApi?.total_count || 0) > 0
              ? Number(weatherApi?.success_count || 0) /
                Number(weatherApi?.total_count || 0)
              : 0,
        },
      },
      token_refresh: {
        success_rate:
          Number(tokenStats?.total_count || 0) > 0
            ? Number(tokenStats?.success_count || 0) /
              Number(tokenStats?.total_count || 0)
            : 0,
        avg_duration_ms: Number(tokenStats?.avg_duration || 0),
      },
    };
  }
}

export const metricsService = new MetricsService();
