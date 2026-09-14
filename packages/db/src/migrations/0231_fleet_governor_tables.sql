CREATE TABLE "fleet_calibration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window" text NOT NULL,
	"w_usd" real NOT NULL,
	"ci_low" real,
	"ci_high" real,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'least_squares' NOT NULL,
	"fitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_limit_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window" text NOT NULL,
	"used_pct" real,
	"resets_at" timestamp with time zone,
	"source" text NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"raw" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "fleet_throttle_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"pace" real,
	"five_hour_pct" real,
	"seven_day_pct" real,
	"floor_active" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"params_version" text NOT NULL,
	"inputs" jsonb,
	"launch_parameters" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fleet_calibration_window_fitted_idx" ON "fleet_calibration" USING btree ("window","fitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fleet_limit_snapshots_window_observed_idx" ON "fleet_limit_snapshots" USING btree ("window","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fleet_throttle_states_ts_idx" ON "fleet_throttle_states" USING btree ("ts" DESC NULLS LAST);