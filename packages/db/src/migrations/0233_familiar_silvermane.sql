DROP INDEX "fleet_limit_snapshots_window_observed_idx";--> statement-breakpoint
ALTER TABLE "fleet_limit_snapshots" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_limit_snapshots" ADD COLUMN "model_scope" text;--> statement-breakpoint
ALTER TABLE "fleet_throttle_states" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_calibration" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
CREATE INDEX "fleet_limit_snapshots_provider_window_observed_idx" ON "fleet_limit_snapshots" USING btree ("provider","window","observed_at" DESC NULLS LAST);