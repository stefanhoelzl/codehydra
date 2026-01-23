import DocsApp from "./DocsApp.svelte";
import { mount } from "svelte";
import "./styles/site.css";

const app = mount(DocsApp, {
  target: document.getElementById("app")!,
});

export default app;
