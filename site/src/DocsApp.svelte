<script lang="ts">
  import Header from "./components/Header.svelte";
  import Footer from "./components/Footer.svelte";
  import GettingStarted from "./components/docs/GettingStarted.svelte";
</script>

<Header />
<main id="main-content" class="docs-main">
  <div class="container">
    <GettingStarted />
  </div>
</main>
<Footer />

<style>
  .docs-main {
    min-height: calc(100vh - 60px - 100px);
    padding: 2rem 0 4rem;
  }
</style>
