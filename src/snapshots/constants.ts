// each artifact set has three fixed files; the inventory grows on disk one bounded line at a time
export const SNAPSHOT_MANIFEST = 'manifest.jsonl';
export const SNAPSHOT_COMPLETE = 'complete.json';
// includes the durably bounded 128-root header with escaped host paths
export const SNAPSHOT_LINE_BYTES = 4_194_304;
export const SNAPSHOT_COPY_BYTES = 65_536;
export const SNAPSHOT_COMPANIONS = [
  ['plan', 'plan.md', 1_048_576],
  ['milestones', 'milestones.md', 1_048_576],
  ['coordination', 'coordination.json', 8_388_608],
] as const;
