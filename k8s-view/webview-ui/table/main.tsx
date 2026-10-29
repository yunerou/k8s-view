import "../shared/base.css";
import "./table.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TableApp } from "./TableApp";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <TableApp />
    </StrictMode>,
  );
