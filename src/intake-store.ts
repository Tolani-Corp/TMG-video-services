import type {
  CreateRequestInput,
  RegisterAssetInput,
  RegisterRightsEvidenceInput,
} from "./intake-schemas";
import type { ConsoleActor } from "./access-auth";

export class IntakeNotFoundError extends Error {}
export class IntakeConflictError extends Error {}
export class IntakeForbiddenError extends Error {}

interface RequestRow {
  request_id: string;
  tenant_id: string;
  request_name: string;
  audience: string;
  business_goal: string;
  priority: string;
  deliverables_json: string;
  output_format: string;
  target_duration: string;
  notes: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  processing_authority: number;
  publication_authority: number;
  commercial_authority: number;
}

export interface AssetRow {
  asset_id: string;
  request_id: string;
  filename: string;
  mime_type: string;
  expected_bytes: number;
  expected_sha256: string;
  quarantine_object_key: string;
  rights_state: string;
  upload_state: string;
  processable: number;
  r2_version: string | null;
  r2_etag: string | null;
  uploaded_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RightsEvidenceRow {
  evidence_id: string;
  request_id: string;
  asset_id: string;
  evidence_kind: string;
  description: string;
  filename: string;
  mime_type: string;
  expected_bytes: number;
  expected_sha256: string;
  evidence_object_key: string;
  upload_state: string;
  review_state: string;
  grants_internal_processing: number;
  grants_derivative_use: number;
  grants_external_provider_evaluation: number;
  submitted_by: string;
  submitted_at: string;
  verified_by: string | null;
  verified_at: string | null;
  rejected_reason: string | null;
}

interface JobRow {
  job_id: string;
  request_id: string;
  status: string;
  workflow_state: string;
  requested_by: string;
  created_at: string;
  updated_at: string;
  processing_authority: number;
  billable: number;
}

function publicRequest(row: RequestRow) {
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    requestName: row.request_name,
    audience: row.audience,
    businessGoal: row.business_goal,
    priority: row.priority,
    deliverables: JSON.parse(row.deliverables_json) as string[],
    outputFormat: row.output_format,
    targetDuration: row.target_duration,
    notes: row.notes,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authority: {
      processing: row.processing_authority === 1,
      publication: row.publication_authority === 1,
      commercial: row.commercial_authority === 1,
    },
  };
}

function publicAsset(row: AssetRow) {
  return {
    assetId: row.asset_id,
    requestId: row.request_id,
    filename: row.filename,
    mimeType: row.mime_type,
    expectedBytes: row.expected_bytes,
    expectedSha256: row.expected_sha256,
    rightsState: row.rights_state,
    uploadState: row.upload_state,
    processable: row.processable === 1,
    uploadedAt: row.uploaded_at,
    createdAt: row.created_at,
  };
}

function publicRights(row: RightsEvidenceRow) {
  return {
    evidenceId: row.evidence_id,
    requestId: row.request_id,
    assetId: row.asset_id,
    evidenceKind: row.evidence_kind,
    description: row.description,
    filename: row.filename,
    mimeType: row.mime_type,
    expectedBytes: row.expected_bytes,
    expectedSha256: row.expected_sha256,
    uploadState: row.upload_state,
    reviewState: row.review_state,
    grants: {
      internalProcessing: row.grants_internal_processing === 1,
      derivativeUse: row.grants_derivative_use === 1,
      externalProviderEvaluation: row.grants_external_provider_evaluation === 1,
    },
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    rejectedReason: row.rejected_reason,
  };
}

function publicJob(row: JobRow) {
  return {
    jobId: row.job_id,
    requestId: row.request_id,
    status: row.status,
    workflowState: row.workflow_state,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processingAuthority: row.processing_authority === 1,
    billable: row.billable === 1,
  };
}

export class IntakeStore {
  constructor(private readonly db: D1Database) {}

  async createRequest(actor: ConsoleActor, input: CreateRequestInput, now: string) {
    const requestId = `req_${crypto.randomUUID()}`;
    const eventId = `evt_${crypto.randomUUID()}`;
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO tmg_requests (
          request_id, tenant_id, request_name, audience, business_goal, priority,
          deliverables_json, output_format, target_duration, notes, status,
          created_by, created_at, updated_at
        ) VALUES (?1,'tmg_internal',?2,?3,?4,?5,?6,?7,?8,?9,'submitted',?10,?11,?11)
      `).bind(
        requestId,
        input.requestName,
        input.audience,
        input.businessGoal,
        input.priority,
        JSON.stringify(input.deliverables),
        input.outputFormat,
        input.targetDuration,
        input.notes,
        actor.email,
        now,
      ),
      this.db.prepare(`
        INSERT INTO tmg_audit_events (event_id,event_type,subject_type,subject_id,actor_email,metadata_json,created_at)
        VALUES (?1,'request_created','request',?2,?3,?4,?5)
      `).bind(eventId, requestId, actor.email, JSON.stringify({ publicStatusGate: "G0" }), now),
    ]);
    return this.getRequestBundleForOwner(requestId, actor.email);
  }

  async listRequestsForOwner(email: string) {
    const result = await this.db.prepare(`
      SELECT * FROM tmg_requests WHERE created_by = ?1 ORDER BY created_at DESC LIMIT 100
    `).bind(email).all<RequestRow>();
    return result.results.map(publicRequest);
  }

  async getRequestForOwner(requestId: string, email: string): Promise<RequestRow> {
    const row = await this.db.prepare(`
      SELECT * FROM tmg_requests WHERE request_id = ?1 AND created_by = ?2 LIMIT 1
    `).bind(requestId, email).first<RequestRow>();
    if (!row) throw new IntakeNotFoundError("request not found");
    return row;
  }

  async getRequestBundleForOwner(requestId: string, email: string) {
    const request = await this.getRequestForOwner(requestId, email);
    const [assets, rights, jobs] = await Promise.all([
      this.db.prepare(`SELECT * FROM tmg_source_assets WHERE request_id = ?1 ORDER BY created_at`).bind(requestId).all<AssetRow>(),
      this.db.prepare(`SELECT * FROM tmg_rights_evidence WHERE request_id = ?1 ORDER BY submitted_at`).bind(requestId).all<RightsEvidenceRow>(),
      this.db.prepare(`SELECT * FROM tmg_jobs WHERE request_id = ?1 ORDER BY created_at DESC`).bind(requestId).all<JobRow>(),
    ]);
    return {
      request: publicRequest(request),
      assets: assets.results.map(publicAsset),
      rightsEvidence: rights.results.map(publicRights),
      jobs: jobs.results.map(publicJob),
    };
  }

  async registerAsset(actor: ConsoleActor, requestId: string, input: RegisterAssetInput, now: string) {
    await this.getRequestForOwner(requestId, actor.email);
    const assetId = `asset_${crypto.randomUUID()}`;
    const objectKey = `tenants/tmg_internal/intake/requests/${requestId}/assets/${assetId}/quarantine/source`;
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO tmg_source_assets (
          asset_id,request_id,filename,mime_type,expected_bytes,expected_sha256,
          quarantine_object_key,created_by,created_at,updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
      `).bind(assetId, requestId, input.filename, input.mimeType, input.expectedBytes, input.expectedSha256.toLowerCase(), objectKey, actor.email, now),
      this.db.prepare(`UPDATE tmg_requests SET status='rights_pending', updated_at=?2 WHERE request_id=?1`).bind(requestId, now),
      this.audit("asset_registered", "asset", assetId, actor.email, { requestId, expectedBytes: input.expectedBytes }, now),
    ]);
    return this.getAssetForOwner(assetId, actor.email);
  }

  async getAssetForOwner(assetId: string, email: string): Promise<AssetRow> {
    const row = await this.db.prepare(`
      SELECT a.* FROM tmg_source_assets a
      JOIN tmg_requests r ON r.request_id = a.request_id
      WHERE a.asset_id = ?1 AND r.created_by = ?2 LIMIT 1
    `).bind(assetId, email).first<AssetRow>();
    if (!row) throw new IntakeNotFoundError("asset not found");
    return row;
  }

  async registerRightsEvidence(
    actor: ConsoleActor,
    assetId: string,
    input: RegisterRightsEvidenceInput,
    now: string,
  ) {
    const asset = await this.getAssetForOwner(assetId, actor.email);
    const evidenceId = `rights_${crypto.randomUUID()}`;
    const objectKey = `tenants/tmg_internal/intake/requests/${asset.request_id}/assets/${assetId}/rights/${evidenceId}/evidence`;
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO tmg_rights_evidence (
          evidence_id,request_id,asset_id,evidence_kind,description,filename,mime_type,
          expected_bytes,expected_sha256,evidence_object_key,
          grants_internal_processing,grants_derivative_use,grants_external_provider_evaluation,
          submitted_by,submitted_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
      `).bind(
        evidenceId,
        asset.request_id,
        assetId,
        input.evidenceKind,
        input.description,
        input.filename,
        input.mimeType,
        input.expectedBytes,
        input.expectedSha256.toLowerCase(),
        objectKey,
        input.grantsInternalProcessing ? 1 : 0,
        input.grantsDerivativeUse ? 1 : 0,
        input.grantsExternalProviderEvaluation ? 1 : 0,
        actor.email,
        now,
      ),
      this.audit("rights_evidence_registered", "rights_evidence", evidenceId, actor.email, { assetId }, now),
    ]);
    return this.getRightsEvidence(evidenceId);
  }

  async getRightsEvidence(evidenceId: string): Promise<RightsEvidenceRow> {
    const row = await this.db.prepare(`SELECT * FROM tmg_rights_evidence WHERE evidence_id=?1 LIMIT 1`).bind(evidenceId).first<RightsEvidenceRow>();
    if (!row) throw new IntakeNotFoundError("rights evidence not found");
    return row;
  }

  async requireRightsEvidenceOwner(evidenceId: string, email: string): Promise<RightsEvidenceRow> {
    const row = await this.db.prepare(`
      SELECT e.* FROM tmg_rights_evidence e
      JOIN tmg_requests r ON r.request_id = e.request_id
      WHERE e.evidence_id=?1 AND r.created_by=?2 LIMIT 1
    `).bind(evidenceId, email).first<RightsEvidenceRow>();
    if (!row) throw new IntakeNotFoundError("rights evidence not found");
    return row;
  }

  async markRightsEvidenceUploaded(
    evidenceId: string,
    actor: ConsoleActor,
    r2Version: string,
    r2Etag: string,
    now: string,
  ) {
    const evidence = await this.requireRightsEvidenceOwner(evidenceId, actor.email);
    if (evidence.upload_state !== "metadata_registered") {
      throw new IntakeConflictError("rights evidence upload already finalized");
    }
    await this.db.batch([
      this.db.prepare(`UPDATE tmg_rights_evidence SET upload_state='integrity_verified' WHERE evidence_id=?1`).bind(evidenceId),
      this.audit("rights_evidence_integrity_verified", "rights_evidence", evidenceId, actor.email, { r2Version, r2Etag }, now),
    ]);
    return this.getRightsEvidence(evidenceId);
  }

  async reviewRightsEvidence(
    evidenceId: string,
    reviewer: ConsoleActor,
    decision: "verify" | "reject",
    rationale: string,
    now: string,
  ) {
    const evidence = await this.getRightsEvidence(evidenceId);
    if (evidence.submitted_by === reviewer.email) {
      throw new IntakeForbiddenError("rights evidence requires independent review by a different authenticated identity");
    }
    if (evidence.upload_state !== "integrity_verified") {
      throw new IntakeConflictError("rights evidence bytes must pass integrity verification before review");
    }
    if (evidence.review_state !== "pending") {
      throw new IntakeConflictError("rights evidence has already been reviewed");
    }

    const approvalId = `approval_${crypto.randomUUID()}`;
    if (decision === "verify") {
      await this.db.batch([
        this.db.prepare(`
          UPDATE tmg_rights_evidence
          SET review_state='verified', verified_by=?2, verified_at=?3
          WHERE evidence_id=?1
        `).bind(evidenceId, reviewer.email, now),
        this.db.prepare(`UPDATE tmg_source_assets SET rights_state='verified', updated_at=?2 WHERE asset_id=?1`).bind(evidence.asset_id, now),
        this.db.prepare(`
          INSERT INTO tmg_approvals (approval_id,subject_type,subject_id,stage,decision,actor_email,rationale,created_at)
          VALUES (?1,'rights_evidence',?2,'rights_review','approve',?3,?4,?5)
        `).bind(approvalId, evidenceId, reviewer.email, rationale, now),
        this.audit("rights_evidence_verified", "rights_evidence", evidenceId, reviewer.email, { assetId: evidence.asset_id }, now),
      ]);
      const pending = await this.db.prepare(`
        SELECT COUNT(*) AS count FROM tmg_source_assets WHERE request_id=?1 AND rights_state <> 'verified'
      `).bind(evidence.request_id).first<{ count: number }>();
      if ((pending?.count ?? 1) === 0) {
        await this.db.prepare(`UPDATE tmg_requests SET status='rights_verified', updated_at=?2 WHERE request_id=?1`).bind(evidence.request_id, now).run();
      }
    } else {
      await this.db.batch([
        this.db.prepare(`
          UPDATE tmg_rights_evidence SET review_state='rejected', rejected_reason=?2 WHERE evidence_id=?1
        `).bind(evidenceId, rationale),
        this.db.prepare(`UPDATE tmg_source_assets SET rights_state='rejected', updated_at=?2 WHERE asset_id=?1`).bind(evidence.asset_id, now),
        this.db.prepare(`UPDATE tmg_requests SET status='rejected', updated_at=?2 WHERE request_id=?1`).bind(evidence.request_id, now),
        this.db.prepare(`
          INSERT INTO tmg_approvals (approval_id,subject_type,subject_id,stage,decision,actor_email,rationale,created_at)
          VALUES (?1,'rights_evidence',?2,'rights_review','reject',?3,?4,?5)
        `).bind(approvalId, evidenceId, reviewer.email, rationale, now),
        this.audit("rights_evidence_rejected", "rights_evidence", evidenceId, reviewer.email, { assetId: evidence.asset_id }, now),
      ]);
    }
    return this.getRightsEvidence(evidenceId);
  }

  async markAssetUploaded(assetId: string, actor: ConsoleActor, r2Version: string, r2Etag: string, now: string) {
    const asset = await this.getAssetForOwner(assetId, actor.email);
    if (asset.rights_state !== "verified") {
      throw new IntakeForbiddenError("asset cannot enter quarantine until rights evidence is independently verified");
    }
    if (asset.upload_state !== "metadata_registered") {
      throw new IntakeConflictError("asset upload already finalized");
    }
    await this.db.batch([
      this.db.prepare(`
        UPDATE tmg_source_assets
        SET upload_state='quarantined_integrity_verified', r2_version=?2, r2_etag=?3, uploaded_at=?4, updated_at=?4
        WHERE asset_id=?1
      `).bind(assetId, r2Version, r2Etag, now),
      this.audit("asset_quarantined_integrity_verified", "asset", assetId, actor.email, { requestId: asset.request_id }, now),
    ]);

    const blocked = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM tmg_source_assets
      WHERE request_id=?1 AND (rights_state <> 'verified' OR upload_state <> 'quarantined_integrity_verified')
    `).bind(asset.request_id).first<{ count: number }>();
    if ((blocked?.count ?? 1) === 0) {
      await this.db.prepare(`UPDATE tmg_requests SET status='ready_for_operator_review', updated_at=?2 WHERE request_id=?1`).bind(asset.request_id, now).run();
    } else {
      await this.db.prepare(`UPDATE tmg_requests SET status='quarantined_uploaded', updated_at=?2 WHERE request_id=?1`).bind(asset.request_id, now).run();
    }
    return this.getAssetForOwner(assetId, actor.email);
  }

  async createBlockedJob(actor: ConsoleActor, requestId: string, now: string) {
    await this.getRequestForOwner(requestId, actor.email);
    const assetCount = await this.db.prepare(`SELECT COUNT(*) AS count FROM tmg_source_assets WHERE request_id=?1`).bind(requestId).first<{ count: number }>();
    if ((assetCount?.count ?? 0) < 1) throw new IntakeConflictError("at least one governed source asset is required");

    const blocked = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM tmg_source_assets
      WHERE request_id=?1 AND (rights_state <> 'verified' OR upload_state <> 'quarantined_integrity_verified')
    `).bind(requestId).first<{ count: number }>();
    if ((blocked?.count ?? 1) !== 0) {
      throw new IntakeConflictError("all source assets must be rights-verified and integrity-verified in quarantine");
    }

    const jobId = `job_${crypto.randomUUID()}`;
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO tmg_jobs (job_id,request_id,status,workflow_state,requested_by,created_at,updated_at)
        VALUES (?1,?2,'blocked_processing_authority','not_started',?3,?4,?4)
      `).bind(jobId, requestId, actor.email, now),
      this.db.prepare(`UPDATE tmg_requests SET status='ready_for_operator_review', updated_at=?2 WHERE request_id=?1`).bind(requestId, now),
      this.audit("job_created_processing_blocked", "job", jobId, actor.email, { requestId, processingAuthority: false }, now),
    ]);
    const row = await this.db.prepare(`SELECT * FROM tmg_jobs WHERE job_id=?1`).bind(jobId).first<JobRow>();
    if (!row) throw new IntakeNotFoundError("job creation failed");
    return publicJob(row);
  }

  async listJobsForOwner(email: string) {
    const result = await this.db.prepare(`
      SELECT j.* FROM tmg_jobs j
      JOIN tmg_requests r ON r.request_id=j.request_id
      WHERE r.created_by=?1 ORDER BY j.created_at DESC LIMIT 100
    `).bind(email).all<JobRow>();
    return result.results.map(publicJob);
  }

  private audit(
    eventType: string,
    subjectType: string,
    subjectId: string,
    actorEmail: string,
    metadata: Record<string, unknown>,
    now: string,
  ) {
    return this.db.prepare(`
      INSERT INTO tmg_audit_events (event_id,event_type,subject_type,subject_id,actor_email,metadata_json,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
    `).bind(`evt_${crypto.randomUUID()}`, eventType, subjectType, subjectId, actorEmail, JSON.stringify(metadata), now);
  }
}

export { publicAsset, publicRights };
