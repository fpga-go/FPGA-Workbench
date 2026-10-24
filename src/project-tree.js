'use strict';

const path = require('node:path');

/** Build a display-only tree from the files already recorded in the project.
 * No directories are scanned and no project file or input object is changed.
 * File nodes retain every original registration, including disabled duplicates.
 */
function buildProjectTree(project) {
  const windows = /^[A-Za-z]:[\\/]/.test(project.path || '') || /^\\\\/.test(project.path || '');
  const api = windows ? path.win32 : path.posix;
  const root = api.resolve(project.root || api.dirname(project.path));
  const name = project.name || api.basename(project.path, api.extname(project.path));
  const srcRoot = api.join(root, `${name}.srcs`), genRoot = api.join(root, `${name}.gen`);
  const normalize = value => {
    const absolute = api.resolve(root, value);
    return windows ? absolute.toLowerCase() : absolute;
  };
  const parts = value => value.replace(/\\/g, '/').split('/').filter(Boolean);
  const relative = (base, value) => {
    const result = api.relative(base, api.resolve(root, value));
    return result === '' ? [] : result !== '..' && !result.startsWith(`..${api.sep}`) && !api.isAbsolute(result) ? parts(result) : undefined;
  };
  const isDesign = set => /^(designsrcs|design)$/i.test(set?.type || '') || (!set?.type && /^sources?_1$/i.test(set?.name || ''));
  const isBlock = set => /^blocksrcs$/i.test(set?.type || '');
  const isXci = file => /\.xci$/i.test(file.path || file.rawPath || '');
  const files = project.files || [];
  const sets = new Map((project.filesets || []).map(set => [set.name, set]));
  for (const file of files) if (!sets.has(file.fileset)) sets.set(file.fileset, { name: file.fileset, type: '' });
  const designs = [...sets.values()].filter(isDesign);
  const sourceSets = set => {
    const values = set.srcSets ?? set.srcSet ?? set.props?.get?.('srcset') ?? [];
    return [...new Set((Array.isArray(values) ? values : [values]).filter(value => sets.has(value) && isDesign(sets.get(value))))];
  };
  const physicalOwner = value => {
    if (!value) return undefined;
    return designs.find(set => relative(api.join(srcRoot, set.name), value) || relative(api.join(genRoot, set.name), value))?.name;
  };
  const registrations = new Map();
  for (const file of files) {
    if (!file.path || !isDesign(sets.get(file.fileset))) continue;
    const key = normalize(file.path);
    if (!registrations.has(key)) registrations.set(key, new Set());
    registrations.get(key).add(file.fileset);
  }
  const artifactOwners = new Map();
  for (const ip of project.ipReferences || []) {
    if (!ip.path) continue;
    for (const artifact of ip.artifactPaths || []) {
      const key = normalize(artifact);
      if (!artifactOwners.has(key)) artifactOwners.set(key, new Set());
      artifactOwners.get(key).add(ip.path);
    }
  }
  const originOf = file => {
    if (file.origin) return file.origin;
    const owners = file.path ? artifactOwners.get(normalize(file.path)) : undefined;
    return owners?.size === 1 ? [...owners][0] : undefined;
  };
  // A BlockSrcs set can be attached only with positive ownership evidence.
  // Being the active/default design alone does not identify an external IP's owner.
  const blockOwners = new Map();
  for (const set of sets.values()) {
    if (!isBlock(set)) continue;
    const evidence = new Set(sourceSets(set));
    for (const file of files.filter(item => item.fileset === set.name)) {
      const owner = physicalOwner(originOf(file) || file.path);
      if (owner) evidence.add(owner);
      const registered = file.path ? registrations.get(normalize(file.path)) : undefined;
      if (registered?.size === 1) evidence.add([...registered][0]);
    }
    if (evidence.size === 1) blockOwners.set(set.name, [...evidence][0]);
  }
  const targetSet = file => isBlock(sets.get(file.fileset)) ? blockOwners.get(file.fileset) || file.fileset : file.fileset;
  const score = file => (file.enabled ? 4 : 0) + (file.selected ? 2 : 0) + (file.exists ? 1 : 0);
  const merge = origins => {
    const best = origins.reduce((old, file) => score(file) > score(old) ? file : old);
    // Keep flags from one actual registration. Independent ORs can invent an
    // enabled + selected combination that none of the original entries had.
    return { ...best };
  };
  const records = [], xciRecords = new Map();
  for (const file of files) {
    const set = sets.get(file.fileset);
    const identity = file.path && isXci(file) && (isDesign(set) || isBlock(set)) ? `${normalize(file.path)}\u0000${targetSet(file)}` : undefined;
    if (identity && xciRecords.has(identity)) xciRecords.get(identity).origins.push(file);
    else {
      const record = { origins: [file] }; records.push(record);
      if (identity) xciRecords.set(identity, record);
    }
  }
  for (const record of records) { record.file = merge(record.origins); record.target = targetSet(record.file); }
  const layout = (file, target) => {
    if (!file.path) return ['未解析路径', ...parts(file.rawPath || '(未知路径)')];
    for (const base of [api.join(srcRoot, target), api.join(genRoot, target)]) {
      const own = relative(base, file.path); if (own?.length) return own;
    }
    const legacy = relative(srcRoot, file.path);
    if (legacy?.length && !sets.has(legacy[0])) return legacy;
    const internal = relative(root, file.path);
    if (internal?.length) return isXci(file) && isDesign(sets.get(target)) && internal[0] !== 'ip' ? ['ip', ...internal] : internal;
    const absolute = parts(api.resolve(root, file.path));
    return [...(isXci(file) && isDesign(sets.get(target)) ? ['ip'] : []), '外部文件', ...absolute];
  };
  for (const record of records) record.parts = layout(record.file, record.target);
  const xciLocations = new Map();
  for (const record of xciRecords.values()) {
    const identity = normalize(record.file.path);
    if (!xciLocations.has(identity)) xciLocations.set(identity, []);
    xciLocations.get(identity).push(record);
  }
  for (const record of records) {
    if (isXci(record.file)) continue;
    const origin = originOf(record.file), candidates = origin ? xciLocations.get(normalize(origin)) || [] : [];
    const ip = candidates.find(item => item.target === record.target) || (candidates.length === 1 ? candidates[0] : undefined);
    if (ip) {
      record.target = ip.target;
      record.parts = [...ip.parts.slice(0, -1), api.basename(record.file.path || record.file.rawPath)];
    }
  }
  const nodes = new Map([...sets.values()].map(set => [set.name, { label: set.name, kind: 'fileset', type: set.type || '', children: [], count: 0 }]));
  for (const record of records) {
    const node = nodes.get(record.target);
    let children = node.children;
    for (const label of record.parts.slice(0, -1)) {
      let folder = children.find(item => item.kind === 'folder' && (windows ? item.label.toLowerCase() === label.toLowerCase() : item.label === label));
      if (!folder) { folder = { label, kind: 'folder', children: [] }; children.push(folder); }
      children = folder.children;
    }
    const identity = record.file.path ? normalize(record.file.path) : record.file.rawPath;
    const existing = children.find(item => item.kind === 'file' && (item.file.path ? normalize(item.file.path) : item.file.rawPath) === identity);
    if (existing) { existing.origins.push(...record.origins); existing.file = merge(existing.origins); }
    else children.push({ label: record.parts.at(-1), kind: 'file', file: record.file, origins: [...record.origins] });
  }
  const finish = node => {
    if (node.kind === 'file') return 1;
    node.children.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.label.localeCompare(b.label, 'en'));
    const count = node.children.reduce((total, child) => total + finish(child), 0);
    if (node.kind === 'fileset') node.count = count;
    return count;
  };
  for (const node of nodes.values()) finish(node);
  return [...nodes.values()].filter(node => node.count || !isBlock(sets.get(node.label)) || !blockOwners.has(node.label));
}

module.exports = { buildProjectTree };
