function terms(query) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function matchesQuery(text, query) {
  const t = terms(query);
  if (!t.length) return true;
  const lower = text.toLowerCase();
  return t.every((term) => lower.includes(term));
}

export function filterFiles(paths, query) {
  const t = terms(query);
  if (!t.length) return paths.slice();
  const matched = paths.filter((p) => t.every((term) => p.toLowerCase().includes(term)));
  return matched.sort((a, b) => {
    const aBase = t.every((term) => basename(a).toLowerCase().includes(term));
    const bBase = t.every((term) => basename(b).toLowerCase().includes(term));
    if (aBase === bBase) return 0;
    return aBase ? -1 : 1;
  });
}

function filterSkill(skill, query) {
  if (matchesQuery(skill.name, query) || matchesQuery(skill.id, query)) return skill;
  const files = skill.files.filter((f) => matchesQuery(f.id, query) || matchesQuery(f.label, query));
  return files.length ? { ...skill, files } : null;
}

export function filterSkillsTree(data, query) {
  if (!query.trim()) return data;
  const scopes = [];
  for (const scope of data.scopes) {
    const groups = [];
    for (const group of scope.groups) {
      const skills = group.skills.map((s) => filterSkill(s, query)).filter(Boolean);
      if (skills.length) groups.push({ ...group, skills });
    }
    const skills = scope.skills.map((s) => filterSkill(s, query)).filter(Boolean);
    if (groups.length || skills.length) scopes.push({ ...scope, groups, skills });
  }
  return { scopes };
}
