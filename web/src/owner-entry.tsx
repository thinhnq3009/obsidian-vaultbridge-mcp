import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OwnerApp } from "./owner.js";

const root = document.getElementById("root");
if (!root) throw new Error("Owner UI root missing");
createRoot(root).render(<StrictMode><OwnerApp /></StrictMode>);
