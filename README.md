# Rain or Shine

A Node.js Express API that integrates Strava activities with weather data. The application provides OAuth-based authentication with Strava and automatically enriches activities with weather information based on time and location coordinates.

## Technical Architecture

### Technology Stack

- **Runtime**: Node.js 22+ with TypeScript (strict mode)
- **Framework**: Express.js with session-based authentication
- **Database**: PostgreSQL with Kysely SQL query builder
- **Authentication**: Passport.js with custom Strava OAuth strategy
- **Weather API**: OpenWeatherMap One Call API 3.0
- **Testing**: Vitest with V8 coverage provider
- **Migration**: node-pg-migrate for database versioning
- **Validation**: Zod schemas for runtime type checking
- **Logging**: Winston with structured logging

### Core Services

#### ActivityProcessor
Primary business logic service responsible for:
- Automatic Strava token refresh with 5-minute expiration buffer
- Activity data retrieval and validation
- Weather data integration and formatting
- Duplicate processing prevention
- GPS coordinate validation for weather lookups

#### StravaApiService
Strava API interaction layer providing:
- OAuth token management and refresh
- Activity retrieval and updates
- Rate limit handling and error categorization
- Account revocation and cleanup

#### WeatherService
Weather data provider with:
- Automatic selection between current and historical weather data
- 5-day historical data support via Time Machine API
- Comprehensive error handling with timeouts and retries

#### MetricsService
System performance monitoring and observability:
- Webhook processing performance tracking
- API response time and success rate monitoring
- OAuth token refresh metrics
- System health and operational insights

### Database Schema

**PostgreSQL with automated migrations and health checks**

#### Users Table
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strava_athlete_id VARCHAR NOT NULL UNIQUE,
    access_token VARCHAR NOT NULL,
    refresh_token VARCHAR NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    weather_enabled BOOLEAN DEFAULT true,
    first_name VARCHAR,
    last_name VARCHAR,
    profile_image_url VARCHAR,
    city VARCHAR,
    state VARCHAR,
    country VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### User Preferences Table
```sql
CREATE TABLE user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    temperature_unit VARCHAR(10) DEFAULT 'fahrenheit' CHECK (temperature_unit IN ('fahrenheit', 'celsius')),
    weather_format VARCHAR(10) DEFAULT 'detailed' CHECK (weather_format IN ('detailed', 'simple')),
    include_uv_index BOOLEAN DEFAULT false,
    include_visibility BOOLEAN DEFAULT false,
    custom_format VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Features:**
- Automatic `updated_at` triggers
- Connection pooling with configurable limits
- Graceful shutdown handling
- Health check integration

## API Endpoints

### Base URL: `/api`

#### Authentication (`/auth`)
- `GET /strava` - Initiate OAuth flow with CSRF protection
- `GET /strava/callback` - Handle OAuth callback and session creation
- `POST /logout` - User logout with session cleanup
- `GET /check` - Authentication status verification
- `DELETE /revoke` - Revoke Strava access and delete user account

#### Strava Integration (`/strava`)
- `GET /webhook` - Webhook verification endpoint
- `POST /webhook` - Process activity webhooks with retry logic
- `GET /webhook/status` - Webhook health monitoring

#### User Management (`/users`)
- User profile and preferences management
- Weather display configuration

#### Activities (`/activities`)
- Activity processing and management

#### Administration (`/admin`)
- Administrative endpoints (protected by admin token)

#### Metrics (`/metrics`)
- System performance metrics and API statistics

#### Health (`/health`)
- Application and database health checks

### Rate Limiting Configuration
- **Health endpoints**: Relaxed limits with request logging
- **Webhook endpoints**: High limits for Strava activity bursts
- **Authentication endpoints**: Strict limits for security
- **Standard API endpoints**: Moderate limits for normal usage

## Environment Configuration

### Required Variables
```bash
# Application Core
APP_URL=https://your-domain.com
DATABASE_URL=postgresql://user:password@host:port/database
SESSION_SECRET=your-32-character-secret-key

# Strava OAuth Integration
STRAVA_CLIENT_ID=your-strava-client-id
STRAVA_CLIENT_SECRET=your-strava-client-secret
STRAVA_WEBHOOK_VERIFY_TOKEN=your-webhook-verify-token

# Weather API
OPENWEATHERMAP_API_KEY=your-openweathermap-api-key
```

### Optional Variables
```bash
NODE_ENV=production
PORT=3001
ADMIN_TOKEN=your-admin-token
LOG_LEVEL=info
```

## Development Setup

### Prerequisites
- Node.js 22+
- PostgreSQL 12+
- OpenWeatherMap API account
- Strava API application

### Installation
```bash
# Clone repository
git clone <repository-url>
cd rain-or-shine

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migrate:dev

# Start development server
npm run dev
```

### Development Commands
```bash
# Development server with auto-reload
npm run dev

# Build application
npm run build

# Run tests
npm run test
npm run test:coverage
npm run test:watch
npm run test:ui

# Code quality
npm run typecheck
npm run lint
npm run lint:fix
npm run format
npm run format:check

# Database operations
npm run migrate:dev      # Development migrations
npm run migrate          # Production migrations
npm run generate         # Generate types
npm run studio          # Database admin UI
npm run seed            # Seed database
```

## Testing Strategy

### Framework: Vitest with Node.js environment

**Coverage Requirements:**
- Branches: 80%
- Functions: 80%
- Lines: 80%
- Statements: 80%

### Test Organization
- Co-located tests in `__tests__` directories
- Shared test utilities and factories
- Comprehensive environment mocking
- Real-time API mocking with nock

### Test Data Factories
```typescript
// Test utilities provide standardized mock data
factories.user()        // Mock user with Strava integration
factories.activity()    // Mock Strava activity data
factories.weatherData() // Mock weather API responses
```

### Running Tests
```bash
# All tests
npm run test

# Specific test file
npm run test src/services/__tests__/activityProcessor.test.ts

# Pattern matching
npm run test -- --grep "weather"

# Coverage report
npm run test:coverage
```

## Deployment

### Docker Production Build

**Multi-stage Dockerfile:**
- Build stage: Full Node.js environment with TypeScript compilation
- Production stage: Minimal Alpine Linux with compiled JavaScript
- Security: Non-root user execution
- Process management: dumb-init for proper signal handling

```bash
# Build production image
docker build -t rain-or-shine-api .

# Run with environment variables
docker run -d \
  --name rain-or-shine-api \
  -p 3001:3001 \
  --env-file .env \
  rain-or-shine-api
```

### Production Features
- Automatic database migration on startup
- Graceful shutdown with cleanup
- Health check endpoint monitoring
- Structured logging with configurable levels

## Architecture Patterns

### Repository Pattern
Data access layer with type-safe query building:
- `UserRepository` - User data operations
- `UserPreferenceRepository` - Settings management
- Kysely integration for complex SQL queries

### Service Layer
Business logic encapsulation:
- Single responsibility principle
- Dependency injection ready
- Comprehensive error handling
- Structured logging integration

### Configuration Management
Runtime validation with Zod schemas:
- Type-safe environment variables
- Computed configuration values
- Environment-specific feature flags

## Security Features

- **CSRF Protection**: OAuth state parameter validation
- **Session Management**: PostgreSQL-backed sessions with encryption
- **Token Security**: Encrypted credential storage
- **Rate Limiting**: Configurable DDoS protection
- **Input Validation**: Zod schema validation on all inputs
- **Admin Protection**: Token-based administrative access

## Performance Optimizations

- **Database Connection Pooling**: Configurable connection limits
- **Query Optimization**: Raw SQL for complex operations

## Error Handling and Reliability

- **Comprehensive Error Categorization**: HTTP status-based error handling
- **Retry Logic**: Progressive backoff for webhook processing
- **Circuit Breaker Pattern**: External API failure handling
- **Health Monitoring**: Database and service health checks
- **Graceful Degradation**: Fallback strategies for external dependencies

## Monitoring and Observability

- **Structured Logging**: Winston with JSON format
- **Health Endpoints**: Application and dependency monitoring
- **Error Tracking**: Categorized error logging
- **Performance Metrics**: API response times, webhook processing, and system health statistics
