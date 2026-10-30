import "../shared/base.css";
import "./tags.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TagApp } from "./TagApp";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <TagApp />
    </StrictMode>,
  );
