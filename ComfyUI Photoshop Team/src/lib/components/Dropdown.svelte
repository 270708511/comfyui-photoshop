<script>
  import { createEventDispatcher, onMount } from "svelte";
  import SVGIcon from "./SVGIcon.svelte";

  export let label = "";
  export let items = []; // [{id, label}]
  export let selected = "";
  export let prefix = "";
  export let style = "";

  const dispatch = createEventDispatcher();

  let open = false;
  let dropdownEl;

  function toggle() {
    open = !open;
  }

  function select(item) {
    selected = item.id;
    dispatch("change", item);
    open = false;
  }

  function closeOverlay() {
    open = false;
  }

  onMount(() => {
    if (!selected && items.length > 0) {
      selected = items[0].id;
    }
  });
</script>

<div class="dropdown" {style}>
  <div class="dropdown-label" on:click={toggle}>
    <span class="discrip">{prefix} {label}</span>
    <SVGIcon
      data='<path fill-rule="evenodd" clip-rule="evenodd" d="M4.88793 8.13736L9.71283 12.9623C10.2035 13.4529 10.997 13.4529 11.4876 12.9623L16.3125 8.13736C16.8032 7.64672 16.8032 6.85328 16.3125 6.36264C15.8219 5.87199 15.0284 5.87199 14.5378 6.36264L10.6002 10.3002L6.66267 6.36264C6.17203 5.87199 5.37858 5.87199 4.88793 6.36264C4.39729 6.85328 4.39729 7.64672 4.88793 8.13736Z" fill="#7D7D7D"/>'
      size="16"
    />
  </div>

  {#if open}
    <div class="overlay" on:click={closeOverlay}></div>
    <div class="dropdown-menu">
      {#each items as item}
        <div
          class="dropdown-item"
          class:selected={selected === item.id}
          id={item.id}
          on:click={() => select(item)}
        >
          <span>{item.label}</span>
          {#if selected === item.id}
            <SVGIcon
              data='<path fill-rule="evenodd" clip-rule="evenodd" d="M25.8593 12.7374L13.6157 24.981C12.8644 25.7322 11.6463 25.7322 10.8949 24.981L6.14113 20.605C5.38981 19.8537 5.38981 18.6356 6.14113 17.8843C6.89245 17.133 8.11059 17.133 8.86191 17.8843L11.9606 20.605H12.55L23.1385 10.0166C23.8899 9.2653 25.1079 9.2653 25.8593 10.0166C26.6105 10.7679 26.6105 11.9861 25.8593 12.7374Z" fill="#7D7D7D"/>'
              size="16"
            />
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <slot />
</div>

<style>
  .dropdown {
    position: relative;
    width: 100%;
  }

  .dropdown-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    padding: 8px 12px;
    background: #000;
    border-radius: var(--border-radius-m, 18px);
    border: 1px solid #1a1a1a;
  }

  .discrip {
    font-size: var(--font-size-medium, 12px);
    color: #969696;
    font-weight: 200;
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: #1a1a1a;
    border: 1px solid #282828;
    border-radius: 10px;
    z-index: 100;
    max-height: 200px;
    overflow-y: auto;
    margin-top: 4px;
  }

  .dropdown-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    cursor: pointer;
    color: #969696;
    font-size: 12px;
  }

  .dropdown-item:hover {
    background: #262627;
    color: #cccccc;
  }

  .dropdown-item.selected {
    color: #cccccc;
  }
</style>
