-- Prompt-cache token counts, captured per session so "total tokens processed"
-- can be shown without another trace re-upload. Claude Code:
-- cache_read_input_tokens / cache_creation_input_tokens (disjoint from
-- input_tokens). Codex: cached_input_tokens (a subset of its input_tokens);
-- it reports no cache-creation figure.
ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
-- Reasoning/thinking output (Codex only; Claude Code folds it into output).
ALTER TABLE sessions ADD COLUMN reasoning_output_tokens INTEGER NOT NULL DEFAULT 0;
-- Server-side web tool invocations, deduped per API request.
ALTER TABLE sessions ADD COLUMN web_search_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN web_fetch_requests INTEGER NOT NULL DEFAULT 0;
-- Subagent (Task tool) spend from completed results' toolUseResult.usage —
-- the only record of it in the uploaded trace (subagent transcripts live in
-- separate, never-uploaded files). Deduped by agentId.
ALTER TABLE sessions ADD COLUMN subagent_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN subagent_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN subagent_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN subagent_cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
