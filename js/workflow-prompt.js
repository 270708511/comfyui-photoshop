// Use Everywhere only injects virtual links into its published conversion entry.
export async function currentWorkflowPrompt(application, fallback = application.graphToPrompt) {
  const hasUE = (application.graph?._nodes || application.graph?.nodes || []).some(node =>
    String(node.comfyClass || node.type || '').includes('Everywhere'));
  let prompt;
  if (typeof application.ue_modified_prompt === 'function') prompt = await application.ue_modified_prompt();
  else {
    if (hasUE) throw new Error('Use Everywhere conversion is unavailable; reload the Web panel and check the extension');
    prompt = await fallback.call(application);
  }
  if (!prompt?.output || typeof prompt.output !== 'object') throw new Error('Workflow conversion returned no prompt');
  const required = {CLIPTextEncode: ['clip'], KSampler: ['model'], KSamplerAdvanced: ['model'], VAEDecode: ['vae']};
  const missing = [];
  for (const [id, node] of Object.entries(prompt.output)) {
    for (const name of required[node.class_type] || []) {
      if (node.inputs?.[name] == null) missing.push(`${node.class_type} #${id}.${name}`);
    }
  }
  if (missing.length) throw new Error('Workflow inputs unresolved: ' + missing.join(', ') + (hasUE ? ' (Use Everywhere links were not applied)' : ''));
  return prompt;
}

export function installUEPromptCompatibility(application) {
  // Install only AFTER UE initialization. Its analyser has captured the original
  // converter by then, so this wrapper cannot recurse into itself.
  if (typeof application.ue_modified_prompt !== 'function' || application.graphToPrompt?.psUECompatible) return false;
  const original = application.graphToPrompt;
  const wrapped = function() { return currentWorkflowPrompt(application, original); };
  wrapped.psUECompatible = true;
  application.graphToPrompt = wrapped;
  return true;
}
