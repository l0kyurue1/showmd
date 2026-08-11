function fileNode(documentId, label) {
  return {
    key: documentId,
    role: 'file',
    label,
    documentId,
    children: [],
    initiallyCollapsed: false,
  };
}

export function adaptFilesTree(data) {
  const byDirectory = new Map();
  for (const documentId of data.tree) {
    const slash = documentId.lastIndexOf('/');
    const directory = slash === -1 ? '' : documentId.slice(0, slash + 1);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(documentId);
  }

  const roots = [];
  for (const directory of [...byDirectory.keys()].sort()) {
    const documents = byDirectory.get(directory).sort();
    if (!directory) {
      roots.push(...documents.map((documentId) => fileNode(documentId, documentId)));
      continue;
    }
    roots.push({
      key: `dir:${directory}`,
      role: 'dir',
      label: directory,
      children: documents.map((documentId) => fileNode(documentId, documentId.slice(directory.length))),
      initiallyCollapsed: false,
    });
  }
  return { roots };
}

function skillNode(skill, initiallyCollapsed) {
  return {
    key: `skill:${skill.id}`,
    role: 'skill',
    label: skill.name,
    documentId: skill.id,
    children: skill.files.map((file) => fileNode(file.id, file.label)),
    initiallyCollapsed,
    metadata: { skill, breadcrumbPrefix: skill.name, documentLabel: skill.id.slice(skill.id.lastIndexOf('/') + 1) },
  };
}

export function adaptSkillsTree(data) {
  let expandedFirstChain = false;
  const roots = data.scopes.map((scope) => {
    const expandScope = !expandedFirstChain && (scope.groups.length > 0 || scope.skills.length > 0);
    const children = scope.groups.map((group, groupIndex) => {
      const expandGroup = expandScope && groupIndex === 0;
      const skills = group.skills.map((skill, skillIndex) => {
        const expandSkill = expandGroup && skillIndex === 0;
        return skillNode(skill, !expandSkill);
      });
      if (expandGroup) expandedFirstChain = true;
      return {
        key: `group:${scope.name}:${group.source}`,
        role: 'group',
        label: group.source,
        children: skills,
        initiallyCollapsed: !expandGroup,
      };
    });

    for (const skill of scope.skills) {
      const expandSkill = expandScope && !expandedFirstChain;
      const node = skillNode(skill, !expandSkill);
      node.metadata.listKey = `local:${scope.name}`;
      children.push(node);
      if (expandSkill) expandedFirstChain = true;
    }

    return {
      key: `scope:${scope.name}`,
      role: 'scope',
      label: scope.name,
      children,
      initiallyCollapsed: !expandScope,
    };
  });
  return { roots };
}

export function adaptAgentTree(data) {
  const roots = data.groups.map((group) => {
    const children = group.files
      ? group.files.map((file) => fileNode(file.id, file.label))
      : group.projects.map((project) => ({
          key: `agentproject:${project.label}`,
          role: project.memoryDoc ? 'project' : 'dir',
          label: project.current ? `${project.label} (current)` : project.label,
          ...(project.memoryDoc ? { documentId: project.memoryDoc.id } : {}),
          children: project.files.map((file) => fileNode(file.id, file.label)),
          initiallyCollapsed: true,
          metadata: {
            project,
            title: project.path,
            searchText: [project.label],
            searchResultRole: 'file',
            searchResultLabel: project.memoryDoc?.label,
            breadcrumbPrefix: project.label,
            documentLabel: project.memoryDoc?.label,
          },
        }));
    return {
      key: `agentgroup:${group.name}`,
      role: 'scope',
      label: group.name,
      children,
      initiallyCollapsed: !!group.projects,
      metadata: { flatSearch: true },
    };
  });
  return { roots };
}
