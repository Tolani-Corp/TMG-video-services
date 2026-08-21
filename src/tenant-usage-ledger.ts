import { DurableObject } from "cloudflare:workers";
import type { TenantQuota, UsageSnapshot } from "./entitlements";
import { evaluateQuotaReservation, utcUsageWindowStarts } from "./tenant-usage-ledger-core";
import { createUsageEvent, type UsageEventInput } from "./usage-meter";

export interface TenantUsageReservation extends UsageEventInput {
  quota: TenantQuota;
}

export interface TenantUsageLedgerDecision {
  allowed: boolean;
  recorded: boolean;
  duplicate: boolean;
  reasons: string[];
  usage: UsageSnapshot;
}

interface StoredUsageRow {
  event_id: string;
  occurred_at_ms: number;
  tenant_id: string;
  purpose: string;
  provider_id: string;
  provider_authority: string;
  request_units: number;
  media_duration_ms: number;
  vector_count: number;
  billing_disposition: string;
}

interface AggregateUsageRow {
  requests_this_hour: number;
  media_duration_ms_today: number;
  vectors_today: number;
}

export class TenantUsageLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ledger_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
          event_id TEXT PRIMARY KEY,
          occurred_at_ms INTEGER NOT NULL,
          tenant_id TEXT NOT NULL,
          purpose TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          provider_authority TEXT NOT NULL,
          request_units INTEGER NOT NULL,
          media_duration_ms INTEGER NOT NULL,
          vector_count INTEGER NOT NULL,
          billing_disposition TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx ON usage_events(occurred_at_ms)",
      );
    });
  }

  async reserveUsage(input: TenantUsageReservation): Promise<TenantUsageLedgerDecision> {
    const event = createUsageEvent(input);
    const occurredAtMs = Date.parse(event.occurredAt);
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
      throw new RangeError("occurredAt must resolve to a non-negative safe integer timestamp.");
    }

    const tenantBinding = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM ledger_metadata WHERE key = 'tenant_id'")
      .toArray()[0];
    if (!tenantBinding) {
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger_metadata (key, value) VALUES ('tenant_id', ?)",
        event.tenantId,
      );
    } else if (tenantBinding.value !== event.tenantId) {
      return {
        allowed: false,
        recorded: false,
        duplicate: false,
        reasons: ["tenant_binding_mismatch"],
        usage: this.readUsageSnapshot(occurredAtMs),
      };
    }

    const existing = this.ctx.storage.sql
      .exec<StoredUsageRow>("SELECT * FROM usage_events WHERE event_id = ?", event.eventId)
      .toArray()[0];
    if (existing) {
      const sameEvent =
        existing.occurred_at_ms === occurredAtMs &&
        existing.tenant_id === event.tenantId &&
        existing.purpose === event.purpose &&
        existing.provider_id === event.providerId &&
        existing.provider_authority === event.providerAuthority &&
        existing.request_units === event.usage.requestUnits &&
        existing.media_duration_ms === event.usage.mediaDurationMs &&
        existing.vector_count === event.usage.vectorCount &&
        existing.billing_disposition === event.billingDisposition;

      return {
        allowed: sameEvent,
        recorded: false,
        duplicate: true,
        reasons: sameEvent ? [] : ["idempotency_conflict"],
        usage: this.readUsageSnapshot(occurredAtMs),
      };
    }

    const usage = this.readUsageSnapshot(occurredAtMs);
    const quotaDecision = evaluateQuotaReservation(input.quota, usage, {
      requestUnits: event.usage.requestUnits,
      mediaDurationMs: event.usage.mediaDurationMs,
      vectorCount: event.usage.vectorCount,
    });
    if (!quotaDecision.allowed) {
      return {
        allowed: false,
        recorded: false,
        duplicate: false,
        reasons: quotaDecision.reasons,
        usage,
      };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO usage_events (
        event_id,
        occurred_at_ms,
        tenant_id,
        purpose,
        provider_id,
        provider_authority,
        request_units,
        media_duration_ms,
        vector_count,
        billing_disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      occurredAtMs,
      event.tenantId,
      event.purpose,
      event.providerId,
      event.providerAuthority,
      event.usage.requestUnits,
      event.usage.mediaDurationMs,
      event.usage.vectorCount,
      event.billingDisposition,
    );

    return {
      allowed: true,
      recorded: true,
      duplicate: false,
      reasons: [],
      usage: quotaDecision.projected,
    };
  }

  async getUsageSnapshot(atIso: string): Promise<UsageSnapshot> {
    const atMs = Date.parse(atIso);
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new RangeError("atIso must be a valid non-negative timestamp.");
    }
    return this.readUsageSnapshot(atMs);
  }

  private readUsageSnapshot(atMs: number): UsageSnapshot {
    const { hourStartMs, dayStartMs } = utcUsageWindowStarts(atMs);
    const row = this.ctx.storage.sql
      .exec<AggregateUsageRow>(
        `SELECT
          COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN request_units ELSE 0 END), 0) AS requests_this_hour,
          COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN media_duration_ms ELSE 0 END), 0) AS media_duration_ms_today,
          COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN vector_count ELSE 0 END), 0) AS vectors_today
        FROM usage_events
        WHERE occurred_at_ms <= ?`,
        hourStartMs,
        dayStartMs,
        dayStartMs,
        atMs,
      )
      .one();

    return {
      requestsThisHour: Number(row.requests_this_hour),
      mediaDurationMsToday: Number(row.media_duration_ms_today),
      vectorsToday: Number(row.vectors_today),
    };
  }
}
