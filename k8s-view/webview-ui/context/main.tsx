import "../shared/base.css";
import "./context.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContextApp } from "./ContextApp";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ContextApp />
    </StrictMode>,
  );
