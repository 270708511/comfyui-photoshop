/* Additive native UXP controls. The existing Photoshop UI and canvas exporter own
 * image capture and execution. This module never navigates or needs a WebView.
 * UXP references: Adobe sp-dropdown (sp-menu slot=options, selectedIndex),
 * sp-textfield and known-issues. Numeric text is deliberately validated here:
 * UXP's native number widget caps values and is unsuitable for ComfyUI seeds.
 */
globalThis.createPSNativePanel = function (hooks) {
  'use strict';
  hooks = hooks || {};
  const transport = hooks.transport;
  const doc = hooks.document || globalThis.document;
  if (!transport || typeof transport.getState !== 'function' || !doc) throw new Error('Native panel requires a transport and document');
  let root = null, refs = {}, unsubscribe = null, mounted = false, generation = 0;
  let busy = false, busyMessage = '', expanded = true, shown = true, containerStyles = null, localError = '', parameterCommitFailed = false, serverDirty = false, selectionKey = '', schemaKey = '';
  let state = {}, fields = [], listeners = [], fieldListeners = [], jobListeners = [];
  let workspaceItems = [], workflowItems = [], workspaceSignature = '', workflowSignature = '', jobsSignature = '';
  const rejectedKeys = ['__proto__', 'prototype', 'constructor'];
  const own = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);
  const label = value => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 1200);
  const array = value => Array.isArray(value) ? value : [];
  const signature = value => { try { return JSON.stringify(value); } catch (_) { return ''; } };
  const contextKey = value => signature([value.origin, value.authenticated, value.username, value.session_id, value.workspace_id, value.workflow_path]);
  function element(tag, text, parent) {
    const node = doc.createElement(tag);
    if (text != null) node.textContent = label(text);
    if (parent) parent.appendChild(node);
    return node;
  }
  function attribute(node, name, value) {
    if (value) node.setAttribute(name, ''); else node.removeAttribute(name);
  }
  function disabled(node, value) { node.disabled = !!value; attribute(node, 'disabled', value); }
  function visible(node, value) { node.style.display = value ? '' : 'none'; }
  function listen(node, type, action, list) {
    node.addEventListener(type, action);
    (list || listeners).push([node, type, action]);
  }
  function detach(list) { for (const item of list.splice(0)) item[0].removeEventListener(item[1], item[2]); }
  function empty(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function clearPassword() { if (refs.password) { refs.password.value = ''; refs.password.removeAttribute('value'); } }
  function readPasswordOnce() {
    // Some macOS UXP releases cannot read a masked field's value. Read the same
    // widget only while hidden, synchronously, and clear it BEFORE restoring it.
    // Never make a plaintext password visible or retain it in panel state.
    const input = refs.password, display = input.style.display;
    let value = '';
    try {
      try { value = input.value; } catch (_) { value = ''; }
      if (typeof value !== 'string' || !value) {
        input.style.display = 'none';
        input.setAttribute('type', 'text');
        value = input.value;
      }
      if (typeof value !== 'string') throw new Error('Native password value is unavailable');
      return value;
    } finally {
      clearPassword();
      input.setAttribute('type', 'password');
      input.style.display = display;
    }
  }
  function textField(name, title, parent, type) {
    const input = element('sp-textfield', null, parent);
    input.setAttribute('data-field', name);
    input.setAttribute('type', type || 'text');
    input.style.width = '100%';
    input.style.minWidth = '0'; input.style.maxWidth = '100%';
    input.style.flexShrink = '0';
    input.style.marginBottom = '6px';
    element('sp-label', title, input).setAttribute('slot', 'label');
    return input;
  }
  function button(name, title, parent, action, list) {
    const node = element('sp-button', title, parent);
    node.setAttribute('data-action', name);
    node.setAttribute('size', 's');
    node.style.maxWidth = '100%'; node.style.flexShrink = '0';
    node.style.marginRight = '6px';
    node.style.marginBottom = '6px';
    listen(node, 'click', () => { if (mounted && !node.disabled) action(); }, list);
    return node;
  }
  function dropdown(name, title, parent) {
    const group = element('div', null, parent);
    element('div', title, group).style.marginBottom = '4px';
    const control = element('sp-dropdown', null, group);
    control.setAttribute('data-field', name);
    control.style.width = '100%';
    control.style.marginBottom = '6px';
    const menu = element('sp-menu', null, control);
    menu.setAttribute('slot', 'options');
    return {control, menu};
  }
  function options(view, items, selected, placeholder) {
    empty(view.menu);
    const values = [{id: '', name: placeholder}, ...items];
    let selectedIndex = 0;
    values.forEach((item, index) => {
      const node = element('sp-menu-item', item.name, view.menu);
      if (String(item.id) === String(selected || '')) { selectedIndex = index; attribute(node, 'selected', true); }
    });
    view.control.selectedIndex = selectedIndex;
    view.control.setAttribute('placeholder', placeholder);
  }
  function selectedItem(view, items) {
    const index = Number(view.control.selectedIndex);
    return Number.isInteger(index) && index > 0 ? items[index - 1] : null;
  }
  function transportError(error) {
    // Never echo an HTTP body or thrown message; either can contain credentials.
    const code = String(error && (error.code || error.type) || error || '').toLowerCase();
    if (/storage|journal|disk/.test(code)) return 'Private request storage is unavailable. Preserve saved requests, check storage and reconnect.';
    if (/cookie/.test(code)) return 'Native sign-in could not be confirmed. Verify server login and Photoshop UXP cookie support.';
    if (/403|denied|permission/.test(code)) return 'The server denied this action. Check your access with the server administrator.';
    if (/auth|login|401|credential|session/.test(code)) return 'Sign in again to access this account’s workspaces.';
    if (/network|fetch|connect|certificate|tls|host|timeout|ats/.test(code)) return 'Cannot reach the server. Check the address, certificate, VPN and Photoshop network access, then Reconnect.';
    if (/workflow|prepar|stale/.test(code)) return 'Workflow preparation is unavailable or changed. Refresh workflows and select it again.';
    return 'The request failed. Try Refresh or Reconnect.';
  }
  function diagnosticText(value) {
    if (!value || typeof value !== 'object') return '';
    const stages = {check_session: 'Session check', clear_session: 'Clear previous session', verify_signout: 'Verify sign-out', submit_login: 'Submit login', verify_login: 'Verify login', sign_out: 'Sign out', bind_session: 'Create native session', list_workspaces: 'Load workspaces', request: 'Server request'};
    const codes = {network_error: 'network request failed', request_timeout: 'request timed out', response_invalid: 'unexpected server response', response_timeout: 'response timed out', unauthorized: 'sign-in required', forbidden: 'access denied', http_error: 'server error', cookie_not_cleared: 'previous session could not be cleared', cookie_not_confirmed: 'login cookie was not confirmed', account_mismatch: 'server returned a different account'};
    if (!own(stages, value.stage) || !own(codes, value.code)) return '';
    const status = Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599 ? ' (HTTP ' + value.http_status + ')' : '';
    return stages[value.stage] + ': ' + codes[value.code] + status + '.';
  }
  function pendingMessage() {
    if (busy) return busyMessage || 'Working…';
    if (state.status === 'signing_in') return 'Signing in…';
    if (state.status === 'connecting') return 'Connecting…';
    if (state.status === 'signing_out') return 'Signing out…';
    return '';
  }
  function displaySheet() {
    if (!root || !root.parentNode) return;
    const container = root.parentNode, style = container.style;
    style.position = 'absolute'; style.zIndex = '40';
    style.top = expanded ? '0' : '8px'; style.right = expanded ? '0' : '8px';
    style.bottom = expanded ? '0' : 'auto'; style.left = expanded ? '0' : 'auto';
    style.width = expanded ? '100%' : 'auto'; style.height = expanded ? '100%' : 'auto';
    style.maxWidth = expanded ? '100%' : 'calc(100% - 72px)'; style.maxHeight = '100%';
    style.minHeight = '0'; style.boxSizing = 'border-box';
    style.display = shown ? 'flex' : 'none'; style.flexDirection = 'column';
    style.overflow = 'hidden'; style.backgroundColor = expanded ? '#242424' : 'transparent';
    root.style.height = expanded ? '100%' : 'auto';
    visible(refs.open, !expanded); refs.sheet.style.display = expanded ? 'flex' : 'none';
    if (typeof hooks.onViewChange === 'function') hooks.onViewChange(shown && expanded);
  }
  function expandSheet(value) {
    expanded = value !== false;
    if (!expanded) clearPassword();
    displaySheet();
  }
  function snapshot() { return transport.getState() || {}; }
  function synchronize() { if (mounted) render(snapshot()); }
  async function run(action, failure, message) {
    if (!mounted || busy) return false;
    const runGeneration = generation;
    busy = true; busyMessage = message || 'Working…'; localError = ''; updateControls();
    try {
      const result = await action();
      if (result === false && mounted && generation === runGeneration) localError = failure;
      return result !== false;
    } catch (_) {
      if (mounted && generation === runGeneration) localError = failure;
      return false;
    } finally {
      if (mounted && generation === runGeneration) { busy = false; busyMessage = ''; synchronize(); }
    }
  }
  function specsFor(schema) {
    let specs = Array.isArray(schema) ? schema : array(schema && (schema.fields || schema.parameters));
    if (!specs.length && schema && schema.properties) specs = Object.keys(schema.properties).map(key => Object.assign({key}, schema.properties[key], {required: array(schema.required).includes(key)}));
    return specs.map(spec => {
      if (!spec || typeof spec !== 'object') return null;
      const key = String(spec.key || spec.name || spec.id || '');
      if (!key || rejectedKeys.includes(key)) return null;
      const choices = array(spec.enum || spec.options || spec.choices).map(value => (value && typeof value === 'object' && own(value, 'value')) ? {value: value.value, name: label(value.label == null ? value.value : value.label)} : {value, name: label(value)});
      const type = String(spec.type || (choices.length ? 'enum' : 'string')).toLowerCase();
      return Object.assign({}, spec, {key, type, choices, title: label(spec.label || spec.title || key)});
    }).filter(Boolean);
  }
  function valueFor(spec) { return own(state.parameters, spec.key) ? state.parameters[spec.key] : spec.default; }
  function readField(field) {
    const spec = field.spec, control = field.control;
    if (spec.choices.length) {
      const choice = spec.choices[Number(control.selectedIndex)];
      if (!choice) return {error: 'Choose a value'};
      return {value: choice.value};
    }
    if (['bool', 'boolean'].includes(spec.type)) return {value: !!control.checked};
    const raw = String(control.value == null ? '' : control.value);
    if (['number', 'integer', 'int', 'float'].includes(spec.type)) {
      const value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value)) return {error: 'Enter a finite number'};
      if (['integer', 'int'].includes(spec.type) && !Number.isSafeInteger(value)) return {error: 'Enter a safe whole number'};
      const min = spec.minimum == null ? spec.min : spec.minimum;
      const max = spec.maximum == null ? spec.max : spec.maximum;
      if (typeof min === 'number' && value < min) return {error: 'Minimum: ' + min};
      if (typeof max === 'number' && value > max) return {error: 'Maximum: ' + max};
      return {value};
    }
    if (!['string', 'text'].includes(spec.type)) return {error: 'Unsupported parameter type; edit this workflow’s preparation'};
    if (spec.required && !raw.trim()) return {error: 'This value is required'};
    return {value: raw};
  }
  function fieldValue(field, value) {
    if (field.spec.choices.length) {
      const index = field.spec.choices.findIndex(choice => signature(choice.value) === signature(value));
      field.control.selectedIndex = index;
      for (let item = 0; item < field.menu.children.length; item++) attribute(field.menu.children[item], 'selected', index === item);
    } else if (['bool', 'boolean'].includes(field.spec.type)) {
      field.control.checked = value === true; attribute(field.control, 'checked', value === true);
    } else field.control.value = value == null ? '' : String(value);
  }
  function validateFields() {
    let valid = true;
    for (const field of fields) {
      const result = readField(field);
      field.error = result.error || '';
      field.help.textContent = result.error || '';
      attribute(field.control, 'invalid', !!result.error);
      if (result.error) valid = false;
    }
    return valid;
  }
  function commitFields() {
    if (!mounted || busy || !state.authenticated || !state.workflow_path) return false;
    if (!validateFields()) { updateControls(); return false; }
    const values = Object.create(null);
    for (const field of fields) values[field.spec.key] = readField(field).value;
    try {
      const result = transport.setParameters(values);
      if (result === false) { parameterCommitFailed = true; localError = 'Parameters were not accepted. Check the values and select the workflow again.'; updateControls(); return false; }
      for (const field of fields) field.committed = signature(values[field.spec.key]);
      parameterCommitFailed = false; localError = ''; synchronize(); return true;
    } catch (_) { parameterCommitFailed = true; localError = 'Parameters were not accepted. Check the values and select the workflow again.'; updateControls(); return false; }
  }
  function buildFields(specs) {
    detach(fieldListeners); empty(refs.parameters); fields = [];
    if (!state.authenticated || !state.workflow_path) return;
    const key = selectionKey;
    for (const spec of specs) {
      const wrapper = element('div', null, refs.parameters);
      let control, menu;
      if (spec.choices.length) {
        const view = dropdown('parameter:' + spec.key, spec.title, wrapper);
        control = view.control; menu = view.menu;
        for (const choice of spec.choices) element('sp-menu-item', choice.name, menu);
      } else if (['boolean', 'bool'].includes(spec.type)) {
        control = element('sp-checkbox', spec.title, wrapper);
        control.setAttribute('data-field', 'parameter:' + spec.key);
      } else control = textField('parameter:' + spec.key, spec.title, wrapper);
      const help = element('div', null, wrapper);
      help.style.color = '#d77b6b'; help.style.marginBottom = '6px';
      const field = {spec, control, menu, help, error: '', committed: signature(valueFor(spec))};
      fieldValue(field, valueFor(spec)); fields.push(field);
      const changed = () => { if (mounted && key === selectionKey && !control.disabled) commitFields(); };
      listen(control, 'change', changed, fieldListeners);
      if (!spec.choices.length && !['boolean', 'bool'].includes(spec.type)) listen(control, 'input', changed, fieldListeners);
    }
    validateFields();
  }
  function workflowReason(item) {
    if (!item) return '';
    const reason = item.reason || item.stale_reason || item.preparation_error || item.unavailable_reason;
    const reasons = {source_changed: 'Saved workflow changed; prepare it again in ComfyUI.', compatibility_changed: 'Node or runtime compatibility changed; prepare it again in ComfyUI.', nodes_unavailable: 'Required nodes are unavailable in this workspace.'};
    if (reason) return reasons[reason] || label(reason);
    if (item.stale || item.status === 'stale') return 'Preparation is stale; prepare this workflow again in ComfyUI.';
    if (item.status === 'unavailable') return 'Preparation could not be checked. Refresh workflows or reconnect.';
    if (item.prepared === false || item.status === 'unprepared' || item.ready === false || item.eligible === false) return 'Not prepared for Photoshop; prepare this workflow in ComfyUI.';
    return '';
  }
  function pendingJobs() { return state.authenticated ? array(state.pending).filter(job => !['delivered', 'completed', 'done', 'cancelled'].includes(job.state || job.status)) : []; }
  function renderJobs() {
    const pending = pendingJobs();
    const key = signature(pending);
    if (key === jobsSignature) return;
    jobsSignature = key; detach(jobListeners); empty(refs.jobs);
    if (!pending.length) return;
    element('div', 'Pending requests', refs.jobs).style.fontWeight = 'bold';
    for (const job of pending) {
      const rid = String(job.rid || job.request_id || '');
      const row = element('div', null, refs.jobs);
      const workspace = job.workspace_name || job.workspace_id || 'Unknown workspace';
      const documentName = job.documentName || job.document_name || (job.context && job.context.documentName);
      const documentID = job.documentID == null ? (job.document_id == null ? job.context && job.context.documentID : job.document_id) : job.documentID;
      const target = documentName || (documentID == null ? 'Original document' : 'Document ' + documentID);
      element('div', label(workspace) + ' • ' + label(target), row);
      const status = job.state || job.status || '';
      element('div', label(job.workflow_path || '') + (status ? ' • ' + label(status) : '') + (job.paused ? ' • Paused; Reconnect to resume' : ''), row);
      if (Number.isInteger(job.result_count) && job.result_count > 0) element('div', array(job.acknowledged).length + '/' + job.result_count + ' results inserted', row);
      const cancellable = rid && job.canCancel !== false && !['completed', 'done', 'cancelled', 'delivered', 'success', 'error', 'failed', 'retry_exhausted'].includes(status);
      if (cancellable && typeof hooks.onCancel === 'function') {
        const cancel = button('cancel:' + rid, 'Cancel request', row, () => {
          if (!pendingJobs().some(current => String(current.rid || current.request_id || '') === rid)) return;
          run(() => hooks.onCancel(rid), 'Cancellation failed. Refresh before retrying this request.');
        }, jobListeners);
        cancel.setAttribute('data-cancel', rid);
      }
    }
  }
  function render(value) {
    if (!mounted) return;
    const previous = state;
    state = value || {};
    const newKey = contextKey(state), contextChanged = newKey !== selectionKey;
    if (contextChanged) {
      clearPassword(); localError = ''; parameterCommitFailed = false; selectionKey = newKey; schemaKey = '';
      if (previous.origin !== state.origin || previous.username !== state.username || previous.authenticated !== state.authenticated) refs.username.value = state.username || '';
    }
    if (!serverDirty) refs.server.value = state.origin || '';
    refs.origin.textContent = state.origin ? 'Server: ' + label(state.origin) : 'Set the server address in Settings, then Connect.';
    refs.account.textContent = state.authenticated ? 'Signed in as ' + label(state.username || 'account') : 'Sign in to choose a ComfyUI workspace';
    visible(refs.login, !state.authenticated); visible(refs.logout, !!state.authenticated); visible(refs.selection, !!state.authenticated);
    workspaceItems = array(state.workspaces).map(item => typeof item === 'string' ? {id: item, name: item} : {id: item.id == null ? item.workspace_id : item.id, name: label(item.name || item.title || item.id || item.workspace_id)});
    let key = signature([workspaceItems, state.workspace_id]);
    if (workspaceSignature !== key) { workspaceSignature = key; options(refs.workspace, workspaceItems, state.workspace_id, 'Select a ComfyUI workspace'); }
    workflowItems = array(state.workflows).map(item => {
      if (typeof item === 'string') return {id: item, name: item, raw: {path: item}};
      const path = item.path || item.workflow_path || item.id;
      const reason = workflowReason(item);
      return {id: path, name: label(item.name || item.title || path) + (reason ? ' — ' + reason : ''), raw: item};
    });
    key = signature([workflowItems, state.workflow_path]);
    if (workflowSignature !== key) { workflowSignature = key; options(refs.workflow, workflowItems, state.workflow_path, 'Select a saved workflow'); }
    const selected = workflowItems.find(item => String(item.id) === String(state.workflow_path));
    refs.workflowReason.textContent = selected ? workflowReason(selected.raw) : (state.workspace_id && !workflowItems.length ? 'No saved workflows in this workspace. Use Refresh after saving one in ComfyUI.' : '');
    const specs = specsFor(state.parameter_schema);
    key = selectionKey + ':' + signature(specs);
    if (schemaKey !== key) { schemaKey = key; buildFields(specs); }
    else for (const field of fields) {
      const value = valueFor(field.spec), incoming = signature(value);
      if (incoming !== field.committed && !field.error) { fieldValue(field, value); field.committed = incoming; }
    }
    renderJobs(); updateControls();
  }
  function selectionReady() {
    const selected = workflowItems.find(item => String(item.id) === String(state.workflow_path));
    const item = selected && selected.raw;
    return !!state.authenticated && !!state.ready && !!state.canGenerate && !!state.workspace_id && !!state.workflow_path && !(item && (item.stale || item.executable === false || item.prepared === false || item.ready === false || item.eligible === false || ['stale', 'unprepared', 'unavailable'].includes(item.status)));
  }
  function updateControls() {
    if (!mounted) return;
    const auth = !!state.authenticated, pending = pendingMessage(), waiting = !!pending || !!state.auth_pending;
    disabled(refs.server, waiting); disabled(refs.connect, waiting);
    disabled(refs.username, waiting); disabled(refs.password, waiting);
    disabled(refs.signin, waiting || !state.origin || serverDirty);
    disabled(refs.logout, waiting);
    if (refs.editor) disabled(refs.editor, waiting);
    disabled(refs.workspace.control, waiting || !auth || serverDirty);
    disabled(refs.refreshWorkspaces, waiting || !auth || serverDirty);
    disabled(refs.workflow.control, waiting || !auth || !state.workspace_id || serverDirty);
    disabled(refs.refreshWorkflows, waiting || !auth || !state.workspace_id || serverDirty);
    for (const field of fields) disabled(field.control, waiting || !auth || !state.workflow_path || serverDirty);
    const invalid = fields.some(field => field.error);
    disabled(refs.generate, waiting || serverDirty || !selectionReady() || invalid || parameterCommitFailed || typeof hooks.onGenerate !== 'function');
    for (const listener of jobListeners) disabled(listener[0], waiting || !auth);
    refs.connect.textContent = pending === 'Connecting…' ? pending : state.origin ? 'Reconnect' : 'Connect';
    refs.signin.textContent = pending === 'Signing in…' ? pending : 'Sign in';
    root.setAttribute('aria-busy', waiting ? 'true' : 'false');
    const needsSignIn = !auth && state.diagnostic && state.diagnostic.stage === 'check_session' && state.diagnostic.code === 'unauthorized';
    const diagnostic = needsSignIn ? '' : diagnosticText(state.diagnostic);
    refs.diagnostic.textContent = pending ? '' : diagnostic;
    visible(refs.diagnostic, !!refs.diagnostic.textContent);
    refs.status.textContent = pending || localError || (state.auth_pending ? 'An earlier sign-in is still finishing. Wait before retrying.' : diagnostic ? 'Native connection needs attention. See the details below.' : needsSignIn ? 'Server selected. Sign in to continue.' : state.error ? transportError(state.error) : serverDirty ? 'Connect to use the edited server address.' : !state.origin ? 'Enter the server address and Connect.' : !auth ? 'Server selected. Sign in to continue.' : !state.workspace_id ? 'Choose a ComfyUI workspace.' : !state.workflow_path ? 'Choose a saved workflow.' : invalid ? 'Correct the highlighted parameters before executing.' : selectionReady() ? 'Ready to execute with the current Photoshop canvas.' : 'This workflow is not ready. Refresh and select it again.');
    refs.status.style.color = !pending && (localError || (!needsSignIn && state.error) || diagnostic || invalid) ? '#d77b6b' : '';
  }
  function validate() {
    if (!mounted) return false;
    const valid = validateFields(); updateControls();
    if (!valid || parameterCommitFailed || serverDirty || !selectionReady()) return false;
    // The original Generate button also uses this method. Flush a final native
    // field edit even when the host has not delivered a blur/change event yet.
    const changed = fields.some(field => signature(readField(field).value) !== signature(valueFor(field.spec)));
    return !changed || (!busy && commitFields());
  }
  const api = {
    mount(container) {
      if (!container || typeof container.appendChild !== 'function') throw new Error('Native panel requires a container');
      if (mounted && root.parentNode === container) { synchronize(); return api; }
      api.unmount(); mounted = true; generation++; busy = false; busyMessage = ''; expanded = true; shown = true;
      const styledKeys = ['position', 'zIndex', 'top', 'right', 'bottom', 'left', 'width', 'height', 'maxWidth', 'maxHeight', 'minHeight', 'boxSizing', 'display', 'flexDirection', 'overflow', 'backgroundColor'];
      containerStyles = {container, values: styledKeys.map(key => [key, container.style[key]])};
      root = element('div', null, container); root.setAttribute('data-ps-native-panel', '');
      root.style.display = 'flex'; root.style.flexDirection = 'column'; root.style.width = '100%'; root.style.minWidth = '0'; root.style.minHeight = '0'; root.style.maxHeight = '100%'; root.style.boxSizing = 'border-box';
      refs.open = button('open-workspace', 'Team workspace', root, () => expandSheet(true));
      refs.sheet = element('div', null, root);
      refs.sheet.style.display = 'flex'; refs.sheet.style.flexDirection = 'column'; refs.sheet.style.height = '100%'; refs.sheet.style.minHeight = '0';
      const header = element('div', null, refs.sheet);
      header.style.display = 'flex'; header.style.alignItems = 'center'; header.style.justifyContent = 'space-between'; header.style.flexShrink = '0'; header.style.padding = '8px'; header.style.borderBottom = '1px solid #555';
      const title = element('div', 'Team workspace', header); title.style.fontWeight = 'bold'; title.style.marginRight = '8px';
      refs.back = button('back-to-canvas', 'Back to canvas', header, () => expandSheet(false)); refs.back.style.marginBottom = '0'; refs.back.style.marginRight = '0';
      refs.scroll = element('div', null, refs.sheet); refs.scroll.setAttribute('data-native-scroll', '');
      refs.scroll.style.flex = '1 1 auto'; refs.scroll.style.minHeight = '0'; refs.scroll.style.overflowY = 'auto'; refs.scroll.style.overflowX = 'hidden'; refs.scroll.style.width = '100%';
      const body = element('div', null, refs.scroll);
      body.style.display = 'flex'; body.style.flexDirection = 'column'; body.style.alignItems = 'flex-start'; body.style.width = '100%'; body.style.maxWidth = '380px'; body.style.boxSizing = 'border-box'; body.style.padding = '12px';

      refs.server = textField('server', 'Server address', body);
      refs.server.setAttribute('placeholder', 'https://comfyui.example.com');
      refs.connect = button('connect', 'Connect', body, () => {
        const address = String(refs.server.value || state.origin || '').trim(), connectionGeneration = generation; clearPassword();
        run(async () => { const result = await (typeof hooks.onConnect === 'function' ? hooks.onConnect() : transport.connect(address)); const connected = snapshot(); if (mounted && generation === connectionGeneration && (result !== false || connected.origin === address)) serverDirty = false; return result === false && connected.origin && connected.status === 'login_required' ? true : result; }, 'Cannot connect. Check the server address, certificate, VPN and Photoshop network access.', 'Connecting…');
      });
      refs.origin = element('div', null, body); refs.origin.style.width = '100%'; refs.origin.style.wordWrap = 'break-word';
      visible(refs.server, typeof hooks.onConnect !== 'function');
      visible(refs.origin, typeof hooks.onConnect === 'function');
      refs.account = element('div', null, body);
      refs.login = element('div', null, body); refs.login.style.width = '100%';
      refs.username = textField('username', 'Username', refs.login);
      refs.password = textField('password', 'Password', refs.login, 'password');
      refs.password.setAttribute('autocomplete', 'off');
      refs.signin = button('signin', 'Sign in', refs.login, () => {
        let username, password;
        try { username = String(refs.username.value || '').trim(); password = readPasswordOnce(); }
        catch (_) { clearPassword(); localError = 'Photoshop could not read the sign-in fields. Re-enter your username and password, then retry.'; updateControls(); return; }
        if (!username || !password) { password = ''; localError = 'Enter a username and password.'; updateControls(); return; }
        run(() => { try { return transport.login(username, password); } finally { password = ''; } }, 'Sign-in failed. Check your credentials and server connection.', 'Signing in…');
      });
      refs.logout = button('logout', 'Sign out', body, () => { clearPassword(); run(() => transport.logout(), 'Sign-out failed. Reconnect before using another account.', 'Signing out…'); });
      refs.selection = element('div', null, body); refs.selection.style.width = '100%';
      refs.workspace = dropdown('workspace', 'ComfyUI workspace', refs.selection);
      refs.refreshWorkspaces = button('refresh-workspaces', 'Refresh workspaces', refs.selection, () => run(() => transport.refreshWorkspaces(), 'Could not refresh workspaces. Reconnect or sign in again.'));
      refs.workflow = dropdown('workflow', 'Saved workflow', refs.selection);
      refs.refreshWorkflows = button('refresh-workflows', 'Refresh workflows', refs.selection, () => run(() => transport.refreshWorkflows(), 'Could not refresh workflows. Reconnect or sign in again.'));
      refs.workflowReason = element('div', null, refs.selection);
      refs.parameters = element('div', null, refs.selection);
      refs.generate = button('generate', 'Execute in Photoshop', refs.selection, () => {
        if (!validate() || !commitFields()) return;
        run(() => hooks.onGenerate(snapshot()), 'Execution could not start. Check the Photoshop document and workflow selection.');
      });
      if (typeof hooks.onOpenEditor === 'function') {
        refs.editor = button('open-editor', 'Load optional Web editor', body, () => run(() => hooks.onOpenEditor(), 'Could not load the optional editor. Native execution remains available.'));
        element('div', 'The Web editor is optional. Native execution does not need it.', body);
      }
      refs.status = element('div', null, body); refs.status.setAttribute('role', 'status'); refs.status.style.marginTop = '6px'; refs.status.style.width = '100%';
      refs.diagnostic = element('div', null, body); refs.diagnostic.setAttribute('data-native-diagnostic', ''); refs.diagnostic.style.marginTop = '6px'; refs.diagnostic.style.width = '100%'; refs.diagnostic.style.color = '#d77b6b';
      refs.jobs = element('div', null, body); refs.jobs.style.marginTop = '8px';
      listen(refs.server, 'input', () => { serverDirty = String(refs.server.value || '') !== String(state.origin || ''); clearPassword(); updateControls(); });
      listen(refs.workspace.control, 'change', () => { const item = selectedItem(refs.workspace, workspaceItems); if (mounted && !refs.workspace.control.disabled && !busy && item && String(item.id) !== String(state.workspace_id)) run(() => transport.selectWorkspace(item.id), 'Could not select this workspace. Refresh workspaces and try again.'); });
      listen(refs.workflow.control, 'change', () => { const item = selectedItem(refs.workflow, workflowItems); if (mounted && !refs.workflow.control.disabled && !busy && item) run(() => transport.selectWorkflow(item.id), 'Could not load this workflow’s preparation. Refresh workflows and try again.'); });
      state = {}; selectionKey = ''; schemaKey = ''; workspaceSignature = ''; workflowSignature = ''; jobsSignature = ''; serverDirty = false; localError = ''; parameterCommitFailed = false;
      displaySheet(); synchronize();
      if (typeof transport.subscribe === 'function') unsubscribe = transport.subscribe(value => { if (mounted) render(value || snapshot()); });
      return api;
    },
    unmount() {
      mounted = false; generation++; clearPassword();
      if (typeof unsubscribe === 'function') unsubscribe(); unsubscribe = null;
      detach(listeners); detach(fieldListeners); detach(jobListeners);
      if (root && typeof hooks.onViewChange === 'function') hooks.onViewChange(false);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      if (containerStyles) for (const entry of containerStyles.values) containerStyles.container.style[entry[0]] = entry[1] == null ? '' : entry[1];
      containerStyles = null;
      root = null; refs = {}; fields = []; state = {}; busy = false;
      return api;
    },
    show(value) { if (root) { const wasShown = shown; shown = value !== false; if (!shown) clearPassword(); else if (!wasShown && !state.authenticated) expanded = true; displaySheet(); } return api; },
    validate
  };
  return api;
};
