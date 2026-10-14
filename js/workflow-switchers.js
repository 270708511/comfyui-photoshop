// Current-graph controls for the Photoshop Preset panel. No cached graph survives a reload.
export function createWorkflowSwitchers({ graph, send, redraw = () => {} }) {
  const roles = ['workflow', 'rndrMode'];
  let revision = 0, currentGraph = null, nodes = [], targets = new Map(), last = new Map();
  const nodeRole = node => {
    const explicit = node.properties?.psSwitcherRole;
    if (['workflow', 'rndrMode', 'none'].includes(explicit)) return explicit;
    if ([node.color, node.bgcolor].includes('#2b4557') || node.title?.startsWith('📁')) return 'workflow';
    if ([node.color, node.bgcolor].includes('#4e5e4e') || node.title?.startsWith('⚙️')) return 'rndrMode';
    return null;
  };
  const selected = widget => typeof widget.toggled === 'boolean' ? widget.toggled
    : typeof widget.value?.toggled === 'boolean' ? widget.value.toggled : widget.value === true;
  function refresh(force = false) {
    const live = graph();
    const candidates = (live?._nodes || []).filter(node =>
      (node.comfyClass || node.type) === 'Fast Groups Muter (rgthree)');
    if (live !== currentGraph || candidates.length !== nodes.length || candidates.some((node, i) => node !== nodes[i])) {
      revision++; currentGraph = live; nodes = candidates;
    }
    const nextTargets = new Map();
    const groups = [];
    for (const node of candidates) {
      if (node.properties?.psSwitcherRole === 'none') continue;
      const groupId = JSON.stringify([revision, node.id]);
      const items = (node.widgets || []).filter(widget =>
        typeof widget.doModeChange === 'function' || typeof widget.callback === 'function')
        .map((widget, index) => {
          const identity = widget.groupKey || widget.name || String(index);
          const id = JSON.stringify([revision, node.id, identity, index]);
          nextTargets.set(groupId + ':' + id, {node, widget, identity});
          return {id, name: String(widget.label || widget.name || '').replace(/^Enable\s+/, ''), selected: selected(widget)};
        });
      if (items.length) groups.push({id: groupId, name: String(node.title || '开关组') + ' #' + node.id, items});
    }
    const groupSignature = JSON.stringify(groups);
    if (force || last.get('groups') !== groupSignature) {
      send('Send_switcherGroups', {groups, status: groups.length ? '' : '当前工作流未配置模式开关'});
      last.set('groups', groupSignature);
    }
    for (const role of roles) {
      let entries;
      try {
        const matches = candidates.filter(node => nodeRole(node) === role);
        // Explicit menu assignments resolve old colour-based ambiguity.
        const explicit = matches.filter(node => node.properties?.psSwitcherRole === role);
        const chosen = explicit.length ? explicit : matches;
        const status = chosen.length > 1 ? '多个开关节点匹配，请在节点菜单指定用途'
          : !chosen.length ? '当前工作流未配置模式开关' : null;
        if (status) entries = [{id: '', name: status, disabled: true}];
        else {
          const node = chosen[0];
          entries = (node.widgets || []).filter(widget =>
            typeof widget.doModeChange === 'function' || typeof widget.callback === 'function')
            .map((widget, index) => {
              const name = String(widget.label || widget.name || '').replace(/^Enable\s+/, '');
              const identity = widget.groupKey || widget.name || String(index);
              const id = JSON.stringify([revision, node.id, identity, index]);
              nextTargets.set(role + ':' + id, {node, widget, identity});
              return {id, name, selected: selected(widget)};
            });
          if (!entries.length) entries = [{id: '', name: '正在等待开关初始化', disabled: true}];
        }
      } catch {
        entries = [{id: '', name: '工作流开关读取失败', disabled: true}];
      }
      const signature = JSON.stringify(entries);
      if (force || last.get(role) !== signature) {
        send(role === 'workflow' ? 'Send_workflow' : 'Send_rndrMode', entries);
        last.set(role, signature);
      }
    }
    targets = nextTargets;
  }
  function invalidate() { revision++; currentGraph = null; nodes = []; targets.clear(); last.clear(); refresh(true); }
  function toggle(role, id) {
    refresh();
    const target = targets.get(role + ':' + id);
    if (!target || graph() !== currentGraph || !currentGraph?._nodes?.includes(target.node)
        || !target.node.widgets?.includes(target.widget)) { refresh(true); return false; }
    // Preset dropdowns select one branch, even when the graph's muter allows many.
    // Call rgthree's methods so underlying node modes change, not just row values.
    const controls = () => (target.node.widgets || []).filter(widget =>
      typeof widget.doModeChange === 'function' || typeof widget.callback === 'function');
    const identity = (widget, index) => widget.groupKey || widget.name || String(index);
    const resolve = key => controls().find((widget, index) => identity(widget, index) === key);
    const apply = (widget, value) => {
      if (typeof widget.doModeChange === 'function') widget.doModeChange(value, true);
      else widget.callback.call(widget, value);
    };
    for (const key of controls().map(identity).filter(key => key !== target.identity)) {
      const widget = resolve(key);
      if (!widget) { refresh(true); return false; }
      apply(widget, false);
    }
    const chosen = resolve(target.identity);
    if (!chosen) { refresh(true); return false; }
    apply(chosen, true);
    redraw(); refresh(true);
    const live = controls();
    const chosenAfter = resolve(target.identity);
    return !!chosenAfter && live.filter(selected).length === 1 && selected(chosenAfter);
  }
  return {refresh, invalidate, toggle};
}
