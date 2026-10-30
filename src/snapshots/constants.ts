// the manifest holds three fixed records: the header, the database and the action key
export const SNAPSHOT_MANIFEST = 'manifest.jsonl';
export const SNAPSHOT_COMPLETE = 'complete.json';
// includes the durably bounded 128-root header with escaped host paths
export const SNAPSHOT_LINE_BYTES = 4_194_304;
export const SNAPSHOT_COPY_BYTES = 65_536;
