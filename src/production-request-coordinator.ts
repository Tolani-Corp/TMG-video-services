import { DurableObject } from "cloudflare:workers";
import {
  checklistTemplate,
  compileProductionPlan,
  type ChecklistItemKind,
  type ChecklistItemStatus,
  type ProductionChecklistArtifact,
  type ProductionChecklistItem,
  type ProductionDeliverable,
  type ProductionPlan,
  type ProductionRequestSnapshot,
  type ProductionRequestStatus,
} from "./production-request";

interface RequestRow extends Record<string, SqlStorageValue> {
  request_id: string;
  tenant_id: string;
  title: string;
  notes: string | null;
  status: string;
  deliverables_json: string;
  workflow_instance_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

interface ChecklistRow extends Record<string, SqlStorageValue> {
  item_id: string;
  kind: string;
  label: string;
  description: string;
  required_item: number;
  accepts_uploads: number;
  accepts_reference: number;
  allows_multiple: number;
  status: string;
  reference_value: string | null;
  updated_at: string;
}

interface ArtifactRow extends Record<string, SqlStorageValue> {
  artifact_id: string;
  item_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  etag: string | null;
  created_at: string;
}

interface UploadSessionRow extends Record<string, SqlStorageValue> {
  upload_id: string;
  item_id: string;
  object_key: string;
  artifact_id: string;
  file_name: string;
  mime_type: string;
  declared_bytes: number | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface InitializeProductionRequestInput {
  requestId: string;
  tenantId: string;
  title: string;
  notes?: string;
  deliverables: ProductionDeliverable[];
  createdAt: string;
}

export interface RegisterUploadSessionInput {
  itemId: string;
  uploadId: string;
  objectKey: string;
  artifactId: string;
  fileName: string;
  mimeType: string;
  declaredBytes?: number;
  createdAt: string;
}

export interface CompleteUploadInput {
  itemId: string;
  uploadId: string;
  artifactId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  etag?: string;
  completedAt: string;
}

export interface UploadSessionAuthorization {
  allowed: boolean;
  reasons: string[];
  session?: {
    uploadId: string;
    itemId: string;
    objectKey: string;
    artifactId: string;
    fileName: string;
    mimeType: string;
    declaredBytes?: number;
  };
}

export class ProductionRequestCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS production_request (
          request_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          title TEXT NOT NULL,
          notes TEXT,
          status TEXT NOT NULL,
          deliverables_json TEXT NOT NULL,
          workflow_instance_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS checklist_items (
          item_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT NOT NULL,
          required_item INTEGER NOT NULL,
          accepts_uploads INTEGER NOT NULL,
          accepts_reference INTEGER NOT NULL,
          allows_multiple INTEGER NOT NULL,
          status TEXT NOT NULL,
          reference_value TEXT,
          updated_at TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS checklist_artifacts (
          artifact_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          object_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          etag TEXT,
          created_at TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS checklist_artifacts_item_idx ON checklist_artifacts(item_id)",
      );
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS upload_sessions (
          upload_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          object_key TEXT NOT NULL UNIQUE,
          artifact_id TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          declared_bytes INTEGER,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS request_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          item_id TEXT,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    });
  }

  async initialize(input: InitializeProductionRequestInput): Promise<ProductionRequestSnapshot> {
    const existing = this.readRequest();
    if (existing) {
      const same =
        existing.request_id === input.requestId &&
        existing.tenant_id === input.tenantId &&
        existing.title === input.title &&
        existing.notes === (input.notes ?? null) &&
        existing.deliverables_json === JSON.stringify(input.deliverables);
      if (!same) throw new Error("production request idempotency conflict");
      return this.buildSnapshot();
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO production_request (
        request_id, tenant_id, title, notes, status, deliverables_json,
        workflow_instance_id, created_at, updated_at, submitted_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, NULL, ?, ?, NULL)`,
      input.requestId,
      input.tenantId,
      input.title,
      input.notes ?? null,
      JSON.stringify(input.deliverables),
      input.createdAt,
      input.createdAt,
    );

    for (const item of checklistTemplate()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO checklist_items (
          item_id, kind, label, description, required_item, accepts_uploads,
          accepts_reference, allows_multiple, status, reference_value, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        item.kind,
        item.kind,
        item.label,
        item.description,
        item.required ? 1 : 0,
        item.acceptsUploads ? 1 : 0,
        item.acceptsReference ? 1 : 0,
        item.allowsMultiple ? 1 : 0,
        input.createdAt,
      );
    }

    this.recordEvent("request_created", undefined, {
      deliverables: input.deliverables,
      checklistVersion: "tmg.production-checklist.v1",
    }, input.createdAt);
    return this.buildSnapshot();
  }

  async getSnapshot(): Promise<ProductionRequestSnapshot> {
    return this.buildSnapshot();
  }

  async registerUploadSession(input: RegisterUploadSessionInput): Promise<UploadSessionAuthorization> {
    const request = this.requireMutableRequest();
    const item = this.readChecklistItem(input.itemId);
    if (!item) return { allowed: false, reasons: ["checklist_item_not_found"] };
    if (item.accepts_uploads !== 1) return { allowed: false, reasons: ["checklist_item_does_not_accept_uploads"] };

    const existingArtifacts = this.artifactsForItem(input.itemId);
    if (item.allows_multiple !== 1 && existingArtifacts.length > 0) {
      return { allowed: false, reasons: ["checklist_item_allows_single_artifact"] };
    }

    const existing = this.ctx.storage.sql
      .exec<UploadSessionRow>("SELECT * FROM upload_sessions WHERE upload_id = ?", input.uploadId)
      .toArray()[0];
    if (existing) {
      const same =
        existing.item_id === input.itemId &&
        existing.object_key === input.objectKey &&
        existing.artifact_id === input.artifactId &&
        existing.file_name === input.fileName &&
        existing.mime_type === input.mimeType;
      return same
        ? { allowed: true, reasons: [], session: this.mapUploadSession(existing) }
        : { allowed: false, reasons: ["upload_session_idempotency_conflict"] };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO upload_sessions (
        upload_id, item_id, object_key, artifact_id, file_name, mime_type,
        declared_bytes, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      input.uploadId,
      input.itemId,
      input.objectKey,
      input.artifactId,
      input.fileName,
      input.mimeType,
      input.declaredBytes ?? null,
      input.createdAt,
    );
    this.ctx.storage.sql.exec(
      "UPDATE checklist_items SET status = 'uploading', updated_at = ? WHERE item_id = ?",
      input.createdAt,
      input.itemId,
    );
    this.touchRequest(request.request_id, input.createdAt);
    this.recordEvent("upload_started", input.itemId, {
      uploadId: input.uploadId,
      artifactId: input.artifactId,
      objectKey: input.objectKey,
    }, input.createdAt);
    return {
      allowed: true,
      reasons: [],
      session: {
        uploadId: input.uploadId,
        itemId: input.itemId,
        objectKey: input.objectKey,
        artifactId: input.artifactId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        ...(input.declaredBytes ? { declaredBytes: input.declaredBytes } : {}),
      },
    };
  }

  async authorizeUpload(itemId: string, uploadId: string): Promise<UploadSessionAuthorization> {
    this.requireMutableRequest();
    const row = this.ctx.storage.sql
      .exec<UploadSessionRow>("SELECT * FROM upload_sessions WHERE upload_id = ?", uploadId)
      .toArray()[0];
    if (!row) return { allowed: false, reasons: ["upload_session_not_found"] };
    if (row.item_id !== itemId) return { allowed: false, reasons: ["upload_session_item_mismatch"] };
    if (row.status !== "active") return { allowed: false, reasons: ["upload_session_not_active"] };
    return { allowed: true, reasons: [], session: this.mapUploadSession(row) };
  }

  async completeUpload(input: CompleteUploadInput): Promise<ProductionRequestSnapshot> {
    const request = this.requireMutableRequest();
    const authorization = await this.authorizeUpload(input.itemId, input.uploadId);
    if (!authorization.allowed || !authorization.session) {
      throw new Error(authorization.reasons.join(",") || "upload session rejected");
    }
    const session = authorization.session;
    if (
      session.artifactId !== input.artifactId ||
      session.objectKey !== input.objectKey ||
      session.fileName !== input.fileName ||
      session.mimeType !== input.mimeType
    ) {
      throw new Error("completed upload does not match registered upload session");
    }
    if (session.declaredBytes !== undefined && session.declaredBytes !== input.bytes) {
      throw new Error("completed upload byte count does not match declaredBytes");
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO checklist_artifacts (
        artifact_id, item_id, object_key, file_name, mime_type, bytes, etag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.artifactId,
      input.itemId,
      input.objectKey,
      input.fileName,
      input.mimeType,
      input.bytes,
      input.etag ?? null,
      input.completedAt,
    );
    this.ctx.storage.sql.exec(
      "UPDATE upload_sessions SET status = 'completed', completed_at = ? WHERE upload_id = ?",
      input.completedAt,
      input.uploadId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE checklist_items SET status = 'completed', updated_at = ? WHERE item_id = ?",
      input.completedAt,
      input.itemId,
    );
    this.refreshRequestReadiness(request.request_id, input.completedAt);
    this.recordEvent("upload_completed", input.itemId, {
      uploadId: input.uploadId,
      artifactId: input.artifactId,
      objectKey: input.objectKey,
      bytes: input.bytes,
    }, input.completedAt);
    return this.buildSnapshot();
  }

  async abortUpload(itemId: string, uploadId: string, abortedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.requireMutableRequest();
    const authorization = await this.authorizeUpload(itemId, uploadId);
    if (!authorization.allowed) throw new Error(authorization.reasons.join(",") || "upload session rejected");
    this.ctx.storage.sql.exec(
      "UPDATE upload_sessions SET status = 'aborted', completed_at = ? WHERE upload_id = ?",
      abortedAt,
      uploadId,
    );
    const item = this.readChecklistItem(itemId);
    if (!item) throw new Error("checklist item not found");
    const completed = this.artifactsForItem(itemId).length > 0 || Boolean(item.reference_value);
    this.ctx.storage.sql.exec(
      "UPDATE checklist_items SET status = ?, updated_at = ? WHERE item_id = ?",
      completed ? "completed" : "pending",
      abortedAt,
      itemId,
    );
    this.refreshRequestReadiness(request.request_id, abortedAt);
    this.recordEvent("upload_aborted", itemId, { uploadId }, abortedAt);
    return this.buildSnapshot();
  }

  async setReference(itemId: string, value: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.requireMutableRequest();
    const item = this.readChecklistItem(itemId);
    if (!item) throw new Error("checklist item not found");
    if (item.accepts_reference !== 1) throw new Error("checklist item does not accept references");
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > 4000) throw new Error("reference value must be 1-4000 characters");
    this.ctx.storage.sql.exec(
      "UPDATE checklist_items SET reference_value = ?, status = 'completed', updated_at = ? WHERE item_id = ?",
      cleaned,
      updatedAt,
      itemId,
    );
    this.refreshRequestReadiness(request.request_id, updatedAt);
    this.recordEvent("checklist_reference_set", itemId, { referenceLength: cleaned.length }, updatedAt);
    return this.buildSnapshot();
  }

  async submit(submittedAt: string): Promise<{ snapshot: ProductionRequestSnapshot; plan: ProductionPlan }> {
    const request = this.requireMutableRequest();
    this.refreshRequestReadiness(request.request_id, submittedAt);
    const ready = this.buildSnapshot();
    if (ready.status !== "ready") throw new Error("required checklist items are incomplete");
    const plan = compileProductionPlan(ready, submittedAt);
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE request_id = ?",
      submittedAt,
      submittedAt,
      request.request_id,
    );
    this.recordEvent("request_submitted", undefined, {
      deliverables: ready.deliverables,
      planVersion: plan.schemaVersion,
    }, submittedAt);
    return { snapshot: this.buildSnapshot(), plan };
  }

  async bindWorkflowInstance(workflowInstanceId: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (!["submitted", "processing"].includes(request.status)) {
      throw new Error(`workflow cannot be bound from request state ${request.status}`);
    }
    if (request.workflow_instance_id && request.workflow_instance_id !== workflowInstanceId) {
      throw new Error("production workflow instance idempotency conflict");
    }
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET workflow_instance_id = ?, updated_at = ? WHERE request_id = ?",
      workflowInstanceId,
      updatedAt,
      request.request_id,
    );
    this.recordEvent("workflow_bound", undefined, { workflowInstanceId }, updatedAt);
    return this.buildSnapshot();
  }

  async markProcessing(workflowInstanceId: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (request.workflow_instance_id && request.workflow_instance_id !== workflowInstanceId) {
      throw new Error("workflow instance mismatch");
    }
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = 'processing', workflow_instance_id = ?, updated_at = ? WHERE request_id = ?",
      workflowInstanceId,
      updatedAt,
      request.request_id,
    );
    this.recordEvent("processing_started", undefined, { workflowInstanceId }, updatedAt);
    return this.buildSnapshot();
  }

  async recordWorkflowHold(workflowInstanceId: string, reason: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (request.workflow_instance_id && request.workflow_instance_id !== workflowInstanceId) {
      throw new Error("workflow instance mismatch");
    }
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = 'submitted', workflow_instance_id = ?, updated_at = ? WHERE request_id = ?",
      workflowInstanceId,
      updatedAt,
      request.request_id,
    );
    this.recordEvent("processing_held", undefined, { workflowInstanceId, reason }, updatedAt);
    return this.buildSnapshot();
  }

  async markCompleted(workflowInstanceId: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (request.workflow_instance_id !== workflowInstanceId) throw new Error("workflow instance mismatch");
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = 'completed', updated_at = ? WHERE request_id = ?",
      updatedAt,
      request.request_id,
    );
    this.recordEvent("processing_completed", undefined, { workflowInstanceId }, updatedAt);
    return this.buildSnapshot();
  }

  async markFailed(workflowInstanceId: string, reason: string, updatedAt: string): Promise<ProductionRequestSnapshot> {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (request.workflow_instance_id && request.workflow_instance_id !== workflowInstanceId) {
      throw new Error("workflow instance mismatch");
    }
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = 'failed', workflow_instance_id = ?, updated_at = ? WHERE request_id = ?",
      workflowInstanceId,
      updatedAt,
      request.request_id,
    );
    this.recordEvent("processing_failed", undefined, { workflowInstanceId, reason }, updatedAt);
    return this.buildSnapshot();
  }

  private readRequest(): RequestRow | undefined {
    return this.ctx.storage.sql.exec<RequestRow>("SELECT * FROM production_request LIMIT 1").toArray()[0];
  }

  private requireMutableRequest(): RequestRow {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    if (!["draft", "ready"].includes(request.status)) {
      throw new Error(`production request is immutable after submission: ${request.status}`);
    }
    return request;
  }

  private readChecklistItem(itemId: string): ChecklistRow | undefined {
    return this.ctx.storage.sql
      .exec<ChecklistRow>("SELECT * FROM checklist_items WHERE item_id = ?", itemId)
      .toArray()[0];
  }

  private artifactsForItem(itemId: string): ProductionChecklistArtifact[] {
    return this.ctx.storage.sql
      .exec<ArtifactRow>("SELECT * FROM checklist_artifacts WHERE item_id = ? ORDER BY created_at ASC", itemId)
      .toArray()
      .map((row) => ({
        artifactId: row.artifact_id,
        objectKey: row.object_key,
        fileName: row.file_name,
        mimeType: row.mime_type,
        bytes: Number(row.bytes),
        ...(row.etag ? { etag: row.etag } : {}),
        createdAt: row.created_at,
      }));
  }

  private mapUploadSession(row: UploadSessionRow): NonNullable<UploadSessionAuthorization["session"]> {
    return {
      uploadId: row.upload_id,
      itemId: row.item_id,
      objectKey: row.object_key,
      artifactId: row.artifact_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      ...(row.declared_bytes === null ? {} : { declaredBytes: Number(row.declared_bytes) }),
    };
  }

  private refreshRequestReadiness(requestId: string, updatedAt: string): void {
    const request = this.readRequest();
    if (!request || request.request_id !== requestId) throw new Error("production request not initialized");
    if (!["draft", "ready"].includes(request.status)) return;
    const incompleteRequired = this.ctx.storage.sql
      .exec<{ count: number } & Record<string, SqlStorageValue>>(
        "SELECT COUNT(*) AS count FROM checklist_items WHERE required_item = 1 AND status != 'completed'",
      )
      .one();
    const nextStatus: ProductionRequestStatus = Number(incompleteRequired.count) === 0 ? "ready" : "draft";
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET status = ?, updated_at = ? WHERE request_id = ?",
      nextStatus,
      updatedAt,
      requestId,
    );
  }

  private touchRequest(requestId: string, updatedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE production_request SET updated_at = ? WHERE request_id = ?",
      updatedAt,
      requestId,
    );
  }

  private recordEvent(
    eventType: string,
    itemId: string | undefined,
    metadata: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO request_events (event_type, item_id, metadata_json, created_at) VALUES (?, ?, ?, ?)",
      eventType,
      itemId ?? null,
      JSON.stringify(metadata),
      createdAt,
    );
  }

  private buildSnapshot(): ProductionRequestSnapshot {
    const request = this.readRequest();
    if (!request) throw new Error("production request not initialized");
    const checklist: ProductionChecklistItem[] = this.ctx.storage.sql
      .exec<ChecklistRow>("SELECT * FROM checklist_items ORDER BY rowid ASC")
      .toArray()
      .map((row) => ({
        itemId: row.item_id,
        kind: row.kind as ChecklistItemKind,
        label: row.label,
        description: row.description,
        required: row.required_item === 1,
        acceptsUploads: row.accepts_uploads === 1,
        acceptsReference: row.accepts_reference === 1,
        allowsMultiple: row.allows_multiple === 1,
        status: row.status as ChecklistItemStatus,
        ...(row.reference_value ? { referenceValue: row.reference_value } : {}),
        artifacts: this.artifactsForItem(row.item_id),
        updatedAt: row.updated_at,
      }));
    return {
      schemaVersion: "tmg.production-request.v1",
      requestId: request.request_id,
      tenantId: request.tenant_id,
      title: request.title,
      ...(request.notes ? { notes: request.notes } : {}),
      status: request.status as ProductionRequestStatus,
      deliverables: JSON.parse(request.deliverables_json) as ProductionDeliverable[],
      checklist,
      ...(request.workflow_instance_id ? { workflowInstanceId: request.workflow_instance_id } : {}),
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      ...(request.submitted_at ? { submittedAt: request.submitted_at } : {}),
    };
  }
}
