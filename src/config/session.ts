import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { config } from "./environment";

const PgSession = connectPgSimple(session);

const pgPool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 2, // Small pool just for sessions
  idleTimeoutMillis: 30000,
});

export const sessionConfig: session.SessionOptions = {
  store: new PgSession({
    pool: pgPool,
    tableName: "session",
    createTableIfMissing: true,
    ttl: 30 * 24 * 60 * 60, // 30 days in seconds
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset expiry on activity
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
    httpOnly: true,
    secure: config.isProduction, // HTTPS only in production
    sameSite: "lax",
  },
  name: "rain-or-shine-session",
};

declare module "express-session" {
  interface SessionData {
    userId?: string;
    stravaAthleteId?: string;
    oauthState?: string;
  }
}
