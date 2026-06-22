<script>
  import { createEventDispatcher } from "svelte";

  export let type = "textfield";
  export let placeholder = "";
  export let id = "";
  export let value = "";
  export let style = "";
  export let size = "";
  export let numeric = false;
  export let className = "";

  const dispatch = createEventDispatcher();

  function handleInput(e) {
    value = e.target.value;
    dispatch("valueChange", value);
  }

  function handleCheckboxChange(e) {
    value = e.target.checked;
    dispatch("valueChange", value);
  }
</script>

{#if type === "checkbox"}
  <label class="checkbox-row" style={style}>
    <input
      type="checkbox"
      {id}
      bind:checked={value}
      on:change={handleCheckboxChange}
    />
    <slot />
  </label>
{:else if type === "textarea"}
  <textarea
    {id}
    {placeholder}
    bind:value
    on:input={handleInput}
    class="native-field textarea {className}"
    {style}
  ></textarea>
{:else if numeric}
  <input
    type="number"
    {id}
    {placeholder}
    bind:value
    on:input={handleInput}
    class="native-field {size === 's' ? 'compact' : ''} {className}"
    {style}
  />
{:else}
  <input
    type="text"
    {id}
    {placeholder}
    bind:value
    on:input={handleInput}
    class="native-field {size === 's' ? 'compact' : ''} {className}"
    {style}
  />
{/if}

<style>
  .native-field {
    width: 100%;
    min-height: 42px;
    background: var(--color-dark-gray, #262627);
    border: 1px solid var(--color-hover-gray, #303031);
    color: #d8d8d8;
    border-radius: 10px;
    padding: 4px 14px;
    outline: none;
    font-weight: 700;
    font-size: 12px;
    font-family: var(--font-family, Arial, sans-serif);
  }

  .native-field:hover,
  .native-field:focus {
    background: #2f2f31;
    border-color: #39393b;
  }

  .native-field.textarea {
    min-height: 68px;
    height: 68px;
    resize: none;
    padding: 12px 14px;
  }

  .native-field.compact {
    width: 86px;
    flex: 0 0 86px;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    color: #969696;
    font-size: 12px;
    font-weight: 200;
    cursor: pointer;
  }

  .checkbox-row:hover {
    color: #cacaca;
  }

  .checkbox-row input {
    width: 16px;
    height: 16px;
    accent-color: #d0d0d0;
    margin-left: 4px;
  }
</style>
