<script>
  export let data = "";
  export let size = "24";
  export let style = "";
</script>

{@html `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="${style}" xmlns="http://www.w3.org/2000/svg">${data}</svg>`}

<style>
</style>
