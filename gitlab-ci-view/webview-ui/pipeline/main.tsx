import "../shared/base.css";
import "./pipeline.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PipelineApp } from "./PipelineApp";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <PipelineApp />
    </StrictMode>,
  );
