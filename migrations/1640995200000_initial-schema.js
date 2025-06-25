/* eslint-disable camelcase */

exports.up = (pgm) => {
  // Create users table if it doesn't exist
  pgm.createTable(
    "users",
    {
      id: {
        type: "text",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()"),
      },
      stravaAthleteId: {
        type: "text",
        notNull: true,
        unique: true,
      },
      accessToken: {
        type: "text",
        notNull: true,
      },
      refreshToken: {
        type: "text",
        notNull: true,
      },
      tokenExpiresAt: {
        type: "timestamp with time zone",
        notNull: true,
      },
      weatherEnabled: {
        type: "boolean",
        notNull: true,
        default: true,
      },
      firstName: {
        type: "text",
      },
      lastName: {
        type: "text",
      },
      profileImageUrl: {
        type: "text",
      },
      city: {
        type: "text",
      },
      state: {
        type: "text",
      },
      country: {
        type: "text",
      },
      createdAt: {
        type: "timestamp with time zone",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
      updatedAt: {
        type: "timestamp with time zone",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
    },
    { ifNotExists: true },
  );

  // Create user_preferences table if it doesn't exist
  pgm.createTable(
    "user_preferences",
    {
      id: {
        type: "text",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()"),
      },
      userId: {
        type: "text",
        notNull: true,
        unique: true,
        references: "users(id)",
        onDelete: "CASCADE",
      },
      temperatureUnit: {
        type: "text",
        notNull: true,
        default: "fahrenheit",
      },
      weatherFormat: {
        type: "text",
        notNull: true,
        default: "detailed",
      },
      includeUvIndex: {
        type: "boolean",
        notNull: true,
        default: false,
      },
      includeVisibility: {
        type: "boolean",
        notNull: true,
        default: false,
      },
      customFormat: {
        type: "text",
      },
      createdAt: {
        type: "timestamp with time zone",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
      updatedAt: {
        type: "timestamp with time zone",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
    },
    { ifNotExists: true },
  );

  // Create function to automatically update updatedAt timestamp
  pgm.createFunction(
    "update_updated_at_column",
    [],
    {
      returns: "trigger",
      language: "plpgsql",
      replace: true,
    },
    `
    BEGIN
        NEW."updatedAt" = current_timestamp;
        RETURN NEW;
    END;
    `,
  );

  // Create triggers to automatically update updatedAt
  pgm.createTrigger("users", "update_users_updated_at", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "update_updated_at_column",
    level: "ROW",
  });

  pgm.createTrigger("user_preferences", "update_user_preferences_updated_at", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "update_updated_at_column",
    level: "ROW",
  });
};

exports.down = (pgm) => {
  // Drop triggers
  pgm.dropTrigger("user_preferences", "update_user_preferences_updated_at");
  pgm.dropTrigger("users", "update_users_updated_at");

  // Drop function
  pgm.dropFunction("update_updated_at_column", []);

  // Drop tables (foreign key constraints will be handled automatically)
  pgm.dropTable("user_preferences");
  pgm.dropTable("users");
};
