ALTER TABLE `hooks` RENAME TO `functions`;--> statement-breakpoint
ALTER TABLE `runs` RENAME COLUMN "inflight_hook" TO "inflight_function";
--> statement-breakpoint
-- One-time data migration; runtime reads only the Function schema.
UPDATE functions SET data = json_set(data, '$.config.endpoint', 'http://127.0.0.1:8789/functions/code') WHERE json_extract(data, '$.config.endpoint') = 'http://127.0.0.1:8789/hooks/code';
--> statement-breakpoint
UPDATE tasks SET data = json_remove(json_set(data, '$.functions', json((SELECT json_group_array(json(CASE WHEN json_extract(value, '$.config.endpoint') = 'http://127.0.0.1:8789/hooks/code' THEN json_set(value, '$.config.endpoint', 'http://127.0.0.1:8789/functions/code') ELSE value END)) FROM json_each(COALESCE(json_extract(tasks.data, '$.functions'), json_extract(tasks.data, '$.hooks'), '[]'))))), '$.hooks');
--> statement-breakpoint
UPDATE runs SET data = json_remove(json_set(data,
  '$.definition.functions', json((SELECT json_group_array(json(CASE WHEN runs.status IN ('running', 'paused') AND json_extract(value, '$.config.endpoint') = 'http://127.0.0.1:8789/hooks/code' THEN json_set(value, '$.config.endpoint', 'http://127.0.0.1:8789/functions/code') ELSE value END)) FROM json_each(COALESCE(json_extract(runs.data, '$.definition.functions'), json_extract(runs.data, '$.definition.hooks'), '[]')))),
  '$.functionIndex', COALESCE(json_extract(data, '$.functionIndex'), json_extract(data, '$.hookIndex'), 0),
  '$.kind', COALESCE(json_extract(data, '$.kind'), 'task'),
  '$.steps', json((SELECT json_group_array(json(json_remove(json_set(value, '$.functionId', COALESCE(json_extract(value, '$.functionId'), json_extract(value, '$.hookId'), ''), '$.functionName', COALESCE(json_extract(value, '$.functionName'), json_extract(value, '$.hookName'), '')), '$.hookId', '$.hookName'))) FROM json_each(COALESCE(json_extract(runs.data, '$.steps'), '[]')))),
  '$.resources', json((SELECT json_group_array(json(json_remove(json_set(value, '$.functionId', COALESCE(json_extract(value, '$.functionId'), json_extract(value, '$.hookId'), '')), '$.hookId'))) FROM json_each(COALESCE(json_extract(runs.data, '$.resources'), '[]')))),
  '$.logs', json((SELECT json_group_array(json(json_remove(CASE WHEN json_type(value, '$.functionId') IS NOT NULL OR json_type(value, '$.hookId') IS NOT NULL THEN json_set(value, '$.functionId', COALESCE(json_extract(value, '$.functionId'), json_extract(value, '$.hookId'))) ELSE value END, '$.hookId'))) FROM json_each(COALESCE(json_extract(runs.data, '$.logs'), '[]'))))
), '$.definition.hooks', '$.hookIndex');
