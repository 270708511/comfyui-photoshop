(function(root) {
  'use strict';
  let state = {groups: [], status: '连接中'}, serial = 0;
  const listeners = new Set();
  function publish() { for (const listener of listeners) listener(); }
  root.PSWorkflowControls = {
    update(data) {
      if (!data || !Array.isArray(data.groups)) return;
      state = {groups: data.groups.filter(group => typeof group.id === 'string' && Array.isArray(group.items) && group.items.length), status: String(data.status || '')};
      publish();
    },
    result(data) { for (const listener of listeners) listener(data); },
    mount(container, send, confirmed = () => {}) {
      let pending = null, timer = null, open = null, error = '';
      const element = (tag, text) => {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        return el;
      };
      function draw(response) {
        if (response && pending && response.request_id === pending.request_id) {
          const applied = response.applied === true;
          clearTimeout(timer); pending = null;
          error = applied ? '' : '切换未生效，请重试';
          if (applied) confirmed();
        }
        if (!state.groups.length && pending) { clearTimeout(timer); pending = null; }
        container.textContent = '';
        container.style.cssText = 'padding:12px;display:flex;flex-direction:column;';
        if (!state.groups.length) container.appendChild(element('div', state.status || '当前工作流未配置模式开关'));
        for (const group of state.groups) {
          const box = element('div'); box.style.cssText = 'margin-bottom:12px;';
          const names = group.items.filter(item => item.selected).map(item => item.name);
          const button = element('button', group.name + '：' + (names.length ? '✓ ' + names.join('、') : '未启用') + ' ▾');
          button.style.cssText = 'width:100%;padding:16px;text-align:left;background:#262626;color:#ddd;border-radius:16px;white-space:normal;';
          button.disabled = !!pending;
          button.addEventListener('click', () => { open = open === group.id ? null : group.id; draw(); });
          box.appendChild(button);
          if (open === group.id) for (const item of group.items) {
            const option = element('button', (item.selected ? '✓ ' : '○ ') + item.name);
            option.style.cssText = 'width:100%;padding:12px;text-align:left;background:#333;color:#ddd;';
            option.disabled = !!pending || item.disabled || typeof item.id !== 'string';
            option.addEventListener('click', () => {
              if (pending) return;
              pending = {group_id: group.id, widget_id: item.id, request_id: 'switch-' + Date.now() + '-' + (++serial)};
              error = ''; draw();
              timer = setTimeout(() => { pending = null; error = '未收到工作流切换确认，请检查连接'; draw(); }, 8000);
              try { send(pending); }
              catch { clearTimeout(timer); pending = null; error = '发送切换请求失败'; draw(); }
            });
            box.appendChild(option);
          }
          container.appendChild(box);
        }
        if (pending || error) container.appendChild(element('div', error || '正在等待工作流确认…'));
      }
      listeners.add(draw); draw();
      return () => { clearTimeout(timer); listeners.delete(draw); };
    }
  };
})(globalThis);
