import "../shared/base.css";
import "./log.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LogApp } from "./LogApp";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <LogApp />
    </StrictMode>,
  );
