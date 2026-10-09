CREATE TABLE public.idempotency_keys (
    id uuid NOT NULL,
    actor_id text NOT NULL,
    operation text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL,
    response jsonb,
    response_status integer,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['stored'::text, 'in_progress'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    organization_id uuid,
    queue text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error text,
    heartbeat_at timestamp with time zone,
    outbox_id uuid,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: kysely_migration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kysely_migration (
    name character varying(255) NOT NULL,
    "timestamp" character varying(255) NOT NULL
);


--
-- Name: kysely_migration_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kysely_migration_lock (
    id character varying(255) NOT NULL,
    is_locked integer DEFAULT 0 NOT NULL
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id uuid NOT NULL,
    organization_id uuid,
    topic text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid NOT NULL,
    scope text NOT NULL,
    scope_id uuid,
    key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settings_check CHECK ((((scope = 'system'::text) AND (scope_id IS NULL)) OR ((scope = ANY (ARRAY['organization'::text, 'project'::text])) AND (scope_id IS NOT NULL)))),
    CONSTRAINT settings_scope_check CHECK ((scope = ANY (ARRAY['system'::text, 'organization'::text, 'project'::text])))
);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: kysely_migration_lock kysely_migration_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kysely_migration_lock
    ADD CONSTRAINT kysely_migration_lock_pkey PRIMARY KEY (id);


--
-- Name: kysely_migration kysely_migration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kysely_migration
    ADD CONSTRAINT kysely_migration_pkey PRIMARY KEY (name);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: idempotency_actor_op_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idempotency_actor_op_key_uniq ON public.idempotency_keys USING btree (actor_id, operation, key);


--
-- Name: jobs_outbox_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_outbox_uniq ON public.jobs USING btree (outbox_id);


--
-- Name: jobs_status_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_status_queue_idx ON public.jobs USING btree (status, queue);


--
-- Name: outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending_idx ON public.outbox USING btree (dispatched_at NULLS FIRST, created_at);


--
-- Name: settings_scope_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settings_scope_key_uniq ON public.settings USING btree (scope, COALESCE((scope_id)::text, ''::text), key);


--
-- Name: jobs jobs_outbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES public.outbox(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict QmUmk4XFkaNb2QYko7Hbyxf39GE1NZcQRzr6wbAYefEtT32wRk6gbLg4ArZk0io

