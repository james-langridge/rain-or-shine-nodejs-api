-- Create metrics table for performance tracking
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  metric_type VARCHAR(50) NOT NULL, -- 'webhook_processing', 'api_call', 'token_refresh'
  metric_name VARCHAR(100) NOT NULL, -- 'strava_api', 'weather_api', etc.
  value NUMERIC NOT NULL, -- duration in ms, or 1/0 for success/failure
  metadata JSONB, -- additional context like status_code, error_type, retry_count
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient querying by type and time
CREATE INDEX idx_metrics_type_created_at ON metrics(metric_type, created_at DESC);
CREATE INDEX idx_metrics_name_created_at ON metrics(metric_name, created_at DESC);

-- Index for JSONB queries
CREATE INDEX idx_metrics_metadata ON metrics USING GIN(metadata);