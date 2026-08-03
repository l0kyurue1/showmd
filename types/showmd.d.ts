// Option records passed between server modules. These exist because the
// `function f({ a, b } = {})` pattern hides any option that has no default:
// the inferred type comes from the `{}`, not from the call sites.

export type WalkMd = (dir: string, root: string, out: any[]) => Promise<any[]>;

export interface SkillRoot {
  dir: string;
  key?: string;
  label: string;
  project?: string | null;
}

export interface TreeCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface AgentTreeOptions {
  home?: string;
  cwd?: string;
  ttlMs?: number;
  now?: () => number;
}

export interface StoreTreeOptions {
  agent?: string;
  skillsMode?: string;
  home?: string;
  cwd?: string;
}

export interface LocateOptions {
  anyExt?: boolean;
}

export interface SkillsTreeOptions {
  // required: injected unconditionally and invoked with no fallback
  walkMd: WalkMd;
  home?: string;
  cwd?: string;
  mode?: string;
}

export interface DiscoverRootsOptions {
  mode?: string;
  projectDirs?: string[];
  home?: string;
  claudeJsonPath?: string;
}

export interface RevealOptions {
  settings?: boolean;
  path?: string;
}
