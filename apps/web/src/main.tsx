// The one stylesheet (#101, decision 0002 §2): every design token and every
// utility the renderer may use arrives here, once, and no other package authors
// CSS. It is `@plotroom/toolkit`'s build output rather than its source, because
// Tailwind runs only in that package's build — which is also why a toolkit
// change needs a `pnpm build` to show up here, unlike the TypeScript, which this
// app resolves straight from source.
import "@plotroom/toolkit/toolkit.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("index.html is missing the #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
