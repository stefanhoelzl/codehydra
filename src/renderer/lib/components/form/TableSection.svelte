<!--
  TableSection.svelte

  Table section leaf: a scrollable data table with an optional header line
  (icon + text) above it.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { TableSectionConfig } from "./types";

  interface Props {
    section: TableSectionConfig;
  }

  const { section }: Props = $props();
</script>

<div class="table-container">
  {#if section.header}
    <div class="table-header">
      {#if section.headerIcon}
        <span class="table-header-icon">
          <Icon name={section.headerIcon} />
        </span>
      {/if}
      <span>{section.header}</span>
    </div>
  {/if}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          {#each section.columns as col (col.key)}
            <th>{col.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each section.rows as row, rowIndex (rowIndex)}
          <tr>
            {#each section.columns as col (col.key)}
              <td>{row[col.key] ?? ""}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .table-container {
    width: 100%;
    margin-top: 0.5rem;
    text-align: left;
  }

  .table-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .table-header-icon {
    display: flex;
    align-items: center;
    color: var(--ch-warning);
  }

  .table-scroll {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-sm, 6px);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th {
    padding: 0.5rem 0.75rem;
    text-align: left;
    font-weight: 500;
    background: color-mix(in srgb, var(--ch-foreground) 5%, transparent);
    border-bottom: 1px solid var(--ch-border);
    position: sticky;
    top: 0;
  }

  td {
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, var(--ch-border) 50%, transparent);
  }

  tr:last-child td {
    border-bottom: none;
  }
</style>
