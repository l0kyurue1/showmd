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

export interface Root {
  key: string;
  dir: string;
  name: string;
}

export interface RootScope {
  rootKey: string;
  scopePath: string;
}

export type RootAddResult =
  | { kind: 'added'; root: Root; scope: RootScope }
  | { kind: 'existing'; root: Root; scope: RootScope }
  | { kind: 'ancestor_conflict'; fallback: 'isolated'; target: Root; conflictingRoots: Root[] };

export type RootRelation = 'same' | 'ancestor' | 'descendant' | 'disjoint';

export interface RestartInstanceMetadata {
  instanceId: string;
  pid: number;
  startedAt: string;
  actualPort?: number;
}

export interface RestartHandoffSnapshot {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  oldInstance: RestartInstanceMetadata;
  newInstance: RestartInstanceMetadata;
  roots: Root[];
  skillsContexts: SkillsContextReference[];
}

// Skills and Agents documentRoute values are opaque, server-emitted route
// tails. Consumers must not derive them from provider-specific document ids.
export type SkillsRouteContext =
  | { space: 'skills'; selection: 'global'; documentRoute?: string }
  | { space: 'skills'; selection: 'all'; documentRoute?: string }
  | { space: 'skills'; selection: 'root'; rootKey: string; documentRoute?: string }
  | { space: 'skills'; selection: 'context'; contextKey: string; documentRoute?: string };

export type RouteContext =
  | { space: 'home' }
  | { space: 'root'; rootKey: string; scopePath?: string; documentPath?: string }
  | SkillsRouteContext
  | { space: 'agents'; agentKey: string; rootKey?: string; documentRoute?: string }
  | { space: 'settings'; rootKey?: string };

// Boot-time-only sibling of RouteContext: the shell always resolves to a
// route (falling back to Home), but flags why the requested URL could not
// be honored so the client can render a recoverable state instead.
export type RouteError =
  | { kind: 'unroutable'; requested: string }
  | { kind: 'root_not_open'; rootKey: string };

export interface SkillsContextReference {
  key: string;
}

export interface AgentReference {
  key: string;
}

export interface RouteResources {
  root?: Root;
  skillsContext?: SkillsContextReference;
  agent?: AgentReference;
}

// Read-only seams keep route resolution independent from runtime ownership.
export interface RouteResolutionDependencies {
  getRoot(rootKey: string): Root | null;
  getSkillsContext(contextKey: string): SkillsContextReference | null;
  getAgent(agentKey: string): AgentReference | null;
  canonicalLocation?(context: RouteContext, resources: RouteResources): string | null;
}

export type RouteResolution =
  | { kind: 'resolved'; context: RouteContext; resources: RouteResources }
  | { kind: 'root_not_open'; rootKey: string }
  | { kind: 'context_expired'; contextKey: string }
  | { kind: 'unknown_agent'; agentKey: string }
  | { kind: 'canonical_redirect'; location: string; context: RouteContext };

export type RouteResolutionHttp =
  | { status: 200 }
  | { status: 404; body: { error: 'root_not_open'; rootKey: string } }
  | { status: 410; body: { error: 'context_expired'; contextKey: string } }
  | { status: 404; body: { error: 'unknown_agent'; agentKey: string } }
  | { status: 308; headers: { location: string } };

export interface DocumentRoot {
  key?: string | null;
  dir: string;
  label?: string | null;
  project?: string | null;
}

export interface DocumentStoreConfig {
  addressing: 'relative' | 'keyed';
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
  rootKey?: string;
  settings?: boolean;
  path?: string;
}

export interface RootTreeOptions {
  scope?: string;
}
