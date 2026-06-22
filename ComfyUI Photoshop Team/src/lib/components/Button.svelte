<script>
  import { createEventDispatcher } from "svelte";

  export let text = "Button";
  export let toggle = false;
  export let value = false;
  export let className = "";
  export let style = "";

  const dispatch = createEventDispatcher();

  $: computedClass = value ? "active" : className;

  function handleEvent(e) {
    dispatch(e.type, { originalEvent: e, target: e.target });
    if (e.type === "click" && toggle) {
      value = !value;
      dispatch("valueChange", value);
    }
  }
</script>

<span
  class="ux-button {computedClass}"
  {style}
  role="button"
  on:click={handleEvent}
  on:mouseenter={handleEvent}
  on:mouseleave={handleEvent}
  on:mousemove={handleEvent}
  on:mousedown={handleEvent}
  on:contextmenu={handleEvent}
  on:mouseup={handleEvent}
  on:focus={handleEvent}
>
  {#if $$slots.default}
    <slot />
  {:else}
    {text}
  {/if}
</span>

<style>
  .ux-button {
    background: var(--color-dark-gray, #262627);
    color: #949494;
    border: 1px solid var(--color-hover-gray, #303031);
    border-radius: 10px;
    padding: 4px 14px;
    height: 42px;
    font-weight: 700;
    font-size: 12px;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: var(--font-family, Arial, sans-serif);
  }

  .ux-button:hover {
    background: #2f2f31;
    color: var(--color-white, #cccccc);
  }

  .ux-button.active {
    background: #27394d;
    color: #dcdcdc;
    border-color: #4d647d;
  }
</style>
