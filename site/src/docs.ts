import Header from "./components/Header.svelte";
import Footer from "./components/Footer.svelte";
import { mount } from "svelte";
import "./styles/site.css";
import "./styles/docs.css";

// The guide itself is static HTML rendered into docs.html at build time; only
// the header and footer are components.
mount(Header, { target: document.getElementById("header")! });
mount(Footer, { target: document.getElementById("footer")! });
