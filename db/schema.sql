-- ============================================================================
-- SIH 26043 - Crowdsourcing-to-Resolution Ecosystem | PostgreSQL Schema
-- Tables: Users, Categories, Complaints, Claims, Solutions, Partnerships,
--         Status Logs, Notifications
-- (Partnerships is the Module 5 addition that records industry CSR/startup/MSME
--  pledges against approved prototypes; the original 7-table core is unchanged.)
--
-- Requires: PostgreSQL 12+ with the pgvector extension (0.5+ for HNSW index)
--
-- To reset the database, uncomment before re-running:
--   DROP TABLE IF EXISTS notifications, status_logs, solutions, claims,
--      complaints, categories, users CASCADE;
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 1. USERS  (stakeholders: citizen, student, ngo, institution, govt_admin)
--    RBAC: role whitelist + org-detail requirement for org roles
-- ============================================================================
CREATE TABLE users (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name           TEXT        NOT NULL
                        CONSTRAINT chk_users_full_name
                        CHECK (btrim(full_name) <> ''),
    email               TEXT        NOT NULL
                        CONSTRAINT chk_users_email_format
                        CHECK (email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    phone               TEXT,
    -- Roles: core stakeholders + Module 5 industry partners. To migrate an
    -- already-applied database, run:
    --   ALTER TABLE users DROP CONSTRAINT chk_users_role;
    --   ALTER TABLE users ADD CONSTRAINT chk_users_role
    --     CHECK (role IN ('citizen','student','ngo','institution','csr',
    --                     'startup','msme','govt_admin'));
    role                TEXT        NOT NULL DEFAULT 'citizen'
                        CONSTRAINT chk_users_role
                        CHECK (role IN ('citizen', 'student', 'ngo', 'institution',
                                        'csr', 'startup', 'msme', 'govt_admin')),
    -- Organizations (ngo/institution/csr/startup/msme) must register an org name
    org_name            TEXT,
    district            TEXT,
    -- Privacy preferences
    allow_email_alerts  BOOLEAN     NOT NULL DEFAULT TRUE,
    is_public_profile   BOOLEAN     NOT NULL DEFAULT FALSE,
    share_location      BOOLEAN     NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    email_verified_at   TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT uq_users_phone UNIQUE (phone),
    -- For an already-applied DB, also run:
    --   ALTER TABLE users DROP CONSTRAINT chk_users_org_details;
    --   ALTER TABLE users ADD CONSTRAINT chk_users_org_details CHECK (
    --     role NOT IN ('ngo','institution','csr','startup','msme')
    --     OR (org_name IS NOT NULL AND btrim(org_name) <> ''));
    CONSTRAINT chk_users_org_details CHECK (
        role NOT IN ('ngo', 'institution', 'csr', 'startup', 'msme')
        OR (org_name IS NOT NULL AND btrim(org_name) <> '')
    ),
    CONSTRAINT chk_users_contact CHECK (email IS NOT NULL OR phone IS NOT NULL),
    CONSTRAINT chk_users_phone_format CHECK (
        phone IS NULL OR phone ~ '^[+0-9][0-9() -]{6,19}$'
    )
);

CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

-- ============================================================================
-- 2. CATEGORIES  (fixed domain taxonomy, self-referencing sub-categories)
-- ============================================================================
CREATE TABLE categories (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        TEXT NOT NULL
                CONSTRAINT chk_categories_code
                CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
    name        TEXT NOT NULL
                CONSTRAINT chk_categories_name
                CHECK (btrim(name) <> ''),
    description TEXT,
    parent_id   BIGINT REFERENCES categories(id) ON DELETE RESTRICT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_categories_code UNIQUE (code),
    CONSTRAINT uq_categories_name UNIQUE (name),
    -- A category cannot be its own parent
    CONSTRAINT chk_categories_no_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

-- ============================================================================
-- 3. COMPLAINTS  (text, geo-coordinates, ML embedding vector(384), cluster_id)
-- ============================================================================
CREATE TABLE complaints (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id     BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    title           TEXT NOT NULL
                    CONSTRAINT chk_complaints_title
                    CHECK (length(btrim(title)) BETWEEN 5 AND 300),
    description     TEXT NOT NULL
                    CONSTRAINT chk_complaints_description
                    CHECK (length(btrim(description)) >= 10),
    -- Geo-coordinates (HTML5 Geolocation) - both set or both NULL
    latitude        NUMERIC(9, 6)
                    CONSTRAINT chk_complaints_latitude CHECK (latitude BETWEEN -90 AND 90),
    longitude       NUMERIC(9, 6)
                    CONSTRAINT chk_complaints_longitude CHECK (longitude BETWEEN -180 AND 180),
    address         TEXT,
    district        TEXT,
    -- Submission metadata
    submission_mode TEXT NOT NULL DEFAULT 'text'
                    CONSTRAINT chk_complaints_submission_mode
                    CHECK (submission_mode IN ('text', 'voice', 'image')),
    source_language TEXT,             -- vernacular language of the reporter
    voice_transcript TEXT,            -- raw Bhashini speech-to-text output
    is_anonymous    BOOLEAN NOT NULL DEFAULT FALSE,
    -- ML triage artifacts
    embedding       VECTOR(384),      -- Sentence-BERT embedding for duplicate detection
    cluster_id      BIGINT REFERENCES complaints(id) ON DELETE SET NULL,
    cluster_score   NUMERIC(4, 3)
                    CONSTRAINT chk_complaints_cluster_score
                    CHECK (cluster_score IS NULL OR cluster_score BETWEEN 0 AND 1),
    -- Workflow state (strict linear state machine, see trigger below)
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CONSTRAINT chk_complaints_status
                    CHECK (status IN ('submitted', 'under_review', 'assigned',
                                      'in_progress', 'resolved')),
    status_reason   TEXT,             -- optional note captured into status_logs
    -- WebP images (< 500 KB each, compressed via Canvas API on the client)
    images          JSONB NOT NULL DEFAULT '[]'::jsonb
                    CONSTRAINT chk_complaints_images_array
                    CHECK (jsonb_typeof(images) = 'array'),
    updated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_complaints_coords_paired CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (latitude IS NOT NULL AND longitude IS NOT NULL)
    ),
    -- A complaint cannot be a duplicate of itself
    CONSTRAINT chk_complaints_no_self_cluster CHECK (cluster_id IS DISTINCT FROM id)
);

CREATE INDEX idx_complaints_user_id        ON complaints (user_id);
CREATE INDEX idx_complaints_category_id    ON complaints (category_id);
CREATE INDEX idx_complaints_status         ON complaints (status);
CREATE INDEX idx_complaints_cluster_id     ON complaints (cluster_id);
CREATE INDEX idx_complaints_created_at     ON complaints (created_at DESC);
-- ANN index over the 384-dim Sentence-BERT embeddings (cosine similarity)
CREATE INDEX idx_complaints_embedding_hnsw
    ON complaints USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- 4. CLAIMS  (academic/NGO team adoption of a problem - one claim per complaint)
-- ============================================================================
CREATE TABLE claims (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    complaint_id     BIGINT NOT NULL UNIQUE
                     REFERENCES complaints(id) ON DELETE CASCADE,
    team_name        TEXT NOT NULL
                     CONSTRAINT chk_claims_team_name
                     CHECK (btrim(team_name) <> ''),
    team_type        TEXT NOT NULL
                     CONSTRAINT chk_claims_team_type
                     CHECK (team_type IN ('student', 'ngo', 'institution')),
    team_lead_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    institution_name TEXT,                 -- college/org the team belongs to
    proposal         TEXT NOT NULL
                     CONSTRAINT chk_claims_proposal
                     CHECK (length(btrim(proposal)) >= 20),
    -- govt_admin moderation of the adoption
    approval_status  TEXT NOT NULL DEFAULT 'pending'
                     CONSTRAINT chk_claims_approval_status
                     CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    reviewed_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claims_team_lead_id ON claims (team_lead_id);
CREATE INDEX idx_claims_approval    ON claims (approval_status);

-- ============================================================================
-- 5. SOLUTIONS  (prototype documentation per claim; versioned by iteration)
-- ============================================================================
CREATE TABLE solutions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    claim_id        BIGINT NOT NULL
                    REFERENCES claims(id) ON DELETE CASCADE,
    iteration       INTEGER NOT NULL DEFAULT 1
                    CONSTRAINT chk_solutions_iteration CHECK (iteration >= 1),
    title           TEXT NOT NULL
                    CONSTRAINT chk_solutions_title CHECK (btrim(title) <> ''),
    summary         TEXT NOT NULL
                    CONSTRAINT chk_solutions_summary CHECK (length(btrim(summary)) >= 20),
    tech_stack      JSONB NOT NULL DEFAULT '[]'::jsonb
                    CONSTRAINT chk_solutions_tech_stack_array
                    CHECK (jsonb_typeof(tech_stack) = 'array'),
    -- Submitted prototype documentation (design docs, PPT, demo video, etc.)
    documentation   JSONB NOT NULL DEFAULT '[]'::jsonb
                    CONSTRAINT chk_solutions_documentation_array
                    CHECK (jsonb_typeof(documentation) = 'array'),
    repository_url  TEXT
                    CONSTRAINT chk_solutions_repo_url
                    CHECK (repository_url IS NULL OR repository_url ~ '^https?://'),
    prototype_url   TEXT
                    CONSTRAINT chk_solutions_prototype_url
                    CHECK (prototype_url IS NULL OR prototype_url ~ '^https?://'),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CONSTRAINT chk_solutions_status
                    CHECK (status IN ('draft', 'submitted', 'under_review',
                                      'approved', 'rejected', 'revision_requested')),
    -- NOTE: if this schema was already applied to a database, migrate with:
    --   ALTER TABLE solutions DROP CONSTRAINT chk_solutions_status;
    --   ALTER TABLE solutions ADD CONSTRAINT chk_solutions_status
    --     CHECK (status IN ('draft','submitted','under_review','approved','rejected','revision_requested'));
    submitted_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    submitted_at    TIMESTAMPTZ,
    reviewed_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ,
    review_comment  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One documentation package per claim per iteration number
    CONSTRAINT uq_solutions_claim_iteration UNIQUE (claim_id, iteration)
);

CREATE INDEX idx_solutions_status ON solutions (status);

-- ============================================================================
-- 6. STATUS LOGS  (immutable audit trail of the workflow state machine)
-- ============================================================================
CREATE TABLE status_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    complaint_id    BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    previous_status TEXT
                    CONSTRAINT chk_status_logs_previous
                    CHECK (previous_status IS NULL OR previous_status IN
                        ('submitted', 'under_review', 'assigned', 'in_progress', 'resolved')),
    new_status      TEXT NOT NULL
                    CONSTRAINT chk_status_logs_new
                    CHECK (new_status IN
                        ('submitted', 'under_review', 'assigned', 'in_progress', 'resolved')),
    changed_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_status_logs_complaint ON status_logs (complaint_id, created_at DESC);
CREATE INDEX idx_status_logs_changed_by ON status_logs (changed_by);

-- ============================================================================
-- 7. NOTIFICATIONS  (closed-loop citizen alerts, primarily email)
-- ============================================================================
CREATE TABLE notifications (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    complaint_id  BIGINT REFERENCES complaints(id) ON DELETE CASCADE,
    type          TEXT NOT NULL
                  CONSTRAINT chk_notifications_type
                  CHECK (type IN ('complaint_status', 'claim_status',
                                  'solution_review', 'partnership', 'general')),
    channel       TEXT NOT NULL DEFAULT 'email'
                  CONSTRAINT chk_notifications_channel
                  CHECK (channel IN ('email', 'sms', 'push')),
    subject       TEXT NOT NULL
                  CONSTRAINT chk_notifications_subject CHECK (btrim(subject) <> ''),
    body          TEXT NOT NULL
                  CONSTRAINT chk_notifications_body CHECK (btrim(body) <> ''),
    -- delivery lifecycle for closed-loop alerts
    status        TEXT NOT NULL DEFAULT 'pending'
                  CONSTRAINT chk_notifications_status
                  CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
    retry_count   INTEGER NOT NULL DEFAULT 0
                  CONSTRAINT chk_notifications_retries CHECK (retry_count >= 0),
    error_message TEXT,
    sent_at       TIMESTAMPTZ,
    delivered_at  TIMESTAMPTZ,
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications (status);
CREATE INDEX idx_notifications_complaint ON notifications (complaint_id);

-- NOTE: 'partnership' above was added for Module 5 pledge alerts. Migrate an
--       already-applied database with:
--   ALTER TABLE notifications DROP CONSTRAINT chk_notifications_type;
--   ALTER TABLE notifications ADD CONSTRAINT chk_notifications_type
--     CHECK (type IN ('complaint_status','claim_status','solution_review',
--                     'partnership','general'));

-- ============================================================================
-- 8. PARTNERSHIPS  (Module 5 — industry pledges against approved prototypes)
--    CSR / startup / MSME partners offer financial grants, technical
--    mentorship, or pilot deployment support to specific validated solutions.
--    Each pledge lands with status 'pending' and notifies the adopting team
--    and the government admins (see POST /api/industry/partnerships).
-- ============================================================================
CREATE TABLE partnerships (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    solution_id     BIGINT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
    partner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- CSR / startup / MSME is derived from the pledging account's role.
    pledge_type     TEXT NOT NULL
                    CONSTRAINT chk_partnerships_pledge_type
                    CHECK (pledge_type IN ('grant', 'mentorship', 'pilot')),
    -- Financial commitment in INR (required for 'grant', optional in-kind
    -- valuation for 'mentorship'/'pilot').
    amount_inr      NUMERIC(14, 2)
                    CONSTRAINT chk_partnerships_amount
                    CHECK (amount_inr IS NULL OR amount_inr > 0),
    title           TEXT NOT NULL
                    CONSTRAINT chk_partnerships_title
                    CHECK (btrim(title) <> ''),
    description     TEXT NOT NULL
                    CONSTRAINT chk_partnerships_description
                    CHECK (length(btrim(description)) >= 20),
    -- Point-of-contact shared with the adopting team and govt reviewers
    -- (the pledging account itself keeps users.email/phone too).
    contact_email    TEXT
                    CONSTRAINT chk_partnerships_contact_email
                    CHECK (contact_email IS NULL OR contact_email ~
                           '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    contact_phone    TEXT
                    CONSTRAINT chk_partnerships_contact_phone
                    CHECK (contact_phone IS NULL OR contact_phone ~
                           '^[+0-9][0-9() -]{6,19}$'),
    -- NOTE: contact columns were added later for the pledge point-of-contact.
    -- Migrate an already-applied database with:
    --   ALTER TABLE partnerships
    --     ADD COLUMN contact_email TEXT,
    --     ADD COLUMN contact_phone TEXT,
    --     ADD CONSTRAINT chk_partnerships_contact_email CHECK (
    --       contact_email IS NULL OR contact_email ~
    --       '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    --     ADD CONSTRAINT chk_partnerships_contact_phone CHECK (
    --       contact_phone IS NULL OR contact_phone ~
    --       '^[+0-9][0-9() -]{6,19}$');
    -- Lifecycle: pending (awaiting govt matching) -> active / matched, or
    -- declined / withdrawn. Metrics count pending + active as committed.
    status          TEXT NOT NULL DEFAULT 'pending'
                    CONSTRAINT chk_partnerships_status
                    CHECK (status IN ('pending', 'active', 'matched',
                                      'declined', 'withdrawn')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One partner cannot duplicate the same pledge type on the same solution
    CONSTRAINT uq_partnerships_partner_solution_type
        UNIQUE (partner_user_id, solution_id, pledge_type),
    -- Financial grants must carry an amount
    CONSTRAINT chk_partnerships_grant_amount CHECK (
        pledge_type <> 'grant' OR amount_inr IS NOT NULL
    )
);

CREATE INDEX idx_partnerships_solution  ON partnerships (solution_id);
CREATE INDEX idx_partnerships_partner   ON partnerships (partner_user_id);
CREATE INDEX idx_partnerships_status    ON partnerships (status);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Generic updated_at bump for mutable tables
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_categories_updated_at
    BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_complaints_updated_at
    BEFORE UPDATE ON complaints
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_claims_updated_at
    BEFORE UPDATE ON claims
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_solutions_updated_at
    BEFORE UPDATE ON solutions
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_partnerships_updated_at
    BEFORE UPDATE ON partnerships
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Strict state machine: enforces the linear workflow and writes the audit log
--   Submitted -> Under Review -> Assigned -> In Progress -> Resolved
-- Every status change must pass through this trigger; a direct multi-step or
-- backward jump raises an exception, and each legal transition is recorded
-- in status_logs automatically.
CREATE OR REPLACE FUNCTION fn_complaints_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'submitted'    AND NEW.status = 'under_review') OR
            (OLD.status = 'under_review' AND NEW.status = 'assigned') OR
            (OLD.status = 'assigned'     AND NEW.status = 'in_progress') OR
            (OLD.status = 'in_progress'  AND NEW.status = 'resolved')
        ) THEN
            RAISE EXCEPTION
                'Illegal complaint status transition: % -> % (only Submitted -> Under Review -> Assigned -> In Progress -> Resolved is allowed)',
                OLD.status, NEW.status;
        END IF;

        INSERT INTO status_logs (complaint_id, previous_status, new_status,
                                 changed_by, reason)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_by, NEW.status_reason);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_complaints_status_guard
    BEFORE UPDATE OF status ON complaints
    FOR EACH ROW EXECUTE FUNCTION fn_complaints_status_guard();
