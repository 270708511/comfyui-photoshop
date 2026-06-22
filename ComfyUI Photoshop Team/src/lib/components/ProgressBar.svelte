<script>
  import { onMount } from "svelte";

  export let progress = 0;
</script>

<div class="progress">
  <div class="progress-bar" style="width: {progress}%"></div>
</div>

<style>
  .progress {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    width: 100%;
    height: 4px;
    background-color: #000;
    z-index: 6;
  }

  .progress-bar {
    height: 100%;
    background: #868686;
    border-radius: 2px;
    width: 0%;
    transition: width 0.15s;
  }
</style>
