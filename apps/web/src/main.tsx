import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { maybeInjectTestWallet } from "./testWallet";
import "./styles.css";

const injected = maybeInjectTestWallet();
(window as any).__arcpreflightTestWallet = injected;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App testWallet={injected} />
    </BrowserRouter>
  </React.StrictMode>,
);
