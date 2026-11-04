// closed observed sessions are forgotten after the same seven days that transitions are kept
export const RETENTION_MS = 604_800_000;

/*
 * Running and waiting sessions by their latest state change, with the idle ones among the included
 * sessions, which run background commands. A managed thread is active only while a runtime binds
 * it, which its runtime epoch index finds; a stopping one reports the state it stops, from its
 * last transition. An observed Codex session carries what the first read of it found, and an
 * observed Claude session joins its indexed transcript, if any, by session ID. The included
 * sessions are one JSON array of [provider, native ID] pairs.
 */
export const ACTIVE_SESSIONS = `WITH included(provider, native_id) AS (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
)
SELECT provider, native_id, state, changed_at, thread, observed_thread, history FROM (
  SELECT agent_hq_thread.provider, agent_hq_thread.native_id,
    EXISTS (SELECT 1 FROM included WHERE included.provider = agent_hq_thread.provider AND included.native_id = agent_hq_thread.native_id) AS is_included,
    coalesce(map.session_state, (SELECT state FROM agent_hq_session_transition WHERE thread_id = agent_hq_thread.id ORDER BY sequence DESC LIMIT 1), 'unknown') AS state,
    coalesce((SELECT recorded_at FROM agent_hq_session_transition WHERE thread_id = agent_hq_thread.id ORDER BY sequence DESC LIMIT 1), agent_hq_thread.updated_at) AS changed_at,
    json_object('id', agent_hq_thread.id, 'ownership', agent_hq_thread.ownership, 'name', agent_hq_thread.name,
      'workspaceRoot', agent_hq_thread.workspace_root, 'nativeLineage', json(agent_hq_thread.native_lineage),
      'createdAt', agent_hq_thread.created_at, 'updatedAt', agent_hq_thread.updated_at) AS thread,
    NULL AS observed_thread, NULL AS history
  FROM agent_hq_thread INNER JOIN agent_hq_session_state_map AS map ON map.thread_state = agent_hq_thread.state
  WHERE agent_hq_thread.runtime_epoch IS NOT NULL AND agent_hq_thread.native_id IS NOT NULL AND (map.session_state IS NULL OR map.session_state IN ('running', 'waiting')
    OR EXISTS (SELECT 1 FROM included WHERE included.provider = agent_hq_thread.provider AND included.native_id = agent_hq_thread.native_id))
  UNION ALL
  SELECT observed.provider, observed.native_id,
    EXISTS (SELECT 1 FROM included WHERE included.provider = observed.provider AND included.native_id = observed.native_id),
    observed.state, observed.observed_at, NULL,
    CASE WHEN observed.provider = 'codex' AND observed.workspace_root IS NOT NULL THEN json_object('workspaceRoot', observed.workspace_root,
      'name', observed.name, 'createdAt', observed.created_at) END,
    CASE WHEN observed.provider = 'claude' THEN (
      SELECT json_object('name', name, 'createdAt', created_at, 'updatedAt', updated_at,
        'isSupported', json(CASE WHEN supported = 1 THEN 'true' ELSE 'false' END))
      FROM agent_hq_claude_file WHERE native_id = observed.native_id AND workspace_state = 'matching'
      ORDER BY updated_at DESC LIMIT 1
    ) END
  FROM agent_hq_observed_session AS observed WHERE observed.state IN ('running', 'waiting')
    OR EXISTS (SELECT 1 FROM included WHERE included.provider = observed.provider AND included.native_id = observed.native_id)
) WHERE state IN ('running', 'waiting') OR (is_included AND state = 'idle')
ORDER BY changed_at DESC, native_id DESC LIMIT ?`;
