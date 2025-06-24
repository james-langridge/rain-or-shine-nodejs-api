import { z } from "zod";
import type { UserTable, UserPreferenceTable } from "../lib/database";

// Zod schemas for runtime validation
export const UserInsertSchema = z.object({
  stravaAthleteId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenExpiresAt: z.date(),
  weatherEnabled: z.boolean().default(true),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
});

export const UserUpdateSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  tokenExpiresAt: z.date().optional(),
  weatherEnabled: z.boolean().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  profileImageUrl: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export const UserPreferenceInsertSchema = z.object({
  userId: z.string().uuid(),
  temperatureUnit: z.enum(["fahrenheit", "celsius"]).default("fahrenheit"),
  weatherFormat: z.enum(["detailed", "simple"]).default("detailed"),
  includeUvIndex: z.boolean().default(false),
  includeVisibility: z.boolean().default(false),
  customFormat: z.string().nullable(),
});

export const UserPreferenceUpdateSchema = z.object({
  temperatureUnit: z.enum(["fahrenheit", "celsius"]).optional(),
  weatherFormat: z.enum(["detailed", "simple"]).optional(),
  includeUvIndex: z.boolean().optional(),
  includeVisibility: z.boolean().optional(),
  customFormat: z.string().nullable().optional(),
});

// Export types derived from database interfaces
export type User = UserTable;
export type UserPreference = UserPreferenceTable;

// Export insert/update types
export type UserInsert = z.infer<typeof UserInsertSchema>;
export type UserUpdate = z.infer<typeof UserUpdateSchema>;
export type UserPreferenceInsert = z.infer<typeof UserPreferenceInsertSchema>;
export type UserPreferenceUpdate = z.infer<typeof UserPreferenceUpdateSchema>;

// User with preferences joined
export type UserWithPreferences = User & {
  preferences: UserPreference | null;
};

// Simple error classes (much simpler than before)
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class NotFoundError extends DatabaseError {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

export class UniqueConstraintError extends DatabaseError {
  constructor(constraint?: string) {
    super(`Unique constraint violation${constraint ? `: ${constraint}` : ""}`);
    this.name = "UniqueConstraintError";
  }
}

// Simple error parser
export const parseDatabaseError = (error: unknown): DatabaseError => {
  if (error instanceof DatabaseError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const pgError = error as {
      code?: string;
      constraint?: string;
      message?: string;
    };

    switch (pgError.code) {
      case "23505": // unique_violation
        return new UniqueConstraintError(pgError.constraint);
      default:
        return new DatabaseError(
          pgError.message || "Database operation failed",
          pgError.code,
        );
    }
  }

  return new DatabaseError(
    error instanceof Error ? error.message : String(error),
  );
};
