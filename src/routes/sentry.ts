import { Router, Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { asyncHandler } from "../middleware/errorHandler";

const sentryRouter = Router();

/**
 * Collect raw body from request stream
 */
async function getRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

/**
 * Sentry tunnel endpoint
 * Proxies Sentry events through your own domain to bypass IP blocks
 */
sentryRouter.post(
  "/tunnel",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Collect raw body
      const envelope = await getRawBody(req);

      if (envelope.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }

      // Parse the envelope header
      const envelopeText = envelope.toString();
      const lines = envelopeText.split("\n");

      if (lines.length === 0) {
        res.status(400).json({ error: "Invalid envelope format" });
        return;
      }

      if (!lines[0]) {
        res.status(400).json({ error: "No Lines" });
        return;
      }

      // Parse header to get DSN
      let header;
      try {
        header = JSON.parse(lines[0]);
      } catch (e) {
        logger.error("Failed to parse envelope header", {
          error: e,
          headerLine: lines[0]?.substring(0, 100),
        });
        res.status(400).json({ error: "Invalid envelope header" });
        return;
      }

      if (!header.dsn) {
        res.status(400).json({ error: "No DSN in envelope" });
        return;
      }

      // Extract project info from DSN
      const dsnUrl = new URL(header.dsn);
      const projectId = dsnUrl.pathname.slice(1); // Remove leading slash

      // Build Sentry URL
      const sentryUrl = `https://${dsnUrl.host}/api/${projectId}/envelope/`;

      logger.debug("Forwarding to Sentry", {
        sentryUrl,
        envelopeSize: envelope.length,
        clientIp: req.ip,
      });

      // Forward to Sentry
      const sentryResponse = await fetch(sentryUrl, {
        method: "POST",
        body: envelope,
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          ...(req.ip && { "X-Forwarded-For": req.ip }),
        },
      });

      // Get response text (may be empty)
      const responseText = await sentryResponse.text();

      // Log the result
      logger.info("Sentry tunnel processed", {
        status: sentryResponse.status,
        hasResponse: !!responseText,
        clientIp: req.ip || "unknown",
      });

      // Return Sentry's response
      res.status(sentryResponse.status);
      if (responseText) {
        res.send(responseText);
      } else {
        res.end();
      }
    } catch (error) {
      logger.error("Sentry tunnel error", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

export { sentryRouter };
