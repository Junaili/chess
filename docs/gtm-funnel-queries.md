# GTM Funnel — AFS Queries (step 2)

Rerunnable Athena SQL for the acquisition/activity funnel, built on the step-1
telemetry events (`src/telemetry.js` — every event carries `device_id`,
`session_id`, `platform`, and UTM fields in `payload`).

**How to run:** `POST /afs/v1/admin/namespaces/seal-chessags/queries` with
`{"sql": "…"}` (Athena Facade; MCP `run-apis`, spec `athena-facade-poc`).
Fast path returns rows inline; otherwise poll `GET …/queries/{id}`.

**Warehouse layout (discovered 2026-07-03):**
- Custom game telemetry: schema **`foundations_prod_game_telemetry_event`**,
  one table per event named `telemetry_<event_name>`
  (e.g. `telemetry_game_started`, `telemetry_matchmaking_result`).
- Platform events: schema `foundations_prod_ags_event`, topic-per-table
  (`useraccount_useraccountcreated`, `userauthentication_userloggedin`,
  `mpv2sessionhistory_*`…).
- Columns (telemetry tables): `userid`, `clienttimestamp` (ISO string),
  `eventname`, `payload` (JSON string → `json_extract_scalar`),
  partitions `namespacez`/`year`/`month`/`day`.
- **Every query must include `WHERE namespacez = 'seal-chessags'`** (facade
  guard; AST-checked). For `information_schema` discovery, satisfy it via a
  CTE: `WITH t AS (SELECT 'seal-chessags' AS namespacez) SELECT … FROM
  information_schema.tables, t WHERE namespacez = 'seal-chessags' AND …`.
- Facade is SELECT/WITH-only, and metered (~$10 lifetime cap on the POC —
  check the dashboard usage header before heavy scans).

## 1. Activity funnel — all users, trailing 30 days

Distinct users reaching each stage. First run (2026-07-03):
6 → 3 → 3 → 3 → 2.

```sql
WITH li AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_user_logged_in
            WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     mm AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_matchmaking_started
            WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     gs AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_game_started
            WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     gc AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_game_completed
            WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     ret AS (SELECT userid FROM foundations_prod_game_telemetry_event.telemetry_game_started
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day
             GROUP BY userid HAVING count(DISTINCT date(from_iso8601_timestamp(clienttimestamp))) >= 2)
SELECT 1 AS ord, '1. logged in' AS stage, count(*) AS users FROM li
UNION ALL SELECT 2, '2. played a game', count(*) FROM li WHERE userid IN (SELECT userid FROM gs)
UNION ALL SELECT 3, '3. completed a game', count(*) FROM li WHERE userid IN (SELECT userid FROM gc)
UNION ALL SELECT 4, '4. tried matchmaking', count(*) FROM li WHERE userid IN (SELECT userid FROM mm)
UNION ALL SELECT 5, '5. returned another day', count(*) FROM li WHERE userid IN (SELECT userid FROM ret)
ORDER BY ord
```

## 2. New-user acquisition funnel — registered cohort, trailing 30 days

Same stages but restricted to users who **registered inside the window**
(true acquisition view; distinguishes new-user activation from veteran
activity). First run: 4 → 1 → 0 → 0 → 0 — new signups aren't converting to
play; the active players are pre-existing accounts.

```sql
WITH reg AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_user_registered
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     li  AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_user_logged_in
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     gs  AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_game_started
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     gc  AS (SELECT DISTINCT userid FROM foundations_prod_game_telemetry_event.telemetry_game_completed
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day),
     ret AS (SELECT userid FROM foundations_prod_game_telemetry_event.telemetry_game_started
             WHERE namespacez = 'seal-chessags' AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day
             GROUP BY userid HAVING count(DISTINCT date(from_iso8601_timestamp(clienttimestamp))) >= 2)
SELECT 1 AS ord, 'registered' AS stage, count(*) AS users FROM reg
UNION ALL SELECT 2, 'logged_in', count(*) FROM reg WHERE userid IN (SELECT userid FROM li)
UNION ALL SELECT 3, 'played_a_game', count(*) FROM reg WHERE userid IN (SELECT userid FROM gs)
UNION ALL SELECT 4, 'completed_a_game', count(*) FROM reg WHERE userid IN (SELECT userid FROM gc)
UNION ALL SELECT 5, 'returned_2nd_day', count(*) FROM reg WHERE userid IN (SELECT userid FROM ret)
ORDER BY ord
```

Caveat: `user_logged_in` may not fire during the registration session itself
(1/4 here), so stage-2 undercounts same-session activation — consider joining
`game_started` directly against the cohort as the activation stage instead.

## 3. Matchmaking health — outcomes & wait times, trailing 30 days

The cold-start bot's report card. First run: `found` 14 @ avg **23.1s**
(20s gate + claim + queue — exactly as designed), `timeout` 11 @ 121s
(pre-bot / bot-down periods), `cancelled` 5.

```sql
SELECT json_extract_scalar(payload, '$.result') AS result,
       count(*) AS searches,
       round(avg(CAST(json_extract_scalar(payload, '$.wait_seconds') AS double)), 1) AS avg_wait_s,
       max(CAST(json_extract_scalar(payload, '$.wait_seconds') AS double)) AS max_wait_s
FROM foundations_prod_game_telemetry_event.telemetry_matchmaking_result
WHERE namespacez = 'seal-chessags'
  AND from_iso8601_timestamp(clienttimestamp) > current_timestamp - interval '30' day
GROUP BY 1 ORDER BY 2 DESC
```

## Next iterations (when there's traffic)

- **UTM attribution**: `json_extract_scalar(payload, '$.utm_source')` on
  `telemetry_user_registered` — registrations (and their downstream funnel)
  by channel.
- **Weekly funnel trend**: group stage counts by `date_trunc('week', …)` to
  watch conversion move.
- **Invite loop**: `telemetry_invite_sent` → `useraccount_useraccountcreated`
  join (invitee attribution via the referral payload).
- Dashboard pinning: the AFS POC's `pinned-queries` endpoint isn't deployed
  yet (404) — re-check later; until then, re-run these queries ad hoc.
