import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App.js";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Owner UI preview root missing");
createRoot(root).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
