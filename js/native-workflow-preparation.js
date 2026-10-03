import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import * as comfyWidgets from '../../../scripts/widgets.js';

// Optional browser authoring only. Photoshop executes the saved preparation via
// the native company adapter; this module never queues a graph or opens a bridge.
// ComfyUI auto-loads .js extensions in WEB_DIRECTORY, so team.js stays unchanged.
// Official frontend v1.53.6 APIs: registerExtension(commands/menuCommands),
// loadGraphData, graphToPrompt and widgets.IS_CONTROL_WIDGET. Queue-time hooks
// are intentionally NOT run: graphToPrompt does not implement queuePrompt's
// beforeQueued/afterQueued lifecycle. Official pinned sources:
// https://github.com/Comfy-Org/ComfyUI_frontend/blob/v1.53.6/src/scripts/app.ts
// https://github.com/Comfy-Org/ComfyUI_frontend/blob/v1.53.6/src/scripts/widgets.ts
// https://github.com/Comfy-Org/ComfyUI_frontend/blob/v1.53.6/src/renderer/extensions/vueNodes/widgets/composables/useIntWidget.ts
const VERSION = 'ps-team-1';
const COMMAND = 'photoshop.prepareSavedWorkflow';
const TITLE = 'Prepare saved workflow for Photoshop';
const OUTPUT_CLASS = '🔹SendTo Photoshop Plugin';
const SEED_INPUTS = new Set(['seed', 'noise_seed']);
const CORE_SEED_NODES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'RandomNoise']);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PARAMETERS = 128;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new PreparationError(message); };

export class PreparationError extends Error {}

export function workflowPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('workflows/') || !/\.json$/i.test(value) || /[\\%\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('Choose a saved .json file inside the workflows folder. Encoded or parent-directory paths are not supported.');
  }
  return value;
}

export function savedWorkflows(items) {
  if (!Array.isArray(items)) fail('The server returned an unsupported workflow list. Ask your administrator to check the userdata API.');
  const result = [];
  const seen = new Set();
  for (const item of items) {
    // GET /api/userdata?dir=workflows&full_info=true is relative to workflows.
    const relative = typeof item === 'string' ? item : item?.path;
    if (typeof relative !== 'string' || !/\.json$/i.test(relative)) continue;
    try {
      const path = workflowPath('workflows/' + relative);
      if (!seen.has(path)) { seen.add(path); result.push({path, label: relative}); }
    } catch { /* Ignore paths which cannot safely identify one saved workflow. */ }
  }
  return result.sort((a, b) => a.label.localeCompare(b.label));
}

export function workspaces(config, currentUser) {
  if (!record(config) || config.storage !== 'server') fail('Server-side saved workflows are required.');
  const users = record(config.users) ? Object.entries(config.users) : [['default', 'Default']];
  const result = users.filter(([id, label]) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && typeof label === 'string').map(([id, label]) => ({id, label}));
  if (!result.length) fail('No saved-workflow profiles are available. Create a profile in ComfyUI first.');
  return {items: result, selected: result.some(item => item.id === currentUser) ? currentUser : result[0].id};
}

export function validatePrompt(prompt) {
  if (!record(prompt) || !Object.keys(prompt).length) fail('ComfyUI produced an empty API prompt. Check the saved graph and installed nodes.');
  for (const [id, node] of Object.entries(prompt)) {
    if (BLOCKED_KEYS.has(id) || !record(node) || typeof node.class_type !== 'string' || !node.class_type || !record(node.inputs)) fail('The saved graph contains an unsupported or missing node. Repair it in ComfyUI, save, then prepare again.');
  }
  if (!Object.values(prompt).some(node => node.class_type === OUTPUT_CLASS)) fail('The saved graph needs an active SendTo Photoshop Plugin output node. Save that change before preparing it.');
  return prompt;
}

export function inspectRuntime(graph, workflow, controlMarker = comfyWidgets.IS_CONTROL_WIDGET) {
  if (!record(workflow) || !Array.isArray(workflow.nodes) || !workflow.nodes.length) fail('This file is not a saved ComfyUI UI workflow. Save the editable graph, rather than an API-only export.');
  if (workflow.definitions?.subgraphs?.length) fail('Subgraphs are not supported by this preparation version. Use and save a flat graph first.');
  if (!graph || typeof graph.computeExecutionOrder !== 'function') fail('This ComfyUI frontend does not expose the required graph API. Ask your administrator to update it.');
  const nodes = graph.computeExecutionOrder(false);
  if (!Array.isArray(nodes) || !nodes.length) fail('The saved graph did not load. Resolve ComfyUI loading errors before preparing again.');
  if (nodes.length !== workflow.nodes.length || workflow.nodes.some(saved => !nodes.some(node => String(node.id) === String(saved.id) && (node.comfyClass || node.type) === saved.type))) fail('The loaded graph does not match the saved node list. Resolve missing nodes, save the graph and prepare again.');
  const requiredSeeds = [];
  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue; // muted/bypassed
    if (node.isSubgraphNode?.() || node.subgraph || typeof node.getInnerNodes === 'function') fail('Subgraphs and custom nested graphs are not supported by this preparation version.');
    for (const widget of node.widgets || []) {
      const hasQueueHook = typeof widget.beforeQueued === 'function' || typeof widget.afterQueued === 'function';
      if (!hasQueueHook) continue;
      const target = (node.widgets || []).find(candidate => SEED_INPUTS.has(candidate.name) && candidate.linkedWidgets?.includes(widget));
      const values = widget.options?.values;
      const knownSeedControl = controlMarker && widget[controlMarker] === true && CORE_SEED_NODES.has(node.comfyClass || node.type) && target && widget.name === 'control_after_generate' && widget.options?.serialize === false && Array.isArray(values) && values.length === 4 && ['fixed', 'increment', 'decrement', 'randomize'].every(value => values.includes(value));
      if (!knownSeedControl) fail('A custom queue-time widget is present. This version cannot reproduce its behavior in native execution. Use a tested graph without that callback, save, then prepare again.');
      const linked = (node.inputs || []).some(input => input.widget?.name === target.name && input.link !== null && input.link !== undefined);
      if (!linked && widget.value !== 'fixed') fail('Set each built-in seed control to fixed and save the workflow before preparing. Native Photoshop parameters set the seed explicitly; browser randomize/increment modes are not replayed.');
      if (!linked) {
        if (!Number.isSafeInteger(target.value) || target.value < 0) fail('Use a nonnegative safe integer seed (0–9007199254740991), then save the workflow again.');
        requiredSeeds.push({node_id: String(node.id), input: target.name});
      }
    }
  }
  return {nodes, requiredSeeds};
}

export function parameterCandidates(prompt, nodes = []) {
  validatePrompt(prompt);
  const result = [];
  for (const [nodeID, node] of Object.entries(prompt)) {
    const runtime = nodes.find(candidate => String(candidate.id) === nodeID);
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!scalar(value) || BLOCKED_KEYS.has(input) || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) continue;
      const widget = runtime?.widgets?.find(candidate => candidate.name === input);
      const options = widget?.options?.values;
      const enumValues = Array.isArray(options) && options.length > 0 && options.length <= 256 && options.every(scalar) && options.includes(value) ? [...new Set(options)] : null;
      const type = enumValues ? 'enum' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
      const candidate = {id: 'param_' + (result.length + 1), node_id: nodeID, input, type, default: value, label: `${node._meta?.title || node.class_type} · ${input}`.slice(0, 200)};
      if (enumValues) candidate.options = enumValues;
      if (type === 'integer' || type === 'number') {
        // Unknown numeric domains remain locked to the saved literal. The author
        // can explicitly widen them after checking the node's allowed range.
        const min = widget?.options?.min, max = widget?.options?.max;
        candidate.min = Number.isFinite(min) && min <= value ? Math.max(min, -Number.MAX_SAFE_INTEGER) : value;
        candidate.max = Number.isFinite(max) && max >= value ? Math.min(max, Number.MAX_SAFE_INTEGER) : value;
        if (SEED_INPUTS.has(input)) { candidate.min = Math.max(0, candidate.min); }
        if (type === 'integer') { candidate.min = Math.ceil(candidate.min); candidate.max = Math.floor(candidate.max); }
      }
      result.push(candidate);
    }
  }
  return result;
}

export function validateParameters(parameters, prompt, requiredSeeds = []) {
  if (!Array.isArray(parameters) || parameters.length > MAX_PARAMETERS) fail('Parameter mapping must be a JSON array with at most 128 entries.');
  const ids = new Set(), targets = new Set();
  for (const parameter of parameters) {
    if (!record(parameter) || Object.keys(parameter).some(key => !['id', 'node_id', 'input', 'type', 'default', 'label', 'min', 'max', 'options'].includes(key))) fail('A parameter contains unknown fields. Use only id, node_id, input, type, default, label, min, max and options.');
    const {id, node_id: nodeID, input, type, default: value} = parameter;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || BLOCKED_KEYS.has(id) || ids.has(id)) fail('Parameter IDs must be unique safe names of 1–64 letters, digits, underscores or hyphens.');
    if (typeof nodeID !== 'string' || !own(prompt, nodeID) || typeof input !== 'string' || BLOCKED_KEYS.has(input) || !own(prompt[nodeID].inputs, input) || !scalar(prompt[nodeID].inputs[input])) fail('Every parameter must point to an existing scalar API input, never a node connection or object.');
    const target = JSON.stringify([nodeID, input]);
    if (targets.has(target)) fail('Map each node input only once.');
    ids.add(id); targets.add(target);
    if (parameter.label !== undefined && (typeof parameter.label !== 'string' || parameter.label.length > 200)) fail('Parameter labels must be text no longer than 200 characters.');
    const original = prompt[nodeID].inputs[input];
    if (!scalar(value) || typeof original !== typeof value || original !== value) fail('A parameter default must exactly match its saved API input. Change and save the graph first if a different default is needed.');
    if (type === 'enum') {
      if (!Array.isArray(parameter.options) || !parameter.options.length || parameter.options.length > 256 || !parameter.options.every(scalar) || !parameter.options.includes(value)) fail('Enum options must contain 1–256 scalar values, including the default.');
    } else if (type === 'string' || type === 'boolean') {
      if (typeof value !== type) fail('A parameter default does not match its declared type.');
      if (type === 'string' && value.length > 65536) fail('A text parameter is too long.');
    } else if (type === 'integer' || type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isSafeInteger(value))) fail('Numeric defaults must be finite; integer defaults must be safe integers.');
      if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max) || parameter.min > parameter.max || value < parameter.min || value > parameter.max) fail('Numeric parameters need finite min/max bounds containing the default.');
      if (type === 'integer' && (!Number.isSafeInteger(parameter.min) || !Number.isSafeInteger(parameter.max))) fail('Integer bounds must be safe integers.');
    } else fail('Allowed parameter types: string, integer, number, boolean and enum.');
    if (type !== 'enum' && own(parameter, 'options')) fail('Only enum parameters accept options.');
    if (!['integer', 'number'].includes(type) && (own(parameter, 'min') || own(parameter, 'max'))) fail('Only numeric parameters accept min/max bounds.');
    if (SEED_INPUTS.has(input) && (type !== 'integer' || parameter.min < 0)) fail('Literal seed inputs must use bounded, nonnegative integer parameters.');
  }
  for (const seed of requiredSeeds) {
    if (!targets.has(JSON.stringify([seed.node_id, seed.input]))) fail('Map every fixed built-in seed as a bounded integer parameter so Photoshop can choose it explicitly.');
  }
  return copy(parameters);
}

export function createPreparationClient({application = app, frontendAPI = api, fetcher = (...args) => fetch(...args)} = {}) {
  async function request(path, {method = 'GET', body, workspace, emptyListOn404 = false} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const headers = {'X-PS-Team': VERSION, 'Accept': 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const profile = workspace || frontendAPI.user;
    if (profile) headers['Comfy-User'] = profile;
    try {
      const response = await fetcher(path, {method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      if (response.status === 404 && emptyListOn404) return [];
      if (!response.ok) {
        if ([401, 403].includes(response.status)) fail('Sign in to the company ComfyUI server and check your access, then reopen this dialog.');
        if (response.status === 404) fail('This workflow or the preparation API is unavailable. Refresh the saved list or ask your administrator to install native workflow preparation support.');
        if (response.status === 409) fail('The saved workflow changed. Reload and review it before preparing again.');
        if (response.status === 413) fail('This workflow is too large for native preparation. Use a smaller saved graph.');
        if (response.status === 422) fail('The server rejected this preparation. Check the saved graph, Photoshop output and parameter mapping, then reload.');
        fail(`The company server could not complete this request (HTTP ${response.status}). Try again after checking the server.`);
      }
      try { return await response.json(); } catch { fail('The company server returned an invalid response. Check that you are signed in and the preparation API is installed.'); }
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      // Never show server HTML, proxy details, credential-bearing URLs or raw
      // custom-widget exceptions in the UI or console.
      fail('The company server could not be reached. Check your connection and sign-in, then try again.');
    } finally { clearTimeout(timer); }
  }
  const route = (workspace, path) => '/ps/team/workflow-preparations?' + new URLSearchParams({workspace_id: workspace, path: workflowPath(path)});
  return {
    async catalog() {
      const capability = await request('/ps/team/capabilities');
      if (capability?.protocol !== VERSION || capability.owner_bound !== true) fail('This server does not advertise authenticated native workflow preparation. Ask your administrator to update the company adapter.');
      return workspaces(await request('/api/users'), frontendAPI.user);
    },
    async workflows(workspace) {
      return savedWorkflows(await request('/api/userdata?dir=workflows&recurse=true&split=false&full_info=true', {workspace, emptyListOn404: true}));
    },
    async inspect(workspace, path, {replaceConfirmed = false} = {}) {
      if (replaceConfirmed !== true) fail('Confirm that unsaved graph changes may be replaced before loading the saved workflow.');
      if (typeof application.loadGraphData !== 'function' || typeof application.graphToPrompt !== 'function') fail('This ComfyUI frontend lacks the required preparation APIs. Ask your administrator to update it.');
      const source = await request('/api/userdata/' + encodeURIComponent(workflowPath(path)), {workspace});
      if (!record(source) || !Array.isArray(source.nodes) || !source.nodes.length) fail('Choose a saved editable ComfyUI workflow, not an API-only JSON export.');
      const state = await request(route(workspace, path), {workspace});
      if (!['unprepared', 'prepared', 'stale'].includes(state?.status) || typeof state.current_source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(state.current_source_hash)) fail('The server returned an unsupported preparation status. Ask your administrator to check the adapter version.');
      try {
        // loadGraphData and graphToPrompt may mutate their graph data. Keep the
        // original source immutable so the server can verify its canonical hash.
        const loaded = await application.loadGraphData(copy(source), true, true, null, {deferWarnings: true, skipAssetScans: true});
        if (loaded !== true && !record(loaded)) fail('ComfyUI could not confirm loading this workflow. Resolve its node or model errors and use a supported frontend.');
        const runtime = inspectRuntime(application.rootGraph || application.graph, source);
        const converted = await application.graphToPrompt();
        const prompt = copy(validatePrompt(converted?.output));
        const requiredSeeds = [];
        for (const [nodeID, node] of Object.entries(prompt)) {
          for (const [input, value] of Object.entries(node.inputs)) {
            if (!SEED_INPUTS.has(input) || !scalar(value)) continue;
            if (!Number.isSafeInteger(value) || value < 0) fail('All literal seed inputs must be nonnegative safe integers. Correct the saved workflow before preparing.');
            requiredSeeds.push({node_id: nodeID, input});
          }
        }
        const candidates = parameterCandidates(prompt, runtime.nodes);
        return {workspace, path, source_hash: state.current_source_hash, workflow: copy(source), api_prompt: prompt, requiredSeeds, candidates, previousStatus: state.status};
      } catch (error) {
        if (error instanceof PreparationError) throw error;
        fail('ComfyUI could not convert this saved graph. Resolve missing nodes and custom-widget errors, save it, then try again.');
      }
    },
    async save(draft, parameters, {reviewConfirmed = false} = {}) {
      if (reviewConfirmed !== true) fail('Review and confirm the parameter mapping and runtime limitations before saving.');
      validatePrompt(draft.api_prompt);
      const mapped = validateParameters(parameters, draft.api_prompt, draft.requiredSeeds);
      const result = await request(route(draft.workspace, draft.path), {method: 'PUT', workspace: draft.workspace, body: {source_hash: draft.source_hash, api_prompt: draft.api_prompt, workflow: draft.workflow, parameters: mapped}});
      if (result?.status !== 'prepared' || !result.preparation?.preparation_id) fail('The save response was not confirmed. Reopen this workflow to check its preparation status before trying again.');
      return result;
    },
  };
}

export function createNativePreparationExtension({application = app, frontendAPI = api, documentObject = globalThis.document, fetcher} = {}) {
  let currentDialog = null;
  function openDialog() {
    if (currentDialog) { currentDialog.focus(); return currentDialog; }
    const document = documentObject;
    const element = (tag, text, attributes = {}) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      Object.assign(node, attributes);
      return node;
    };
    const dialog = element('dialog');
    currentDialog = dialog;
    dialog.style.cssText = 'width:min(800px,92vw);max-height:90vh;overflow:auto;padding:24px;border:1px solid #6b7280;border-radius:12px;background:var(--comfy-menu-bg,#202228);color:var(--input-text,#eee);font:14px/1.5 system-ui;';
    dialog.setAttribute('aria-labelledby', 'ps-native-preparation-title');
    const title = element('h2', TITLE, {id: 'ps-native-preparation-title'});
    const explanation = element('p', 'Optional browser setup for saved workflows. Photoshop selects and runs the prepared workflow natively. Saved profiles are shared workflow spaces, not account permissions.');
    const warning = element('p', 'Loading a saved workflow replaces the current browser graph and may discard unsaved changes. Save your work first. Preparation does not run the workflow or verify GPU execution.');
    const status = element('p', 'Checking company preparation support…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const profile = element('select', undefined, {disabled: true});
    const workflow = element('select', undefined, {disabled: true});
    const replace = element('input', undefined, {type: 'checkbox'});
    const replaceLabel = element('label'); replaceLabel.append(replace, element('span', ' I saved my changes and allow the selected saved workflow to replace the current graph'));
    const load = element('button', 'Load saved workflow and review', {type: 'button', disabled: true});
    const mapping = element('textarea', undefined, {rows: 14, spellcheck: false, disabled: true, value: '[]'});
    mapping.setAttribute('aria-label', 'Native parameter mapping JSON'); mapping.style.cssText = 'display:block;width:100%;box-sizing:border-box;font:12px/1.4 monospace;';
    const instructions = element('p', 'Review the suggested scalar mappings below. Remove entries you do not want exposed in Photoshop; edit labels and numeric min/max bounds. Unrecognized numeric ranges start locked to their saved value. Connections and objects cannot be mapped. Built-in fixed literal seeds must stay mapped as bounded integers.');
    const review = element('input', undefined, {type: 'checkbox', disabled: true});
    const reviewLabel = element('label'); reviewLabel.append(review, element('span', ' I reviewed these mappings and will validate a native test run. Custom runtime-widget behavior is not guaranteed. Saving replaces this shared workflow’s preparation.'));
    const save = element('button', 'Save preparation for Photoshop', {type: 'button', disabled: true});
    const close = element('button', 'Close', {type: 'button'});
    const labeled = (text, control) => { const label = element('label', text); label.style.display = 'block'; label.append(control); control.style.margin = '8px'; return label; };
    const actions = element('div'); actions.style.cssText = 'display:flex;gap:12px;margin-top:16px;'; actions.append(save, close);
    dialog.append(title, explanation, warning, labeled('Saved-workflow profile ', profile), labeled('Saved workflow ', workflow), replaceLabel, element('br'), load, status, instructions, mapping, reviewLabel, actions);
    document.body.append(dialog);
    let busy = false, draft = null, closed = false, hasCatalog = false;
    const client = createPreparationClient({application, frontendAPI, fetcher});
    const refresh = () => {
      profile.disabled = busy || !hasCatalog;
      workflow.disabled = busy || !workflow.value;
      replace.disabled = busy;
      load.disabled = busy || !workflow.value || !replace.checked;
      mapping.disabled = busy || !draft;
      review.disabled = busy || !draft;
      save.disabled = busy || !draft || !review.checked;
      close.disabled = busy;
    };
    const clearDraft = () => { draft = null; mapping.value = '[]'; review.checked = false; replace.checked = false; refresh(); };
    const run = async operation => {
      if (busy || closed) return;
      busy = true; refresh();
      try { await operation(); }
      catch (error) { status.textContent = error instanceof PreparationError ? error.message : 'Preparation could not finish. Reopen the dialog and try again.'; }
      finally { busy = false; if (!closed) refresh(); }
    };
    const options = (select, items, selected) => {
      select.replaceChildren(...items.map(item => element('option', item.label, {value: item.id || item.path})));
      select.value = selected || items[0]?.id || items[0]?.path || '';
    };
    const list = async () => {
      clearDraft(); options(workflow, []);
      status.textContent = 'Reading saved workflows…';
      options(workflow, await client.workflows(profile.value));
      status.textContent = workflow.value ? 'Choose a saved workflow, then confirm graph replacement to review it.' : 'No saved workflows found in this profile. Save an editable workflow in ComfyUI first.';
    };
    profile.addEventListener('change', () => run(list));
    workflow.addEventListener('change', () => { clearDraft(); status.textContent = 'Selection changed. Confirm graph replacement, then load the saved workflow.'; });
    replace.addEventListener('change', refresh);
    review.addEventListener('change', refresh);
    mapping.addEventListener('input', () => { review.checked = false; refresh(); });
    load.addEventListener('click', () => run(async () => {
      draft = null; review.checked = false; mapping.value = '[]';
      status.textContent = 'Loading the saved graph and checking supported widgets…';
      draft = await client.inspect(profile.value, workflow.value, {replaceConfirmed: replace.checked});
      mapping.value = JSON.stringify(draft.candidates, null, 2);
      status.textContent = `Previous preparation: ${draft.previousStatus}. Review the mapping, then explicitly save the new preparation. Native runs use this saved snapshot; later browser graph edits are not included.`;
    }));
    save.addEventListener('click', () => run(async () => {
      let parameters;
      try { parameters = JSON.parse(mapping.value); } catch { fail('The parameter mapping is not valid JSON. Correct it before saving.'); }
      status.textContent = 'Saving the reviewed preparation…';
      await client.save(draft, parameters, {reviewConfirmed: review.checked});
      status.textContent = 'Preparation saved. Refresh the workflow in the Photoshop native panel and validate a test run. Any later saved-workflow change requires preparing again.';
      draft = null; review.checked = false;
    }));
    const dismiss = () => { if (busy) return; closed = true; currentDialog = null; dialog.close(); dialog.remove(); };
    close.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.showModal();
    run(async () => {
      const catalog = await client.catalog();
      hasCatalog = true;
      options(profile, catalog.items, catalog.selected);
      await list();
    });
    return dialog;
  }
  return {
    name: 'photoshop.native.savedWorkflowPreparation',
    commands: [{id: COMMAND, label: TITLE, function: openDialog}],
    menuCommands: [{path: ['Photoshop'], commands: [COMMAND]}],
  };
}

app.registerExtension(createNativePreparationExtension());
