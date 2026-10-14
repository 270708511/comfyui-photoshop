(function(root) {
  'use strict';
  let state = {groups: [], status: '连接中'}, serial = 0;
  const listeners = new Set();
  root.PSWorkflowControls = {
    update(data) {
      if (!data || !Array.isArray(data.groups)) return;
      state = {groups: data.groups.filter(group => typeof group.id === 'string' && Array.isArray(group.items) && group.items.length), status: String(data.status || '')};
      for (const listener of listeners) listener();
    },
    result(data) { for (const listener of listeners) listener(data); },
    mount(container, send, confirmed, makeDropdown) {
      const controls = new Map();
      let pending = null, timer = null;
      const status = document.createElement('div');
      function showStatus(text) {
        status.textContent = text;
        if (text) container.insertBefore(status, container.firstChild);
        else status.remove();
      }
      function draw(response) {
        if (response && pending && response.request_id === pending.request_id) {
          clearTimeout(timer); pending = null;
          showStatus(response.applied ? '' : '切换未生效，请重试');
          if (response.applied) confirmed();
        }
        const ids = new Set(state.groups.map(group => group.id));
        if (pending && !ids.has(pending.group_id)) { clearTimeout(timer); pending = null; }
        for (const [id, entry] of controls) if (!ids.has(id)) { entry.widget.destroy(); controls.delete(id); }
        if (!state.groups.length) showStatus(state.status || '当前工作流未配置模式开关');
        else if (!response && !pending) showStatus('');
        state.groups.forEach((group, index) => {
          let entry = controls.get(group.id);
          if (!entry) {
            const widget = makeDropdown(container, index === 1 ? '⚙️' : '📂', group.items, id => {
              if (pending || !state.groups.some(current => current.id === group.id && current.items.some(item => item.id === id))) return;
              pending = {group_id: group.id, widget_id: id, request_id: 'switch-' + Date.now() + '-' + (++serial)};
              showStatus('');
              timer = setTimeout(() => { pending = null; showStatus('未收到工作流切换确认，请检查连接'); }, 8000);
              try { send(pending); }
              catch { clearTimeout(timer); pending = null; showStatus('发送切换请求失败'); }
            });
            entry = {widget}; controls.set(group.id, entry);
          }
          entry.widget.update(group.items);
        });
      }
      listeners.add(draw); draw();
      return () => { clearTimeout(timer); listeners.delete(draw); for (const entry of controls.values()) entry.widget.destroy(); };
    }
  };
})(globalThis);
