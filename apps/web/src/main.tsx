import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

/** The private-key test wallet exists only in builds made with VITE_TEST_WALLET=1 (docs/LIFECYCLE.md §9 "public builds"): the import below is
 *  dead code otherwise, so a public bundle carries neither the module nor its URL switch. */
const TEST_WALLET_BUILD = import.meta.env.VITE_TEST_WALLET === "1";

async function boot() {
  let injected = false;
  if (TEST_WALLET_BUILD) {
    const { maybeInjectTestWallet } = await import("./testWallet");
    injected = maybeInjectTestWallet();
    (window as any).__arcpreflightTestWallet = injected;
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App testWallet={injected} />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
void boot();
