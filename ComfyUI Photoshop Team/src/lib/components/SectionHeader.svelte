<script>
  export let title = "";
  export let status = "";
</script>

<div class="header">
  <span class="header_title">{title}</span>
  {#if status}
    <span class="header_discrip">{status}</span>
  {/if}
</div>

<style>
  .header {
    width: 100%;
    height: 32px;
    background: var(--color-dark2-gray, #1a1a1a);
    border-radius: var(--border-radius-m, 18px) var(--border-radius-m, 18px) 2px 2px;
    border: 1px solid #282828;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .header_title {
    font-size: var(--font-size-medium, 12px);
    font-weight: 700;
    color: #9e9e9e;
  }

  .header_discrip {
    font-size: var(--font-size-small, 10px);
    color: #696969;
  }
</style>
