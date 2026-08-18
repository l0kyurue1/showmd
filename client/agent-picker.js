// Finds the first agent (starting with the default) whose tree has content,
// probing via the injected fetcher so this stays testable without a server.
export async function pickAgentWithContent(defaultKey, fetchTree) {
  const first = await fetchTree(defaultKey);
  if (first && first.groups && first.groups.length) return { key: defaultKey, data: first };
  const candidates = (first && first.agents) || [];
  for (const a of candidates) {
    if (a.key === defaultKey || !a.detected) continue;
    const data = await fetchTree(a.key);
    if (data && data.groups && data.groups.length) return { key: a.key, data };
  }
  return null;
}
