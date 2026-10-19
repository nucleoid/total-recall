#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Full backup/restore rehearsal. It never stops or mutates the source database.
usage() {
  echo "usage: $0 --expected-host HOST --database total_recall --execution-id ID --output-base \$HOME/.local/share/total-recall/reembedding-execution --restore-image-digest sha256:HEX [--dump-timeout-seconds 3500 --restore-timeout-seconds 21600]" >&2
  exit 2
}
expected_host= database= execution_id= output_base= restore_image_digest=
dump_timeout=3500 restore_timeout=21600
while (($#)); do case "$1" in
  --expected-host) expected_host=${2-}; shift 2;; --database) database=${2-}; shift 2;;
  --execution-id) execution_id=${2-}; shift 2;; --output-base) output_base=${2-}; shift 2;;
  --restore-image-digest) restore_image_digest=${2-}; shift 2;;
  --dump-timeout-seconds) dump_timeout=${2-}; shift 2;; --restore-timeout-seconds) restore_timeout=${2-}; shift 2;;
  *) usage;; esac; done
[[ -n $expected_host && -n $database && -n $execution_id && -n $output_base && $restore_image_digest =~ ^sha256:[a-f0-9]{64}$ ]] || usage
[[ $(hostname) == "$expected_host" ]] || { echo backup.host_identity >&2; exit 1; }
[[ $database == total_recall ]] || { echo backup.database_identity >&2; exit 1; }
[[ $execution_id =~ ^[a-z0-9][a-z0-9._-]{5,63}$ ]] || { echo backup.execution_id >&2; exit 1; }
[[ $output_base == "$HOME/.local/share/total-recall/reembedding-execution" ]] || { echo backup.output_base >&2; exit 1; }
[[ $dump_timeout =~ ^[0-9]+$ && $dump_timeout -ge 600 && $dump_timeout -le 3500 ]] || { echo backup.dump_timeout >&2; exit 1; }
[[ $restore_timeout =~ ^[0-9]+$ && $restore_timeout -ge 3600 && $restore_timeout -le 43200 ]] || { echo backup.restore_timeout >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${PGDATABASE:-} && -z ${PGHOST:-} && -z ${PGPORT:-} && -z ${PGUSER:-} && -z ${PGPASSWORD:-} ]] || { echo backup.database_environment_forbidden >&2; exit 1; }
for command in sudo psql pg_dump pg_restore docker sha256sum timeout nice ionice env realpath stat df awk cmp date; do
  command -v "$command" >/dev/null || { echo "backup.missing_command.$command" >&2; exit 1; }
done
sudo -n -u postgres true || { echo backup.postgres_peer_access >&2; exit 1; }
[[ $(sudo -n -u postgres pg_dump --version) =~ PostgreSQL\)\ 16\. ]] || { echo backup.pg_dump_major >&2; exit 1; }
restore_image="pgvector/pgvector@$restore_image_digest"
docker manifest inspect "$restore_image" >/dev/null || { echo backup.exact_restore_image_unavailable >&2; exit 1; }

mkdir -p "$output_base"
[[ ! -L $output_base && $(realpath "$output_base") == "$output_base" ]] || { echo backup.output_path >&2; exit 1; }
[[ $(stat -c %U "$output_base") == "$(id -un)" ]] || { echo backup.output_owner >&2; exit 1; }
chmod 700 "$output_base"
run_dir="$output_base/$execution_id"; mkdir "$run_dir"; chmod 700 "$run_dir"
dump_file="$run_dir/total_recall.custom"; roles_file="$run_dir/required-roles.sql"
before_file="$run_dir/source-receipt.json"; after_file="$run_dir/restore-receipt.json"
receipt_sql="$run_dir/receipt.sql"; final_file="$run_dir/rehearsal-receipt.json"; restart_file="$run_dir/restart-receipt.json"
container="total-recall-restore-$execution_id"; label="total-recall.reembedding-restore=$execution_id"
dump_application_name="total-recall-backup-$execution_id"
receipt_application_name="total-recall-receipt-$execution_id"
[[ ${#dump_application_name} -le 63 && ${#receipt_application_name} -le 63 ]] || { echo backup.application_name_length >&2; exit 1; }
minimum_free=$((80*1024*1024*1024)); maximum_dump=$((40*1024*1024*1024)); snapshot_holder_pid=
minimum_host_available=$((2*1024*1024*1024)); maximum_memory_psi_avg10=1.0; pressure_failures=0
host_pressure_ok() {
  available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  psi_avg10=$(awk '/^some / {for(i=1;i<=NF;i++)if($i~/^avg10=/){split($i,a,"=");print a[2]}}' /proc/pressure/memory)
  [[ $available_kb =~ ^[0-9]+$ && -n $psi_avg10 ]] || return 1
  [[ $((available_kb*1024)) -ge $minimum_host_available ]] || return 1
  awk -v actual="$psi_avg10" -v maximum="$maximum_memory_psi_avg10" 'BEGIN{exit !(actual<=maximum)}'
}
pressure_trip() { if host_pressure_ok; then pressure_failures=0; return 1; fi; pressure_failures=$((pressure_failures+1)); [[ $pressure_failures -ge 3 ]]; }
cancel_owned_dump() {
  sudo -n -u postgres psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1 \
    -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname='$database' AND usename='postgres' AND backend_type='client backend' AND application_name='$dump_application_name' AND pid<>pg_backend_pid()" \
    >/dev/null 2>&1 || true
}
cancel_owned_receipt() {
  sudo -n -u postgres psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1 \
    -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname='$database' AND usename='postgres' AND backend_type='client backend' AND application_name='$receipt_application_name' AND pid<>pg_backend_pid()" \
    >/dev/null 2>&1 || true
}
cleanup() {
  cancel_owned_dump
  cancel_owned_receipt
  if [[ -n ${snapshot_holder_pid:-} ]] && kill -0 "$snapshot_holder_pid" 2>/dev/null; then kill -TERM "$snapshot_holder_pid" 2>/dev/null || true; wait "$snapshot_holder_pid" 2>/dev/null || true; fi
  owned=$(docker ps -aq --filter "name=^/${container}$" --filter "label=$label" 2>/dev/null || true)
  [[ -z $owned ]] || docker rm -fv "$owned" >/dev/null
}
trap cleanup EXIT
free_bytes() { df -PB1 "$1" | awk 'NR==2 {print $4}'; }
[[ $(free_bytes "$output_base") -ge $minimum_free ]] || { echo backup.output_disk_guard >&2; exit 1; }
docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ -n $docker_root && $(free_bytes "$docker_root") -ge $minimum_free ]] || { echo backup.docker_disk_guard >&2; exit 1; }
host_pressure_ok || { echo backup.host_pressure_guard >&2; exit 1; }

identity=$(sudo -n -u postgres psql -XAt --no-password -d "$database" -v ON_ERROR_STOP=1 -c "SELECT current_database()||'|'||current_user||'|'||(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())")
[[ $identity == "$database|postgres|"* ]] || { echo backup.database_identity >&2; exit 1; }
db_owner=${identity##*|}; [[ $db_owner == total_recall || $db_owner == postgres ]] || { echo backup.database_owner >&2; exit 1; }
source_server_version=$(sudo -n -u postgres psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1 -c "SHOW server_version_num")
[[ $source_server_version =~ ^16[0-9]{4}$ ]] || { echo backup.source_server_major >&2; exit 1; }

sudo -n -u postgres psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1 >"$roles_file" <<'SQL'
DO $b$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE (rolname='postgres' OR rolname!~'^pg_') AND rolconfig IS NOT NULL) THEN
    RAISE EXCEPTION 'backup.role_settings_require_separate_secret_review';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    WHERE (member.rolname='postgres' OR member.rolname!~'^pg_')
      AND (m.admin_option OR NOT m.inherit_option OR NOT m.set_option)) THEN
    RAISE EXCEPTION 'backup.nondefault_role_membership_options';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE parent.rolname!~'^pg_' AND member.rolname~'^pg_') THEN
    RAISE EXCEPTION 'backup.unsupported_system_role_membership';
  END IF;
END $b$;
SELECT CASE WHEN rolname='postgres' OR rolname~'^pg_' THEN '' ELSE format('CREATE ROLE %I;',rolname) END || E'\n' ||
 format('ALTER ROLE %I WITH %s %s %s %s %s %s %s CONNECTION LIMIT %s VALID UNTIL %L;',rolname,
 CASE WHEN rolsuper THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END,CASE WHEN rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
 CASE WHEN rolcreaterole THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END,CASE WHEN rolcreatedb THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
 CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,CASE WHEN rolreplication THEN 'REPLICATION' ELSE 'NOREPLICATION' END,
 CASE WHEN rolbypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END,rolconnlimit,COALESCE(rolvaliduntil::text,'infinity'))
FROM pg_roles WHERE rolname='postgres' OR rolname!~'^pg_' ORDER BY rolname;
SELECT format('GRANT %I TO %I;',parent.rolname,member.rolname)
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
WHERE member.rolname='postgres' OR member.rolname!~'^pg_' ORDER BY parent.rolname,member.rolname;
SQL
chmod 600 "$roles_file"
for role in total_recall total_recall_app total_recall_fts_owner postgres; do grep -Eq "ROLE \"?${role}\"?" "$roles_file" || { echo "backup.required_role.$role" >&2; exit 1; }; done

cat >"$receipt_sql" <<'SQL'
SET LOCAL statement_timeout='15min';
SET LOCAL max_parallel_workers_per_gather=0;
SET LOCAL work_mem='4MB';
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
SET LOCAL extra_float_digits=3;
SELECT jsonb_pretty(jsonb_build_object(
 'database',current_database(),'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'server_major',current_setting('server_version_num')::integer/10000,
 'encoding',pg_encoding_to_char((SELECT encoding FROM pg_database WHERE datname=current_database())),
 'collation',(SELECT datcollate FROM pg_database WHERE datname=current_database()),'ctype',(SELECT datctype FROM pg_database WHERE datname=current_database()),
 'locale_provider',(SELECT datlocprovider FROM pg_database WHERE datname=current_database()),
 'icu_locale',(SELECT daticulocale FROM pg_database WHERE datname=current_database()),
 'extensions',(SELECT jsonb_object_agg(extname,extversion ORDER BY extname) FROM pg_extension WHERE extname IN ('vector','pgcrypto')),
 'ledger',(SELECT jsonb_build_object('count',count(*),'max',max(version),'digest',encode(digest(COALESCE(string_agg(version,',' ORDER BY version),''),'sha256'),'hex')) FROM schema_migrations),
 'counts',(SELECT jsonb_object_agg(name,row_count ORDER BY name) FROM (
   SELECT name,CASE WHEN to_regclass('public.'||name) IS NULL THEN NULL ELSE
    ((xpath('/row/count/text()',query_to_xml(format('SELECT count(*) AS count FROM public.%I',name),false,true,'')))[1]::text)::bigint END row_count
   FROM unnest(ARRAY['memories','documents','memory_subscriptions','audit_log','memory_embedding_manifests','memory_embedding_chunks','subscription_embedding_targets','shadow_subscription_insert_events']) name) c),
 'derived_fingerprints',(SELECT jsonb_object_agg(name,fingerprint ORDER BY name) FROM (SELECT name,
   CASE WHEN to_regclass('public.'||name) IS NULL THEN NULL ELSE
    ((xpath('/row/value/text()',query_to_xml(format($q$SELECT jsonb_build_object('rows',count(*),
      'hash_a',COALESCE(sum((('x'||substr(encode(digest(to_jsonb(t)::text,'sha256'),'hex'),1,16))::bit(64)::bigint)::numeric),0),
      'hash_b',COALESCE(sum((('x'||substr(encode(digest(to_jsonb(t)::text,'sha256'),'hex'),17,16))::bit(64)::bigint)::numeric),0)) AS value FROM public.%I t$q$,name),false,true,'')))[1]::text)::jsonb END fingerprint
   FROM unnest(ARRAY['memories','documents','memory_subscriptions','audit_log','memory_embedding_manifests','memory_embedding_chunks','subscription_embedding_targets','shadow_subscription_insert_events','embedding_work_items','embedding_runs','embedding_cutover_attestations','embedding_serving_settings']) name) fingerprints),
 'sequence_digest',(SELECT encode(digest(COALESCE(string_agg(schemaname||'.'||sequencename||'|'||start_value||'|'||min_value||'|'||max_value||'|'||increment_by||'|'||cycle||'|'||cache_size||'|'||COALESCE(last_value::text,'NULL'),E'\n' ORDER BY schemaname,sequencename),''),'sha256'),'hex') FROM pg_sequences WHERE schemaname='public'),
 'role_prerequisite_digest',(SELECT encode(digest(COALESCE(string_agg(item,E'\n' ORDER BY item),''),'sha256'),'hex') FROM (
   SELECT rolname||'|'||rolsuper||'|'||rolinherit||'|'||rolcreaterole||'|'||rolcreatedb||'|'||rolcanlogin||'|'||rolreplication||'|'||rolbypassrls||'|'||rolconnlimit||'|'||COALESCE(rolvaliduntil::text,'') item
   FROM pg_roles WHERE rolname='postgres' OR rolname!~'^pg_'
   UNION ALL SELECT parent.rolname||'->'||member.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
   WHERE member.rolname='postgres' OR member.rolname!~'^pg_'
   UNION ALL SELECT rolname||'|config|'||COALESCE(rolconfig::text,'') FROM pg_roles WHERE rolname='postgres' OR rolname!~'^pg_') role_items),
 'memory_aggregates',(SELECT jsonb_build_object('source_bytes',COALESCE(sum(octet_length(content)),0),
   'complete_row_hash_sum',COALESCE(sum((('x'||substr(encode(digest(to_jsonb(memories)::text,'sha256'),'hex'),1,16))::bit(64)::bigint)::numeric),0),
   'source_hash_sum',COALESCE(sum((('x'||substr(encode(digest(content,'sha256'),'hex'),1,16))::bit(64)::bigint)::numeric),0),
   'canonical_vectors',count(*) FILTER(WHERE embedding IS NOT NULL),'deleted',count(*) FILTER(WHERE deleted_at IS NOT NULL),
   'superseded',count(*) FILTER(WHERE superseded_at IS NOT NULL),'consolidated',count(*) FILTER(WHERE consolidated_into_id IS NOT NULL),
   'expires_set',count(*) FILTER(WHERE expires_at IS NOT NULL)) FROM memories),
 'document_aggregates',(SELECT jsonb_build_object('rows',count(*),'content_bytes',COALESCE(sum(content_bytes),0),'chunks',COALESCE(sum(chunk_count),0)) FROM documents),
 'topology_acl_digest',(SELECT encode(digest(COALESCE(string_agg(item,E'\n' ORDER BY item),''),'sha256'),'hex') FROM (
   SELECT n.nspname||'.'||c.relname||'|'||c.relkind::text||'|'||pg_get_userbyid(c.relowner)||'|'||c.relrowsecurity::text||'|'||COALESCE(c.relacl::text,'') item
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','i','S','v','m')
   UNION ALL SELECT schemaname||'.'||tablename||'|'||policyname||'|'||roles::text||'|'||cmd||'|'||COALESCE(qual,'')||'|'||COALESCE(with_check,'') FROM pg_policies WHERE schemaname='public'
   UNION ALL SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||pg_get_userbyid(p.proowner)||'|'||COALESCE(p.proacl::text,'')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') topology)
));
SQL
chmod 600 "$receipt_sql"

# Export one bounded read-only snapshot. Receipt and pg_dump both import it.
coproc SNAPSHOT_HOLDER { sudo -n -u postgres psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1; }
snapshot_holder_pid=$SNAPSHOT_HOLDER_PID
printf "%s\n" "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='1h'; SELECT current_database()||'|'||pg_export_snapshot();" >&"${SNAPSHOT_HOLDER[1]}"
IFS='|' read -r snapshot_database snapshot_id <&"${SNAPSHOT_HOLDER[0]}"
[[ $snapshot_database == "$database" && $snapshot_id =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$ ]] || { echo backup.snapshot_identity >&2; exit 1; }
{ printf "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '%s';\n" "$snapshot_id"; cat "$receipt_sql"; printf 'COMMIT;\n'; } |
 sudo -n -u postgres env PGAPPNAME="$receipt_application_name" psql -XAtq --no-password -d "$database" -v ON_ERROR_STOP=1 >"$before_file" &
receipt_pid=$!; pressure_failures=0
while kill -0 "$receipt_pid" 2>/dev/null; do if pressure_trip; then kill -TERM "$receipt_pid" 2>/dev/null || true; cancel_owned_receipt; echo backup.host_pressure_guard >&2; exit 1; fi; sleep 5; done
wait "$receipt_pid"
chmod 600 "$before_file"

# RLIMIT_FSIZE is 40 GiB; the loop also enforces free space throughout the dump.
( ulimit -f 83886080; timeout --signal=TERM --kill-after=60 "$dump_timeout" nice -n 10 ionice -c2 -n7 sudo -n -u postgres env PGAPPNAME="$dump_application_name" pg_dump -Fc --create --no-password --compress=6 --lock-wait-timeout=5s --snapshot="$snapshot_id" -d "$database" ) >"$dump_file" &
dump_pid=$!; guard_failure=
while kill -0 "$dump_pid" 2>/dev/null; do
  current_size=$(stat -c %s "$dump_file" 2>/dev/null || echo 0)
  if [[ $current_size -gt $maximum_dump ]]; then guard_failure=backup.dump_size_guard; kill -TERM "$dump_pid" 2>/dev/null || true; cancel_owned_dump; break; fi
  if [[ $(free_bytes "$output_base") -lt $minimum_free ]]; then guard_failure=backup.output_disk_guard; kill -TERM "$dump_pid" 2>/dev/null || true; cancel_owned_dump; break; fi
  if pressure_trip; then guard_failure=backup.host_pressure_guard; kill -TERM "$dump_pid" 2>/dev/null || true; cancel_owned_dump; break; fi
  sleep 5
done
set +e; wait "$dump_pid"; dump_status=$?; set -e
[[ -z $guard_failure ]] || { echo "$guard_failure" >&2; exit 1; }
[[ $dump_status -eq 0 ]] || { echo backup.dump_failed >&2; exit 1; }
printf 'COMMIT;\\q\n' >&"${SNAPSHOT_HOLDER[1]}"; wait "$snapshot_holder_pid"; snapshot_holder_pid=
chmod 600 "$dump_file"; [[ $(stat -c %s "$dump_file") -le $maximum_dump ]] || { echo backup.dump_size_guard >&2; exit 1; }
dump_sha=$(sha256sum "$dump_file" | awk '{print $1}'); pg_restore --list "$dump_file" >/dev/null
[[ $(free_bytes "$docker_root") -ge $minimum_free ]] || { echo backup.docker_disk_guard >&2; exit 1; }

docker run --detach --name "$container" --label "$label" --network none --memory 768m --memory-swap 768m --cpus 1 --pids-limit 256 --shm-size 128m -e POSTGRES_HOST_AUTH_METHOD=trust --mount "type=bind,src=$run_dir,dst=/rehearsal,readonly" "$restore_image" >/dev/null
ready=false; for _ in $(seq 1 60); do if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || { echo backup.restore_database_not_ready >&2; exit 1; }
runtime_versions=$(docker exec "$container" psql -XAt -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT current_setting('server_version_num')::integer/10000||'|'||(SELECT default_version FROM pg_available_extensions WHERE name='vector')")
[[ $runtime_versions == '16|0.6.0' ]] || { echo backup.restore_runtime_version >&2; exit 1; }
restore_server_version=$(docker exec "$container" psql -XAtq -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SHOW server_version_num")
docker exec -i "$container" psql -Xq -U postgres -v ON_ERROR_STOP=1 <"$roles_file"
timeout --signal=TERM --kill-after=60 "$restore_timeout" docker exec "$container" nice -n 10 pg_restore --create --exit-on-error --no-password -U postgres --dbname postgres /rehearsal/total_recall.custom &
restore_pid=$!; pressure_failures=0; restore_guard_failure=
while kill -0 "$restore_pid" 2>/dev/null; do
  if [[ $(free_bytes "$docker_root") -lt $minimum_free ]]; then restore_guard_failure=backup.docker_disk_guard; kill -TERM "$restore_pid" 2>/dev/null || true; break; fi
  if pressure_trip; then restore_guard_failure=backup.host_pressure_guard; kill -TERM "$restore_pid" 2>/dev/null || true; break; fi
  sleep 5
done
set +e; wait "$restore_pid"; restore_status=$?; set -e
[[ -z $restore_guard_failure ]] || { echo "$restore_guard_failure" >&2; exit 1; }
[[ $restore_status -eq 0 ]] || { echo backup.restore_failed >&2; exit 1; }
docker exec "$container" psql -XAtq -1 -U postgres -d total_recall -v ON_ERROR_STOP=1 -f /rehearsal/receipt.sql >"$after_file"
chmod 600 "$after_file"; cmp --silent "$before_file" "$after_file" || { echo backup.restore_receipt_mismatch >&2; exit 1; }
docker restart "$container" >/dev/null
ready=false; for _ in $(seq 1 60); do if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || { echo backup.restart_database_not_ready >&2; exit 1; }
docker exec "$container" psql -XAtq -1 -U postgres -d total_recall -v ON_ERROR_STOP=1 -f /rehearsal/receipt.sql >"$restart_file"
chmod 600 "$restart_file"; cmp --silent "$before_file" "$restart_file" || { echo backup.restart_receipt_mismatch >&2; exit 1; }
image_id=$(docker inspect --format '{{.Image}}' "$container")
before_sha=$(sha256sum "$before_file"|awk '{print $1}'); after_sha=$(sha256sum "$after_file"|awk '{print $1}'); restart_sha=$(sha256sum "$restart_file"|awk '{print $1}'); roles_sha=$(sha256sum "$roles_file"|awk '{print $1}'); receipt_sql_sha=$(sha256sum "$receipt_sql"|awk '{print $1}')
printf '{"schema":2,"status":"passed","execution_id":"%s","database":"%s","source_host":"%s","source_server_version_num":"%s","restore_server_version_num":"%s","completed_at":"%s","image":"%s","image_digest":"%s","image_id":"%s","dump_sha256":"%s","dump_bytes":%s,"source_receipt_sha256":"%s","restore_receipt_sha256":"%s","restart_receipt_sha256":"%s","roles_sha256":"%s","receipt_sql_sha256":"%s","auth_secrets_restored":false}\n' "$execution_id" "$database" "$expected_host" "$source_server_version" "$restore_server_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" pgvector/pgvector:0.6.0-pg16 "$restore_image_digest" "$image_id" "$dump_sha" "$(stat -c %s "$dump_file")" "$before_sha" "$after_sha" "$restart_sha" "$roles_sha" "$receipt_sql_sha" >"$final_file"
chmod 600 "$final_file"; echo "$final_file"
