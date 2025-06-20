import { beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Mock environment variables for testing
beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = "test";

  // Mock sensitive environment variables
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
  vi.stubEnv(
    "JWT_SECRET",
    "test-jwt-secret-that-is-at-least-32-characters-long",
  );
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-that-is-at-least-32-chars");
  vi.stubEnv("STRAVA_CLIENT_ID", "test-client-id");
  vi.stubEnv("STRAVA_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("STRAVA_WEBHOOK_VERIFY_TOKEN", "test-webhook-token");
  vi.stubEnv("OPENWEATHERMAP_API_KEY", "test-weather-api-key");
  vi.stubEnv("APP_URL", "http://localhost:3000");
});

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Cleanup after all tests
afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

// Helper to create mock implementations
export const createMockImplementation = <T extends (...args: any[]) => any>(
  fn: T,
  implementation?: (...args: Parameters<T>) => ReturnType<T>,
) => {
  return vi.fn(implementation);
};

// Test data factories
export const factories = {
  user: (overrides = {}) => ({
    id: "test-user-id",
    stravaAthleteId: "12345",
    accessToken: "encrypted-token",
    refreshToken: "encrypted-refresh",
    tokenExpiresAt: new Date(Date.now() + 3600000),
    weatherEnabled: true,
    firstName: "Test",
    lastName: "User",
    profileImageUrl: "https://example.com/profile.jpg",
    city: "Test City",
    state: "Test State",
    country: "Test Country",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  }),

  activity: (overrides = {}) => ({
    id: 123456,
    name: "Test Activity",
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 50,
    type: "Run",
    start_date: "2024-01-15T07:30:00Z",
    start_date_local: "2024-01-15T08:30:00+01:00",
    timezone: "Europe/Berlin",
    start_latlng: [52.52, 13.405],
    end_latlng: [52.525, 13.41],
    achievement_count: 0,
    kudos_count: 0,
    comment_count: 0,
    athlete_count: 1,
    photo_count: 0,
    private: false,
    visibility: "everyone",
    description: null,
    ...overrides,
  }),

  weatherData: (overrides = {}) => ({
    temperature: 15,
    temperatureFeel: 13,
    humidity: 65,
    pressure: 1013,
    windSpeed: 3.5,
    windDirection: 180,
    cloudCover: 40,
    visibility: 10,
    condition: "Clear",
    description: "clear sky",
    icon: "01d",
    uvIndex: 3,
    timestamp: new Date().toISOString(),
    ...overrides,
  }),
};

// Assertion helpers
export const assertDateWithinRange = (
  actual: Date | string,
  expected: Date | string,
  marginMs = 1000,
) => {
  const actualMs = new Date(actual).getTime();
  const expectedMs = new Date(expected).getTime();
  const diff = Math.abs(actualMs - expectedMs);

  if (diff > marginMs) {
    throw new Error(
      `Date ${actual} is not within ${marginMs}ms of ${expected} (diff: ${diff}ms)`,
    );
  }
};

// Mock timers helper
export const useFakeTimers = () => {
  let clock: ReturnType<typeof vi.useFakeTimers>;

  beforeEach(() => {
    clock = vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  return () => clock;
};
