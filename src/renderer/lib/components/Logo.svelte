<script lang="ts">
  /**
   * Logo component for branding display.
   * Shows the CodeHydra hydra symbol with optional pulse animation.
   */
  import logo from "../../assets/logo.png";

  interface Props {
    size?: number;
    animated?: boolean;
  }

  const { size = 128, animated = false }: Props = $props();
</script>

<img
  src={logo}
  alt=""
  class:animated
  style:height="{size}px"
  role="presentation"
  aria-hidden="true"
/>

<style>
  img {
    display: block;
    width: auto;
    object-fit: contain;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.7;
    }
    50% {
      opacity: 1;
    }
  }

  .animated {
    animation: pulse 2s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .animated {
      animation: none;
      opacity: 1;
    }
  }
</style>
