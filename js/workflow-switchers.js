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
    // New rgthree widgets own group recomputation and mutual-exclusion rules.
    if (typeof target.widget.doModeChange === 'function') target.widget.doModeChange();
    else target.widget.callback.call(target.widget, !selected(target.widget));
    redraw(); refresh(true); return true;
  }
  return {refresh, invalidate, toggle};
}
