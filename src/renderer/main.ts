import { mount } from "svelte";
import "./lib/styles/variables.css";
import "./lib/styles/global.css";
import App from "./App.svelte";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
